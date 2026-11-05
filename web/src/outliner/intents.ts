import { nextMarker, parseBlock, setMarker } from "../../../shared/blocktext";
import { keyBetween, keysBetween } from "../../../shared/order";
import type { Block } from "../../../shared/types";
import { type Outline, parentKey } from "./outline";

// Editing operations as pure functions. Each looks at the outline and returns the blocks to
// write (full new states) and to delete, plus where the caret goes next. Nothing here touches
// the DOM, the store or the network, so all of it is unit-tested.
//
// `scope`: in views that show one block with everything under it (zooming in, references, query
// results), the id of that block. Nothing may reach outside it, since nothing outside it is on
// screen: the block above it isn't there to merge into, and a sibling of it wouldn't be shown.

export interface Caret {
  id: string;
  offset: number;
}

export interface Change {
  upserts: Block[];
  deletes: string[]; // each delete also removes everything under the block
  caret?: Caret;
}

export function newBlock(page: string, parent: string | null, order_key: string, content = ""): Block {
  return { id: crypto.randomUUID(), page, parent, order_key, content, collapsed: false, rev: 0 };
}

// --- Finding neighbours ---------------------------------------------------------------------

function blockAt(o: Outline, ids: readonly string[], index: number): Block | undefined {
  return index >= 0 && index < ids.length ? o.get(ids[index]) : undefined;
}

export function previousSibling(o: Outline, b: Block): Block | undefined {
  const siblings = o.childIds(parentKey(b));
  const index = siblings.indexOf(b.id);
  return index === -1 ? undefined : blockAt(o, siblings, index - 1);
}

export function nextSibling(o: Outline, b: Block): Block | undefined {
  const siblings = o.childIds(parentKey(b));
  const index = siblings.indexOf(b.id);
  return index === -1 ? undefined : blockAt(o, siblings, index + 1);
}

function lastChild(o: Outline, id: string): Block | undefined {
  const children = o.childIds(id);
  return blockAt(o, children, children.length - 1);
}

function hasVisibleChildren(o: Outline, b: Block): boolean {
  return !b.collapsed && o.childIds(b.id).length > 0;
}

/** The block shown just above this one on the same page (skipping collapsed children). */
export function previousVisible(o: Outline, id: string, scope?: string | null): Block | undefined {
  const b = o.get(id);
  if (!b || id === scope) return undefined;
  let previous = previousSibling(o, b);
  if (!previous) return b.parent === null ? undefined : o.get(b.parent);
  while (hasVisibleChildren(o, previous)) previous = lastChild(o, previous.id)!;
  return previous;
}

/** The block shown just below this one on the same page. */
export function nextVisible(o: Outline, id: string, scope?: string | null): Block | undefined {
  let b = o.get(id);
  if (b && hasVisibleChildren(o, b)) return o.get(o.childIds(b.id)[0]);
  while (b && b.id !== scope) {
    const next = nextSibling(o, b);
    if (next) return next;
    b = b.parent === null ? undefined : o.get(b.parent);
  }
  return undefined;
}

// --- Editing --------------------------------------------------------------------------------

/** The first block on an empty page. */
export function firstBlock(page: string): Change {
  const block = newBlock(page, null, keyBetween(null, null));
  return { upserts: [block], deletes: [], caret: { id: block.id, offset: 0 } };
}

export function setContent(o: Outline, id: string, content: string): Change | null {
  const b = o.get(id);
  if (!b || b.content === content) return null;
  return { upserts: [{ ...b, content }], deletes: [] };
}

