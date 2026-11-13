import { describe, expect, test } from "bun:test";
import { keysBetween } from "../../../shared/order";
import * as intents from "./intents";
import { Outline, topKey } from "./outline";

const PAGE = "test";

/**
 * Builds an outline from indented text. Each line's text is also the block's id, and a
 * trailing "+" marks a collapsed block.
 */
function outlineOf(text: string): Outline {
  const o = new Outline();
  const path: string[] = [];
  const lastKey = new Map<string, string>();
  for (const line of text.trim().split("\n")) {
    const depth = (line.length - line.trimStart().length) / 2;
    const collapsed = line.trim().endsWith("+");
    const id = line.trim().replace(/\+$/, "");
    path.length = depth;
    const parent = depth === 0 ? null : path[depth - 1];
    const listKey = parent ?? topKey(PAGE);
    const [order_key] = keysBetween(lastKey.get(listKey) ?? null, null, 1);
    lastKey.set(listKey, order_key);
    o.upsert({ id, page: PAGE, parent, order_key, content: id, collapsed, rev: 1 });
    path.push(id);
  }
  return o;
}

/** A page's outline as indented text again; empty blocks show as "·". */
function textOf(o: Outline, page = PAGE): string {
  const lines: string[] = [];
  const walk = (key: string, depth: number) => {
    for (const id of o.childIds(key)) {
      const b = o.get(id)!;
      lines.push("  ".repeat(depth) + (b.content || "·") + (b.collapsed ? "+" : ""));
      walk(id, depth + 1);
    }
  };
  walk(topKey(page), 0);
  return lines.join("\n");
}

/** Applies a change the way the app does: writes first, then deletes. */
function apply(o: Outline, change: intents.Change | null): intents.Change {
  if (!change) throw new Error("expected a change");
  for (const b of change.upserts) o.upsert(b);
  for (const id of change.deletes) o.remove(id);
  return change;
}

describe("split (Enter)", () => {
  test("splits the text at the caret, and the caret moves to the new block", () => {
    const o = outlineOf("hello");
    const change = apply(o, intents.split(o, "hello", 2, 2));
    expect(textOf(o)).toBe("he\nllo");
    expect(o.get(change.caret!.id)?.content).toBe("llo");
  });

  test("drops the selected text", () => {
    const o = outlineOf("hello");
    apply(o, intents.split(o, "hello", 1, 4));
    expect(textOf(o)).toBe("h\no");
  });

  test("at the very start, opens an empty block above and keeps the caret", () => {
    const o = outlineOf("a\nb");
    const change = apply(o, intents.split(o, "b", 0, 0));
    expect(textOf(o)).toBe("a\n·\nb");
    expect(change.caret).toEqual({ id: "b", offset: 0 });
  });

  test("with children showing, the new block becomes the first child", () => {
    const o = outlineOf("a\n  b");
    apply(o, intents.split(o, "a", 1, 1));
    expect(textOf(o)).toBe("a\n  ·\n  b");
  });

  test("with children collapsed, the new block goes after them", () => {
    const o = outlineOf("a+\n  b\nc");
    apply(o, intents.split(o, "a", 1, 1));
    expect(textOf(o)).toBe("a+\n  b\n·\nc");
  });

  test("in an empty nested block, outdents instead", () => {
    const o = outlineOf("a\n  b");
    apply(o, intents.setContent(o, "b", ""));
    apply(o, intents.split(o, "b", 0, 0));
    expect(textOf(o)).toBe("a\n·");
  });
});

describe("indent and outdent (Tab, Shift+Tab)", () => {
  test("indent makes the block the last child of its previous sibling", () => {
    const o = outlineOf("a\n  x\nb");
    apply(o, intents.indent(o, "b", 0));
    expect(textOf(o)).toBe("a\n  x\n  b");
  });

  test("indenting into a collapsed block expands it", () => {
    const o = outlineOf("a+\n  x\nb");
    apply(o, intents.indent(o, "b", 0));
    expect(textOf(o)).toBe("a\n  x\n  b");
  });

  test("the first block can't be indented", () => {
    expect(intents.indent(outlineOf("a\nb"), "a", 0)).toBeNull();
  });

  test("outdent moves the block after its parent and adopts the siblings that followed it", () => {
    const o = outlineOf("a\n  b\n  c\n    c1\n  d\ne");
    apply(o, intents.outdent(o, "c", 0));
    expect(textOf(o)).toBe("a\n  b\nc\n  c1\n  d\ne");
  });

  test("a top-level block can't be outdented", () => {
    expect(intents.outdent(outlineOf("a"), "a", 0)).toBeNull();
  });
});

