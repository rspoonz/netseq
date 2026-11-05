// `bun run export`: the notes as markdown in data/export/ (or $NETSEQ_DATA/export), in Logseq's
// layout. Safe while the server is running: it reads a snapshot taken with VACUUM INTO (deleted
// afterwards), so it never sees a half-saved change. Exits with 1 if it fails. See RUNBOOK.md.
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { exportMarkdown } from "../server/export";
import { dataDirFromEnv } from "../server/main";

const dataDir = dataDirFromEnv();
const file = join(dataDir, "netseq.db");
const snapshot = join(dataDir, "export-snapshot.tmp.db");
const out = join(dataDir, "export");
const started = performance.now();
const removeSnapshot = () => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(snapshot + suffix, { force: true });
};

try {
  removeSnapshot(); // left over from an export that was interrupted
  const live = new Database(file, { readonly: true });
  try {
    live.query("VACUUM INTO ?").run(snapshot);
  } finally {
    live.close();
  }
  const db = new Database(snapshot, { readonly: true });
  try {
    const { pages, blocks, skipped } = exportMarkdown(db, out);
    const ms = Math.round(performance.now() - started);
    console.log(`Exported ${pages} pages (${blocks} blocks) to ${out} in ${ms} ms`);
    for (const { page, reason } of skipped) console.warn(`Skipped "${page}": ${reason}`);
  } finally {
    db.close();
  }
} catch (e) {
  console.error(`Exporting ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  removeSnapshot();
}
