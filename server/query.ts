import type { Database } from "bun:sqlite";
import { MARKERS, propertyValue, searchText } from "../shared/blocktext";
import { dayName, dayNumber, isJournalKey, pageKey } from "../shared/names";
import { matchPageRef, matchTag } from "../shared/refs";
import type { QueryResult } from "../shared/types";
import { groupBlocks, idsOf } from "./read";

// {{query …}}: Logseq's simple queries.
//
//   [[page]] or #tag          blocks that reference the page, blocks under them, and blocks on the page
//   "some text" or word       blocks whose text contains it (ignoring case)
//   (task TODO DOING)         blocks with one of these task markers ((todo …) works too)
//   (priority A B)            blocks with one of these priorities
//   (property key [value])    blocks with the property (set to the value)
//   (page "name")             blocks on the page
//   (between -7d today)       blocks on journal days in the range: today, yesterday, tomorrow,
//                             ±Nd/w/m/y from today, or a date (2026-11-02 or [[2026-11-02]])
//   (anniversary today +60d)  blocks on journal days in earlier years whose month and day fall
//                             in the range: birthdays and the like. Same dates as (between …)
//   (and …) (or …) (not …)    combine them; several terms side by side mean "and"
//
// A query becomes one parameterised SQL statement; user text only ever goes in as parameters.

export class QueryError extends Error {}

export type QueryNode =
  | { t: "and" | "or"; items: QueryNode[] }
  | { t: "not"; item: QueryNode }
  | { t: "ref"; name: string }
  | { t: "text"; text: string }
  | { t: "task"; markers: string[] }
  | { t: "priority"; values: string[] }
  | { t: "property"; key: string; value: string | null }
  | { t: "page"; name: string }
  | { t: "between" | "anniversary"; from: string; to: string };

type Token = { t: "(" } | { t: ")" } | { t: "word" | "string" | "ref"; value: string };

const MAX_LENGTH = 2_000;
export const QUERY_LIMIT = 500;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < src.length; ) {
    const char = src[i];
    if (/\s/.test(char)) {
      i++;
    } else if (char === "(" || char === ")") {
      tokens.push({ t: char });
      i++;
    } else if (char === '"') {
      const close = src.indexOf('"', i + 1);
      if (close === -1) throw new QueryError("A quote isn't closed.");
      tokens.push({ t: "string", value: src.slice(i + 1, close) });
      i = close + 1;
    } else if (src.startsWith("[[", i)) {
      const ref = matchPageRef(src, i);
      if (!ref) throw new QueryError("A [[link]] isn't closed.");
      tokens.push({ t: "ref", value: ref.name });
      i = ref.end;
    } else {
      const tag = matchTag(src, i); // stops before a closing ")"
      if (tag) {
        tokens.push({ t: "ref", value: tag.name });
        i = tag.end;
        continue;
      }
      const word = /[^\s()"]+/y;
      word.lastIndex = i;
      const value = word.exec(src)![0];
      tokens.push({ t: "word", value });
      i += value.length;
    }
  }
  return tokens;
}

export function parseQuery(src: string): QueryNode {
  if (src.length > MAX_LENGTH) throw new QueryError("The query is too long.");
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const close = () => {
    if (next()?.t !== ")") throw new QueryError("A ( isn't closed.");
  };
  const terms = (): QueryNode[] => {
    const items: QueryNode[] = [];
    while (peek() && peek().t !== ")") items.push(term());
    return items;
  };
  const words = (): string[] => {
    const values: string[] = [];
    for (let token = peek(); token && token.t !== ")"; token = peek()) {
      if (token.t === "(") throw new QueryError("Unexpected ( here.");
      values.push(token.value);
      pos++;
    }
    return values;
  };
  const argument = (what: string): string => {
    const token = next();
    if (!token || token.t === "(" || token.t === ")") throw new QueryError(`Expected ${what}.`);
    return token.value;
  };

  const term = (): QueryNode => {
    const token = next();
    if (token.t === ")") throw new QueryError("Unexpected ).");
    if (token.t === "ref") return { t: "ref", name: token.value };
    if (token.t === "string" || token.t === "word") return { t: "text", text: token.value };
    const op = next();
    if (!op || op.t !== "word") throw new QueryError("Expected a filter name after (.");
    const name = op.value.toLowerCase();
    let node: QueryNode;
    switch (name) {
      case "and":
      case "or":
      case "not": {
        const items = terms();
        if (items.length === 0) throw new QueryError(`(${name}) needs something to combine.`);
        const inner = items.length === 1 ? items[0] : { t: "and" as const, items };
        node = name === "not" ? { t: "not", item: inner } : { t: name, items };
        break;
      }
      case "task":
      case "todo": {
        const markers = words().map((w) => w.toUpperCase());
        const unknown = markers.find((m) => !(MARKERS as readonly string[]).includes(m));
        if (markers.length === 0 || unknown) throw new QueryError(`(task) takes markers such as TODO and DONE${unknown ? `, not ${unknown}` : ""}.`);
        node = { t: "task", markers };
        break;
      }
      case "priority": {
        const values = words().map((w) => w.toUpperCase());
        if (values.length === 0 || values.some((v) => !["A", "B", "C"].includes(v))) {
          throw new QueryError("(priority) takes A, B or C.");
        }
        node = { t: "priority", values };
        break;
      }
      case "property": {
        const key = argument("a property name").toLowerCase().replace(/::?$/, "");
        const value = peek() && peek().t !== ")" ? argument("a value") : null;
        node = { t: "property", key, value };
        break;
      }
      case "page":
        node = { t: "page", name: argument("a page name") };
        break;
      case "between":
      case "anniversary":
        node = { t: name, from: argument("a start date"), to: argument("an end date") };
        break;
      default:
        throw new QueryError(`Unknown filter (${op.value}).`);
    }
    close();
    return node;
  };

  const items = terms();
  if (pos < tokens.length) throw new QueryError("Unexpected ).");
  if (items.length === 0) throw new QueryError("The query is empty.");
  return items.length === 1 ? items[0] : { t: "and", items };
}