/** Enter: split the block at the caret (or the selection, which is dropped). */
export function split(o: Outline, id: string, start: number, end: number, scope?: string | null): Change | null {
  const b = o.get(id);
  if (!b) return null;
  if (id === scope) {
    // The block at the top of the view: the new block becomes its first child, so it's on screen.
    const at = start === 0 && end === 0 ? b.content.length : start; // at the very start, keep the text here
    const head = { ...b, content: b.content.slice(0, at), collapsed: false };
    const first = o.get(o.childIds(id)[0] ?? "");
    const below = newBlock(b.page, id, keyBetween(null, first?.order_key ?? null), b.content.slice(at === start ? end : at));
    return { upserts: [head, below], deletes: [], caret: { id: below.id, offset: 0 } };
  }
  // Enter in an empty nested block outdents it, as in Logseq.
  if (b.content === "" && b.parent !== null) return outdent(o, id, 0);
  // At the very start of a block with text: open an empty block above, and stay put.
  if (start === 0 && end === 0 && b.content !== "") {
    const above = newBlock(b.page, b.parent, keyBetween(previousSibling(o, b)?.order_key ?? null, b.order_key));
    return { upserts: [above], deletes: [], caret: { id, offset: 0 } };
  }
  const head = { ...b, content: b.content.slice(0, start) };
  const tail = b.content.slice(end);
  // The new block appears right below this line: as the first child when children are
  // showing, otherwise as the next sibling.
  const below = hasVisibleChildren(o, b)
    ? newBlock(b.page, id, keyBetween(null, o.get(o.childIds(id)[0])!.order_key), tail)
    : newBlock(b.page, b.parent, keyBetween(b.order_key, nextSibling(o, b)?.order_key ?? null), tail);
  return { upserts: [head, below], deletes: [], caret: { id: below.id, offset: 0 } };
}

/** Tab: become the last child of the previous sibling. */
export function indent(o: Outline, id: string, offset: number, scope?: string | null): Change | null {
  const b = o.get(id);
  const previous = b && id !== scope ? previousSibling(o, b) : undefined;
  if (!b || !previous) return null;
  const moved = { ...b, parent: previous.id, order_key: keyBetween(lastChild(o, previous.id)?.order_key ?? null, null) };
  const upserts: Block[] = [moved];
  if (previous.collapsed) upserts.push({ ...previous, collapsed: false }); // keep the moved block visible
  return { upserts, deletes: [], caret: { id, offset } };
}

/**
 * Shift+Tab: move up a level, right after the parent. Following siblings become this block's
 * children, so nothing jumps around on screen (Logseq's default).
 */
export function outdent(o: Outline, id: string, offset: number, scope?: string | null): Change | null {
  const b = o.get(id);
  const parent = b?.parent && id !== scope && b.parent !== scope ? o.get(b.parent) : undefined;
  if (!b || !parent) return null;
  const moved = {
    ...b,
    parent: parent.parent,
    order_key: keyBetween(parent.order_key, nextSibling(o, parent)?.order_key ?? null),
  };
  const siblings = o.childIds(parent.id);
  const following = siblings.slice(siblings.indexOf(id) + 1).map((sid) => o.get(sid)!);
  const upserts: Block[] = [moved];
  if (following.length > 0) {
    const keys = keysBetween(lastChild(o, id)?.order_key ?? null, null, following.length);
    following.forEach((sibling, i) => upserts.push({ ...sibling, parent: id, order_key: keys[i] }));
    moved.collapsed = false;
  }
  return { upserts, deletes: [], caret: { id, offset } };
}

/** Appends `source`'s text to `target` and removes `source`. Its children move to `target`. */
function mergeInto(o: Outline, target: Block, source: Block): Change {
  const upserts: Block[] = [{ ...target, content: target.content + source.content }];
  const children = o.childIds(source.id).map((cid) => o.get(cid)!);
  if (children.length > 0) {
    let keys: string[];
    if (source.parent === target.id) {
      // `source` is one of target's children: its own children take its place.
      const siblings = o.childIds(target.id);
      const index = siblings.indexOf(source.id);
      keys = keysBetween(
        blockAt(o, siblings, index - 1)?.order_key ?? null,
        blockAt(o, siblings, index + 1)?.order_key ?? null,
        children.length,
      );
    } else {
      keys = keysBetween(lastChild(o, target.id)?.order_key ?? null, null, children.length);
    }
    children.forEach((child, i) => upserts.push({ ...child, parent: target.id, order_key: keys[i] }));
  }
  return { upserts, deletes: [source.id], caret: { id: target.id, offset: target.content.length } };
}

