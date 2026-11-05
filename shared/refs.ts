import { pageKey } from "./names";

// References in block text: [[Page]], #tag and #[[multi word tag]] to pages, ((block id)) to
// blocks, plus macros such as {{query …}}. The matchers below are the one definition of that
// syntax: the markdown renderer (shared/markdown.ts) and the server's indexing and renaming (via
// scan) both use them. Macros are opaque: a [[link]] inside {{query [[x]]}} is part of the query,
// not a reference.

export interface RefMatch {
  name: string;
  kind: "link" | "tag";
  end: number; // index just after the reference
}

export interface RefSpan extends RefMatch {
  start: number;
}

/** `[[name]]` at `pos`. */
export function matchPageRef(src: string, pos: number): RefMatch | null {
  if (!src.startsWith("[[", pos)) return null;
  const close = src.indexOf("]]", pos + 2);
  if (close === -1) return null;
  const inner = src.slice(pos + 2, close);
  if (inner.includes("[[") || inner.includes("\n")) return null; // no nested page names
  const name = inner.trim();
  return name ? { name, kind: "link", end: close + 2 } : null;
}

const TAG_WORD = /[^\s#]+/y;
const TAG_TRAILING = /[,.;:!?)"']+$/; // "see #todo." tags "todo"

/** `#tag` or `#[[multi word tag]]` at `pos`. A tag needs the start of a line, whitespace or "(" before it. */
export function matchTag(src: string, pos: number): RefMatch | null {
  if (src[pos] !== "#") return null;
  if (pos > 0 && !/[\s(]/.test(src[pos - 1])) return null; // not "a#b", nor "/#anchor" in a URL
  if (src.startsWith("[[", pos + 1)) {
    const ref = matchPageRef(src, pos + 1);
    return ref && { ...ref, kind: "tag" };
  }
  TAG_WORD.lastIndex = pos + 1;
  const name = (TAG_WORD.exec(src)?.[0] ?? "").replace(TAG_TRAILING, "");
  return name ? { name, kind: "tag", end: pos + 1 + name.length } : null; // "# heading" has no word
}

export interface BlockRefMatch {
  id: string; // lower-case
  end: number;
}

export interface BlockRefSpan extends BlockRefMatch {
  start: number;
}

const BLOCK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `((block id))` at `pos`. Only block ids (UUIDs) count, so "((sic))" stays text. */
export function matchBlockRef(src: string, pos: number): BlockRefMatch | null {
  if (!src.startsWith("((", pos)) return null;
  const close = src.indexOf("))", pos + 2);
  if (close === -1) return null;
  const id = src.slice(pos + 2, close).trim();
  return BLOCK_ID.test(id) ? { id: id.toLowerCase(), end: close + 2 } : null;
}

export interface MacroMatch {
  name: string; // lower-cased, e.g. "query"
  args: string; // everything after the name, trimmed
  end: number;
}

export interface MacroSpan extends MacroMatch {
  start: number;
}

/** `{{name args}}` at `pos`, on one line. */
export function matchMacro(src: string, pos: number): MacroMatch | null {
  if (!src.startsWith("{{", pos)) return null;
  const close = src.indexOf("}}", pos + 2);
  if (close === -1) return null;
  const inner = src.slice(pos + 2, close);
  if (inner.includes("\n") || inner.includes("{{")) return null;
  const match = /^\s*([A-Za-z][\w-]*)(?:\s+(.*?))?\s*$/.exec(inner);
  return match ? { name: match[1].toLowerCase(), args: match[2] ?? "", end: close + 2 } : null;
}

export interface ContentLine {
  text: string;
  offset: number; // where the line starts in the block's text
  code: boolean; // inside a fenced code block, or one of its fences
}

/** A block's lines, marking the ones that belong to fenced code. */
export function contentLines(content: string): ContentLine[] {
  const lines: ContentLine[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const text of content.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(text)?.[1];
    const code = fence !== null || marker !== undefined;
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) {
      fence = marker;
    }
    lines.push({ text, offset, code });
    offset += text.length + 1;
  }
  return lines;
}

export interface Scanned {
  refs: RefSpan[];
  blockRefs: BlockRefSpan[];
  macros: MacroSpan[];
}

/** Every reference and macro in a block's text, skipping code (fenced blocks and `inline code`) and escapes. */
export function scan(content: string): Scanned {
  const refs: RefSpan[] = [];
  const blockRefs: BlockRefSpan[] = [];
  const macros: MacroSpan[] = [];
  for (const { text: line, offset, code } of contentLines(content)) {
    if (code) continue;
    for (let i = 0; i < line.length; ) {
      if (line[i] === "\\") {
        i += 2;
      } else if (line[i] === "`") {
        const ticks = /`+/y;
        ticks.lastIndex = i;
        const run = ticks.exec(line)![0];
        const close = line.indexOf(run, i + run.length);
        i = close === -1 ? i + run.length : close + run.length;
      } else {
        const macro = matchMacro(line, i);
        const blockRef = macro ? null : matchBlockRef(line, i);
        const match = macro || blockRef ? null : (matchPageRef(line, i) ?? matchTag(line, i));
        if (macro) macros.push({ ...macro, start: offset + i, end: offset + macro.end });
        else if (blockRef) blockRefs.push({ ...blockRef, start: offset + i, end: offset + blockRef.end });
        else if (match) refs.push({ ...match, start: offset + i, end: offset + match.end });
        i = macro?.end ?? blockRef?.end ?? match?.end ?? i + 1;
      }
    }
  }
  return { refs, blockRefs, macros };
}

/** Every page reference in a block's text. */
export function scanRefs(content: string): RefSpan[] {
  return scan(content).refs;
}

/** The blocks a block's text refers to with ((id)), once each, in order of first mention. */
export function blockRefsIn(content: string): string[] {
  return [...new Set(scan(content).blockRefs.map((ref) => ref.id))];
}

/** The queries in a block's text: the arguments of each {{query …}}. */
export function queriesIn(content: string): string[] {
  return scan(content)
    .macros.filter((macro) => macro.name === "query" && macro.args !== "")
    .map((macro) => macro.args);
}

/** The pages a block refers to, once each (by page key), in order of first mention. */
export function extractRefs(content: string): string[] {
  const names = new Map<string, string>();
  for (const { name } of scanRefs(content)) if (!names.has(pageKey(name))) names.set(pageKey(name), name);
  return [...names.values()];
}

/**
 * Rewrites references to page `from` so they point to `to`, leaving everything else alone. That
 * includes [[from]] and #from inside {{query …}}, but not a quoted "from" there (that's text).
 */
export function renameRefs(content: string, from: string, to: string): string {
  const fromKey = pageKey(from);
  const { refs, macros } = scan(content);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const span of refs) {
    if (pageKey(span.name) === fromKey) edits.push({ ...span, text: formatRef(to, span.kind, content.startsWith("#[[", span.start)) });
  }
  for (const macro of macros) {
    if (macro.name !== "query") continue;
    const inner = content.slice(macro.start + 2, macro.end - 2);
    const renamed = renameInQuery(inner, fromKey, to);
    if (renamed !== inner) edits.push({ ...macro, text: `{{${renamed}}}` });
  }
  let result = "";
  let last = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    result += content.slice(last, edit.start) + edit.text;
    last = edit.end;
  }
  return result + content.slice(last);
}

function renameInQuery(query: string, fromKey: string, to: string): string {
  let result = "";
  let last = 0;
  for (let i = 0; i < query.length; ) {
    if (query[i] === '"') {
      const close = query.indexOf('"', i + 1);
      i = close === -1 ? query.length : close + 1;
      continue;
    }
    const ref = matchPageRef(query, i) ?? matchTag(query, i);
    if (!ref) {
      i++;
      continue;
    }
    if (pageKey(ref.name) === fromKey) {
      result += query.slice(last, i) + formatRef(to, ref.kind, query.startsWith("#[[", i));
      last = ref.end;
    }
    i = ref.end;
  }
  return result + query.slice(last);
}

/** Why a name can't be a page name, or null if it can: it has to survive being written as [[name]]. */
export function pageNameProblem(name: string): string | null {
  if (!name.trim()) return "A page needs a name.";
  const link = formatRef(name.trim(), "link");
  const read = matchPageRef(link, 0);
  if (read?.end !== link.length || read.name !== name.trim()) return "Page names can't contain [[, ]], line breaks or end with ].";
  return null;
}

/** How to write a reference to `name`. Tags with spaces or punctuation need the bracket form. */
export function formatRef(name: string, kind: "link" | "tag", brackets = false): string {
  if (kind === "link") return `[[${name}]]`;
  return !brackets && /^[^\s#,.;:!?()"'[\]]+$/.test(name) ? `#${name}` : `#[[${name}]]`;
}
