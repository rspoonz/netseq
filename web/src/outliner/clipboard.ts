import { writeOutline } from "../../../shared/markdownOutline";
import { keysBetween } from "../../../shared/order";
import type { Block } from "../../../shared/types";
import { type Change, newBlock, nextSibling } from "./intents";
import type { Outline } from "./outline";

// Copying blocks as a markdown outline ("- item", two spaces per level) and pasting one back
// as blocks. Pure functions, unit-tested.

export interface PastedBlock {
  content: string;
  children: PastedBlock[];
}

const BULLET = /^(\s*)[-*+] (.*)$/;

/** Whether pasted text is an outline of "- item" lines rather than ordinary text. */
export function looksLikeOutline(text: string): boolean {
  const lines = text.trim().split(/\r?\n/);
  return lines.length > 1 && BULLET.test(lines[0]);
}

export function parseOutline(text: string): PastedBlock[] {
  const roots: PastedBlock[] = [];
  const stack: { indent: number; block: PastedBlock }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const bullet = BULLET.exec(line);
    if (bullet) {
      const indent = bullet[1].length;
      const block: PastedBlock = { content: bullet[2], children: [] };
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      (stack.length > 0 ? stack[stack.length - 1].block.children : roots).push(block);
      stack.push({ indent, block });
    } else if (stack.length > 0) {
      // A continuation line of the item above, minus the indentation of the item's text.
      const top = stack[stack.length - 1];
      const leading = line.length - line.trimStart().length;
      top.block.content += "\n" + line.slice(Math.min(leading, top.indent + 2));
    } else if (line.trim()) {
      roots.push({ content: line.trim(), children: [] });
    }
  }
  const tidy = (blocks: PastedBlock[]): PastedBlock[] =>
    blocks.map((b) => ({ content: b.content.trimEnd(), children: tidy(b.children) }));
  return tidy(roots);
}

/** The blocks (with everything under them) as a markdown outline. */
export function toMarkdown(o: Outline, ids: readonly string[]): string {
  return writeOutline(ids, { children: (id) => o.childIds(id), content: (id) => o.get(id)?.content });
}

/**
 * Inserts pasted blocks after block `id`. If that block is empty, the first pasted block goes
 * into it. The caret ends up at the end of the last top-level block pasted.
 */
export function insertOutline(o: Outline, id: string, pasted: PastedBlock[], scope?: string | null): Change | null {
  const target = o.get(id);
  if (!target || pasted.length === 0) return null;
  const upserts: Block[] = [];
  // Adds blocks under `parent` between two order keys; returns the key of the last one added.
  const add = (blocks: PastedBlock[], parent: string, after: string | null, before: string | null): string | null => {
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
  if (target.content === "") {
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
