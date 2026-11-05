import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBatch } from "./apply";
import { MIGRATIONS, openDb, schemaVersion } from "./db";
import { blockOp, writer } from "./testing";

const tempDirs: string[] = [];

function tempDbFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "netseq-db-"));
  tempDirs.push(dir);
  return join(dir, "netseq.db");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a new database is migrated to the latest schema", () => {
  const db = openDb(tempDbFile());
  expect(schemaVersion(db)).toBe(1);
  db.close();
});

test("journal_day is derived from ISO page keys only", () => {
  const db = openDb(":memory:");
  const insert = db.query("INSERT INTO pages (key, name, created_at) VALUES (?, ?, 0)");
  insert.run("2026-11-02", "2026-11-02");
  insert.run("project x", "Project X");
  expect(db.query("SELECT key, journal_day FROM pages ORDER BY key").all()).toEqual([
    { key: "2026-11-02", journal_day: 20261102 },
    { key: "project x", journal_day: null },
  ]);
  db.close();
});

test("renaming a page key cascades to its blocks and refs", () => {
  const db = openDb(":memory:");
  db.run("INSERT INTO pages (key, name, created_at) VALUES ('old', 'Old', 0), ('other', 'Other', 0)");
  db.run(
    "INSERT INTO blocks (id, page, order_key, rev, updated_at) VALUES ('b1', 'old', 'a0', 1, 0), ('b2', 'other', 'a0', 2, 0)",
  );
  db.run("INSERT INTO refs (block, page) VALUES ('b2', 'old')");

  db.run("UPDATE pages SET key = 'new', name = 'New' WHERE key = 'old'");

  expect(db.query("SELECT page FROM blocks WHERE id = 'b1'").get()).toEqual({ page: "new" });
  expect(db.query("SELECT page FROM refs WHERE block = 'b2'").get()).toEqual({ page: "new" });
  db.close();
});

test("data survives closing and reopening the database", () => {
  const file = tempDbFile();
  const first = openDb(file);
  first.run("INSERT INTO pages (key, name, created_at) VALUES ('kept', 'Kept', 0)");
  first.close();

  const second = openDb(file);
  expect(second.query("SELECT name FROM pages").all()).toEqual([{ name: "Kept" }]);
  expect(schemaVersion(second)).toBe(1);
  second.close();
});

/** Saves a block with a [[link]] and a property in a database at schema version 1. */
function withLinkedBlock(file: string): void {
  const db = openDb(file, [MIGRATIONS[0]]);
  applyBatch(db, { ...writer, ops: [blockOp("a", "Notes", null, "a0", { content: "see [[Project]]\nstatus:: draft" })] });
  db.close();
}

function counts(db: Database): unknown {
  return db.query("SELECT (SELECT count(*) FROM blocks) AS blocks, (SELECT count(*) FROM refs) AS refs, (SELECT count(*) FROM props) AS props").get();
}

test("a migration that rebuilds a table keeps its blocks' links and properties", () => {
  const file = tempDbFile();
  withLinkedBlock(file);
  // The usual way to change a table: create the new one, copy, drop the old, rename.
  const rebuildBlocks = `
    CREATE TABLE blocks_new (id TEXT PRIMARY KEY, page TEXT NOT NULL, content TEXT NOT NULL);
    INSERT INTO blocks_new SELECT id, page, content FROM blocks;
    DROP TABLE blocks;
    ALTER TABLE blocks_new RENAME TO blocks;`;
  const db = openDb(file, [MIGRATIONS[0], rebuildBlocks]);
  expect(schemaVersion(db)).toBe(2);
  expect(counts(db)).toEqual({ blocks: 1, refs: 1, props: 1 });
  expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 }); // on again once migrated
  db.close();
});

test("a migration that leaves broken references is rolled back, and the database doesn't open", () => {
  const file = tempDbFile();
  withLinkedBlock(file);
  expect(() => openDb(file, [MIGRATIONS[0], "DELETE FROM blocks"])).toThrow("Migration 2 left 2 broken references");
  const db = openDb(file, [MIGRATIONS[0]]);
  expect(schemaVersion(db)).toBe(1);
  expect(counts(db)).toEqual({ blocks: 1, refs: 1, props: 1 });
  db.close();
});
