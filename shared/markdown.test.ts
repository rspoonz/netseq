import { describe, expect, test } from "bun:test";
import MarkdownIt from "markdown-it";
import { renderBlock, renderMarkdown } from "./markdown";
import { pageNames, softLinksIn } from "./softlinks";

test("a task gets a checkbox and its marker, and DONE is checked", () => {
  expect(renderBlock("TODO buy milk")).toBe(
    '<div class="task task-todo"><input type="checkbox" class="task-check" aria-label="Done"><span class="marker">TODO</span>' +
      '<div class="task-text"><p>buy milk</p></div></div>',
  );
  expect(renderBlock("DONE buy milk")).toContain('aria-label="Done" checked>');
  expect(renderBlock("CANCELED buy milk")).not.toContain("checkbox");
});

test("priorities show as badges", () => {
  expect(renderBlock("[#A] urgent")).toBe('<p><span class="priority priority-a" title="Priority A">A</span> urgent</p>');
});

test("dates link to their journal day, and properties show as a list", () => {
  const html = renderBlock("call Ann\nSCHEDULED: <2026-11-02 Mon>\nwho:: [[Ann]]");
  expect(html).toContain('<div class="task-dates"><span class="task-date">Scheduled: <a class="date-ref" href="/page/2026-11-02" data-page="2026-11-02">');
  expect(html).toContain('<dl class="props"><div><dt>who</dt><dd><a class="page-ref" href="/page/Ann" data-page="Ann">Ann</a></dd></div></dl>');
});