/** Backspace at the start: join this block onto the one above (or drop it if it's empty). */
export function mergeWithPrevious(o: Outline, id: string, scope?: string | null): Change | null {
  const b = o.get(id);
  const previous = previousVisible(o, id, scope);
  if (!b || !previous) return null;
  if (b.content === "" && o.childIds(id).length === 0) {
    return { upserts: [], deletes: [id], caret: { id: previous.id, offset: previous.content.length } };
  }
  return mergeInto(o, previous, b);
}

/** Delete at the end: pull the block below into this one. */
export function mergeNext(o: Outline, id: string, scope?: string | null): Change | null {
  const b = o.get(id);
  const next = nextVisible(o, id, scope);
  return b && next ? mergeInto(o, b, next) : null;
}

/** Swap places with the sibling above. */
export function moveUp(o: Outline, id: string, offset: number, scope?: string | null): Change | null {
  const b = o.get(id);
  const previous = b && id !== scope ? previousSibling(o, b) : undefined;
  if (!b || !previous) return null;
  const order_key = keyBetween(previousSibling(o, previous)?.order_key ?? null, previous.order_key);
  return { upserts: [{ ...b, order_key }], deletes: [], caret: { id, offset } };
}

/** Swap places with the sibling below. */
export function moveDown(o: Outline, id: string, offset: number, scope?: string | null): Change | null {
  const b = o.get(id);
  const next = b && id !== scope ? nextSibling(o, b) : undefined;
  if (!b || !next) return null;
  const order_key = keyBetween(next.order_key, nextSibling(o, next)?.order_key ?? null);
  return { upserts: [{ ...b, order_key }], deletes: [], caret: { id, offset } };
}

export function setCollapsed(o: Outline, id: string, collapsed: boolean, offset?: number): Change | null {
  const b = o.get(id);
  if (!b || b.collapsed === collapsed || o.childIds(id).length === 0) return null;
  return { upserts: [{ ...b, collapsed }], deletes: [], caret: offset === undefined ? undefined : { id, offset } };
}

/** Mod+Enter: TODO → DOING → DONE → no marker. The caret stays by the same text. */
export function cycleMarker(o: Outline, id: string, offset: number): Change | null {
  const b = o.get(id);
  if (!b) return null;
  const content = setMarker(b.content, nextMarker(parseBlock(b.content).marker));
  return { upserts: [{ ...b, content }], deletes: [], caret: { id, offset: Math.max(0, offset + content.length - b.content.length) } };
}

/** The checkbox: DONE becomes TODO, anything else becomes DONE. */
export function toggleDone(o: Outline, id: string): Change | null {
  const b = o.get(id);
  if (!b) return null;
  const content = setMarker(b.content, parseBlock(b.content).marker === "DONE" ? "TODO" : "DONE");
  return { upserts: [{ ...b, content }], deletes: [] };
}

/** Where the caret lands when moving up (into the last line) or down (into the first line) of another block. */
export function columnTarget(text: string, offset: number, target: string, direction: "up" | "down"): number {
  const column = offset - (offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1);
  if (direction === "up") return Math.min(target.lastIndexOf("\n") + 1 + column, target.length);
  const firstLineEnd = target.indexOf("\n");
  return Math.min(column, firstLineEnd === -1 ? target.length : firstLineEnd);
}

/**
 * Where a click lands in a block's raw text, given the rendered text before it. Matches that
 * text character by character, skipping markup ("[[", "**", …) that isn't shown. When the shown
 * text differs from the raw text (a journal link shown as a date), the caret goes to the end.
 */
export function rawOffset(raw: string, shownBefore: string): number {
  let index = 0;
  for (const char of shownBefore) {
    const found = raw.indexOf(char, index);
    if (found === -1) return raw.length;
    index = found + 1;
  }
  return index;
}
