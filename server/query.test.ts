import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Op } from "../shared/types";
import { applyBatch } from "./apply";
import { openDb } from "./db";
import { parseQuery, QueryError, resolveDay, runQuery } from "./query";
import { blockOp, checkTree, writer } from "./testing";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  // A small graph to query.
  apply(
    blockOp("p1", "Project", null, "a0", { content: "TODO [#A] plan the project" }),
    blockOp("p2", "Project", "p1", "a0", { content: "DONE book a room" }),
    blockOp("m1", "2026-11-02", null, "a0", { content: "meeting about [[Project]]" }),
    blockOp("m2", "2026-11-02", "m1", "a0", { content: "TODO send notes\nstatus:: [[Draft]]" }),
    blockOp("m3", "2026-11-02", null, "a1", { content: "LATER [#B] water the plants" }),
    blockOp("o1", "2026-10-01", null, "a0", { content: "TODO old task #errand" }),
    blockOp("q", "Dashboard", null, "a0", { content: "{{query (task TODO)}}" }),
  );
});

afterEach(() => {
  checkTree(db);
  db.close();
});

function apply(...ops: Op[]) {
  return applyBatch(db, { ...writer, ops });
}

const TODAY = 20261103;

/** The ids a query finds, roots first in page order, each group's roots together. */
function find(query: string, block: string | null = null): string[] {
  return runQuery(db, query, TODAY, block).groups.flatMap((group) => group.roots);
}

describe("filters", () => {
  test("a page reference finds referencing blocks, blocks under them, and blocks on the page", () => {
    // m1 references Project (m2 sits under it, so it's shown inside m1); p1 is on the page.
    expect(find("[[Project]]")).toEqual(["m1", "p1"]);
    expect(find("#project")).toEqual(["m1", "p1"]);
  });

  test("tasks, priorities and properties", () => {
    expect(find("(task TODO)").sort()).toEqual(["m2", "o1", "p1"]);
    expect(find("(todo later done)").sort()).toEqual(["m3", "p2"]);
    expect(find("(priority a b)").sort()).toEqual(["m3", "p1"]);
    expect(find("(property status draft)")).toEqual(["m2"]);
    expect(find("(property status [[Draft]])")).toEqual(["m2"]);
    expect(find("(property status)")).toEqual(["m2"]);
    expect(find("(property status final)")).toEqual([]);
  });

  test("text, pages and journal dates", () => {
    expect(find('"WATER the"')).toEqual(["m3"]);
    expect(find("plants")).toEqual(["m3"]);
    expect(find('(page "project")')).toEqual(["p1"]);
    expect(find("(between -7d today)")).toEqual(["m1", "m3"]);
    expect(find("(between [[2026-10-01]] 2026-10-31)")).toEqual(["o1"]);
  });

  test("and, or, not, and terms side by side", () => {
    expect(find("(and [[Project]] (task TODO))").sort()).toEqual(["m2", "p1"]);
    expect(find("[[Project]] (task TODO)").sort()).toEqual(["m2", "p1"]);
    expect(find("(or #errand (priority B))").sort()).toEqual(["m3", "o1"]);
    expect(find("(and (task TODO) (not [[Project]]))")).toEqual(["o1"]);
  });

  test("the query's own block, and anything under it, never shows up in its results", () => {
    apply(blockOp("q2", "Dashboard", "q", "a0", { content: "TODO under the query" }));
    expect(find("(task TODO)", "q")).not.toContain("q2");
    expect(find("(task TODO)")).toContain("q2");
  });

  test("results are grouped by page, journals newest first", () => {
    const groups = runQuery(db, "(task TODO DONE)", TODAY, null).groups;
    expect(groups.map((g) => g.page.key)).toEqual(["2026-11-02", "2026-10-01", "project"]);
    expect(groups[0].paths.m2.map((crumb) => crumb.id)).toEqual(["m1"]);
  });
});