test("links to the page being viewed are marked as the current page, whatever their casing", () => {
  const current = (html: string) => [...html.matchAll(/data-page="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
  const content = "[[Yvonne]] met [[Ann]] and [[yvonne]] #Yvonne\nwho:: [[Yvonne]]";
  expect(current(renderBlock(content, undefined, "yvonne"))).toEqual(["Yvonne", "yvonne", "Yvonne", "Yvonne"]);
  expect(renderBlock(content)).not.toContain("aria-current");
  // A task on its own journal day: the date links back to the page being viewed.
  expect(current(renderBlock("TODO call\nSCHEDULED: <2026-11-02 Mon>", undefined, "2026-11-02"))).toEqual(["2026-11-02"]);
});

test("property keys and values are escaped", () => {
  expect(renderBlock("k:: <img src=x onerror=alert(1)>")).toContain("<dd>&lt;img src=x onerror=alert(1)&gt;</dd>");
});

const TARGET = "6f1c2a7e-3b4d-4c5e-8f90-a1b2c3d4e5f6";

test("a block reference shows the referenced block's first line", () => {
  const texts: Record<string, string | null> = { [TARGET]: "TODO **call** [[Ann]]\nSCHEDULED: <2026-11-02 Mon>\nmore" };
  expect(renderBlock(`see ((${TARGET}))`, (id) => texts[id])).toBe(
    `<p>see <a class="block-ref" href="/b/${TARGET}" data-block-ref="${TARGET}"><strong>call</strong> ` +
      '<span class="page-ref">Ann</span></a></p>',
  );
});

test("a block reference to a heading shows its words, without the #s", () => {
  expect(renderBlock(`((${TARGET}))`, () => "## Meeting notes")).toBe(
    `<p><a class="block-ref" href="/b/${TARGET}" data-block-ref="${TARGET}">Meeting notes</a></p>`,
  );
});

test("links inside a block reference are text, so the whole reference leads to its block", () => {
  const html = renderBlock(`((${TARGET}))`, () => "https://example.com/music and [docs](https://example.com/docs) #tag");
  expect(html).toBe(
    `<p><a class="block-ref" href="/b/${TARGET}" data-block-ref="${TARGET}"><span class="ref-link">https://example.com/music</span> and ` +
      '<span class="ref-link">docs</span> <span class="tag">#tag</span></a></p>',
  );
  expect(html.match(/<a /g)).toHaveLength(1); // the reference itself is the only link
  // Outside references they're links that leave the app (shown with a ↗).
  expect(renderBlock("https://example.com/music")).toBe(
    '<p><a href="https://example.com/music" target="_blank" rel="noopener noreferrer" class="external">https://example.com/music</a></p>',
  );
  expect(renderBlock("[[Page]] #tag")).not.toContain("external");
});

test("a block reference that's loading, missing, or inside another one isn't expanded", () => {
  expect(renderBlock(`((${TARGET}))`, () => undefined)).toBe(`<p><a class="block-ref" href="/b/${TARGET}" data-block-ref="${TARGET}">…</a></p>`);
  expect(renderBlock(`((${TARGET}))`, () => null)).toContain("missing block");
  // A block that references itself shows its text once, not forever.
  const self = `loop ((${TARGET}))`;
  expect(renderBlock(self, () => self)).toBe(
    `<p>loop <a class="block-ref" href="/b/${TARGET}" data-block-ref="${TARGET}">loop <span class="block-ref">…</span></a></p>`,
  );
});

test("referenced text is escaped like any other", () => {
  expect(renderBlock(`((${TARGET}))`, () => "<script>x</script>")).toContain("&lt;script&gt;x&lt;/script&gt;");
});

test("ordinary markdown renders exactly as stock markdown-it does (we replaced its text rule)", () => {
  const stock = new MarkdownIt({ html: false, linkify: true, breaks: true });
  const samples = [
    "plain (parenthesised) text, with: punctuation! and 100% & more ~ ^ = + -",
    "*em* **strong** `code` ~~gone~~ [link](https://example.com/a_(b)) ![img](x.png)",
    "(((nested))) (( spaced )) ((not-a-uuid)) f(x) = (a + b)",
    "line one\nline two\n\n- a list\n- (item)\n\n> quote (with parens)",
    "https://example.com/path_(x) and <angle> &amp; \\*escaped\\*",
  ];
  for (const sample of samples) {
    // Our only intended difference: links open in a new tab, marked as leaving the app.
    const ours = renderMarkdown(sample).replaceAll(' target="_blank" rel="noopener noreferrer" class="external"', "");
    expect(ours).toBe(stock.render(sample).trimEnd());
  }
});

describe("soft links", () => {
  const names = pageNames(["Alice", "Project X", "Project", "Bob Smith"]);
  const soft = (html: string) => [...html.matchAll(/<a class="soft-ref" [^>]*data-page="([^"]*)">([^<]*)<\/a>/g)].map((m) => `${m[2]}→${m[1]}`);

  test("a mention of a page's name links to it, showing the text as written", () => {
    expect(renderBlock("lunch with alice about Project X", undefined, undefined, names)).toBe(
      '<p>lunch with <a class="soft-ref" href="/page/Alice" data-page="Alice">alice</a> about ' +
        '<a class="soft-ref" href="/page/Project%20X" data-page="Project X">Project X</a></p>',
    );
  });

  test("not in properties, or text inside a ((reference))", () => {
    expect(soft(renderBlock("Alice\nwho:: Alice", undefined, undefined, names))).toEqual(["Alice→Alice"]);
    expect(soft(renderBlock(`see ((${TARGET}))`, () => "Alice", undefined, names))).toEqual([]);
  });

  test("a mention of the page being viewed is a soft link too, marked as the current page", () => {
    expect(renderBlock("ask alice", undefined, "alice", names)).toBe(
      '<p>ask <a class="soft-ref" href="/page/Alice" data-page="Alice" aria-current="page">alice</a></p>',
    );
  });

  test("the renderer links exactly what Link mentions would link", () => {
    const samples = [
      "TODO [#A] call Alice about Project X\nSCHEDULED: <2026-11-02 Mon>\nstatus:: Alice",
      "# Alice\n\n- Project X\n- *Alice* and **Project**\n\n> Bob Smith said",
      "[Alice](https://example.com) [[Alice]] #Alice `Alice` https://example.com/Alice Alice",
      "| who | what |\n| --- | --- |\n| Alice | Project X |",
      "```\nAlice\n```\nAlice\\\nBob Smith\nBob\nSmith",
      "{{query Alice}} ((6f1c2a7e-3b4d-4c5e-8f90-a1b2c3d4e5f6)) Alice&amp;Bob Smith <b>Alice</b>",
    ];
    for (const content of samples) {
      const linked = softLinksIn(content, names).map((m) => `${content.slice(m.start, m.end)}→${m.name}`);
      expect(soft(renderBlock(content, () => "x", undefined, names))).toEqual(linked);
    }
  });

  test("an image's description keeps its text", () => {
    const content = "![photo of Alice at the beach](https://example.com/a.png)";
    expect(renderBlock(content, undefined, undefined, names)).toBe(renderBlock(content));
    expect(renderBlock(content, undefined, undefined, names)).toContain('alt="photo of Alice at the beach"');
  });

  test("without names, nothing changes", () => {
    const content = "lunch with Alice";
    expect(renderBlock(content, undefined, undefined, pageNames([]))).toBe(renderBlock(content));
  });
});
