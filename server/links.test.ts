import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Op } from "../shared/types";
import { applyBatch, renamePage } from "./apply";
import { openDb } from "./db";
import { getBlockTree, getJournals, getLinkedRefs, getPage, getRecentPages, SUBTREE } from "./read";
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

function refsOf(id: string): string[] {
  return (db.query("SELECT page FROM refs WHERE block = ? ORDER BY page").all(id) as { page: string }[]).map((r) => r.page);
}

describe("references", () => {
  test("a reference creates the page and is indexed", () => {
    const result = apply(blockOp("a", "Notes", null, "a0", { content: "about [[Project X]] #idea" }));
    expect(result.pages.map((p) => p.name).sort()).toEqual(["Notes", "Project X", "idea"]);
    expect(refsOf("a")).toEqual(["idea", "project x"]);
  });

  test("pages created while typing a link are cleaned up again", () => {
    apply(blockOp("a", "Notes", null, "a0", { content: "[[P]]" }));
    const result = apply(blockOp("a", "Notes", null, "a0", { content: "[[Pr]]", base: 1 }));
    expect(result.removedPages).toEqual(["p"]);
    expect(getPage(db, "P").page).toBeNull();
    expect(getPage(db, "Pr").page?.name).toBe("Pr");
  });

  test("a referenced page with its own blocks stays when the reference goes", () => {
    apply(blockOp("x", "Project X", null, "a0"), blockOp("a", "Notes", null, "a0", { content: "[[Project X]]" }));
    const result = apply(blockOp("a", "Notes", null, "a0", { content: "nothing" }));
    expect(result.removedPages).toEqual([]);
  });

  test("deleting a block drops its references, and pages only it referred to", () => {
    apply(blockOp("a", "Notes", null, "a0", { content: "[[Lonely]]" }), blockOp("b", "Notes", null, "a1"));
    expect(apply({ t: "delete", id: "a" }).removedPages).toEqual(["lonely"]);
  });

  test("a journal day that's only linked to doesn't show up in the journals", () => {
    apply(blockOp("a", "Notes", null, "a0", { content: "due [[2026-12-24]]" }), blockOp("j", "2026-11-01", null, "a0"));
    expect(getJournals(db, 20270101, 10).map((d) => d.page?.key)).toEqual(["2026-11-01"]);
  });

  test("a journal day with only blank blocks doesn't show up in the journals", () => {
    apply(
      blockOp("j", "2026-11-01", null, "a0"),
      blockOp("s", "1998-04-16", null, "a0", { content: " " }),
      blockOp("n", "1996-02-07", null, "a0", { content: "\n\t " }),
    );
    expect(getJournals(db, 20270101, 10).map((d) => d.page?.key)).toEqual(["2026-11-01"]);
  });
});

describe("recently changed pages", () => {
  const at = (now: number, ...ops: Op[]) => applyBatch(db, { ...writer, ops }, now);

  test("named pages with blocks, the most recently changed first", () => {
    at(1000, blockOp("a", "Alpha", null, "a0"));
    at(2000, blockOp("b", "Beta", null, "a0", { content: "see [[Only linked]]" }), blockOp("j", "2026-11-01", null, "a0"));
    expect(getRecentPages(db, 10)).toEqual([
      { key: "beta", name: "Beta", journal_day: null },
      { key: "alpha", name: "Alpha", journal_day: null },
    ]); // no journal day, no "Only linked" (it has no blocks)
    at(3000, blockOp("a", "Alpha", null, "a0", { content: "edited", base: 1 }));
    expect(getRecentPages(db, 10).map((p) => p.name)).toEqual(["Alpha", "Beta"]);
  });

  test("only the `limit` most recent, ties in name order", () => {
    at(1000, blockOp("a", "A", null, "a0"), blockOp("b", "B", null, "a0"), blockOp("c", "C", null, "a0"));
    at(2000, blockOp("c", "C", null, "a0", { content: "edited", base: 1 }));
    expect(getRecentPages(db, 2).map((p) => p.name)).toEqual(["C", "A"]);
  });
});

describe("linked references", () => {
  test("are grouped by page, with breadcrumbs and children, newest journal first", () => {
    apply(
      blockOp("t", "Target", null, "a0", { content: "on the page itself [[Target]]" }),
      blockOp("p", "Project", null, "a0", { content: "parent" }),
      blockOp("r", "Project", "p", "a0", { content: "see [[Target]]" }),
      blockOp("rc", "Project", "r", "a0", { content: "child, also [[Target]]" }),
      blockOp("j1", "2026-11-01", null, "a0", { content: "[[target]] earlier" }),
      blockOp("j2", "2026-11-02", null, "a0", { content: "#Target later" }),
    );
    const groups = getLinkedRefs(db, "Target");
    expect(groups.map((g) => g.page.key)).toEqual(["2026-11-02", "2026-11-01", "project"]);
    const project = groups[2];
    expect(project.roots).toEqual(["r"]); // rc shows inside r, not on its own
    expect(project.paths.r).toEqual([{ id: "p", content: "parent" }]);
    expect(project.blocks.map((b) => b.id)).toEqual(["r", "rc"]);
  });
});

