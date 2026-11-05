// Helpers shared by the server tests.
import type { Database } from "bun:sqlite";
import { expect } from "bun:test";
import type { Op } from "../shared/types";

export const writer = { writer: "tab-1", device: "Test" };

export function blockOp(
  id: string,
  page: string,
  parent: string | null,
  order_key: string,
  extra: { content?: string; collapsed?: boolean; base?: number } = {},
): Op {
  const { content = id, collapsed = false, base = 0 } = extra;
  return { t: "block", id, page, parent, order_key, content, collapsed, base };
}

/** A page's outline as indented text, one block's content per line. */
export function outlineOf(db: Database, page: string): string {
  const rows = db.query("SELECT id, parent, content FROM blocks WHERE page = ? ORDER BY order_key, id").all(page) as {
    id: string;
    parent: string | null;
    content: string;
  }[];
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const row of rows.filter((r) => r.parent === parent)) {
      lines.push("  ".repeat(depth) + row.content);
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

/** Asserts the invariants every batch must leave behind. */
export function checkTree(db: Database): void {
  const rows = db.query("SELECT id, page, parent, order_key FROM blocks").all() as {
    id: string;
    page: string;
    parent: string | null;
    order_key: string;
  }[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const siblingKeys = new Set<string>();
  for (const row of rows) {
    const seen = new Set([row.id]);
    for (let parent = row.parent; parent !== null; ) {
      expect(seen.has(parent)).toBe(false); // no cycles
      seen.add(parent);
      const parentRow = byId.get(parent);
      expect(parentRow).toBeDefined(); // no orphans
      expect(parentRow?.page).toBe(row.page); // children live on their parent's page
      parent = parentRow?.parent ?? null;
    }
    const siblingKey = `${row.page}\u0000${row.parent}\u0000${row.order_key}`;
    expect(siblingKeys.has(siblingKey)).toBe(false); // unique sibling order
    siblingKeys.add(siblingKey);
  }
}
