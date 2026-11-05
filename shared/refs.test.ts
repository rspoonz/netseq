import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";
import { blockRefsIn, extractRefs, formatRef, pageNameProblem, queriesIn, renameRefs } from "./refs";

// One table pins the syntax, and checks that indexing (extractRefs) and rendering agree.
const cases: [string, string, string[]][] = [
  ["page link", "see [[Project X]] today", ["Project X"]],
  ["spaces inside the brackets are trimmed", "[[ Project X ]]", ["Project X"]],
  ["tag", "#idea and more", ["idea"]],
  ["tag after an opening parenthesis", "(#idea)", ["idea"]],
  ["trailing punctuation isn't part of a tag", "see #todo, #later.", ["todo", "later"]],
  ["multi-word tag", "#[[big idea]]", ["big idea"]],
  ["a heading is not a tag", "# Heading", []],
  ["# inside a word or URL is not a tag", "a#b https://example.com/#anchor", []],
  ["empty brackets", "[[]] and [[ ]]", []],
  ["unclosed brackets", "[[open", []],
  ["nested brackets link only the inner page", "[[a [[b]]]]", ["b"]],
  ["inline code is skipped", "`[[not a link]]` but [[link]]", ["link"]],
  ["fenced code is skipped", "```\n[[not a link]] #nope\n```\n[[after]]", ["after"]],
  ["escaped brackets are skipped", "\\[[not a link]]", []],
  ["each page once, by name ignoring case", "[[Foo]] [[foo]] #FOO", ["Foo"]],
];

describe("references", () => {
  test.each(cases)("%s", (_, content, refs) => {
    expect(extractRefs(content)).toEqual(refs);
    // The renderer links exactly the same pages.
    const linked = [...renderMarkdown(content).matchAll(/data-page="([^"]*)"/g)].map((m) => m[1]);
    expect([...new Set(linked.map((name) => name.toLowerCase()))]).toEqual(refs.map((name) => name.toLowerCase()));
  });
});

describe("renameRefs", () => {
  test("rewrites links and tags to the page, matching its name case-insensitively", () => {
    expect(renameRefs("[[old]] #Old #[[old]] [[Other]]", "Old", "New")).toBe("[[New]] #New #[[New]] [[Other]]");
  });

  test("rewrites links and tags inside queries, but not quoted text", () => {
    expect(renameRefs('{{query (and [[Old]] #old "old")}} [[old]]', "old", "New")).toBe('{{query (and [[New]] #New "old")}} [[New]]');
    expect(renameRefs("{{query #old}}", "old", "New")).toBe("{{query #New}}");
  });

  test("a tag whose new name has spaces uses brackets", () => {
    expect(renameRefs("#old", "old", "New name")).toBe("#[[New name]]");
  });

  test("leaves code alone", () => {
    expect(renameRefs("`[[old]]` [[old]]", "old", "new")).toBe("`[[old]]` [[new]]");
  });

  test("formatRef picks the shortest form that still parses", () => {
    expect(formatRef("idea", "tag")).toBe("#idea");
    expect(formatRef("two words", "tag")).toBe("#[[two words]]");
    expect(formatRef("two words", "link")).toBe("[[two words]]");
  });
});

describe("renderMarkdown", () => {
  test("page links point into the app; journal links show a friendly date", () => {
    const html = renderMarkdown("[[Project X]] [[2026-11-02]]");
    expect(html).toContain('<a class="page-ref" href="/page/Project%20X" data-page="Project X">Project X</a>');
    expect(html).toContain('data-page="2026-11-02">');
    expect(html).not.toContain(">2026-11-02<");
  });

  test("tags keep their #", () => {
    expect(renderMarkdown("#idea")).toContain('class="tag" href="/page/idea" data-page="idea">#idea</a>');
  });

  test("raw HTML is escaped and javascript: links aren't links", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> [click](javascript:alert(1))');
    expect(html).not.toContain("<img");
    expect(html).not.toContain('href="javascript');
  });

  test("ordinary links open in a new tab", () => {
    expect(renderMarkdown("[site](https://example.com)")).toContain('target="_blank" rel="noopener noreferrer"');
  });

  test("line breaks inside a block are kept", () => {
    expect(renderMarkdown("one\ntwo")).toContain("one<br>");
  });
});

describe("macros", () => {
  test("links inside a macro are part of it, not references", () => {
    expect(extractRefs("{{query (and [[Project]] (task TODO))}} and [[Real]]")).toEqual(["Real"]);
    expect(renderMarkdown("{{query [[Project]]}}")).toBe('<p><code class="macro">{{query [[Project]]}}</code></p>');
  });

  test("queriesIn finds each query's text, outside code", () => {
    expect(queriesIn("{{query [[a]]}} then {{ query (task TODO) }} and `{{query no}}` {{embed x}}")).toEqual([
      "[[a]]",
      "(task TODO)",
    ]);
    expect(queriesIn("{{query}} {{query unclosed")).toEqual([]);
  });
});

describe("block references", () => {
  const id = "6f1c2a7e-3b4d-4c5e-8f90-a1b2c3d4e5f6";

  test("((id)) refers to a block; other text in double parentheses doesn't", () => {
    expect(blockRefsIn(`see ((${id})) and ((${id.toUpperCase()}))`)).toEqual([id]);
    expect(blockRefsIn("((sic)) ((not-a-uuid)) (( ))")).toEqual([]);
  });

  test("references in code or inside macros don't count, and aren't page references", () => {
    expect(blockRefsIn(`\`((${id}))\` {{embed ((${id}))}}`)).toEqual([]);
    expect(extractRefs(`((${id}))`)).toEqual([]);
  });
});

describe("page names", () => {
  test("a page name has to survive being written as a link", () => {
    expect(pageNameProblem("Project X")).toBeNull();
    expect(pageNameProblem("a [b] c")).toBeNull();
    for (const name of ["Foo]]", "a [[b", "two\nlines", "ends]", "  "]) expect(pageNameProblem(name), name).not.toBeNull();
  });
});