describe("anniversaries", () => {
  beforeEach(() => {
    apply(
      blockOp("w1", "1990-11-20", null, "a0", { content: "wedding\nevent:: married" }),
      blockOp("b1", "1985-12-28", null, "a0", { content: "[[Amelia]]\nevent:: born" }),
      blockOp("b2", "2001-01-05", null, "a0", { content: "[[Alma]]\nevent:: born" }),
      blockOp("b3", "1996-02-29", null, "a0", { content: "[[Leap]]\nevent:: born" }),
      blockOp("b4", "1970-06-15", null, "a0", { content: "[[Summer]]\nevent:: born\nended:: yes" }),
      blockOp("n1", "2026-11-10", null, "a0", { content: "this year\nevent:: born" }),
      blockOp("n2", "2027-11-10", null, "a0", { content: "next year\nevent:: born" }),
    );
  });

  const events = (window: string) => find(`(property event) (anniversary ${window})`).sort();

  test("a range within one calendar year", () => {
    expect(events("today +30d")).toEqual(["w1"]);
    expect(events("+30d today")).toEqual(["w1"]); // either way round
    expect(events("2026-12-28 2026-12-28")).toEqual(["b1"]);
    expect(events("2026-12-29 2026-12-31")).toEqual([]);
  });

  test("a range crossing New Year", () => {
    expect(events("today +70d")).toEqual(["b1", "b2", "w1"]); // 3 Nov to 12 Jan
    expect(events("2026-12-01 2027-01-04")).toEqual(["b1"]);
  });

  test("a range of a year or more matches every day", () => {
    expect(events("today +1y")).toEqual(["b1", "b2", "b3", "b4", "w1"]);
    expect(events("2026-11-03 2027-11-02")).toEqual(["b1", "b2", "b3", "b4", "w1"]); // a day short, but still every day
    expect(events("2026-11-04 2027-11-02")).toEqual(["b1", "b2", "b3", "b4", "w1"]);
    expect(events("2026-11-21 2027-11-19")).toEqual(["b1", "b2", "b3", "b4", "n1"]); // misses 20 Nov; n1 is now before the range
  });

  test("days in the range itself, and after it, are left out", () => {
    // n1 (2026-11-10) is inside the range and n2 is in the future; m1, m2, m3 (2026-11-02) are a day before it.
    expect(find("(anniversary today +30d)")).toEqual(["w1"]);
    expect(find("(anniversary 2027-11-01 2027-11-30)").sort()).toEqual(["m1", "m3", "n1", "w1"]);
  });

  test("29 February in a year without one", () => {
    expect(events("2027-02-20 2027-03-05")).toEqual(["b3"]);
    expect(events("2027-02-28 2027-03-01")).toEqual(["b3"]);
    expect(events("2027-02-20 2027-02-28")).toEqual([]); // ends on the 28th: not counted
    expect(events("2028-02-29 2028-02-29")).toEqual(["b3"]);
  });

  test("the results come soonest first", () => {
    const pages = (query: string) => runQuery(db, query, TODAY, null).groups.map((group) => group.page.key);
    apply(blockOp("w2", "1975-11-20", null, "a0", { content: "an older wedding\nevent:: married" }));
    // By month and day, not by year; the same day in two years goes oldest first.
    expect(pages("(property event) (anniversary today +60d)")).toEqual(["1975-11-20", "1990-11-20", "1985-12-28"]);
    // Across New Year, December comes before January.
    expect(pages("(property event) (anniversary today +70d)")).toEqual(["1975-11-20", "1990-11-20", "1985-12-28", "2001-01-05"]);
    // A year from today starts with today's month and day, wherever the year begins.
    expect(pages("(property event born) (anniversary today +1y)")).toEqual(["1985-12-28", "2001-01-05", "1996-02-29", "1970-06-15"]);
    // Pages that aren't journal days come last.
    expect(pages('(or (and (property event) (anniversary today +60d)) (page "Project"))')).toEqual([
      "1975-11-20",
      "1990-11-20",
      "1985-12-28",
      "project",
    ]);
  });

  test("combined with other filters", () => {
    expect(find("(and (property event born) (anniversary today +1y))").sort()).toEqual(["b1", "b2", "b3", "b4"]);
    expect(find("(property event) (not (property event born)) (anniversary today +1y)")).toEqual(["w1"]);
    expect(find("(property event born) (not (property ended)) (anniversary 2027-06-01 2027-06-30)")).toEqual([]);
    expect(find("[[Alma]] (anniversary today +70d)")).toEqual(["b2"]);
    expect(find("(or (property event married) [[Alma]]) (anniversary today +70d)").sort()).toEqual(["b2", "w1"]);
    expect(find('(anniversary today +1y) (page "Project")')).toEqual([]); // blocks on ordinary pages never match
  });
});

describe("parsing", () => {
  test("mistakes come back as readable errors", () => {
    for (const [query, message] of [
      ["(task TODO", "A ( isn't closed."],
      ["(task TODO))", "Unexpected )."],
      ['"open', "A quote isn't closed."],
      ["(frobnicate x)", "Unknown filter (frobnicate)."],
      ["(task SOMEDAY)", "(task) takes markers such as TODO and DONE, not SOMEDAY."],
      ["(priority D)", "(priority) takes A, B or C."],
      ["(between today)", "Expected an end date."],
      ["(between soon today)", '"soon" isn\'t a date: use today, -7d, +2w, 2026-11-02 and the like.'],
      ["(anniversary)", "Expected a start date."],
      ["(anniversary today)", "Expected an end date."],
      ["(anniversary today soon)", '"soon" isn\'t a date: use today, -7d, +2w, 2026-11-02 and the like.'],
      ["(anniversary today +60d +90d)", "A ( isn't closed."],
      ["", "The query is empty."],
      ["(and)", "(and) needs something to combine."],
    ]) {
      expect(() => runQuery(db, query, TODAY, null), query).toThrow(new QueryError(message));
    }
  });

  test("the parse tree", () => {
    expect(parseQuery('(and [[a b]] (not "x") (property type book))')).toEqual({
      t: "and",
      items: [
        { t: "ref", name: "a b" },
        { t: "not", item: { t: "text", text: "x" } },
        { t: "property", key: "type", value: "book" },
      ],
    });
  });

  test("relative days", () => {
    expect(resolveDay("today", TODAY)).toBe(TODAY);
    expect(resolveDay("yesterday", 20260301)).toBe(20260228);
    expect(resolveDay("+2w", TODAY)).toBe(20261117);
    expect(resolveDay("-1m", 20260331)).toBe(20260228);
    expect(resolveDay("-1y", TODAY)).toBe(20251103);
  });
});

test("text that looks like SQL is only ever a parameter", () => {
  expect(find(`"'; DROP TABLE blocks; --"`)).toEqual([]);
  expect(find(`(page "x' OR 1=1 --")`)).toEqual([]);
  expect(db.query("SELECT count(*) AS n FROM blocks").get()).toEqual({ n: 7 });
});
