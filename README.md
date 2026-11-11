# NetSeq

A personal, Logseq-style outliner: blocks, pages, daily journals and `[[links]]`. The notes live in one SQLite file, served by a small Bun server, with a Vue frontend.

Status: ready for day-to-day use on your own machine. Blocks render as markdown. `[[Page]]`, `#tag` and `#[[multi word]]` link pages: typing `[[` or `#` suggests page names, `((` references a block, every page lists the blocks that link to it (and counts those that mention its name without linking, listed when you click the count), and renaming a page (click its title) rewrites those links. Links that open another site have a ↗ after them; every other link stays in NetSeq. Click a bullet to zoom into a block. Edits are saved as you type and show up live in other open tabs. If you overwrite text another tab or device wrote, you're told, and the earlier version can be restored. The server backs up the database every day, and your notes can be exported as markdown.

Keys while editing: Enter splits a block, Shift+Enter adds a line, Tab and Shift+Tab indent and outdent, Backspace at the start joins a block onto the one above, ↑/↓ move between blocks, Alt+Shift+↑/↓ move a block, Ctrl+↑/↓ collapse and expand, Ctrl+Enter cycles TODO → DOING → DONE → none, Ctrl+Z / Ctrl+Shift+Z undo and redo. Esc stops editing and selects the block: then Shift+↑/↓ extend the selection, Backspace deletes, Tab / Shift+Tab indent and outdent, Ctrl+C / Ctrl+X copy or cut as a markdown outline. Pasting a markdown outline creates blocks. Ctrl+K searches, from anywhere.

Typing `/` offers commands: task markers, Scheduled and Deadline (with a date picker), links to today, tomorrow, yesterday or any date, and Query.

## Favourites

The ☆ beside a page's title makes it a favourite. Favourites are listed in the sidebar (☰ shows and hides it; on a phone it opens over your notes), and Ctrl+K lists them before you type, so Ctrl+K then Enter opens the first. Drag a favourite to reorder the list, or press Alt+↑ / Alt+↓ on it. The list is stored with your notes, so it's the same on every device.

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
| `(anniversary today +60d)` | on journal days in earlier years whose month and day fall in the range: birthdays and the like. Same dates as `(between …)` |
| `(and …)` `(or …)` `(not …)` | combining the above; terms side by side mean "and" |

For example `{{query (and [[Project]] (task TODO DOING))}}`. Results show at most 500 blocks.

## AI agents

There are two ways in, with the same abilities and the same rules.

**MCP.** NetSeq is a Model Context Protocol server at `/mcp`, so an agent that speaks MCP gets your notes as tools with nothing to read first. For Claude Code:

```sh
claude mcp add --transport http netseq http://localhost:8080/mcp
```

**Plain HTTP.** `/agents` explains NetSeq and its API to any agent that can fetch a URL. Give it NetSeq's address (the page there points it to the guide), or `http://localhost:8080/agents` itself, and ask it to look something up or add to your notes. The guide is [server/agents.md](server/agents.md).

Either way, agents read pages as markdown outlines, search and run queries, add blocks, change a block's text, and move, indent or outdent blocks. They can read and set your favourites, which tells them what matters to you. An agent's edit keeps the text it replaced in the block's history.

Agents can delete a block (with everything under it), but are told to do so only when you expressly ask. NetSeq can't check that you asked: what it does is refuse a delete that doesn't quote the block as it is now, and hand the agent what it deleted so it can be put back. Over MCP, `delete_block` is marked as destructive, a hint a client can use to ask you before running it. The daily backup is the last resort.

## Run it

Requires [Bun](https://bun.sh) 1.3 or later.

```sh
bun install
bun run dev                        # API on :8080 plus Vite on http://localhost:5173, with hot reload
bun run build && bun run start     # the built app and the API on http://localhost:8080
```

Notes are stored in `data/netseq.db`. Set `NETSEQ_DATA` to use another folder, `PORT` to change the port, and `NETSEQ_HOSTS` to list host names other than localhost that the server should answer to (comma-separated), for example behind a proxy.

The server has no login and only listens on 127.0.0.1. Don't expose it to a network: anything that can reach it, under any name in `NETSEQ_HOSTS`, can read and change your notes.

## On your phone

NetSeq works in a phone's browser, and can be put on the home screen: in Safari, Share → Add to Home Screen (in Chrome on Android, Install app). It then opens as an app of its own, without the browser's bars. To go back, swipe from the left edge.

The phone has to reach the server, which only answers on the machine it runs on. A private network such as [Tailscale](https://tailscale.com) does that without opening NetSeq to anyone else: run `tailscale serve 8080` on that machine, and start NetSeq with `NETSEQ_HOSTS` set to the machine's Tailscale name (`NETSEQ_HOSTS=my-mac.my-tailnet.ts.net`). It still needs the connection: edits made while it's away are sent when it's back, but the app won't start without the server.

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
