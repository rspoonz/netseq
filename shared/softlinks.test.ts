import { describe, expect, test } from "bun:test";
import { linkMentions, mentions, pageNames, softLinkable, softLinksIn } from "./softlinks";

const names = pageNames(["Alice", "Project", "Project X", "Ålesund", "C++", "Node.js", "2026-11-02", "Al"]);

/** The soft-linked text, each as "text→page". */
function found(text: string): string[] {
  return mentions(text, names).map((m) => `${text.slice(m.start, m.end)}→${m.name}`);
}

describe("mentions", () => {
  const cases: [string, string, string[]][] = [
    ["a plain mention", "Lunch with Alice", ["Alice→Alice"]],
    ["ignoring case", "lunch with ALICE and alice", ["ALICE→Alice", "alice→Alice"]],
    ["whole words only", "Alicea, Malice, Alice_1, Alice2", []],
    ["punctuation ends a word", "(Alice), Alice. Alice's", ["Alice→Alice", "Alice→Alice", "Alice→Alice"]],
    ["the longest name wins", "about Project X and Project Y", ["Project X→Project X", "Project→Project"]],
    ["falls back to a shorter name when the longer one isn't a whole word", "Project Xylophone", ["Project→Project"]],
    ["letters outside ASCII", "trip to Ålesund, not Ålesunds", ["Ålesund→Ålesund"]],
    ["names with punctuation", "learning C++ and Node.js", ["C++→C++", "Node.js→Node.js"]],
    ["not inside links or tags", "[[Alice]] #Alice #[[Project X]] Alice", ["Alice→Alice"]],
    ["not inside markdown links", "[Alice's page](https://example.com) and ![Alice](a.png)", []],
    ["not inside web or e-mail addresses", "https://example.com/Alice and <https://example.com/Alice> alice@example.com", []],
    ["not inside code", "`Alice` and ``Alice` `` then Alice", ["Alice→Alice"]],
    ["not inside fenced code", "```\nAlice\n```\nAlice", ["Alice→Alice"]],
    ["not inside block refs or macros", "((6f1c2a7e-3b4d-4c5e-8f90-a1b2c3d4e5f6)) {{query Alice}}", []],
    ["escapes split words", "\\*Alice\\*", ["Alice→Alice"]],
    ["next to markup", "**Alice** *Project X*", ["Alice→Alice", "Project X→Project X"]],
    ["_ is part of a word, as for unlinked references", "_Alice_ snake_alice", []],
    ["no journal days or very short names", "on 2026-11-02 with Al", []],
  ];
  test.each(cases)("%s", (_, text, expected) => {
    expect(found(text)).toEqual(expected);
  });

  test("positions are in the whole text, across lines", () => {
    const text = "first line\nsecond: Alice";
    expect(mentions(text, names).map((m) => text.slice(m.start, m.end))).toEqual(["Alice"]);
    expect(mentions(text, names)[0].start).toBe(text.indexOf("Alice"));
  });

  test("no names, no mentions", () => {
    expect(mentions("Alice", pageNames([]))).toEqual([]);
  });
});

test("journal days and names under three characters can't soft-link", () => {
  expect(softLinkable("Alice")).toBe(true);
  expect(softLinkable("Ann")).toBe(true);
  expect(softLinkable("Al")).toBe(false);
  expect(softLinkable(" Al ")).toBe(false);
  expect(softLinkable("2026-11-02")).toBe(false);
});

test("a block's task marker, dates and properties aren't soft-linked", () => {
  const todo = pageNames(["todo", "Alice", "draft"]);
  const content = "TODO call Alice about the todo list\nSCHEDULED: <2026-11-02 Mon>\nstatus:: draft\nthen Alice";
  expect(softLinksIn(content, todo).map((m) => content.slice(m.start, m.end))).toEqual(["Alice", "todo", "Alice"]);
  expect(softLinksIn(content, todo)[0].start).toBe(content.indexOf("Alice"));
});

test("linking mentions writes each as a [[link]], keeping the text as written", () => {
  expect(linkMentions("lunch with alice about Project X", names)).toBe("lunch with [[alice]] about [[Project X]]");
  expect(linkMentions("TODO ask Alice\nwho:: Alice", names)).toBe("TODO ask [[Alice]]\nwho:: Alice");
  expect(linkMentions("[[Alice]] and Alice", names)).toBe("[[Alice]] and [[Alice]]");
  expect(linkMentions("nothing here", names)).toBe("nothing here");
});
