import { nextTick, reactive, ref, shallowRef } from "vue";
import { pageKey } from "../../shared/names";
import { renameRefs } from "../../shared/refs";
import type { BatchResult, Block, Op, PageData, PageSummary } from "../../shared/types";
import { getJSON } from "./api";
import * as outbox from "./outbox";
import { Outline } from "./outliner/outline";

// What the browser knows: the loaded blocks, the pages it has seen, and which block is being
// edited. Server data only ever overwrites a block when it's newer than our copy and we have
// no unsent changes to that block, so replies, events and reloads can arrive in any order.

export const outline = reactive(new Outline()) as Outline;
export const pages = reactive(new Map<string, PageSummary>());
const names = new Map<string, string>(); // display names, including pages not created yet
const loadedPages = new Set<string>(); // pages a view has loaded; live changes to other pages are skipped

/** Bumped when views should reload what they show (after missing live updates). */
export const refreshes = ref(0);

export function requestRefresh(): void {
  refreshes.value++;
}

/** Bumped whenever the server has applied a change (from this tab or elsewhere), for views showing search results. */
export const changes = ref(0);

/** Which block's editor is open, in which view. `seq` changes every time the caret is placed. */
export const editing = reactive({ view: null as string | null, id: null as string | null, offset: 0, seq: 0 });

let placingCaret = false;

export function startEditing(view: string | null, id: string, offset: number): void {
  editing.view = view;
  editing.id = id;
  editing.offset = offset;
  editing.seq++;
  // The next render may move the editor's element (or swap editors), which blurs the textarea.
  // Blurs until then come from that, not from the user leaving the editor.
  placingCaret = true;
  void nextTick(() => {
    placingCaret = false;
  });
}

export function isPlacingCaret(): boolean {
  return placingCaret;
}

export function stopEditing(): void {
  editing.view = null;
  editing.id = null;
}

export function rememberPageName(name: string): void {
  names.set(pageKey(name), name.trim());
}

export function pageName(key: string): string {
  return pages.get(key)?.name ?? names.get(key) ?? key;
}

function applyRows(rows: Block[], fromAnyPage = false): void {
  for (const row of rows) {
    const target = refTargets.get(row.id);
    if (target !== undefined && (target === null || row.rev >= target.rev)) refTargets.set(row.id, row);
    if (outbox.isPending(row.id)) continue;
    const local = outline.get(row.id);
    if (!local && !fromAnyPage && !loadedPages.has(row.page)) continue;
    if (!local || row.rev > local.rev) outline.upsert(row);
    else if (row.rev === local.rev && row.ref_count !== local.ref_count) setRefCount(row.id, row.ref_count ?? 0);
  }
}

// A block's ref_count changes when other blocks start or stop referencing it, without the block
// itself changing, so it's updated on its own.
function setRefCount(id: string, count: number): void {
  const block = outline.get(id);
  if (block && (block.ref_count ?? 0) !== count) outline.upsert({ ...block, ref_count: count });
}

/** The op that saves a block as it is now. */
export function saveOp(b: Block): Op {
  const { id, parent, order_key, content, collapsed } = b;
  return { t: "block", id, page: pageName(b.page), parent, order_key, content, collapsed, base: b.rev };
}

/** The latest rename seen (from this tab or elsewhere), so a view of the old page can follow it. */
export const lastRename = shallowRef<{ from: string; to: string } | null>(null);

// The server sends every block it changed in a rename, but blocks with unsent edits here skip
// server rows (see applyRows). Without this, their next save would put them back on the old page
// and its links back to the old name.
function followRename(from: string, to: string): void {
  const toKey = pageKey(to);
  rememberPageName(to);
  if (loadedPages.has(from)) loadedPages.add(toKey);
  for (const b of [...outline.blocks.values()]) {
    if (!outbox.isPending(b.id)) continue;
    const moved = { ...b, page: b.page === from ? toKey : b.page, content: renameRefs(b.content, from, to) };
    if (moved.page === b.page && moved.content === b.content) continue;
    outline.upsert(moved);
    outbox.queue(saveOp(moved));
  }
  lastRename.value = { from, to };
}

