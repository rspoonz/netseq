import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { keyBetween } from "../shared/order";
import type { Op } from "../shared/types";
import { applyBatch, BadBatch, parseBatch, pruneHistory } from "./apply";
import { openDb } from "./db";
import { getHistory, getPage } from "./read";
import { blockOp, checkTree, outlineOf, writer } from "./testing";

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

describe("writing blocks", () => {
  test("creates the page on first write, keeping its display name", () => {
    const result = apply(blockOp("a", "Project X", null, "a0"));
    expect(result.pages).toEqual([{ key: "project x", name: "Project X", journal_day: null }]);
    expect(result.rows.map((r) => [r.id, r.page])).toEqual([["a", "project x"]]);
    expect(getPage(db, "PROJECT x").page?.name).toBe("Project X");
  });

  test("a later write replaces the block and gets a newer rev", () => {
    const first = apply(blockOp("a", "p", null, "a0", { content: "one" }));
    const second = apply(blockOp("a", "p", null, "a0", { content: "two", collapsed: true }));
    expect(second.rev).toBeGreaterThan(first.rev);
    expect(second.rows).toEqual([
      { id: "a", page: "p", parent: null, order_key: "a0", content: "two", collapsed: true, rev: second.rev, ref_count: 0 },
    ]);
  });

  test("journal pages get their day", () => {
    expect(apply(blockOp("a", "2026-11-02", null, "a0")).pages[0]?.journal_day).toBe(20261102);
  });

  test("the change counter survives a restart", () => {
    const rev = apply(blockOp("a", "p", null, "a0")).rev;
    apply({ t: "delete", id: "a" });
    expect(apply(blockOp("b", "p", null, "a0")).rev).toBe(rev + 2);
  });
});

describe("deleting", () => {
  test("removes the block with everything under it", () => {
    apply(blockOp("a", "p", null, "a0"), blockOp("b", "p", "a", "a0"), blockOp("c", "p", null, "a1"));
    const result = apply({ t: "delete", id: "a" });
    expect(result.deleted.sort()).toEqual(["a", "b"]);
    expect(outlineOf(db, "p")).toBe("c");
  });

  test("a page left with no blocks is removed", () => {
    apply(blockOp("a", "p", null, "a0"));
    expect(apply({ t: "delete", id: "a" }).removedPages).toEqual(["p"]);
    expect(getPage(db, "p").page).toBeNull();
  });

  test("writes in a batch happen before its deletes, whatever their order", () => {
    // Undoing a merge: the child moves back out of the block that the same batch deletes.
    apply(blockOp("a", "p", null, "a0"), blockOp("b", "p", "a", "a0"), blockOp("x", "p", "b", "a0"));
    apply({ t: "delete", id: "b" }, blockOp("x", "p", "a", "a1"));
    expect(outlineOf(db, "p")).toBe("a\n  x");
  });
});

