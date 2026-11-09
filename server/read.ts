import type { Database } from "bun:sqlite";
import { pageKey } from "../shared/names";
import type { Block, BlockTree, Crumb, HistoryEntry, PageData, PageSummary, RefGroup } from "../shared/types";

export const BLOCK_COLUMNS =
  "id, page, parent, order_key, content, collapsed, rev, (SELECT count(*) FROM block_refs WHERE target = blocks.id) AS ref_count";

export type BlockRow = Omit<Block, "collapsed"> & { collapsed: number };

export function toBlock(row: BlockRow): Block {
  return { ...row, collapsed: row.collapsed === 1 };
}

export function currentRev(db: Database): number {
  return (db.query("SELECT value FROM meta WHERE key = 'rev'").get() as { value: number }).value;
}

export function getPage(db: Database, name: string): PageData {
  const key = pageKey(name);
  const page = pageSummary(db, key);
  return { page, blocks: page ? blocksOf(db, key) : [], rev: currentRev(db) };
}

/** Journal pages for days before `before` (yyyymmdd), newest first. */
export function getJournals(db: Database, before: number, limit: number): PageData[] {
  const rev = currentRev(db);
  const pages = db
    .query(
      // Only days with something written: a [[2026-12-24]] link alone creates an empty journal page,
      // and a block of only spaces or line breaks counts as nothing written.
      `SELECT key, name, journal_day FROM pages WHERE journal_day < ?
         AND EXISTS (SELECT 1 FROM blocks WHERE page = pages.key AND trim(content, ' ' || char(9, 10, 13)) != '')
       ORDER BY journal_day DESC LIMIT ?`,
    )
    .all(before, limit) as PageSummary[];
  return pages.map((page) => ({ page, blocks: blocksOf(db, page.key), rev }));
}

/** How many pages the Pages tab shows before you filter. */
export const RECENT_PAGES = 20;

/**
 * Named pages, the most recently changed first: the time the server last saved one of their
 * blocks. Journal days are left out (the Journals tab has them), and so are pages with no blocks.
 */
export function getRecentPages(db: Database, limit: number): PageSummary[] {
  return db
    .query(
      `SELECT p.key, p.name, p.journal_day
       FROM pages p JOIN (SELECT page, max(updated_at) AS changed FROM blocks GROUP BY page) b ON b.page = p.key
       WHERE p.journal_day IS NULL
       ORDER BY b.changed DESC, p.key LIMIT ?`,
    )
    .all(limit) as PageSummary[];
}

function blocksOf(db: Database, key: string): Block[] {
  const rows = db.query(`SELECT ${BLOCK_COLUMNS} FROM blocks WHERE page = ? ORDER BY parent, order_key, id`).all(key);
  return (rows as BlockRow[]).map(toBlock);
}

/** Text other tabs or devices replaced in this block, newest first. */
export function getHistory(db: Database, id: string): HistoryEntry[] {
  return db
    .query("SELECT content, device, saved_at FROM block_history WHERE block = ? ORDER BY saved_at DESC, rowid DESC")
    .all(id) as HistoryEntry[];
}

// CROSS JOIN keeps this join order in SQLite: walk the subtree, then look each block up by id.
// With a plain JOIN the planner scanned every block for each call (12 ms per call at 100k blocks).
export const SUBTREE = `
  WITH RECURSIVE sub(id, depth) AS (SELECT ?1, 0 UNION ALL SELECT b.id, sub.depth + 1 FROM blocks b JOIN sub ON b.parent = sub.id)
  SELECT ${BLOCK_COLUMNS} FROM sub CROSS JOIN blocks USING (id) ORDER BY sub.depth, order_key, id`;

const ANCESTORS = `
  WITH RECURSIVE up(id, parent, content, order_key, depth) AS (
    SELECT id, parent, content, order_key, 0 FROM blocks WHERE id = (SELECT parent FROM blocks WHERE id = ?1)
    UNION ALL SELECT b.id, b.parent, b.content, b.order_key, up.depth + 1 FROM blocks b JOIN up ON b.id = up.parent)
  SELECT id, content, order_key FROM up ORDER BY depth DESC`;

