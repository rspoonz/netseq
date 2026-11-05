import { contentLines, scan } from "./refs";

// What a block's text says beyond its markdown, in Logseq's syntax:
//
//   TODO [#A] write the report        a task marker at the very start, a priority anywhere on the first line
//   SCHEDULED: <2026-11-02 Mon>       dates on lines of their own
//   DEADLINE: <2026-11-06 Fri>
//   status:: draft                    properties, one per line
//
// The server stores what this finds (blocks.marker, props, …) for search, queries and the agenda;
// the renderer uses it to show checkboxes, dates and properties. Nothing inside fenced code counts.

export const MARKERS = ["TODO", "DOING", "DONE", "LATER", "NOW", "WAITING", "CANCELED"] as const;
export type Marker = (typeof MARKERS)[number];

/** Markers of tasks that still need doing. */
export const OPEN_MARKERS: readonly Marker[] = ["TODO", "DOING", "LATER", "NOW", "WAITING"];

export type Priority = "A" | "B" | "C";
export type DateKind = "SCHEDULED" | "DEADLINE";

const MARKER_PREFIX = /^(TODO|DOING|DONE|LATER|NOW|WAITING|CANCELED)(?=\s|$) ?/;
export const PRIORITY = /\[#([ABC])\]/;
const DATE_LINE = /^\s*(SCHEDULED|DEADLINE): <(\d{4})-(\d{2})-(\d{2})(?:[ \t][^>]*)?>\s*$/;
const PROPERTY_LINE = /^\s*([A-Za-z0-9][\w-]*)::(?:\s+(.*))?$/;

export interface BlockInfo {
  marker: Marker | null;
  priority: Priority | null;
  scheduled: number | null; // yyyymmdd
  deadline: number | null;
  props: [string, string][]; // lower-cased key, value as written
  body: string; // the rest, shown as markdown: no marker, date lines or property lines
}

export function parseBlock(content: string): BlockInfo {
  const prefix = MARKER_PREFIX.exec(content);
  const info: BlockInfo = {
    marker: prefix ? (prefix[1] as Marker) : null,
    priority: null,
    scheduled: null,
    deadline: null,
    props: [],
    body: "",
  };
  const kept: string[] = [];
  for (const line of contentLines(prefix ? content.slice(prefix[0].length) : content)) {
    if (!line.code) {
      const date = DATE_LINE.exec(line.text);
      const day = date && toDay(date[2], date[3], date[4]);
      if (date && day) {
        if (date[1] === "SCHEDULED") info.scheduled = day;
        else info.deadline = day;
        continue;
      }
      const property = PROPERTY_LINE.exec(line.text);
      if (property) {
        info.props.push([property[1].toLowerCase(), (property[2] ?? "").trim()]);
        continue;
      }
      if (line.offset === 0) info.priority = (PRIORITY.exec(line.text)?.[1] as Priority | undefined) ?? null;
    }
    kept.push(line.text);
  }
  info.body = kept.join("\n");
  return info;
}

function toDay(year: string, month: string, day: string): number | null {
  const [m, d] = [Number(month), Number(day)];
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? Number(year + month + day) : null;
}

/** The text with its task marker replaced (or removed, for null). */
export function setMarker(content: string, marker: Marker | null): string {
  const prefix = MARKER_PREFIX.exec(content);
  const rest = prefix ? content.slice(prefix[0].length) : content;
  return marker ? `${marker} ${rest}` : rest;
}

const NEXT_MARKER: Record<Marker | "none", Marker | null> = {
  none: "TODO",
  TODO: "DOING",
  DOING: "DONE",
  DONE: null,
  LATER: "NOW",
  NOW: "DONE",
  WAITING: "DOING",
  CANCELED: null,
};

/** Mod+Enter: TODO → DOING → DONE → no marker → TODO (LATER → NOW → DONE for the LATER/NOW workflow). */
export function nextMarker(marker: Marker | null): Marker | null {
  return NEXT_MARKER[marker ?? "none"];
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** How Logseq writes a date: <2026-11-02 Mon>. `day` is an ISO date. */
export function formatDate(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return `<${day} ${WEEKDAYS[new Date(year, month - 1, date).getDay()]}>`;
}

/** Sets a block's SCHEDULED or DEADLINE date: replaces that line, or adds one after the first line. */
export function setDate(content: string, kind: DateKind, day: string): string {
  const line = `${kind}: ${formatDate(day)}`;
  const lines = contentLines(content);
  const existing = lines.find((l) => !l.code && l.offset > 0 && DATE_LINE.exec(l.text)?.[1] === kind);
  if (existing) return content.slice(0, existing.offset) + line + content.slice(existing.offset + existing.text.length);
  const firstEnd = lines[0].text.length;
  return `${content.slice(0, firstEnd)}\n${line}${content.slice(firstEnd)}`;
}

/**
 * The block's text without markup that gets in the way of searching: [[ ]] around page names,
 * **, ~~, ==, `. Block references and macros such as {{query …}} are left out: they aren't prose.
 */
export function plainText(content: string): string {
  const { refs, blockRefs, macros } = scan(content);
  const spans = [
    ...refs.map((ref) => ({ ...ref, text: (ref.kind === "tag" ? "#" : "") + ref.name })),
    ...blockRefs.map((ref) => ({ ...ref, text: "" })),
    ...macros.map((macro) => ({ ...macro, text: "" })),
  ].sort((a, b) => a.start - b.start);
  let text = "";
  let last = 0;
  for (const span of spans) {
    text += content.slice(last, span.start) + span.text;
    last = span.end;
  }
  text += content.slice(last);
  return text.replace(/\*\*|~~|==|`/g, "").normalize("NFC");
}

/** What search and unlinked references match against: the plain text, lower-cased. */
export function searchText(content: string): string {
  return plainText(content).toLowerCase();
}

/**
 * A property value as queries compare it: plain text, lower-cased, without a leading #. A value
 * with commas ("tags:: a, [[b c]]") also matches each part.
 */
export function propertyValues(value: string): string[] {
  const parts = value.includes(",") ? value.split(",").map(propertyValue).filter(Boolean) : [];
  return [...new Set([propertyValue(value), ...parts])];
}

/** One value (or query argument) as queries compare it. */
export function propertyValue(value: string): string {
  return searchText(value).trim().replace(/^#/, "");
}
