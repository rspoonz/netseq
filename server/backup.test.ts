import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBatch } from "./apply";
import { backupNow, dailyBackup, pruneBackups } from "./backup";
import { MIGRATIONS, openDb, schemaVersion } from "./db";
import { blockOp, writer } from "./testing";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "netseq-backup-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function blockCount(file: string): number {
  const db = new Database(file, { readonly: true });
  const { n } = db.query("SELECT count(*) AS n FROM blocks").get() as { n: number };
  db.close();
  return n;
}

test("a backup is a complete copy, named after the local date and time", () => {
  const dir = tempDir();
  const db = openDb(join(dir, "netseq.db"));
  applyBatch(db, { ...writer, ops: [blockOp("a", "P", null, "a0"), blockOp("b", "P", null, "a1")] });
  const file = backupNow(db, join(dir, "backups"), "netseq", new Date(2026, 10, 4, 9, 5, 7));
  expect(file).toBe(join(dir, "backups", "netseq-2026-11-04-090507.db"));
  expect(blockCount(file)).toBe(2);
  expect(readdirSync(join(dir, "backups"))).toEqual(["netseq-2026-11-04-090507.db"]); // no leftover .partial
  db.close();
});

test("a backup only touches its own process's half-written file, never another's from the same second", () => {
  const dir = tempDir();
  const db = openDb(join(dir, "netseq.db"));
  applyBatch(db, { ...writer, ops: [blockOp("a", "P", null, "a0")] });
  const backups = join(dir, "backups");
  mkdirSync(backups);
  // Another process's, and the name every process used to share.
  const others = [`netseq-2026-11-04-090507.db.${process.pid + 1}.partial`, "netseq-2026-11-04-090507.db.partial"];
  for (const name of others) writeFileSync(join(backups, name), "still being written");
  const file = backupNow(db, backups, "netseq", new Date(2026, 10, 4, 9, 5, 7));
  expect(blockCount(file)).toBe(1);
  expect(readdirSync(backups).sort()).toEqual(["netseq-2026-11-04-090507.db", ...others].sort());
  db.close();
});

test("the daily backup is made once a day", () => {
  const dir = tempDir();
  const db = openDb(join(dir, "netseq.db"));
  const backups = join(dir, "backups");
  expect(dailyBackup(db, backups, new Date(2026, 10, 4, 9, 0))).toBe(join(backups, "netseq-2026-11-04-090000.db"));
  expect(dailyBackup(db, backups, new Date(2026, 10, 4, 18, 0))).toBeNull();
  expect(dailyBackup(db, backups, new Date(2026, 10, 5, 0, 30))).toBe(join(backups, "netseq-2026-11-05-003000.db"));
  expect(readdirSync(backups).sort()).toEqual(["netseq-2026-11-04-090000.db", "netseq-2026-11-05-003000.db"]);
  db.close();
});

test("pruning keeps the 14 most recent days with backups, and never touches other files", () => {
  const dir = tempDir();
  const days = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
  for (const day of days) writeFileSync(join(dir, `netseq-${day}-120000.db`), "");
  writeFileSync(join(dir, "netseq-2026-10-20-180000.db"), ""); // a second backup on the newest day
  const others = ["before-migration-v1-to-v2-2026-01-01-120000.db", "netseq-2026-01-01-120000.db.partial", "notes.txt"];
  for (const name of others) writeFileSync(join(dir, name), "");
  mkdirSync(join(dir, "keep-me"));

  const removed = pruneBackups(dir);
  expect(removed.sort()).toEqual(days.slice(0, 6).map((day) => `netseq-${day}-120000.db`));
  const left = readdirSync(dir);
  expect(left.filter((name) => name.startsWith("netseq-2026-10-")).length).toBe(15); // 14 days, two on the 20th
  for (const name of [...others, "keep-me"]) expect(left).toContain(name);
});

test("an existing database is backed up before a migration, and a new one isn't", () => {
  const dir = tempDir();
  const file = join(dir, "netseq.db");
  const db = openDb(file);
  applyBatch(db, { ...writer, ops: [blockOp("a", "P", null, "a0")] });
  db.close();
  expect(readdirSync(dir)).not.toContain("backups"); // creating the database made no backup

  const upgraded = openDb(file, [...MIGRATIONS, "CREATE TABLE extra (x INTEGER)"]);
  expect(schemaVersion(upgraded)).toBe(MIGRATIONS.length + 1);
  upgraded.close();
  const [backup, ...more] = readdirSync(join(dir, "backups"));
  expect(more).toEqual([]);
  expect(backup).toMatch(/^before-migration-v1-to-v2-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
  const copy = new Database(join(dir, "backups", backup), { readonly: true });
  expect(schemaVersion(copy)).toBe(1); // taken before the upgrade
  copy.close();
  expect(blockCount(join(dir, "backups", backup))).toBe(1);

  // Daily pruning leaves it alone.
  expect(pruneBackups(join(dir, "backups"), 0)).toEqual([]);
});
