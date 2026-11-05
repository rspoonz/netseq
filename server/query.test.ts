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
