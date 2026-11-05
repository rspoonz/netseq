import type { Database } from "bun:sqlite";
import { pageKey } from "../shared/names";
import { isValidKey, keyBetween } from "../shared/order";
import { parseBlock, propertyValues, searchText } from "../shared/blocktext";
import { blockRefsIn, extractRefs, renameRefs } from "../shared/refs";
import type { Batch, BatchResult, Op, Overwrite, PageSummary } from "../shared/types";
import { getBlocks, pageSummary } from "./read";

/** A batch that isn't shaped the way the client is supposed to send it. Answered with a 400. */
export class BadBatch extends Error {}

const MAX_ID = 100;

// Shape checks only, which catch client bugs. No size limits: anything normal use can produce (a
// long paste, a long [[link]], a position key that grew from many inserts in one spot) must save,
// because the browser can't do anything with a refused change except tell you it was lost.
export function parseBatch(body: unknown): Batch {
  if (!isRecord(body)) throw new BadBatch("expected an object");
  const { writer, device, ops } = body;
  if (typeof writer !== "string" || typeof device !== "string") throw new BadBatch("writer and device must be strings");
  if (!Array.isArray(ops)) throw new BadBatch("ops must be an array");
  return { writer: writer.slice(0, MAX_ID), device: device.slice(0, MAX_ID), ops: ops.map(parseOp) };
}

function parseOp(op: unknown, index: number): Op {
  const bad = (why: string) => new BadBatch(`op ${index}: ${why}`);
  if (!isRecord(op)) throw bad("expected an object");
  if (!isId(op.id)) throw bad("bad id");
  if (op.t === "delete") return { t: "delete", id: op.id };
  if (op.t !== "block") throw bad("unknown op type");
  if (typeof op.page !== "string" || op.page.trim() === "") throw bad("bad page");
  if (op.parent !== null && !isId(op.parent)) throw bad("bad parent");
  if (typeof op.order_key !== "string" || !isValidKey(op.order_key)) throw bad("bad order_key");
  if (typeof op.content !== "string") throw bad("bad content");
  if (typeof op.collapsed !== "boolean") throw bad("bad collapsed");
  if (typeof op.base !== "number" || !Number.isInteger(op.base) || op.base < 0) throw bad("bad base");
  const { id, page, parent, order_key, content, collapsed, base } = op;
  return { t: "block", id, page, parent, order_key, content, collapsed, base };
}

/**
 * Applies a batch in one transaction: block writes first, then deletes, then one repair pass,
 * so the order of ops inside a batch never matters.
 */
export function applyBatch(db: Database, batch: Batch, now = Date.now()): BatchResult {
  return db.transaction(() => {
    const rev = bumpRev(db);
    const touched = new Set<string>(); // blocks this batch wrote or repaired
    const overwrote: Overwrite[] = [];
    const ctx = indexContext(now);
    const { created, emptied } = ctx;

    const upsert = db.query(`
      INSERT INTO blocks (id, page, parent, order_key, content, collapsed, rev, writer, device, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        page = excluded.page, parent = excluded.parent, order_key = excluded.order_key,
        content = excluded.content, collapsed = excluded.collapsed, rev = excluded.rev,
        writer = excluded.writer, device = excluded.device, updated_at = excluded.updated_at`);

    for (const op of batch.ops) {
      if (op.t !== "block") continue;
      const key = pageKey(op.page);
      ensurePage(db, op.page, ctx);
      const previous = db.query("SELECT page, content, rev, writer, device FROM blocks WHERE id = ?").get(op.id) as {
        page: string;
        content: string;
        rev: number;
        writer: string | null;
        device: string | null;
      } | null;
      if (previous && previous.page !== key) emptied.add(previous.page);
      // Another tab or device changed this text after the edit started: keep what it wrote. (Writer
      // null means the server itself changed the block, in a rename.)
      if (
        previous &&
        previous.rev > op.base &&
        previous.writer !== null &&
        previous.writer !== batch.writer &&
        previous.content !== op.content
      ) {
        db.query("INSERT INTO block_history (block, content, device, saved_at) VALUES (?, ?, ?, ?)").run(
          op.id,
          previous.content,
          previous.device,
          now,
        );
        overwrote.push({ block: op.id, device: previous.device });
      }
      const values = [op.id, key, op.parent, op.order_key, op.content, op.collapsed ? 1 : 0, rev];
      upsert.run(...values, batch.writer, batch.device, now);
      touched.add(op.id);
      indexBlock(db, op.id, op.content, ctx);
    }

    const deleted: string[] = [];
    for (const op of batch.ops) {
      if (op.t !== "delete") continue;
      for (const row of db.query(SUBTREE).all(op.id) as { id: string; page: string }[]) {
        for (const ref of db.query("SELECT page FROM refs WHERE block = ?").all(row.id) as { page: string }[]) {
          emptied.add(ref.page);
        }
        for (const ref of db.query("SELECT target FROM block_refs WHERE block = ?").all(row.id) as { target: string }[]) {
          ctx.targets.add(ref.target);
        }
        db.query("DELETE FROM blocks WHERE id = ?").run(row.id); // its refs go with it
        deleted.push(row.id);
        touched.delete(row.id);
        emptied.add(row.page);
      }
    }

    repair(db, touched, emptied, rev, now);

    const removedPages = [...emptied].filter(
      (key) =>
        db
          .query(
            "DELETE FROM pages WHERE key = ?1 AND NOT EXISTS (SELECT 1 FROM blocks WHERE page = ?1) AND NOT EXISTS (SELECT 1 FROM refs WHERE page = ?1) RETURNING key",
          )
          .get(key) !== null,
    );

    return {
      rev,
      rows: getBlocks(db, [...touched]),
      deleted,
      pages: [...created.values()].filter((page) => !removedPages.includes(page.key)),
      removedPages,
      overwrote,
      refCounts: refCounts(db, ctx.targets),
    };
  })();
}

