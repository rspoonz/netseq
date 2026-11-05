// `bun run backup`: a snapshot of the database in data/backups/ (or $NETSEQ_DATA/backups), right
// now, under the same 14-day rule as the server's daily backups. Safe while the server is running.
// Exits with 1 if it fails. See RUNBOOK.md.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { backupNow, pruneBackups } from "../server/backup";
import { dataDirFromEnv } from "../server/main";

const dataDir = dataDirFromEnv();
const file = join(dataDir, "netseq.db");
const backups = join(dataDir, "backups");
try {
  const db = new Database(file, { readonly: true });
  try {
    console.log(`Backed up to ${backupNow(db, backups)}`);
  } finally {
    db.close();
  }
  pruneBackups(backups);
} catch (e) {
  console.error(`Backing up ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
