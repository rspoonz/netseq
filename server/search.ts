import type { Database } from "bun:sqlite";
import { OPEN_MARKERS, plainText } from "../shared/blocktext";
import { dayName, pageKey } from "../shared/names";
import type { PageSummary, RefGroup, SearchHit } from "../shared/types";
import { groupBlocks, idsOf } from "./read";

// Finding blocks by their text. Each search word must appear somewhere in a block's search_text
// (lower-cased plain text, see shared/blocktext.ts). A plain scan is fast enough for one
// person's notes; SQLite full-text search can come later if it isn't.

const MAX_WORDS = 8;

export function searchWords(query: string): string[] {
  const words = query.normalize("NFC").toLowerCase().split(/\s+/).filter(Boolean);
  return [...new Set(words)].slice(0, MAX_WORDS);
}

/** Blocks containing every word of the query, most recently changed first. */
export function search(db: Database, query: string, limit = 30): SearchHit[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const where = words.map(() => "instr(b.search_text, ?) > 0").join(" AND ");
  const rows = db
    .query(
      `SELECT b.id, b.content, p.key, p.name, p.journal_day FROM blocks b JOIN pages p ON p.key = b.page
       WHERE ${where} ORDER BY b.updated_at DESC, b.id LIMIT ?`,
    )
    .all(...words, limit) as ({ id: string; content: string } & PageSummary)[];
  return rows.map(({ id, content, key, name, journal_day }) => ({
    id,
    page: { key, name, journal_day },
    ...snippet(plainText(content), words),
  }));
}

/**
 * About `width` characters of `text` around the first match, on one line, with where each word
 * appears in it. Matching ignores case, so it works on a lower-cased copy with an index back
 * into the original.
 */
export function snippet(text: string, words: string[], width = 160): { text: string; ranges: [number, number][] } {
  let lower = "";
  const original: number[] = []; // original[i] = where lower[i] came from in `text`
  for (let i = 0; i < text.length; ) {
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const folded = char.toLowerCase(); // can be longer than char ("İ" → "i̇")
    for (let k = 0; k < folded.length; k++) original.push(i);
    lower += folded;
    i += char.length;
  }
  original.push(text.length);

  const hits: [number, number][] = [];
  for (const word of words) {
    for (let i = lower.indexOf(word); i !== -1; i = lower.indexOf(word, i + word.length)) {
      hits.push([original[i], original[i + word.length]]);
    }
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  // Don't split a surrogate pair (an emoji, say) at either end.
  const lowSurrogate = (i: number) => /[\uDC00-\uDFFF]/.test(text[i] ?? "");
  let start = Math.max(0, (hits[0]?.[0] ?? 0) - 40);
  if (lowSurrogate(start)) start++;
  let end = Math.min(text.length, start + width);
  if (lowSurrogate(end)) end--;
  const prefix = start > 0 ? "…" : "";
  const ranges: [number, number][] = [];
  for (const [from, to] of hits) {
    if (from < start || to > end) continue;
    const range: [number, number] = [from - start + prefix.length, to - start + prefix.length];
    const last = ranges.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else ranges.push(range);
  }
  const shown = text.slice(start, end).replace(/[\n\t]/g, " ");
  return { text: prefix + shown + (end < text.length ? "…" : ""), ranges };
}

/**
 * Blocks that mention a page's name as plain text without linking to it: the name as a whole
 * word, on other pages. At most 200, the most recently changed.
 */
export function getUnlinkedRefs(db: Database, name: string): RefGroup[] {
  const key = pageKey(name);
  // SQL finds the name anywhere ("art" in "start"); the whole-word check comes after, and the
  // limit only after that, so short names don't lose real mentions.
  const rows = db
    .query(
      `SELECT id, search_text FROM blocks
       WHERE instr(search_text, ?1) > 0 AND page != ?1 AND id NOT IN (SELECT block FROM refs WHERE page = ?1)
       ORDER BY updated_at DESC`,
    )
    .all(key) as { id: string; search_text: string }[];
  const word = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(key)}(?![\\p{L}\\p{N}_])`, "u");
  return groupBlocks(db, idsOf(rows.filter((row) => word.test(row.search_text)).slice(0, 200)));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Today's agenda: unfinished tasks scheduled or due today or earlier. Tasks written on today's
 * journal are left out, since they're on screen right above it.
 */
export function getAgenda(db: Database, today: number): RefGroup[] {
  const rows = db
    .query(
      `SELECT id FROM blocks
       WHERE marker IN (SELECT value FROM json_each(?1)) AND (scheduled <= ?2 OR deadline <= ?2) AND page != ?3
       LIMIT 500`,
    )
    .all(JSON.stringify(OPEN_MARKERS), today, dayName(today));
  return groupBlocks(db, idsOf(rows));
}
