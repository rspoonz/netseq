import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Op } from "../shared/types";
import { applyBatch } from "./apply";
import { openDb } from "./db";
import { getAgenda, getUnlinkedRefs, search, snippet } from "./search";
import { blockOp, checkTree, writer } from "./testing";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => {
  checkTree(db);
  db.close();
});

function apply(...ops: Op[]) {
  return applyBatch(db, { ...writer, ops });
}

describe("search", () => {
  test("every word must appear, in any order and case", () => {
    apply(
      blockOp("a", "Notes", null, "a0", { content: "Meeting with **Ann** about [[Project X]]" }),
      blockOp("b", "Notes", null, "a1", { content: "meeting notes" }),
    );
    expect(search(db, "ann MEETING").map((hit) => hit.id)).toEqual(["a"]);
    expect(search(db, "project x").map((hit) => hit.id)).toEqual(["a"]); // the link's brackets don't get in the way
    expect(search(db, "meeting").map((hit) => hit.id).sort()).toEqual(["a", "b"]);
    expect(search(db, "   ")).toEqual([]);
  });

  test("a hit says where the words are in its snippet", () => {
    apply(blockOp("a", "Notes", null, "a0", { content: "Meeting with **Ann**" }));
    const [hit] = search(db, "ann meet");
    expect(hit).toMatchObject({ page: { key: "notes", name: "Notes" }, text: "Meeting with Ann", ranges: [[0, 4], [13, 16]] });
  });

  test("snippets of long text start near the first match", () => {
    const text = `${"x".repeat(100)} the word ${"y".repeat(300)}`;
    const result = snippet(text, ["word"]);
    expect(result.text.startsWith("…")).toBe(true);
    expect(result.text.endsWith("…")).toBe(true);
    const [[start, end]] = result.ranges;
    expect(result.text.slice(start, end)).toBe("word");
  });

  test("ranges stay right when lower-casing changes the length", () => {
    const result = snippet("İstanbul trip", ["trip"]);
    expect(result.text.slice(...result.ranges[0])).toBe("trip");
  });
});

describe("unlinked references", () => {
  test("blocks elsewhere that mention the name as a word, without linking it", () => {
    apply(
      blockOp("own", "Ann", null, "a0", { content: "Ann's own page" }),
      blockOp("text", "Notes", null, "a0", { content: "lunch with ann" }),
      blockOp("linked", "Notes", null, "a1", { content: "lunch with [[Ann]]" }),
      blockOp("word", "Notes", null, "a2", { content: "annual review" }),
      blockOp("query", "Notes", null, "a3", { content: "{{query (and [[Ann]] (task TODO))}}" }),
    );
    expect(getUnlinkedRefs(db, "Ann").flatMap((group) => group.roots)).toEqual(["text"]);
  });

  test("lots of blocks containing the name inside other words don't crowd out real mentions", () => {
    const ops = Array.from({ length: 250 }, (_, i) => blockOp(`s${i}`, "Noise", null, `a${String(i).padStart(3, "0")}`, { content: "a fresh start" }));
    apply(blockOp("real", "Old", null, "a0", { content: "modern art" }));
    apply(...ops); // changed more recently than "real"
    expect(getUnlinkedRefs(db, "art").flatMap((group) => group.roots)).toEqual(["real"]);
  });
});

describe("agenda", () => {
  test("unfinished tasks scheduled or due today or earlier, except on today's journal", () => {
    apply(
      blockOp("overdue", "Work", null, "a0", { content: "TODO report\nDEADLINE: <2026-11-01 Sun>" }),
      blockOp("today", "Work", null, "a1", { content: "DOING slides\nSCHEDULED: <2026-11-03 Tue>" }),
      blockOp("later", "Work", null, "a2", { content: "TODO next week\nSCHEDULED: <2026-11-10 Tue>" }),
      blockOp("done", "Work", null, "a3", { content: "DONE finished\nSCHEDULED: <2026-11-01 Sun>" }),
      blockOp("onToday", "2026-11-03", null, "a0", { content: "TODO here\nSCHEDULED: <2026-11-03 Tue>" }),
    );
    expect(getAgenda(db, 20261103).flatMap((group) => group.roots)).toEqual(["overdue", "today"]);
  });
});

describe("indexing", () => {
  test("properties and task fields are stored for queries", () => {
    apply(blockOp("a", "Notes", null, "a0", { content: "TODO [#B] x\nSCHEDULED: <2026-11-02 Mon>\ntype:: [[Book]], #fiction" }));
    expect(db.query("SELECT marker, priority, scheduled, deadline FROM blocks WHERE id = 'a'").get()).toEqual({
      marker: "TODO",
      priority: "B",
      scheduled: 20261102,
      deadline: null,
    });
    expect(db.query("SELECT key, value FROM props WHERE block = 'a' ORDER BY value").all()).toEqual([
      { key: "type", value: "book" },
      { key: "type", value: "book, #fiction" },
      { key: "type", value: "fiction" },
    ]);
  });
});
