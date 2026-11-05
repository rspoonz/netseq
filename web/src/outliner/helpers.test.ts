import { describe, expect, test } from "bun:test";
import { keysBetween } from "../../../shared/order";
import { applyCompletion, matchPages, refQueryAt } from "./autocomplete";
import { insertOutline, looksLikeOutline, parseOutline, toMarkdown } from "./clipboard";
import { rawOffset } from "./intents";
import { Outline, topKey } from "./outline";

describe("autocomplete", () => {
  test("finds the name typed inside [[ ]], up to the closing brackets", () => {
    expect(refQueryAt("see [[Pro]]", 9)).toEqual({ kind: "link", start: 6, end: 9, query: "Pro" });
    expect(refQueryAt("see [[Pro", 9)).toEqual({ kind: "link", start: 6, end: 9, query: "Pro" });
    expect(refQueryAt("see [[Project]] done", 9)).toEqual({ kind: "link", start: 6, end: 13, query: "Pro" });
  });

  test("finds a tag being typed", () => {
    expect(refQueryAt("idea #pro", 9)).toEqual({ kind: "tag", start: 6, end: 9, query: "pro" });
    expect(refQueryAt("#", 1)).toEqual({ kind: "tag", start: 1, end: 1, query: "" });
  });

  test("is quiet elsewhere", () => {
    expect(refQueryAt("[[done]] now", 12)).toBeNull();
    expect(refQueryAt("a#b", 3)).toBeNull();
    expect(refQueryAt("# heading", 9)).toBeNull();
  });

  test("puts the chosen page in place of the query", () => {
    expect(applyCompletion("see [[Pro]]!", refQueryAt("see [[Pro]]!", 9)!, "Project X")).toEqual({
      text: "see [[Project X]]!",
      caret: 17,
    });
    expect(applyCompletion("idea #pro", refQueryAt("idea #pro", 9)!, "big project")).toEqual({
      text: "idea #[[big project]] ",
      caret: 22,
    });
  });

  test("finds the search words typed inside (( )), and puts the chosen block's id in their place", () => {
    const id = "6f1c2a7e-3b4d-4c5e-8f90-a1b2c3d4e5f6";
    expect(refQueryAt("see ((launch))", 12)).toEqual({ kind: "block", start: 6, end: 12, query: "launch" });
    expect(applyCompletion("see ((launch))!", refQueryAt("see ((launch))!", 12)!, id)).toEqual({
      text: `see ((${id}))!`,
      caret: 4 + id.length + 4,
    });
    expect(refQueryAt("f((x", 4)).toBeNull(); // only at the start or after a space
    expect(refQueryAt("[[a ((b", 7)?.kind).toBe("block"); // the one opened last
  });

  test("ranks exact, then prefix, then shorter matches", () => {
    expect(matchPages(["Big project", "Project X", "project", "Other"], "project")).toEqual([
      "project",
      "Project X",
      "Big project",
    ]);
  });
});

describe("clicks on rendered text", () => {
  test("map back into the raw text, skipping markup", () => {
    expect(rawOffset("see [[Page]] then", "see Page t")).toBe(14);
    expect(rawOffset("**bold** text", "bold")).toBe(6);
    expect(rawOffset("[[2026-11-02]]", "Mon 2 Nov")).toBe(14);
  });
});

describe("clipboard", () => {
  function outlineOf(...rows: [string, string | null][]): Outline {
    const o = new Outline();
    const keys = keysBetween(null, null, rows.length);
    rows.forEach(([id, parent], i) => o.upsert({ id, page: "p", parent, order_key: keys[i], content: id, collapsed: false, rev: 1 }));
    return o;
  }

  test("copies blocks with their children as a markdown outline", () => {
    const o = outlineOf(["a", null], ["b", "a"], ["c", null]);
    o.upsert({ ...o.get("b")!, content: "two\nlines" });
    expect(toMarkdown(o, ["a", "c"])).toBe("- a\n  - two\n    lines\n- c");
  });

  test("a copied outline parses back to the same blocks", () => {
    expect(parseOutline("- a\n  - two\n    lines\n- c")).toEqual([
      { content: "a", children: [{ content: "two\nlines", children: [] }] },
      { content: "c", children: [] },
    ]);
  });

  test("reads tabs, other bullets and text before the first bullet", () => {
    expect(parseOutline("intro\n* one\n\t+ two")).toEqual([
      { content: "intro", children: [] },
      { content: "one", children: [{ content: "two", children: [] }] },
    ]);
  });

  test("only multi-line text starting with a bullet counts as an outline", () => {
    expect(looksLikeOutline("- a\n- b")).toBe(true);
    expect(looksLikeOutline("- just one")).toBe(false);
    expect(looksLikeOutline("plain\ntext")).toBe(false);
  });

  test("pasting into an empty block fills it, and the rest follow as siblings", () => {
    const o = outlineOf(["a", null], ["x", null]);
    o.upsert({ ...o.get("a")!, content: "" });
    const change = insertOutline(o, "a", parseOutline("- one\n  - child\n- two"))!;
    for (const b of change.upserts) o.upsert(b);
    const text = (key: string, depth = 0): string[] =>
      o.childIds(key).flatMap((id) => ["  ".repeat(depth) + o.get(id)!.content, ...text(id, depth + 1)]);
    expect(text(topKey("p"))).toEqual(["one", "  child", "two", "x"]);
    expect(o.get(change.caret!.id)!.content).toBe("two");
  });

  test("pasting into the block at the top of a zoomed view keeps everything under it", () => {
    const text = (o: Outline, key: string, depth = 0): string[] =>
      o.childIds(key).flatMap((id) => ["  ".repeat(depth) + o.get(id)!.content, ...text(o, id, depth + 1)]);
    const o = outlineOf(["a", null], ["kid", "a"], ["x", null]);
    for (const b of insertOutline(o, "a", parseOutline("- one\n- two"), "a")!.upserts) o.upsert(b);
    expect(text(o, topKey("p"))).toEqual(["a", "  one", "  two", "  kid", "x"]);

    const empty = outlineOf(["a", null], ["kid", "a"], ["x", null]);
    empty.upsert({ ...empty.get("a")!, content: "" });
    for (const b of insertOutline(empty, "a", parseOutline("- one\n- two"), "a")!.upserts) empty.upsert(b);
    expect(text(empty, topKey("p"))).toEqual(["one", "  kid", "  two", "x"]);
  });
});
