# NetSeq

A personal, Logseq-style outliner: blocks, pages, daily journals and `[[links]]`. The notes live in one SQLite file, served by a small Bun server, with a Vue frontend.

Status: ready for day-to-day use on your own machine. Blocks render as markdown. `[[Page]]`, `#tag` and `#[[multi word]]` link pages: typing `[[` or `#` suggests page names, `((` references a block, every page lists the blocks that link to it (and counts those that mention its name without linking, listed when you click the count), and renaming a page (click its title) rewrites those links. Links that open another site have a ↗ after them; every other link stays in NetSeq. Click a bullet to zoom into a block. Edits are saved as you type and show up live in other open tabs. If you overwrite text another tab or device wrote, you're told, and the earlier version can be restored. The server backs up the database every day, and your notes can be exported as markdown.

Keys while editing: Enter splits a block, Shift+Enter adds a line, Tab and Shift+Tab indent and outdent, Backspace at the start joins a block onto the one above, ↑/↓ move between blocks, Alt+Shift+↑/↓ move a block, Ctrl+↑/↓ collapse and expand, Ctrl+Enter cycles TODO → DOING → DONE → none, Ctrl+Z / Ctrl+Shift+Z undo and redo. Esc stops editing and selects the block: then Shift+↑/↓ extend the selection, Backspace deletes, Tab / Shift+Tab indent and outdent, Ctrl+C / Ctrl+X copy or cut as a markdown outline. Pasting a markdown outline creates blocks. Ctrl+K searches, from anywhere.

Typing `/` offers commands: task markers, Scheduled and Deadline (with a date picker), links to today, tomorrow, yesterday or any date, and Query.

## Block references

Typing `((` and a few words searches blocks; picking one inserts a reference such as `((6f1c2a7e-…))`, which shows that block's first line, stays up to date when it changes, and zooms into it when clicked. Right-clicking a bullet offers "Copy block ref", to paste into any block. A block that's referenced shows how many blocks reference it; click the number to list them. A reference to a deleted block shows "missing block".

## Tasks

Logseq's syntax: a block starting with `TODO`, `DOING`, `DONE`, `LATER`, `NOW`, `WAITING` or `CANCELED` is a task, with a checkbox. `[#A]`, `[#B]` and `[#C]` set a priority. Dates go on their own lines, `SCHEDULED: <2026-11-02 Mon>` and `DEADLINE: <2026-11-06 Fri>`, and properties too, `status:: draft`. Today's journal lists unfinished tasks scheduled or due today or earlier.

## Queries

A block containing `{{query …}}` shows the matching blocks below it, editable in place:

| Query | Finds blocks |
|---|---|
| `[[page]]` or `#tag` | that reference the page, under one that does, or on the page |
| `"some text"` or `word` | containing the text (ignoring case) |
| `(task TODO DOING)` | with one of these markers |
| `(priority A B)` | with one of these priorities |
| `(property status draft)` | with the property (and value) |
| `(page "name")` | on the page |
| `(between -7d today)` | on journal days in the range: `today`, `yesterday`, `tomorrow`, `-7d`, `+2w`, `-1m`, `-1y`, `2026-11-02` |
| `(and …)` `(or …)` `(not …)` | combining the above; terms side by side mean "and" |

For example `{{query (and [[Project]] (task TODO DOING))}}`. Results show at most 500 blocks.

## Run it

Requires [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bun run dev                        # API on :8080 plus Vite on http://localhost:5173, with hot reload
bun run build && bun run start     # the built app and the API on http://localhost:8080
```

Notes are stored in `data/netseq.db`. Set `NETSEQ_DATA` to use another folder, `PORT` to change the port, and `NETSEQ_HOSTS` to list host names other than localhost that the server should answer to (comma-separated), for example behind a proxy.

The server has no login and only listens on 127.0.0.1. Don't expose it to a network: anything that can reach it, under any name in `NETSEQ_HOSTS`, can read and change your notes.

## Backups and export

```sh
bun run backup     # a database snapshot in data/backups/ (the server also makes one every day; 14 days kept)
bun run export     # all pages as markdown in data/export/, in Logseq's layout
```

Both are safe while the server is running. [RUNBOOK.md](RUNBOOK.md) covers restoring a backup and the export format.

## Check it

```sh
bunx playwright install chromium   # once, for the browser tests
bun run check                      # type checks, unit tests, then browser tests against a built app
bun run bench                      # speed on a generated 100k-block graph (about a minute; results in RUNBOOK.md)
```

## Licence

MIT, see [LICENSE](LICENSE).
