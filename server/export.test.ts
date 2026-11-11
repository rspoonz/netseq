import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Op } from "../shared/types";
import { applyBatch } from "./apply";
import { openDb } from "./db";
import { exportMarkdown, pageFile } from "./export";
import { setFavourites } from "./favourites";
import { blockOp, writer } from "./testing";

let db: Database;
let root: string;
let out: string;

beforeEach(() => {
  db = openDb(":memory:");
  root = mkdtempSync(join(tmpdir(), "netseq-export-"));
  out = join(root, "export");
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function apply(...ops: Op[]) {
  return applyBatch(db, { ...writer, ops });
}

const REFERENCED = "0a0a0a0a-0000-4000-8000-00000000000a";

test("pages are written as Logseq outlines: tabs per level, folded and referenced blocks marked", () => {
  apply(
    blockOp(REFERENCED, "Project", null, "a0", { content: "TODO Plan [[Milestone]]" }),
    blockOp("b", "Project", null, "a1", { content: "Details\nsecond line\nstatus:: draft", collapsed: true }),
    blockOp("c", "Project", "b", "a0", { content: "child" }),
    blockOp("d", "Project", "c", "a0", { content: `grandchild, see ((${REFERENCED}))` }),
    blockOp("e", "Project", null, "a2", { content: "folded, but nothing under it", collapsed: true }),
  );
  expect(exportMarkdown(db, out)).toEqual({ pages: 1, blocks: 5, skipped: [] });
  expect(readFileSync(join(out, "pages", "Project.md"), "utf8")).toBe(
    [
      "- TODO Plan [[Milestone]]",
      `  id:: ${REFERENCED}`,
      "- Details",
      "  collapsed:: true",
      "  second line",
      "  status:: draft",
      "\t- child",
      `\t\t- grandchild, see ((${REFERENCED}))`,
      "- folded, but nothing under it",
      "",
    ].join("\n"),
  );
  // "Milestone" exists only because it's linked to: no blocks, so no file.
  expect(readdirSync(join(out, "pages"))).toEqual(["Project.md"]);
});

test("journal days go to journals/, and page names are made safe as file names", () => {
  const page = (name: string, journal_day: number | null = null) => pageFile({ key: name.toLowerCase(), name, journal_day });
  expect(page("2026-11-04", 20261104)).toBe("journals/2026_11_04.md");
  expect(page("Projects/NetSeq")).toBe("pages/Projects___NetSeq.md");
  expect(page('What? "now" 100%')).toBe("pages/What%3F %22now%22 100%25.md");
  expect(page("a:b*c<d>e|f\\g")).toBe("pages/a%3Ab%2Ac%3Cd%3Ee%7Cf%5Cg.md");
  expect(page(".hidden")).toBe("pages/%2Ehidden.md");
  expect(page("Ålesund ✓")).toBe("pages/Ålesund ✓.md");
});

test("favourites are written where Logseq keeps them", () => {
  apply(blockOp("a", "Keep", null, "a0"));
  exportMarkdown(db, out);
  expect(existsSync(join(out, "logseq"))).toBe(false); // nothing to write yet
  setFavourites(db, { pages: ["Keep", 'Say "hi"'] });
  exportMarkdown(db, out);
  expect(readFileSync(join(out, "logseq", "config.edn"), "utf8")).toBe('{:favorites ["keep" "say \\"hi\\""]}\n');
});

test("each export replaces the last one: deleted pages disappear", () => {
  apply(blockOp("a", "Keep", null, "a0"), blockOp("b", "Gone", null, "a0"), blockOp("j", "2026-11-04", null, "a0"));
  exportMarkdown(db, out);
  expect(readdirSync(join(out, "pages")).sort()).toEqual(["Gone.md", "Keep.md"]);
  expect(readdirSync(join(out, "journals"))).toEqual(["2026_11_04.md"]);

  apply({ t: "delete", id: "b" });
  writeFileSync(join(out, "pages", "stray.md"), "written by hand");
  exportMarkdown(db, out);
  expect(readdirSync(join(out, "pages"))).toEqual(["Keep.md"]);
  expect(readdirSync(root).sort()).toEqual(["export"]); // no .tmp or .old left behind
});

test("a page whose file name another page already took is skipped and reported", () => {
  apply(blockOp("a", "A/B", null, "a0", { content: "slash" }), blockOp("b", "a___b", null, "a0", { content: "underscores" }));
  const result = exportMarkdown(db, out);
  expect(result.pages).toBe(1);
  expect(result.skipped).toEqual([{ page: "a___b", reason: "another page is also written as pages/a___b.md" }]);
  expect(readFileSync(join(out, "pages", "A___B.md"), "utf8")).toBe("- slash\n");
  expect(readdirSync(join(out, "pages"))).toEqual(["A___B.md"]); // (asking for a___b.md would find it where file names ignore case)
});

test("a page whose name is too long for a file name is skipped and reported, and the rest are written", () => {
  const long = "x".repeat(300); // file names stop at 255 bytes
  apply(blockOp("a", long, null, "a0", { content: "long" }), blockOp("b", "Short", null, "a0", { content: "short" }));
  const result = exportMarkdown(db, out);
  expect(result).toEqual({ pages: 1, blocks: 1, skipped: [{ page: long, reason: "its name is too long for a file name" }] });
  expect(readFileSync(join(out, "pages", "Short.md"), "utf8")).toBe("- short\n");
  expect(readdirSync(join(out, "pages"))).toEqual(["Short.md"]);
});
