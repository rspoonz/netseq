import type { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { journalName } from "../shared/names";

// Database snapshots in data/backups/. VACUUM INTO writes a complete, consistent copy even while
// the server is saving, which copying netseq.db can't promise (recent changes may still be in
// netseq.db-wal). See RUNBOOK.md for restoring one.

/** Daily and manual backups: netseq-2026-11-04-153012.db. Only files named like this are ever deleted. */
const BACKUP_FILE = /^netseq-(\d{4}-\d{2}-\d{2})-\d{6}\.db$/;
export const KEEP_DAYS = 14;

/** Writes a snapshot of the database to `dir` as `<prefix>-<local date>-<time>.db`, and returns its path. */
export function backupNow(db: Database, dir: string, prefix = "netseq", now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${prefix}-${stamp(now)}.db`);
  // Under a temporary name first, so a half-written file never looks like a backup. The pid keeps
  // it apart from another process's (the server and `bun run backup` in the same second).
  const partial = `${file}.${process.pid}.partial`;
  rmSync(partial, { force: true });
  db.query("VACUUM INTO ?").run(partial);
  renameSync(partial, file);
  return file;
}

/** Makes today's backup unless there is one already, then prunes. Returns the new file, if any. */
export function dailyBackup(db: Database, dir: string, now = new Date()): string | null {
  const today = journalName(now);
  const made = backupFiles(dir).some((f) => f.day === today) ? null : backupNow(db, dir, "netseq", now);
  pruneBackups(dir);
  return made;
}

/** Deletes backups from all but the `keepDays` most recent days that have one. Returns the deleted names. */
export function pruneBackups(dir: string, keepDays = KEEP_DAYS): string[] {
  const files = backupFiles(dir);
  const keep = new Set([...new Set(files.map((f) => f.day))].sort().reverse().slice(0, keepDays));
  const removed = files.filter((f) => !keep.has(f.day)).map((f) => f.name);
  for (const name of removed) rmSync(join(dir, name));
  return removed;
}

function backupFiles(dir: string): { name: string; day: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no backups yet
  }
  return names.flatMap((name) => {
    const match = BACKUP_FILE.exec(name);
    return match ? [{ name, day: match[1] }] : [];
  });
}

/** Local date and time, e.g. "2026-11-04-153012". */
function stamp(now: Date): string {
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");
  return `${journalName(now)}-${time}`;
}