/** A day in a (between …) or (anniversary …) filter, as yyyymmdd. `today` is the browser's today. */
export function resolveDay(text: string, today: number): number {
  const word = text.toLowerCase();
  const offsets: Record<string, number> = { today: 0, yesterday: -1, tomorrow: 1 };
  if (word in offsets) return shiftDay(today, offsets[word], "d");
  const relative = /^([+-]\d{1,4})([dwmy])$/.exec(word);
  if (relative) return shiftDay(today, Number(relative[1]), relative[2] as "d" | "w" | "m" | "y");
  if (isJournalKey(word)) return dayNumber(word);
  throw new QueryError(`"${text}" isn't a date: use today, -7d, +2w, 2026-11-02 and the like.`);
}

function shiftDay(day: number, amount: number, unit: "d" | "w" | "m" | "y"): number {
  const [year, month, date] = dayName(day).split("-").map(Number);
  let d: Date;
  if (unit === "d" || unit === "w") {
    d = new Date(year, month - 1, date + (unit === "w" ? 7 : 1) * amount);
  } else {
    // A month before 31 March is the end of February, not 3 March.
    d = new Date(year + (unit === "y" ? amount : 0), month - 1 + (unit === "m" ? amount : 0), 1);
    d.setDate(Math.min(date, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return d.getFullYear() * 10_000 + (d.getMonth() + 1) * 100 + d.getDate();
}

interface Compiled {
  ctes: string[];
  params: Record<string, string | number>;
}

function compile(node: QueryNode, today: number, out: Compiled): string {
  const param = (value: string | number) => {
    const name = `p${Object.keys(out.params).length}`;
    out.params[name] = value;
    return `$${name}`;
  };
  const list = (values: string[]) => values.map(param).join(", ");
  switch (node.t) {
    case "and":
    case "or":
      return `(${node.items.map((item) => compile(item, today, out)).join(` ${node.t.toUpperCase()} `)})`;
    case "not":
      return `NOT (${compile(node.item, today, out)})`;
    case "ref": {
      // Referencing blocks, blocks on the page, and everything under either.
      const cte = `r${out.ctes.length}`;
      const key = param(pageKey(node.name));
      out.ctes.push(
        `${cte}(id) AS (SELECT block FROM refs WHERE page = ${key} UNION SELECT id FROM blocks WHERE page = ${key} ` +
          `UNION SELECT b.id FROM blocks b JOIN ${cte} ON b.parent = ${cte}.id)`,
      );
      return `b.id IN (SELECT id FROM ${cte})`;
    }
    case "text":
      return `instr(b.search_text, ${param(searchText(node.text))}) > 0`;
    case "task":
      return `b.marker IN (${list(node.markers)})`;
    case "priority":
      return `b.priority IN (${list(node.values)})`;
    case "property": {
      const value = node.value === null ? "" : ` AND p.value = ${param(propertyValue(node.value))}`;
      return `EXISTS (SELECT 1 FROM props p WHERE p.block = b.id AND p.key = ${param(node.key)}${value})`;
    }
    case "page":
      return `b.page = ${param(pageKey(node.name))}`;
    case "between": {
      const [from, to] = [resolveDay(node.from, today), resolveDay(node.to, today)].sort((x, y) => x - y);
      return `b.page IN (SELECT key FROM pages WHERE journal_day BETWEEN ${param(from)} AND ${param(to)})`;
    }
    case "anniversary": {
      const [from, to] = [resolveDay(node.from, today), resolveDay(node.to, today)].sort((x, y) => x - y);
      // journal_day is yyyymmdd, so the last four digits are the month and day.
      const md = "journal_day % 10000";
      const [first, last] = [param(from % 10_000), param(to % 10_000)];
      const window =
        shiftDay(from, 1, "y") <= to
          ? "1" // a year or more: every day matches
          : from % 10_000 <= to % 10_000
            ? `${md} BETWEEN ${first} AND ${last}`
            : `(${md} >= ${first} OR ${md} <= ${last})`; // the range crosses New Year
      // Days in the range itself are left out: nothing is its own "0th anniversary".
      return `b.page IN (SELECT key FROM pages WHERE journal_day < ${param(from)} AND ${window})`;
    }
  }
}

/**
 * Runs a query. The block holding the query, and everything under it, never shows up in its
 * own results.
 */
export function runQuery(db: Database, src: string, today: number, block: string | null): QueryResult {
  const out: Compiled = { ctes: [], params: {} };
  const where = compile(parseQuery(src), today, out);
  out.params.self = block ?? "";
  const ctes = [`self(id) AS (SELECT $self UNION SELECT b.id FROM blocks b JOIN self ON b.parent = self.id)`, ...out.ctes];
  const rows = db
    .query(
      `WITH RECURSIVE ${ctes.join(", ")}
       SELECT b.id FROM blocks b WHERE ${where} AND b.id NOT IN (SELECT id FROM self)
       ORDER BY b.updated_at DESC LIMIT ${QUERY_LIMIT + 1}`,
    )
    .all(out.params);
  const ids = idsOf(rows);
  return { groups: groupBlocks(db, ids.slice(0, QUERY_LIMIT)), truncated: ids.length > QUERY_LIMIT };
}
