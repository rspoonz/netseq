import { dayNumber, journalName } from "../../shared/names";
import type { BatchResult, BlockTree, PageData, QueryResult, RecentPage, RefGroup, SearchHit } from "../../shared/types";
import { drain } from "./outbox";

// Small helpers for talking to the NetSeq server. Block edits go through the outbox instead.

export async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function fetchPage(name: string): Promise<PageData> {
  return getJSON(`/api/page?name=${encodeURIComponent(name)}`);
}

/** The `limit` named pages changed most recently, newest first. */
export function fetchRecentPages(limit: number): Promise<RecentPage[]> {
  return getJSON(`/api/pages/recent?limit=${limit}`);
}

/** Journal pages for days before `before` (yyyymmdd), newest first. */
export function fetchJournals(before: number, limit: number): Promise<PageData[]> {
  return getJSON(`/api/journals?before=${before}&limit=${limit}`);
}

/** These journal days (ISO names), in this order; days with nothing written come back empty. */
export async function fetchJournalDays(names: string[]): Promise<PageData[]> {
  const days: PageData[] = [];
  for (let i = 0; i < names.length; i += 500) {
    days.push(...(await getJSON<PageData[]>(`/api/journals?days=${names.slice(i, i + 500).join(",")}`)));
  }
  return days;
}

/** Blocks on other pages that reference this one. */
export function fetchRefs(name: string): Promise<RefGroup[]> {
  return getJSON(`/api/refs?name=${encodeURIComponent(name)}`);
}

/** Blocks that reference a block with ((id)). */
export function fetchBlockRefs(id: string): Promise<RefGroup[]> {
  return getJSON(`/api/blocks/${encodeURIComponent(id)}/refs`);
}

/** Blocks on other pages that mention this page's name without linking to it. */
export function fetchUnlinked(name: string): Promise<RefGroup[]> {
  return getJSON(`/api/unlinked?name=${encodeURIComponent(name)}`);
}

/** Today as the server wants it (yyyymmdd): the server's clock may be in another time zone. */
function today(): number {
  return dayNumber(journalName(new Date()));
}

/** Unfinished tasks scheduled or due today or earlier. */
export function fetchAgenda(): Promise<RefGroup[]> {
  return getJSON(`/api/agenda?today=${today()}`);
}

export function fetchSearch(query: string): Promise<SearchHit[]> {
  return getJSON(`/api/search?q=${encodeURIComponent(query)}`);
}

/** A {{query …}}'s results, or what's wrong with the query. */
export async function fetchQuery(query: string, block: string): Promise<QueryResult | { error: string }> {
  const params = new URLSearchParams({ q: query, block, today: String(today()) });
  const res = await fetch(`/api/query?${params}`, { headers: { Accept: "application/json" } });
  if (res.status === 400) return (await res.json()) as { error: string };
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as QueryResult;
}

/** A block with everything under it, or null if it doesn't exist. */
export async function fetchBlockTree(id: string): Promise<BlockTree | null> {
  const res = await fetch(`/api/blocks/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as BlockTree;
}

export type RenameOutcome = { ok: true; result: BatchResult } | { ok: false; error: string };

/** Renames a page, after sending any unsaved edits (they may mention it). */
export async function renamePage(from: string, to: string): Promise<RenameOutcome> {
  if (!(await drain())) return { ok: false, error: "Can't rename while offline." };
  const res = await fetch("/api/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to }),
  });
  if (res.ok) return { ok: true, result: (await res.json()) as BatchResult };
  if (res.status === 409) return { ok: false, error: `A page called "${to}" already exists.` };
  if (res.status === 400) return { ok: false, error: ((await res.json()) as { error: string }).error };
  return { ok: false, error: "Couldn't rename the page." };
}
