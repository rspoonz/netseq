import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Op } from "../shared/types";
import { AGENT_WRITER, AgentError, addBlocks, editBlock, moveBlock, pageOutline } from "./agent";
import { applyBatch } from "./apply";
import { openDb } from "./db";
import { getHistory } from "./read";
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

function refused(run: () => unknown): AgentError {
  try {
    run();
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error("expected the request to be refused");
}

describe("reading a page", () => {
  test("is a markdown outline with every block's id", () => {
    apply(
      blockOp("a", "Project", null, "a0", { content: "Plan" }),
      blockOp("b", "Project", "a", "a0", { content: "TODO step\nSCHEDULED: <2026-11-06 Fri>" }),
    );
    expect(pageOutline(db, "project")).toBe(
      "- Plan\n  id:: a\n\t- TODO step\n\t  id:: b\n\t  SCHEDULED: <2026-11-06 Fri>",
    );
  });

  test("is null for a page that doesn't exist", () => {
    expect(pageOutline(db, "Nowhere")).toBeNull();
  });
});

describe("adding", () => {
  test("adds a block at the end of a page's top level", () => {
    apply(blockOp("a", "Project", null, "a0", { content: "first" }), blockOp("b", "Project", "a", "a0", { content: "child" }));
    const { page, ids } = addBlocks(db, { page: "PROJECT", text: "TODO last" });
    expect(page).toBe("Project");
    expect(ids).toHaveLength(1);
    expect(outlineOf(db, "project")).toBe("first\n  child\nTODO last");
    const row = db.query("SELECT marker, writer, device FROM blocks WHERE id = ?").get(ids[0]);
    expect(row).toEqual({ marker: "TODO", writer: AGENT_WRITER, device: "Agent" });
  });

  test("creates the page, links and journal day it needs", () => {
    const { page, result } = addBlocks(db, { page: " 2026-11-05 ", text: "Met [[Alice]]" });
    expect(page).toBe("2026-11-05");
    expect(result.pages.map((p) => [p.name, p.journal_day])).toEqual([
      ["2026-11-05", 20261105],
      ["Alice", null],
    ]);
  });

  test("text that starts with a bullet is an outline; other text is one block", () => {
    const outline = addBlocks(db, { page: "P", text: "- one\n  - two\n    more\n- three" });
    expect(outline.ids).toHaveLength(3);
    addBlocks(db, { page: "P", text: "plain\nsecond line\n" });
    expect(outlineOf(db, "p")).toBe("one\n  two\nmore\nthree\nplain\nsecond line");
  });

  test("under a parent, goes after its last child on the parent's page", () => {
    apply(blockOp("a", "Project", null, "a0", { content: "parent" }), blockOp("b", "Project", "a", "a0", { content: "old child" }));
    const { page } = addBlocks(db, { parent: "a", text: "- new child\n  - grandchild" });
    expect(page).toBe("Project");
    expect(outlineOf(db, "project")).toBe("parent\n  old child\n  new child\n    grandchild");
  });

  test("drops id:: and collapsed:: lines copied from a page outline", () => {
    addBlocks(db, { page: "P", text: "- copied\n  id:: 1234\n  collapsed:: true\n  status:: kept" });
    expect(outlineOf(db, "p")).toBe("copied\nstatus:: kept");
  });

  test("an agent that gives its name is shown by it", () => {
    const { ids } = addBlocks(db, { page: "P", text: "hello", agent: " Claude " });
    addBlocks(db, { page: "P", text: "hi", agent: "" });
    const devices = db.query("SELECT device FROM blocks ORDER BY order_key").all();
    expect(devices).toEqual([{ device: "Claude (agent)" }, { device: "Agent" }]);
    editBlock(db, { id: ids[0], content: "hello again", agent: "Codex" });
    expect(getHistory(db, ids[0]).map((h) => h.device)).toEqual(["Claude (agent)"]);
    expect(refused(() => addBlocks(db, { page: "P", text: "x", agent: 1 })).message).toBe("agent must be a name");
  });

  test("refuses requests it can't follow", () => {
    apply(blockOp("a", "Project", null, "a0"));
    expect(refused(() => addBlocks(db, { text: "x" })).message).toBe("give one of page, parent, after or before");
    expect(refused(() => addBlocks(db, { page: "P", parent: "a", text: "x" })).message).toBe("give one of page, parent, after or before");
    expect(refused(() => addBlocks(db, { page: "P", text: "  " })).status).toBe(400);
    expect(refused(() => addBlocks(db, { page: "a]]b", text: "x" })).status).toBe(400);
    expect(refused(() => addBlocks(db, { page: 7, text: "x" })).status).toBe(400);
    expect(refused(() => addBlocks(db, { parent: "missing", text: "x" }))).toMatchObject({ message: "no such block", status: 404 });
    expect(refused(() => addBlocks(db, { after: "a", before: "a", text: "x" })).status).toBe(400);
    expect(refused(() => addBlocks(db, { after: "missing", text: "x" }))).toMatchObject({ message: "no such block", status: 404 });
    expect(refused(() => addBlocks(db, { before: 7, text: "x" })).message).toBe("before must be a block id");
    expect(refused(() => addBlocks(db, null)).status).toBe(400);
    expect(outlineOf(db, "project")).toBe("a");
  });
});

describe("adding next to a block", () => {
  beforeEach(() => {
    apply(
      blockOp("a", "Project", null, "a0"),
      blockOp("b", "Project", null, "a1"),
      blockOp("b1", "Project", "b", "a0"),
      blockOp("b2", "Project", "b", "a1"),
      blockOp("c", "Project", null, "a2"),
    );
  });

  test("after a block, goes between it and the next one", () => {
    const { page } = addBlocks(db, { after: "a", text: "new" });
    expect(page).toBe("Project");
    expect(outlineOf(db, "project")).toBe("a\nnew\nb\n  b1\n  b2\nc");
  });

  test("after the last block, goes at the end", () => {
    addBlocks(db, { after: "c", text: "new" });
    expect(outlineOf(db, "project")).toBe("a\nb\n  b1\n  b2\nc\nnew");
  });

  test("before a block, goes between it and the one before", () => {
    addBlocks(db, { before: "c", text: "new" });
    expect(outlineOf(db, "project")).toBe("a\nb\n  b1\n  b2\nnew\nc");
  });

  test("before the first block, goes at the top", () => {
    addBlocks(db, { before: "a", text: "new" });
    expect(outlineOf(db, "project")).toBe("new\na\nb\n  b1\n  b2\nc");
  });

  test("next to a nested block, stays under its parent, with an outline's children", () => {
    addBlocks(db, { after: "b1", text: "- one\n  - under one\n- two" });
    addBlocks(db, { before: "b1", text: "zero" });
    expect(outlineOf(db, "project")).toBe("a\nb\n  zero\n  b1\n  one\n    under one\n  two\n  b2\nc");
  });
});

describe("moving", () => {
  beforeEach(() => {
    apply(
      blockOp("a", "Project", null, "a0"),
      blockOp("b", "Project", null, "a1"),
      blockOp("b1", "Project", "b", "a0"),
      blockOp("b1x", "Project", "b1", "a0"),
      blockOp("b2", "Project", "b", "a1"),
      blockOp("b3", "Project", "b", "a2"),
      blockOp("c", "Project", null, "a2"),
    );
  });

  const collapsed = (id: string) => (db.query("SELECT collapsed FROM blocks WHERE id = ?").get(id) as { collapsed: number }).collapsed;

  test("goes after or before a block, or under one, with everything under it", () => {
    expect(moveBlock(db, { id: "b1", after: "c" })).toMatchObject({ id: "b1", page: "Project" });
    expect(outlineOf(db, "project")).toBe("a\nb\n  b2\n  b3\nc\nb1\n  b1x");
    moveBlock(db, { id: "c", before: "a" });
    moveBlock(db, { id: "b3", parent: "a" });
    expect(outlineOf(db, "project")).toBe("c\na\n  b3\nb\n  b2\nb1\n  b1x");
  });

  test("to another page, takes everything under it there, and keeps ids and text", () => {
    apply(blockOp("s", "Solo", null, "a0"));
    expect(moveBlock(db, { id: "b", page: "other" })).toMatchObject({ page: "other" });
    expect(outlineOf(db, "project")).toBe("a\nc");
    expect(outlineOf(db, "other")).toBe("b\n  b1\n    b1x\n  b2\n  b3");
    moveBlock(db, { id: "s", after: "a" });
    expect(outlineOf(db, "project")).toBe("a\ns\nc");
    expect(db.query("SELECT key FROM pages WHERE key = 'solo'").get()).toBeNull(); // nothing left on it
  });

  test("indenting makes it the last child of the block above it at its level", () => {
    apply(blockOp("b1", "Project", "b", "a0", { collapsed: true }));
    expect(moveBlock(db, { id: "b2", indent: true, agent: "Claude" })).toMatchObject({ page: "Project" });
    expect(outlineOf(db, "project")).toBe("a\nb\n  b1\n    b1x\n    b2\n  b3\nc");
    expect(collapsed("b1")).toBe(0); // opened, so the moved block stays in view
    const row = db.query("SELECT content, device FROM blocks WHERE id = 'b2'").get();
    expect(row).toEqual({ content: "b2", device: "Claude (agent)" });
    expect(getHistory(db, "b2")).toEqual([]);
  });

  test("can't indent the first block at its level", () => {
    expect(refused(() => moveBlock(db, { id: "b1", indent: true })).message).toBe(
      "there's no block above it at its level to indent it under",
    );
    expect(refused(() => moveBlock(db, { id: "a", indent: true })).status).toBe(400);
  });

  test("outdenting puts it after its parent, and the blocks below it become its children (Logseq's default)", () => {
    apply(blockOp("b2x", "Project", "b2", "a0"), blockOp("b2", "Project", "b", "a1", { collapsed: true }));
    moveBlock(db, { id: "b2", outdent: true });
    expect(outlineOf(db, "project")).toBe("a\nb\n  b1\n    b1x\nb2\n  b2x\n  b3\nc");
    expect(collapsed("b2")).toBe(0); // opened, so the blocks that moved under it stay in view
  });

  test("outdenting the last block at its level moves only it", () => {
    moveBlock(db, { id: "b3", outdent: true });
    expect(outlineOf(db, "project")).toBe("a\nb\n  b1\n    b1x\n  b2\nb3\nc");
    expect(refused(() => moveBlock(db, { id: "a", outdent: true })).message).toBe("it's already at the top level");
  });

  test("refuses moves it can't make", () => {
    const before = outlineOf(db, "project");
    expect(refused(() => moveBlock(db, { id: "b", parent: "b" })).message).toBe(
      "a block can't move under itself or a block under it",
    );
    expect(refused(() => moveBlock(db, { id: "b", after: "b1x" })).status).toBe(400);
    expect(refused(() => moveBlock(db, { id: "b", before: "b" })).message).toBe("a block can't move next to itself");
    expect(refused(() => moveBlock(db, { id: "b" })).message).toBe(
      "give one of page, parent, after, before, indent or outdent",
    );
    expect(refused(() => moveBlock(db, { id: "b", after: "a", indent: true })).status).toBe(400);
    expect(refused(() => moveBlock(db, { id: "b2", indent: "yes" })).message).toBe("indent must be true");
    expect(refused(() => moveBlock(db, { id: "b", after: 3 })).message).toBe("after must be a block id");
    expect(refused(() => moveBlock(db, { id: "missing", indent: true }))).toMatchObject({ status: 404 });
    expect(refused(() => moveBlock(db, { id: "b", after: "missing" }))).toMatchObject({ status: 404 });
    expect(refused(() => moveBlock(db, { id: 7, indent: true })).status).toBe(400);
    expect(outlineOf(db, "project")).toBe(before);
  });
});

describe("editing", () => {
  test("replaces a block's text, keeps its place and children, and keeps the old text in history", () => {
    apply(
      blockOp("a", "Project", null, "a0", { content: "TODO step", collapsed: true }),
      blockOp("b", "Project", "a", "a0", { content: "child" }),
    );
    const { id, page } = editBlock(db, { id: "a", content: "DONE step\nid:: a" }, 1000);
    expect([id, page]).toEqual(["a", "Project"]);
    expect(outlineOf(db, "project")).toBe("DONE step\n  child");
    const row = db.query("SELECT marker, collapsed, device FROM blocks WHERE id = 'a'").get();
    expect(row).toEqual({ marker: "DONE", collapsed: 1, device: "Agent" });
    expect(getHistory(db, "a")).toEqual([{ content: "TODO step", device: "Test", saved_at: 1000 }]);
  });

  test("with the text the agent read, only edits a block that still says it", () => {
    apply(
      blockOp("a", "Project", null, "a0", { content: "parent" }),
      blockOp("b", "Project", "a", "a0", { content: "TODO step\nSCHEDULED: <2026-11-06 Fri>" }),
    );
    // Copied from the page outline, with its indentation and id line.
    const read = "TODO step\n\t  id:: b\n\t  SCHEDULED: <2026-11-06 Fri>";
    editBlock(db, { id: "b", content: "DONE step\nSCHEDULED: <2026-11-06 Fri>", expect: read });
    expect(outlineOf(db, "project")).toBe("parent\n  DONE step\nSCHEDULED: <2026-11-06 Fri>");

    // Someone changed it since: nothing is written, and the agent is told what it says now.
    expect(refused(() => editBlock(db, { id: "b", content: "CANCELED step", expect: read }))).toMatchObject({
      message: "the block has changed since you read it",
      status: 409,
      details: { content: "DONE step\nSCHEDULED: <2026-11-06 Fri>" },
    });
    expect(getHistory(db, "b")).toHaveLength(1);
    expect(refused(() => editBlock(db, { id: "b", content: "x", expect: 3 })).status).toBe(400);
  });

  test("the same text again saves nothing, so the block stays as it was", () => {
    apply(blockOp("a", "Project", null, "a0", { content: "my own words  " }));
    const before = db.query("SELECT rev, writer, device, updated_at FROM blocks WHERE id = 'a'").get();
    const { result, page } = editBlock(db, { id: "a", content: "my own words", agent: "Claude" });
    expect([result, page]).toEqual([null, "Project"]);
    expect(db.query("SELECT rev, writer, device, updated_at FROM blocks WHERE id = 'a'").get()).toEqual(before);
    expect(getHistory(db, "a")).toEqual([]);
  });

  test("re-indexes links, and removes pages nothing links to any more", () => {
    apply(blockOp("a", "Project", null, "a0", { content: "see [[Old]]" }));
    const { result } = editBlock(db, { id: "a", content: "see [[New]]" });
    expect(result?.pages.map((p) => p.name)).toEqual(["New"]);
    expect(result?.removedPages).toEqual(["old"]);
  });

  test("refuses requests it can't follow", () => {
    expect(refused(() => editBlock(db, { id: "missing", content: "x" }))).toMatchObject({ message: "no such block", status: 404 });
    expect(refused(() => editBlock(db, { id: "a" })).status).toBe(400);
    expect(refused(() => editBlock(db, [])).status).toBe(400);
  });
});