function subtreeOf(db: Database, id: string): Block[] {
  return (db.query(SUBTREE).all(id) as BlockRow[]).map(toBlock);
}

function ancestorsOf(db: Database, id: string): (Crumb & { order_key: string })[] {
  return db.query(ANCESTORS).all(id) as (Crumb & { order_key: string })[];
}

function crumbs(ancestors: (Crumb & { order_key: string })[]): Crumb[] {
  return ancestors.map(({ id, content }) => ({ id, content }));
}

export function pageSummary(db: Database, key: string): PageSummary | null {
  return db.query("SELECT key, name, journal_day FROM pages WHERE key = ?").get(key) as PageSummary | null;
}

/**
 * Blocks on other pages that reference this page, grouped by page (journals newest first).
 * A block under another block that already references the page shows up inside that one.
 */
export function getLinkedRefs(db: Database, name: string): RefGroup[] {
  const key = pageKey(name);
  const rows = db.query("SELECT b.id FROM refs r JOIN blocks b ON b.id = r.block WHERE r.page = ?1 AND b.page != ?1").all(key);
  return groupBlocks(db, idsOf(rows));
}

/**
 * Blocks to show away from their page, grouped by page (journals newest first, then by name).
 * Each block comes with everything under it, so a block under another one of them isn't shown
 * separately. Within a page, blocks are in the order they appear there.
 */
export function groupBlocks(db: Database, ids: string[]): RefGroup[] {
  const chosen = new Set(ids);
  const groups = new Map<string, RefGroup>();
  const positions = new Map<string, string>();
  const rows = db
    .query("SELECT id, page, order_key FROM blocks WHERE id IN (SELECT value FROM json_each(?))")
    .all(JSON.stringify(ids)) as { id: string; page: string; order_key: string }[];
  for (const { id, page, order_key } of rows) {
    const ancestors = ancestorsOf(db, id);
    if (ancestors.some((crumb) => chosen.has(crumb.id))) continue;
    let group = groups.get(page);
    if (!group) groups.set(page, (group = { page: pageSummary(db, page)!, roots: [], paths: {}, blocks: [] }));
    group.roots.push(id);
    group.paths[id] = crumbs(ancestors);
    // Order keys only sort among siblings, so a block's place on the page is the path of keys down to it.
    positions.set(id, [...ancestors.map((crumb) => crumb.order_key), order_key].join(" "));
    group.blocks.push(...subtreeOf(db, id));
  }
  for (const group of groups.values()) group.roots.sort((a, b) => (positions.get(a)! < positions.get(b)! ? -1 : 1));
  return [...groups.values()].sort(
    (a, b) => (b.page.journal_day ?? 0) - (a.page.journal_day ?? 0) || (a.page.key < b.page.key ? -1 : 1),
  );
}

export function idsOf(rows: unknown[]): string[] {
  return (rows as { id: string }[]).map((row) => row.id);
}

/** Blocks that reference a block with ((id)), grouped by page. */
export function getBlockRefs(db: Database, id: string): RefGroup[] {
  return groupBlocks(db, idsOf(db.query("SELECT block AS id FROM block_refs WHERE target = ?").all(id)));
}

/** Blocks by id, for showing ((references)) to them. Ids that don't exist are left out. */
export function getBlocks(db: Database, ids: string[]): Block[] {
  const rows = db.query(`SELECT ${BLOCK_COLUMNS} FROM blocks WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids));
  return (rows as BlockRow[]).map(toBlock);
}

export function getBlockTree(db: Database, id: string): BlockTree | null {
  const blocks = subtreeOf(db, id);
  if (blocks.length === 0) return null;
  return { page: pageSummary(db, blocks[0].page)!, path: crumbs(ancestorsOf(db, id)), blocks };
}