/** The current ref_count of each block. */
function refCounts(db: Database, ids: Set<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of ids) counts[id] = 0;
  const rows = db
    .query("SELECT target, count(*) AS n FROM block_refs WHERE target IN (SELECT value FROM json_each(?)) GROUP BY target")
    .all(JSON.stringify([...ids])) as { target: string; n: number }[];
  for (const { target, n } of rows) counts[target] = n;
  return counts;
}

const HISTORY_DAYS = 30;

/** Forgets replaced text older than 30 days. */
export function pruneHistory(db: Database, now = Date.now()): void {
  db.query("DELETE FROM block_history WHERE saved_at < ?").run(now - HISTORY_DAYS * 24 * 60 * 60 * 1000);
}

function bumpRev(db: Database): number {
  return (db.query("UPDATE meta SET value = value + 1 WHERE key = 'rev' RETURNING value").get() as { value: number }).value;
}

/** Creates the page if it doesn't exist yet, noting it among the pages created. */
function ensurePage(db: Database, name: string, ctx: IndexContext): void {
  const page = db
    .query("INSERT INTO pages (key, name, created_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING RETURNING key, name, journal_day")
    .get(pageKey(name), name.trim(), ctx.now) as PageSummary | null;
  if (page) ctx.created.set(page.key, page);
}

/** What indexing blocks in one transaction collects along the way. */
interface IndexContext {
  created: Map<string, PageSummary>; // pages created along the way
  emptied: Set<string>; // pages that lost a reference or block, and may need cleaning up
  targets: Set<string>; // blocks that gained or lost a ((reference))
  now: number;
}

function indexContext(now: number): IndexContext {
  return { created: new Map(), emptied: new Set(), targets: new Set(), now };
}

/**
 * Re-derives what the server stores about a block's text: task marker, priority, dates, search
 * text, properties, page references and block references. Pages it refers to are created.
 */
function indexBlock(db: Database, id: string, content: string, ctx: IndexContext): void {
  const info = parseBlock(content);
  db.query("UPDATE blocks SET marker = ?, priority = ?, scheduled = ?, deadline = ?, search_text = ? WHERE id = ?").run(
    info.marker,
    info.priority,
    info.scheduled,
    info.deadline,
    searchText(content),
    id,
  );

  db.query("DELETE FROM props WHERE block = ?").run(id);
  const insertProp = db.query("INSERT INTO props (block, key, value) VALUES (?, ?, ?)");
  for (const [key, value] of info.props) for (const v of propertyValues(value)) insertProp.run(id, key, v);

  for (const ref of db.query("SELECT page FROM refs WHERE block = ?").all(id) as { page: string }[]) ctx.emptied.add(ref.page);
  db.query("DELETE FROM refs WHERE block = ?").run(id);
  for (const name of extractRefs(content)) {
    ensurePage(db, name, ctx);
    db.query("INSERT OR IGNORE INTO refs (block, page) VALUES (?, ?)").run(id, pageKey(name));
  }

  const before = db.query("SELECT target FROM block_refs WHERE block = ?").all(id) as { target: string }[];
  const after = blockRefsIn(content).filter((target) => target !== id); // a block referencing itself doesn't count
  if (before.length === after.length && before.every((row) => after.includes(row.target))) return;
  for (const row of before) ctx.targets.add(row.target);
  db.query("DELETE FROM block_refs WHERE block = ?").run(id);
  for (const target of after) {
    db.query("INSERT INTO block_refs (block, target) VALUES (?, ?)").run(id, target);
    ctx.targets.add(target);
  }
}

export type RenameOutcome = { ok: true; result: BatchResult } | { ok: false; status: 404 | 409 };

/**
 * Renames a page: its key changes (blocks and refs follow through ON UPDATE CASCADE) and every
 * reference to it is rewritten. Renaming onto another existing page is refused (409).
 */
