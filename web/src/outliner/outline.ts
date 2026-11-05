import { compareSiblings } from "../../../shared/order";
import type { Block } from "../../../shared/types";

/** The key of a sibling list: the parent block's id, or the top level of a page. */
export function parentKey(block: { page: string; parent: string | null }): string {
  return block.parent ?? topKey(block.page);
}

export function topKey(page: string): string {
  return `page:${page}`;
}

const NONE: readonly string[] = Object.freeze([]);

/**
 * The blocks the browser has loaded, with sibling lists kept sorted for rendering and editing.
 * Plain TypeScript so it can be tested without Vue; the app wraps one instance in reactive().
 * Blocks are replaced, never mutated in place.
 */
export class Outline {
  blocks = new Map<string, Block>();
  children = new Map<string, string[]>(); // parentKey → sorted child ids

  get(id: string): Block | undefined {
    return this.blocks.get(id);
  }

  childIds(key: string): readonly string[] {
    return this.children.get(key) ?? NONE;
  }

  upsert(block: Block): void {
    const old = this.blocks.get(block.id);
    const moved = !old || parentKey(old) !== parentKey(block) || old.order_key !== block.order_key;
    if (old && moved) this.unlink(old);
    this.blocks.set(block.id, block);
    if (moved) this.link(block);
  }

  /** Removes a block and everything under it. */
  remove(id: string): void {
    for (const sub of this.subtree(id).reverse()) {
      const block = this.blocks.get(sub);
      if (!block) continue;
      this.unlink(block);
      this.blocks.delete(sub);
    }
  }

  /** The ids of a block and everything under it, parents before their children. */
  subtree(id: string): string[] {
    if (!this.blocks.has(id)) return [];
    const ids = [id];
    for (let i = 0; i < ids.length; i++) ids.push(...this.childIds(ids[i]));
    return ids;
  }

  private link(block: Block): void {
    const key = parentKey(block);
    const list = this.children.get(key);
    if (!list) {
      this.children.set(key, [block.id]);
      return;
    }
    let index = list.length;
    while (index > 0 && compareSiblings(block, this.blocks.get(list[index - 1])!) < 0) index--;
    list.splice(index, 0, block.id);
  }

  private unlink(block: Block): void {
    const key = parentKey(block);
    const list = this.children.get(key);
    const index = list?.indexOf(block.id) ?? -1;
    if (!list || index === -1) return;
    if (list.length === 1) this.children.delete(key);
    else list.splice(index, 1);
  }
}