describe("repairs", () => {
  test("a block whose parent doesn't exist goes to the top level", () => {
    const result = apply(blockOp("a", "p", "missing", "a0"));
    expect(result.rows[0]?.parent).toBeNull();
  });

  test("a move that would create a cycle is undone", () => {
    apply(blockOp("a", "p", null, "a0"), blockOp("b", "p", "a", "a0"));
    apply(blockOp("a", "p", "b", "a0")); // a under its own child
    expect(outlineOf(db, "p")).toBe("a\n  b");
  });

  test("moving a block to another page brings its children, and empties the old page", () => {
    apply(blockOp("a", "old", null, "a0"), blockOp("b", "old", "a", "a0"), blockOp("c", "old", "b", "a0"));
    const result = apply(blockOp("a", "new", null, "a0"));
    expect(outlineOf(db, "new")).toBe("a\n  b\n    c");
    expect(result.removedPages).toEqual(["old"]);
    expect(result.rows.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
  });

  test("a block placed under a parent on another page joins that page", () => {
    apply(blockOp("a", "p", null, "a0"));
    apply(blockOp("b", "q", "a", "a0"));
    expect(outlineOf(db, "p")).toBe("a\n  b");
  });

  test("siblings with the same order key are pulled apart", () => {
    apply(blockOp("a", "p", null, "a0"), blockOp("c", "p", null, "a1"));
    const result = apply(blockOp("b", "p", null, "a0")); // another device inserted at the same spot
    const b = result.rows.find((r) => r.id === "b");
    expect(b && b.order_key > "a0" && b.order_key < "a1").toBe(true);
    expect(outlineOf(db, "p")).toBe("a\nb\nc");
  });
});

describe("overwrites", () => {
  const laptop = { writer: "laptop-tab", device: "Laptop" };
  const phone = { writer: "phone-tab", device: "Phone" };

  function setUp(): number {
    applyBatch(db, { ...laptop, ops: [blockOp("a", "p", null, "a0", { content: "original" })] });
    return applyBatch(db, { ...laptop, ops: [blockOp("a", "p", null, "a0", { content: "from laptop", base: 1 })] }).rev;
  }

  test("text another device wrote after the edit started is kept in history", () => {
    setUp();
    // The phone's edit started from rev 1, before the laptop's second write.
    const result = applyBatch(db, { ...phone, ops: [blockOp("a", "p", null, "a0", { content: "from phone", base: 1 })] });
    expect(result.overwrote).toEqual([{ block: "a", device: "Laptop" }]);
    expect(getHistory(db, "a").map((h) => [h.content, h.device])).toEqual([["from laptop", "Laptop"]]);
  });

  test("an edit that started from the latest version overwrites nothing", () => {
    const rev = setUp();
    const result = applyBatch(db, { ...phone, ops: [blockOp("a", "p", null, "a0", { content: "from phone", base: rev })] });
    expect(result.overwrote).toEqual([]);
  });

  test("a tab replacing its own earlier text overwrites nothing", () => {
    setUp();
    const result = applyBatch(db, { ...laptop, ops: [blockOp("a", "p", null, "a0", { content: "again", base: 1 })] });
    expect(result.overwrote).toEqual([]);
  });

  test("moving or folding a block keeps who wrote its text", () => {
    const rev = setUp();
    applyBatch(db, { ...phone, ops: [blockOp("a", "p", null, "a1", { content: "from laptop", collapsed: true, base: rev })] });
    expect(db.query("SELECT writer, device FROM blocks WHERE id = 'a'").get()).toEqual({ writer: "laptop-tab", device: "Laptop" });
    // So the laptop replacing its own text, from before the phone moved it, overwrites nothing.
    const result = applyBatch(db, { ...laptop, ops: [blockOp("a", "p", null, "a1", { content: "again", base: rev })] });
    expect(result.overwrote).toEqual([]);
  });

  test("history older than 30 days is pruned", () => {
    setUp();
    applyBatch(db, { ...phone, ops: [blockOp("a", "p", null, "a0", { content: "from phone", base: 1 })] });
    pruneHistory(db, Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(getHistory(db, "a")).toEqual([]);
  });
});

describe("parseBatch", () => {
  const valid = { writer: "w", device: "d", ops: [blockOp("a", "p", null, "a0"), { t: "delete", id: "b" }] };

  test("accepts well-formed batches", () => {
    expect(parseBatch(valid).ops).toHaveLength(2);
  });

  test("accepts what normal use can produce: long position keys, long text, long page names, big pastes", () => {
    const ops = [
      blockOp("a", "p", null, longKey()),
      blockOp("b", "p", null, "a0", { content: "x".repeat(200_000) }),
      blockOp("c", "x".repeat(600), null, "a0"),
      ...Array.from({ length: 6_000 }, (_, i) => blockOp(`n${i}`, "p", null, "a1")),
    ];
    expect(parseBatch({ ...valid, ops }).ops).toHaveLength(6_003);
  });

  test.each([
    ["not an object", null],
    ["missing ops", { writer: "w", device: "d" }],
    ["unknown op", { ...valid, ops: [{ t: "explode", id: "a" }] }],
    ["empty page", { ...valid, ops: [{ ...blockOp("a", "p", null, "a0"), page: " " }] }],
    ["bad order key", { ...valid, ops: [{ ...blockOp("a", "p", null, "a0"), order_key: "" }] }],
    ["collapsed not boolean", { ...valid, ops: [{ ...blockOp("a", "p", null, "a0"), collapsed: "yes" }] }],
    ["missing base", { ...valid, ops: [{ ...blockOp("a", "p", null, "a0"), base: undefined }] }],
  ])("rejects %s", (_, body) => {
    expect(() => parseBatch(body)).toThrow(BadBatch);
  });
});

/** The key after 1,000 inserts in one spot, as when the newest entry always goes under the same block. */
function longKey(): string {
  const after = keyBetween("a0", null);
  let key = "a0";
  for (let i = 0; i < 1_000; i++) key = keyBetween(key, after);
  return key;
}

test("a block whose position key grew past 200 characters saves, in its place", () => {
  const key = longKey();
  expect(key.length).toBeGreaterThan(200);
  apply(blockOp("first", "P", null, "a0"), blockOp("last", "P", null, keyBetween("a0", null)), blockOp("new", "P", null, key));
  expect(getPage(db, "P").blocks.map((b) => b.id)).toEqual(["first", "new", "last"]);
});