describe("merging (Backspace at the start, Delete at the end)", () => {
  test("Backspace joins the text onto the block above, caret at the join", () => {
    const o = outlineOf("ab\ncd");
    const change = apply(o, intents.mergeWithPrevious(o, "cd"));
    expect(textOf(o)).toBe("abcd");
    expect(change.caret).toEqual({ id: "ab", offset: 2 });
  });

  test("Backspace in an empty block deletes it", () => {
    const o = outlineOf("a\nb");
    apply(o, intents.setContent(o, "b", ""));
    expect(apply(o, intents.mergeWithPrevious(o, "b")).caret).toEqual({ id: "a", offset: 1 });
    expect(textOf(o)).toBe("a");
  });

  test("Backspace in a block of only spaces deletes it too", () => {
    const o = outlineOf("a\nb");
    apply(o, intents.setContent(o, "b", "  "));
    expect(apply(o, intents.mergeWithPrevious(o, "b")).caret).toEqual({ id: "a", offset: 1 });
    expect(textOf(o)).toBe("a");
  });

  test("merging a first child into its parent keeps its children in its place", () => {
    const o = outlineOf("a\n  b\n    x\n  c");
    apply(o, intents.mergeWithPrevious(o, "b"));
    expect(textOf(o)).toBe("ab\n  x\n  c");
  });

  test("the block above can be deep inside the previous sibling", () => {
    const o = outlineOf("a\n  a1\nb\n  b1");
    apply(o, intents.mergeWithPrevious(o, "b"));
    expect(textOf(o)).toBe("a\n  a1b\n    b1");
  });

  test("nothing happens at the first block", () => {
    expect(intents.mergeWithPrevious(outlineOf("a\nb"), "a")).toBeNull();
  });

  test("Delete pulls in the next block", () => {
    const o = outlineOf("a\nb");
    apply(o, intents.mergeNext(o, "a"));
    expect(textOf(o)).toBe("ab");
  });

  test("Delete pulls in a first child, whose children move up a level", () => {
    const o = outlineOf("a\n  b\n    x");
    apply(o, intents.mergeNext(o, "a"));
    expect(textOf(o)).toBe("ab\n  x");
  });
});

describe("moving and collapsing", () => {
  test("move up and down swap places with a sibling", () => {
    const o = outlineOf("a\nb\nc");
    apply(o, intents.moveUp(o, "c", 0));
    expect(textOf(o)).toBe("a\nc\nb");
    apply(o, intents.moveDown(o, "a", 0));
    expect(textOf(o)).toBe("c\na\nb");
  });

  test("moves stop at the ends of the list", () => {
    const o = outlineOf("a\nb");
    expect(intents.moveUp(o, "a", 0)).toBeNull();
    expect(intents.moveDown(o, "b", 0)).toBeNull();
  });

  test("only blocks with children can collapse", () => {
    const o = outlineOf("a\n  b");
    apply(o, intents.setCollapsed(o, "a", true));
    expect(textOf(o)).toBe("a+\n  b");
    expect(intents.setCollapsed(o, "b", true)).toBeNull();
  });
});

describe("moving to a page", () => {
  test("a block and everything under it go to the end of the other page's top level", () => {
    const o = outlineOf("a\nb+\n  c\n    d\ne");
    o.upsert({ id: "x", page: "other", parent: null, order_key: "a0", content: "x", collapsed: false, rev: 1 });
    const change = apply(o, intents.moveToPage(o, "b", "other"));
    expect(textOf(o)).toBe("a\ne");
    expect(textOf(o, "other")).toBe("x\nb+\n  c\n    d");
    expect(["b", "c", "d"].map((id) => o.get(id)?.page)).toEqual(["other", "other", "other"]);
    expect(change.upserts.map((b) => b.id)).toEqual(["b", "c", "d"]); // every one of them, so undo puts them all back
    expect(change.caret).toBeUndefined();
  });

  test("to an empty page, and to its own page's top level", () => {
    const o = outlineOf("a\n  b\n    c\nd");
    apply(o, intents.moveToPage(o, "b", PAGE));
    expect(textOf(o)).toBe("a\nd\nb\n  c");
    apply(o, intents.moveToPage(o, "a", "new"));
    expect(textOf(o, "new")).toBe("a");
  });

  test("nothing to do when it's already last on that page's top level, or doesn't exist", () => {
    const o = outlineOf("a\nb");
    expect(intents.moveToPage(o, "b", PAGE)).toBeNull();
    expect(intents.moveToPage(o, "nope", PAGE)).toBeNull();
  });
});

