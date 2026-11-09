import { type OutlineItem, writeOutline } from "../../../shared/markdownOutline";
import { keysBetween } from "../../../shared/order";
import type { Block } from "../../../shared/types";
import { type Change, isBlank, newBlock, nextSibling } from "./intents";
import type { Outline } from "./outline";

// Copying blocks as a markdown outline ("- item", two spaces per level) and pasting one back
// as blocks (parsed by shared/markdownOutline.ts). Pure functions, unit-tested.

/** The blocks (with everything under them) as a markdown outline. */
export function toMarkdown(o: Outline, ids: readonly string[]): string {
  return writeOutline(ids, { children: (id) => o.childIds(id), content: (id) => o.get(id)?.content });
}

/**
 * Inserts pasted blocks after block `id`. If that block is empty, the first pasted block goes
 * into it. The caret ends up at the end of the last top-level block pasted.
 */
export function insertOutline(o: Outline, id: string, pasted: OutlineItem[], scope?: string | null): Change | null {
  const target = o.get(id);
  if (!target || pasted.length === 0) return null;
  const upserts: Block[] = [];
  // Adds blocks under `parent` between two order keys; returns the key of the last one added.
  const add = (blocks: OutlineItem[], parent: string, after: string | null, before: string | null): string | null => {
    const keys = keysBetween(after, before, blocks.length);
    blocks.forEach((child, i) => {
      const block = newBlock(target.page, parent, keys[i], child.content);
      upserts.push(block);
      add(child.children, block.id, null, null);
    });
    return keys.at(-1) ?? after;
  };

  let rest = pasted;
  let last: Block = target;
  let lastChildKey = o.get(o.childIds(id).at(-1) ?? "")?.order_key ?? null;
  if (isBlank(target.content)) {
    last = { ...target, content: pasted[0].content };
    upserts.push(last);
    lastChildKey = add(pasted[0].children, id, lastChildKey, null);
    rest = pasted.slice(1);
  }
  // Below the block at the top of a zoomed view means among its children, or it wouldn't be on screen.
  const firstChildKey = o.get(o.childIds(id)[0] ?? "")?.order_key ?? null;
  const [parent, after, before] =
    id === scope
      ? [id, ...(rest === pasted ? [null, firstChildKey] : [lastChildKey, null])]
      : [target.parent, target.order_key, nextSibling(o, target)?.order_key ?? null];
  const keys = keysBetween(after, before, rest.length);
  rest.forEach((block, i) => {
    last = newBlock(target.page, parent, keys[i], block.content);
    upserts.push(last);
    add(block.children, last.id, null, null);
  });
  return { upserts, deletes: [], caret: { id: last.id, offset: last.content.length } };
}