describe("zooming in", () => {
  test("returns the block, everything under it, and its ancestors", () => {
    apply(
      blockOp("a", "P", null, "a0"),
      blockOp("b", "P", "a", "a0"),
      blockOp("c", "P", "b", "a0"),
      blockOp("d", "P", "b", "a1"),
    );
    const tree = getBlockTree(db, "b")!;
    expect(tree.page.key).toBe("p");
    expect(tree.path).toEqual([{ id: "a", content: "a" }]);
    expect(tree.blocks.map((b) => b.id)).toEqual(["b", "c", "d"]);
    expect(getBlockTree(db, "missing")).toBeNull();
  });

  test("looks blocks up by id instead of scanning them all", () => {
    // Every reference list fetches one subtree per result, so a scan here makes them slow on big graphs.
    const plan = (db.query(`EXPLAIN QUERY PLAN ${SUBTREE}`).all("a") as { detail: string }[]).map((row) => row.detail);
    expect(plan.filter((detail) => detail.startsWith("SCAN blocks"))).toEqual([]);
    expect(plan).toContain("SEARCH blocks USING INDEX sqlite_autoindex_blocks_1 (id=?)");
  });
});

describe("renaming", () => {
  test("moves the page and rewrites every reference to it", () => {
    apply(
      blockOp("x", "Old Name", null, "a0", { content: "on the page" }),
      blockOp("a", "Notes", null, "a0", { content: "[[old name]] and #[[Old Name]] but `[[Old Name]]`" }),
    );
    const outcome = renamePage(db, "Old Name", "New Name");
    expect(outcome.ok).toBe(true);
    expect(outlineOf(db, "new name")).toBe("on the page");
    expect(getPage(db, "Old Name").page).toBeNull();
    expect(db.query("SELECT content FROM blocks WHERE id = 'a'").get()).toEqual({
      content: "[[New Name]] and #[[New Name]] but `[[Old Name]]`",
    });
    expect(refsOf("a")).toEqual(["new name"]);
    if (outcome.ok) {
      expect(outcome.result.removedPages).toEqual(["old name"]);
      expect(outcome.result.rows.map((r) => r.id).sort()).toEqual(["a", "x"]);
    }
  });

  test("changing only the casing keeps the page", () => {
    apply(blockOp("x", "project", null, "a0"));
    expect(renamePage(db, "project", "Project").ok).toBe(true);
    expect(getPage(db, "project").page?.name).toBe("Project");
  });

  test("refuses to rename onto another page, or a page that doesn't exist", () => {
    apply(blockOp("x", "One", null, "a0"), blockOp("y", "Two", null, "a0"));
    expect(renamePage(db, "One", "two")).toEqual({ ok: false, status: 409 });
    expect(renamePage(db, "Missing", "Three")).toEqual({ ok: false, status: 404 });
  });

  test("says what was renamed, so other tabs can follow", () => {
    apply(blockOp("x", "Old", null, "a0"));
    const outcome = renamePage(db, "Old", "New");
    expect(outcome.ok && outcome.result.renamed).toEqual({ from: "old", to: "New" });
  });

  test("rewrites links inside queries too", () => {
    apply(blockOp("x", "Old", null, "a0"), blockOp("q", "Dash", null, "a0", { content: "{{query (and [[Old]] (task TODO))}}" }));
    renamePage(db, "Old", "New");
    expect(db.query("SELECT content FROM blocks WHERE id = 'q'").get()).toEqual({ content: "{{query (and [[New]] (task TODO))}}" });
  });

  test("an edit started before a rename isn't taken for overwriting another device's text", () => {
    // Another device wrote the block; then the page is renamed; then this tab saves its edit, which started before the rename.
    applyBatch(db, { writer: "other", device: "Phone", ops: [blockOp("x", "Old", null, "a0", { content: "draft" })] });
    const base = (db.query("SELECT rev FROM blocks WHERE id = 'x'").get() as { rev: number }).rev;
    renamePage(db, "Old", "New");
    const result = apply(blockOp("x", "New", null, "a0", { content: "draft, edited", base }));
    expect(result.overwrote).toEqual([]);
  });
});