describe("navigating", () => {
  test("previous and next visible block skip collapsed children", () => {
    const o = outlineOf("a+\n  x\nb\n  y\nc");
    expect(intents.previousVisible(o, "b")?.id).toBe("a");
    expect(intents.nextVisible(o, "a")?.id).toBe("b");
    expect(intents.nextVisible(o, "y")?.id).toBe("c");
    expect(intents.previousVisible(o, "c")?.id).toBe("y");
    expect(intents.previousVisible(o, "a")).toBeUndefined();
    expect(intents.nextVisible(o, "c")).toBeUndefined();
  });

  test("the caret keeps its column when moving between blocks", () => {
    expect(intents.columnTarget("abcdef", 3, "xy\nlonger line", "up")).toBe(6);
    expect(intents.columnTarget("ab\ncdef", 5, "x", "down")).toBe(1);
    expect(intents.columnTarget("\nabc", 0, "hello", "down")).toBe(0);
  });
});

describe("tasks", () => {
  function block(content: string): Outline {
    const o = new Outline();
    o.upsert({ id: "a", page: PAGE, parent: null, order_key: "a0", content, collapsed: false, rev: 1 });
    return o;
  }

  test("Mod+Enter cycles the marker and keeps the caret by the same text", () => {
    const change = intents.cycleMarker(block("TODO buy milk"), "a", 8); // after "buy"
    expect(change?.upserts[0].content).toBe("DOING buy milk");
    expect(change?.caret).toEqual({ id: "a", offset: 9 });
    expect(intents.cycleMarker(block("DONE x"), "a", 0)?.upserts[0].content).toBe("x");
    expect(intents.cycleMarker(block("x"), "a", 1)?.caret?.offset).toBe(6);
  });

  test("the checkbox toggles between DONE and TODO", () => {
    expect(intents.toggleDone(block("DOING x"), "a")?.upserts[0].content).toBe("DONE x");
    expect(intents.toggleDone(block("DONE x"), "a")?.upserts[0].content).toBe("TODO x");
  });
});

describe("inside a view of one block and what's under it (scope)", () => {
  // Zoomed into b: a and e are on the page but not on screen.
  const page = "a\nb\n  c\n  d\ne";

  test("edits at the edges don't reach blocks outside the view", () => {
    const o = outlineOf(page);
    expect(intents.mergeWithPrevious(o, "b", "b")).toBeNull();
    expect(intents.indent(o, "b", 0, "b")).toBeNull();
    expect(intents.outdent(o, "b", 0, "b")).toBeNull();
    expect(intents.outdent(o, "c", 0, "b")).toBeNull(); // would make c a sibling of b, off screen
    expect(intents.moveUp(o, "b", 0, "b")).toBeNull();
    expect(intents.moveDown(o, "b", 0, "b")).toBeNull();
    expect(intents.mergeNext(o, "d", "b")).toBeNull();
    expect(intents.nextVisible(o, "d", "b")).toBeUndefined();
  });

  test("edits inside the view work as usual", () => {
    const o = outlineOf(page);
    expect(intents.previousVisible(o, "c", "b")?.id).toBe("b");
    apply(o, intents.mergeWithPrevious(o, "c", "b"));
    expect(textOf(o)).toBe("a\nbc\n  d\ne");
  });

  test("Enter on the top block adds a first child, so it's on screen", () => {
    const o = outlineOf(page);
    apply(o, intents.split(o, "b", 1, 1, "b"));
    expect(textOf(o)).toBe("a\nb\n  ·\n  c\n  d\ne");
    const at = outlineOf(page);
    apply(at, intents.split(at, "b", 0, 0, "b")); // at the very start the text stays put
    expect(textOf(at)).toBe("a\nb\n  ·\n  c\n  d\ne");
  });
});
