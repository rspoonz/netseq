import { type DateKind, type Marker, setDate, setMarker } from "../../../shared/blocktext";
import { journalName } from "../../../shared/names";

// Commands typed as "/" plus a few letters, as in Logseq. Pure functions, unit-tested; Editor.vue
// shows the matching commands and asks for a date when a command needs one.

export interface SlashQuery {
  start: number; // where the "/" is
  end: number; // the caret
  query: string; // what's typed after the "/"
}

export type SlashCommand =
  | { label: string; marker: Marker }
  | { label: string; date: DateKind | "link" } // asks for a date first
  | { label: string; days: number } // a link to the journal page this many days from today
  | { label: string; insert: string; caret: number }; // text to insert, and where the caret goes in it

export const SLASH_COMMANDS: SlashCommand[] = [
  { label: "TODO", marker: "TODO" },
  { label: "DOING", marker: "DOING" },
  { label: "DONE", marker: "DONE" },
  { label: "LATER", marker: "LATER" },
  { label: "NOW", marker: "NOW" },
  { label: "Scheduled", date: "SCHEDULED" },
  { label: "Deadline", date: "DEADLINE" },
  { label: "Date picker", date: "link" },
  { label: "Today", days: 0 },
  { label: "Tomorrow", days: 1 },
  { label: "Yesterday", days: -1 },
  { label: "Query", insert: "{{query }}", caret: "{{query ".length },
];

/** The command being typed at the caret: a "/" at the start or after a space, then letters. */
export function slashQueryAt(text: string, caret: number): SlashQuery | null {
  const match = /(?:^|\s)\/([\p{L}\p{N}]*)$/u.exec(text.slice(0, caret));
  return match ? { start: caret - match[1].length - 1, end: caret, query: match[1] } : null;
}

/** Commands whose name starts with the query, then ones that contain it. */
export function matchCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const starts = SLASH_COMMANDS.filter((c) => c.label.toLowerCase().startsWith(q));
  const contains = SLASH_COMMANDS.filter((c) => !starts.includes(c) && c.label.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/**
 * The text after running a command typed at `q`, and where the caret goes. `day` (an ISO date)
 * answers commands that ask for one.
 */
export function applySlash(text: string, q: SlashQuery, command: SlashCommand, day = "", today = new Date()): { text: string; caret: number } {
  const base = text.slice(0, q.start) + text.slice(q.end);
  const at = q.start;
  if ("marker" in command) {
    const next = setMarker(base, command.marker);
    return { text: next, caret: Math.max(0, at + next.length - base.length) };
  }
  if ("date" in command && command.date !== "link") {
    // The date goes on the line after the first, so the caret only moves if it's further down.
    const next = setDate(base, command.date, day);
    const firstLineEnd = base.includes("\n") ? base.indexOf("\n") : base.length;
    return { text: next, caret: at <= firstLineEnd ? at : at + next.length - base.length };
  }
  if ("insert" in command) return { text: base.slice(0, at) + command.insert + base.slice(at), caret: at + command.caret };
  const target = "days" in command ? journalName(new Date(today.getFullYear(), today.getMonth(), today.getDate() + command.days)) : day;
  const link = `[[${target}]]`;
  return { text: base.slice(0, at) + link + base.slice(at), caret: at + link.length };
}