export function renamePage(db: Database, from: string, to: string, now = Date.now()): RenameOutcome {
  const name = to.trim();
  const fromKey = pageKey(from);
  const toKey = pageKey(name);
  return db.transaction((): RenameOutcome => {
    if (!db.query("SELECT 1 FROM pages WHERE key = ?").get(fromKey)) return { ok: false, status: 404 };
    if (toKey !== fromKey && db.query("SELECT 1 FROM pages WHERE key = ?").get(toKey)) return { ok: false, status: 409 };
    const rev = bumpRev(db);
    db.query("UPDATE pages SET key = ?, name = ? WHERE key = ?").run(toKey, name, fromKey);

    const touched = new Set((db.query("SELECT id FROM blocks WHERE page = ?").all(toKey) as { id: string }[]).map((r) => r.id));
    // The blocks' page changed, so they get a new rev (that's how tabs hear of it). Writer null says
    // the server made the change, so it's not mistaken for another device's edit (see applyBatch).
    db.query("UPDATE blocks SET rev = ?, writer = NULL, updated_at = ? WHERE page = ?").run(rev, now, toKey);
    // Blocks that link to the page, and blocks with queries (links inside them aren't in refs).
    const referring = db
      .query(
        "SELECT b.id, b.content FROM refs r JOIN blocks b ON b.id = r.block WHERE r.page = ? UNION SELECT id, content FROM blocks WHERE content LIKE '%{{query%'",
      )
      .all(toKey) as { id: string; content: string }[];
    for (const { id, content } of referring) {
      const rewritten = renameRefs(content, from, name);
      if (rewritten === content) continue;
      db.query("UPDATE blocks SET content = ?, rev = ?, writer = NULL, updated_at = ? WHERE id = ?").run(rewritten, rev, now, id);
      indexBlock(db, id, rewritten, indexContext(now));
      touched.add(id);
    }

    const page = pageSummary(db, toKey)!;
    const removedPages = toKey === fromKey ? [] : [fromKey];
    const renamed = { from: fromKey, to: name };
    const result = { rev, rows: getBlocks(db, [...touched]), deleted: [], pages: [page], removedPages, overwrote: [], refCounts: {}, renamed };
    return { ok: true, result };
  })();
}

const SUBTREE = `
  WITH RECURSIVE sub(id) AS (SELECT ?1 UNION SELECT b.id FROM blocks b JOIN sub ON b.parent = sub.id)
  SELECT b.id, b.page FROM blocks b JOIN sub USING (id)`;

const DESCENDANTS_ELSEWHERE = `
  WITH RECURSIVE sub(id) AS (SELECT id FROM blocks WHERE parent = ?1 UNION SELECT b.id FROM blocks b JOIN sub ON b.parent = sub.id)
  SELECT b.id, b.page FROM blocks b JOIN sub USING (id) WHERE b.page != ?2`;

interface Placement {
  id: string;
  page: string;
  parent: string | null;
  order_key: string;
}

/**
 * Keeps the tree valid whatever the batch said:
 * - a block whose parent is missing, or would create a cycle, moves to its page's top level;
 * - a block lives on its parent's page, and its descendants follow it there;
 * - a block whose sibling already has its order key gets a new key just after it.
 */
function repair(db: Database, touched: Set<string>, emptied: Set<string>, rev: number, now: number): void {
  const select = db.query("SELECT id, page, parent, order_key FROM blocks WHERE id = ?");
  const update = db.query("UPDATE blocks SET page = ?, parent = ?, order_key = ?, rev = ?, updated_at = ? WHERE id = ?");

  for (const id of [...touched]) {
    const block = select.get(id) as Placement | null;
    if (!block) continue;
    let { page, parent, order_key } = block;

    if (parent !== null) {
      const parentRow = select.get(parent) as Placement | null;
      if (!parentRow || createsCycle(db, id, parent)) parent = null;
      else page = parentRow.page;
    }

    const clash = db
      .query("SELECT 1 FROM blocks WHERE page = ? AND parent IS ? AND order_key = ? AND id != ?")
      .get(page, parent, order_key, id);
    if (clash) {
      const next = db
        .query("SELECT min(order_key) AS key FROM blocks WHERE page = ? AND parent IS ? AND order_key > ?")
        .get(page, parent, order_key) as { key: string | null };
      order_key = keyBetween(order_key, next.key);
    }

    if (page !== block.page || parent !== block.parent || order_key !== block.order_key) {
      update.run(page, parent, order_key, rev, now, id);
      if (page !== block.page) emptied.add(block.page);
    }

    for (const row of db.query(DESCENDANTS_ELSEWHERE).all(id, page) as { id: string; page: string }[]) {
      db.query("UPDATE blocks SET page = ?, rev = ?, updated_at = ? WHERE id = ?").run(page, rev, now, row.id);
      emptied.add(row.page);
      touched.add(row.id);
    }
  }
}

/** Whether giving block `id` this parent would put it under itself. */
export function createsCycle(db: Database, id: string, parent: string): boolean {
  const parentOf = db.query("SELECT parent FROM blocks WHERE id = ?");
  const seen = new Set<string>();
  for (let current: string | null = parent; current !== null; ) {
    if (current === id || seen.has(current)) return true;
    seen.add(current);
    current = (parentOf.get(current) as { parent: string | null } | null)?.parent ?? null;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
}
