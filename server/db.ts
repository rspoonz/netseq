import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { backupNow } from "./backup";

// Each entry upgrades the schema by one version (tracked in PRAGMA user_version).
// Never edit an entry once it has been used on real data: append a new one instead.
// Before upgrading an existing database, a copy goes to backups/ (see migrate).
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE pages (
    key TEXT PRIMARY KEY,               -- normalised name, see shared/names.ts
    name TEXT NOT NULL,                 -- display casing
    journal_day INTEGER GENERATED ALWAYS AS (
      CASE WHEN key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
           THEN CAST(replace(key, '-', '') AS INTEGER) END
    ) STORED,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pages_journal_day ON pages(journal_day) WHERE journal_day IS NOT NULL;

  CREATE TABLE blocks (
    id TEXT PRIMARY KEY,                -- crypto.randomUUID() from the client
    page TEXT NOT NULL REFERENCES pages(key) ON UPDATE CASCADE,
    parent TEXT,                        -- NULL = top level (no FK: batches repair orphans)
    order_key TEXT NOT NULL,            -- fractional index, siblings sort by (order_key, id)
    content TEXT NOT NULL DEFAULT '',
    collapsed INTEGER NOT NULL DEFAULT 0,
    rev INTEGER NOT NULL,               -- global change counter at the block's last change
    writer TEXT,
    device TEXT,
    updated_at INTEGER NOT NULL,
    marker TEXT,                        -- this column and the ones below are derived from content
    priority TEXT,
    scheduled INTEGER,
    deadline INTEGER,
    search_text TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX blocks_tree ON blocks(page, parent, order_key);
  CREATE INDEX blocks_parent ON blocks(parent);
  CREATE INDEX blocks_marker ON blocks(marker) WHERE marker IS NOT NULL;
  CREATE INDEX blocks_scheduled ON blocks(scheduled) WHERE scheduled IS NOT NULL;
  CREATE INDEX blocks_deadline ON blocks(deadline) WHERE deadline IS NOT NULL;

  CREATE TABLE refs (
    block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    page TEXT NOT NULL REFERENCES pages(key) ON UPDATE CASCADE,
    PRIMARY KEY (block, page)
  );
  CREATE INDEX refs_page ON refs(page);

  CREATE TABLE block_refs (               -- ((target)) in a block's text
    block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target TEXT NOT NULL,                 -- no FK: the target may not exist (any more)
    PRIMARY KEY (block, target)
  );
  CREATE INDEX block_refs_target ON block_refs(target);

  CREATE TABLE props (
    block TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL
  );
  CREATE INDEX props_block ON props(block);
  CREATE INDEX props_key_value ON props(key, value);

  CREATE TABLE block_history (           -- text that another tab or device replaced
    block TEXT NOT NULL,
    content TEXT NOT NULL,
    device TEXT,
    saved_at INTEGER NOT NULL
  );
  CREATE INDEX block_history_block ON block_history(block, saved_at);

  -- The global change counter behind blocks.rev. It lives here rather than being
  -- max(rev), so numbers are never reused after the newest blocks are deleted.
  CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
  INSERT INTO meta (key, value) VALUES ('rev', 0);
  `,
  `
  CREATE TABLE favourites (              -- the pages kept at hand, in the owner's order
    page TEXT PRIMARY KEY REFERENCES pages(key) ON UPDATE CASCADE ON DELETE CASCADE,
    position INTEGER NOT NULL
  );
  `,
];

/** Opens (or creates) the database and brings its schema up to date. `migrations` is for tests. */
export function openDb(file: string, migrations: readonly string[] = MIGRATIONS): Database {
  const inMemory = file === ":memory:";
  if (!inMemory) mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  // Migrate with foreign keys still off (SQLite's default, and the setting can't change inside a
  // transaction): the usual way to change a table (copy it, drop it, rename the copy) would
  // otherwise cascade the DROP and delete every block's refs, props and block_refs.
  migrate(db, migrations, inMemory ? null : join(dirname(file), "backups"));
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function schemaVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function migrate(db: Database, migrations: readonly string[], backupDir: string | null): void {
  const from = schemaVersion(db);
  if (from >= migrations.length) return;
  // An existing database (not a brand-new one) is copied first, and that copy is never pruned.
  if (from > 0 && backupDir) backupNow(db, backupDir, `before-migration-v${from}-to-v${migrations.length}`);
  for (let version = from; version < migrations.length; version++) {
    db.transaction(() => {
      db.exec(migrations[version]);
      // With foreign keys off nothing checks them, so check before committing: a migration
      // that leaves references to missing rows is rolled back, and the server doesn't start.
      const broken = db.query("PRAGMA foreign_key_check").all();
      if (broken.length > 0) {
        throw new Error(`Migration ${version + 1} left ${broken.length} broken references, so it was rolled back`);
      }
      db.exec(`PRAGMA user_version = ${version + 1}`);
    })();
  }
}
