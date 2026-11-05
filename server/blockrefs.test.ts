import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Op } from "../shared/types";
import { applyBatch } from "./apply";
import { openDb } from "./db";
import { getBlockRefs, getBlocks, getPage } from "./read";
import { search } from "./search";
import { blockOp, checkTree, writer } from "./testing";

// Block ids in references have to look like the UUIDs the app makes.
const T = "6f1c2a7e-3b4d-4c5e-8f90-a1b2c3d4e5f6";
const A = "0a1b2c3d-0000-4000-8000-000000000001";
const B = "0a1b2c3d-0000-4000-8000-000000000002";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
  apply(blockOp(T, "Plans", null, "a0", { content: "launch on friday" }));
});

afterEach(() => {
  checkTree(db);
  db.close();
});

function apply(...ops: Op[]) {
  return applyBatch(db, { ...writer, ops });
}

function countOf(id: string): number | undefined {
  return getPage(db, "Plans").blocks.find((b) => b.id === id)?.ref_count;
}

test("references are counted on the target, and the batch reports the new count", () => {
  const result = apply(blockOp(A, "Notes", null, "a0", { content: `see ((${T}))` }), blockOp(B, "Notes", null, "a1", { content: `and ((${T}))` }));
  expect(result.refCounts).toEqual({ [T]: 2 });
  expect(countOf(T)).toBe(2);
});

test("removing a reference, or deleting the referencing block, lowers the count", () => {
  apply(blockOp(A, "Notes", null, "a0", { content: `see ((${T}))` }), blockOp(B, "Notes", null, "a1", { content: `and ((${T}))` }));
  expect(apply(blockOp(A, "Notes", null, "a0", { content: "nothing now", base: 2 })).refCounts).toEqual({ [T]: 1 });
  expect(apply({ t: "delete", id: B }).refCounts).toEqual({ [T]: 0 });
  expect(countOf(T)).toBe(0);
});

test("editing text without changing references reports no counts", () => {
  apply(blockOp(A, "Notes", null, "a0", { content: `see ((${T}))` }));
  expect(apply(blockOp(A, "Notes", null, "a0", { content: `still ((${T}))`, base: 2 })).refCounts).toEqual({});
});

test("a block referencing itself doesn't count", () => {
  apply(blockOp(A, "Notes", null, "a0", { content: `me ((${A}))` }));
  expect(getBlockRefs(db, A)).toEqual([]);
});

test("the blocks referencing a block, grouped by page", () => {
  apply(blockOp(A, "Notes", null, "a0", { content: `see ((${T}))` }));
  expect(getBlockRefs(db, T).map((group) => [group.page.key, group.roots])).toEqual([["notes", [A]]]);
});

test("targets can be fetched by id, and missing ones are left out", () => {
  expect(getBlocks(db, [T, A]).map((b) => b.content)).toEqual(["launch on friday"]);
});

test("a reference's id isn't searchable text", () => {
  apply(blockOp(A, "Notes", null, "a0", { content: `see ((${T}))` }));
  expect(search(db, "6f1c2a7e")).toEqual([]);
});