export function applyBatchResult(result: BatchResult): void {
  changes.value++;
  if (result.renamed) followRename(result.renamed.from, result.renamed.to);
  applyRows(result.rows);
  for (const id of result.deleted) {
    if (refTargets.has(id)) refTargets.set(id, null);
    if (!outbox.isPending(id)) outline.remove(id);
  }
  for (const [id, count] of Object.entries(result.refCounts)) setRefCount(id, count);
  for (const page of result.pages) pages.set(page.key, page);
  for (const key of result.removedPages) pages.delete(key);
}

// --- Blocks shown in ((references)) ---------------------------------------------------------

/** Referenced blocks that aren't loaded otherwise; null = doesn't exist. Kept up to date by live changes. */
const refTargets = reactive(new Map<string, Block | null>());
const wanted = new Set<string>();
const inFlight = new Set<string>();
let fetchScheduled = false;

/** A referenced block's text: undefined while it isn't known yet, null if the block doesn't exist. */
export function blockText(id: string): string | null | undefined {
  const local = outline.get(id);
  if (local) return local.content;
  const target = refTargets.get(id);
  return target === undefined ? undefined : (target?.content ?? null);
}

/** Fetches referenced blocks we don't have, a batch at a time. */
export function requestBlocks(ids: string[]): void {
  for (const id of ids) if (!outline.get(id) && !refTargets.has(id) && !inFlight.has(id)) wanted.add(id);
  if (fetchScheduled || wanted.size === 0) return;
  fetchScheduled = true;
  queueMicrotask(async () => {
    fetchScheduled = false;
    const ids = [...wanted];
    wanted.clear();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      for (const id of chunk) inFlight.add(id);
      try {
        const found = new Map((await getJSON<Block[]>(`/api/blocks?ids=${chunk.join(",")}`)).map((b) => [b.id, b]));
        for (const id of chunk) refTargets.set(id, found.get(id) ?? null);
      } catch {
        // shown as "…" until the next refresh asks again
      } finally {
        for (const id of chunk) inFlight.delete(id);
      }
    }
  });
}

/** After missed live updates: forget referenced blocks, so the ones on screen are fetched again. */
export function forgetRefTargets(): void {
  refTargets.clear();
}

/** Takes in blocks shown outside their own page (linked references, zooming in). */
export function applyTree(blocks: Block[]): void {
  applyRows(blocks, true);
}

/** Whether `pages` holds the full list yet. */
export const pagesLoaded = ref(false);

/** Loads all pages (for autocomplete and the Pages tab); live changes keep the list up to date. */
export async function loadPageList(): Promise<void> {
  const list = await getJSON<PageSummary[]>("/api/pages");
  const fresh = new Set(list.map((page) => page.key));
  for (const key of [...pages.keys()]) if (!fresh.has(key)) pages.delete(key);
  for (const page of list) pages.set(page.key, page);
  pagesLoaded.value = true;
}

/** Takes in a fresh copy of one page from the server. */
export function applyPageData(key: string, data: PageData): void {
  loadedPages.add(key);
  if (data.page) pages.set(key, data.page);
  else pages.delete(key);
  const fresh = new Set(data.blocks.map((b) => b.id));
  // Drop blocks the server no longer has, unless they changed after this copy was taken or
  // have unsent local edits.
  for (const b of [...outline.blocks.values()]) {
    if (b.page === key && !fresh.has(b.id) && b.rev <= data.rev && !outbox.isPending(b.id)) outline.remove(b.id);
  }
  applyRows(data.blocks);
  // Unsent edits from before a reload win over the server's copy: the outbox has their full state.
  for (const op of outbox.pendingOps()) {
    if (op.t === "block" && pageKey(op.page) === key && !outline.get(op.id)) outline.upsert(blockFromOp(op));
  }
}

function blockFromOp(op: Extract<Op, { t: "block" }>): Block {
  const { id, parent, order_key, content, collapsed } = op;
  return { id, page: pageKey(op.page), parent, order_key, content, collapsed, rev: 0 };
}
