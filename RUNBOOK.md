# NetSeq runbook

How your notes are stored, backed up, exported and restored. Commands run from the project folder.

## Where the notes are

- `data/netseq.db` (or `$NETSEQ_DATA/netseq.db`), with `netseq.db-wal` and `netseq.db-shm` next to it. Recent changes can sit in the `-wal` file for a while, so **never copy `netseq.db` on its own while the server is running**. Use a backup instead.
- `data/backups/`: backups (below).
- `data/export/`: the latest markdown export, if you've made one.

## Backups

| What | When | Kept |
|---|---|---|
| Daily backup | The running server makes one per day: when it starts, or at its next hourly check | Backups from the 14 most recent days that have one |
| Before-migration backup | Just before an update changes the database structure | Never deleted automatically |
| `bun run backup` | Whenever you run it | Same 14-day rule as the daily ones |

- Each backup is a complete database file, `netseq-2026-11-04-153012.db` (local date and time), made with SQLite's `VACUUM INTO`. That gives a consistent copy even while the server is saving.
- `bun run backup` is safe while the server runs. It prints the file it wrote, and exits with code 1 if it fails.
- To check a backup, run `sqlite3 data/backups/netseq-2026-11-04-153012.db "PRAGMA integrity_check"`. It should print `ok`.
- Backups sit on the same disk as your notes. They protect against mistakes (a deleted page, a bad edit, a bug), not against losing the disk.
- Only files named exactly `netseq-<date>-<time>.db` are ever deleted. Anything else in `data/backups/` is left alone.

## Restoring a backup

1. **Close every NetSeq tab, on every device.** Open tabs keep unsaved edits and newer copies of blocks. When they reconnect, they would write those back over the restored notes.
2. **Stop the server.** Press Ctrl+C in the terminal running `bun run dev` or `bun run start`. To confirm it has stopped, run `curl -s localhost:8080/api/healthz`: it should print nothing.
3. **Put the current files aside.** Don't delete them yet.

   ```sh
   cd data
   R=replaced-$(date +%F-%H%M); mkdir "$R" && mv netseq.db* "$R"/
   ```

4. **Copy the backup in.** For example, `cp backups/netseq-2026-11-04-153012.db netseq.db`.
5. **Start the server again.** `curl -s localhost:8080/api/healthz` should print `{"ok":true,"schema":1}`. Then open NetSeq and check your notes.
6. **Clean up.** Once you're happy, delete the `replaced-…` folder.

If you restore a before-migration backup with newer code, the server upgrades it again when it starts, after first backing it up. To use it with its old schema, also check out the code from before the update.

### Restore drill (do this once)

1. `bun run backup`
2. Add a block "restore drill" to today's journal and wait until the top bar says "Saved".
3. Restore the backup from step 1, following the steps above.
4. The block is gone. Delete the `replaced-…` folder.

## Markdown export

- **What it writes:** `bun run export` writes every page that has blocks to `data/export/`, in Logseq's layout: `journals/2026_11_04.md` and `pages/<name>.md`, plus your favourites in `logseq/config.edn`. It prints how many pages and blocks it wrote.
- **What it replaces:** each export replaces the previous one completely, so pages deleted since then disappear.
- **Safe while the server runs.** It reads a consistent snapshot, which it deletes afterwards.
- **One at a time.** Two exports at once can leave `data/export/` incomplete. Running it again fixes it.
- **Block format:**
  - `- ` bullets, one tab per level;
  - a block's extra lines are indented two spaces;
  - `collapsed:: true` marks folded blocks;
  - `id:: <uuid>` marks blocks that other blocks reference with `((…))`.
- **File names:**
  - `/` in a page name becomes `___`;
  - characters file names can't hold (`<>:"\|?*`), and `%` itself, are written as `%XX`;
  - if two pages end up with the same file name, the second is skipped and reported;
  - a page whose name is too long for a file name (over about 250 characters) is skipped and reported.
- **Logseq:** opening the export in Logseq should work, but hasn't been tested.
- **Backup and export together:** `bun run backup && bun run export`.

## Speed

`bun run bench` generates a repeatable 100,000-block graph in a temporary folder (never your notes). It times the main operations against a budget, then opens the app on that graph in Chromium. It takes about a minute.

Measured on 2026-11-04, on this laptop:

| Server | Time | Budget |
|---|---|---|
| Save one block (a keystroke, including the disk sync) | 2.6 ms | 100 ms |
| Paste 100 blocks | 11.7 ms | 100 ms |
| Open a 100-block page / a 2,000-block page | 0.3 / 2.9 ms | 100 ms |
| Journals, 5 days | 0.5 ms | 100 ms |
| Search, two words / no hits | 42.9 / 20.7 ms | 100 ms |
| Linked references of the most linked page | 13.8 ms | 100 ms |
| Unlinked references of a word in most blocks | 92.4 ms | 100 ms |
| Query `(task TODO DOING)`, 500 shown | 63.3 ms | 100 ms |
| Query `(and [[Page 1]] (task TODO))` | 13.4 ms | 100 ms |
| Agenda | 57.1 ms | 100 ms |
| Recently changed pages (Pages tab) | 32.9 ms | 100 ms |
| Rename the most linked page (and back) | 58.7 ms | 100 ms |
| Backup (the server waits for it, once a day) | 113.5 ms | 1,000 ms |
| Export (runs in its own process) | 624.2 ms | — |

| Browser (Chromium) | Time | Budget |
|---|---|---|
| Open the 2,000-block page | 394 ms | 1,000 ms |
| Open a 100-block page | 119 ms | 1,000 ms |
| Open the journals | 326 ms | 1,000 ms |
| A keystroke on the 2,000-block page, median / slowest | 4.5 / 9.8 ms | 50 / 100 ms |

Everything is within budget. Closest to its limit: unlinked references for a page named after a very common word. That search runs over every block's text, and SQLite's full-text search would be the fix if it ever gets slow.
