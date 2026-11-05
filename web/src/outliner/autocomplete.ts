import { formatRef } from "../../../shared/refs";

// Finding the reference being typed (a page name after [[ or #, or search words after (( for a
// block), and putting the chosen page or block in its place. Pure functions, unit-tested;
// Editor.vue wires them to the textarea.

export interface RefQuery {
  kind: "link" | "tag" | "block";
  start: number; // where the typed text starts (just after "[[", "#" or "((")
  end: number; // where it ends: the caret, or the closing "]]" or "))"
  query: string; // what has been typed so far
}

const BRACKETS = { link: ["[[", "]]"], block: ["((", "))"] } as const;

/** Inside [[…]] or ((…)) at the caret. A (( only counts at the start or after a space. */
function bracketQuery(text: string, caret: number, kind: "link" | "block"): RefQuery | null {
  const [open, close] = BRACKETS[kind];
  const at = caret >= 2 ? text.lastIndexOf(open, caret - 2) : -1;
  if (at === -1 || (kind === "block" && at > 0 && !/\s/.test(text[at - 1]))) return null;
  const typed = text.slice(at + 2, caret);
  if (typed.includes(close) || typed.includes("\n")) return null;
  const closeAt = text.indexOf(close, caret);
  const between = closeAt === -1 ? "" : text.slice(caret, closeAt);
  const end = closeAt !== -1 && !between.includes(open) && !between.includes("\n") ? closeAt : caret;
  return { kind, start: at + 2, end, query: typed };
}

/** The reference being typed at the caret, if any: inside [[…]] or ((…)), or straight after a #. */
export function refQueryAt(text: string, caret: number): RefQuery | null {
  const link = bracketQuery(text, caret, "link");
  const block = bracketQuery(text, caret, "block");
  if (link && block) return link.start > block.start ? link : block; // the one opened last
  if (link || block) return link ?? block;
  const tag = /(?:^|[\s(])#([^\s#[\]]*)$/.exec(text.slice(0, caret));
  if (tag) return { kind: "tag", start: caret - tag[1].length, end: caret, query: tag[1] };
  return null;
}

/** The text with `name` (a page name, or a block id) in place of the typed query, and where the caret goes. */
export function applyCompletion(text: string, q: RefQuery, name: string): { text: string; caret: number } {
  if (q.kind === "link" || q.kind === "block") {
    const close = BRACKETS[q.kind][1];
    const before = text.slice(0, q.start - 2);
    const rest = text.slice(q.end);
    const after = rest.startsWith(close) ? rest.slice(close.length) : rest;
    const ref = q.kind === "link" ? formatRef(name, "link") : `((${name}))`;
    return { text: before + ref + after, caret: before.length + ref.length };
  }
  const before = text.slice(0, q.start - 1);
  const after = text.slice(q.end);
  const ref = formatRef(name, "tag") + (/^\s/.test(after) ? "" : " ");
  return { text: before + ref + after, caret: before.length + ref.length };
}

/** Page names matching a query: exact match first, then names starting with it, then the shortest. */
export function matchPages(names: Iterable<string>, query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  const rank = (name: string) => {
    const n = name.toLowerCase();
    return n === q ? 0 : n.startsWith(q) ? 1 : 2;
  };
  return [...names]
    .filter((name) => name.toLowerCase().includes(q))
    .sort((a, b) => rank(a) - rank(b) || a.length - b.length || (a < b ? -1 : 1))
    .slice(0, limit);
}
