import { expect, type Page, test } from "@playwright/test";
import { keysBetween } from "../shared/order";
import { createPage, expectSaved, openFreshPage, outlineText, startWriting, unique } from "./helpers";

function row(page: Page, text: string) {
  return page.locator(".block-row").filter({ has: page.locator(".block-content", { hasText: new RegExp(`^${text}$`) }) });
}

test("typing [[ suggests pages, and the link leads to a page listing the reference", async ({ page, request }) => {
  const target = unique("Target");
  await createPage(request, target, ["the target page"]);
  await openFreshPage(page);
  await startWriting(page);

  await page.keyboard.type(`see [[${target}`);
  await expect(page.getByRole("option", { name: target, exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("textarea.block-editor")).toHaveValue(`see [[${target}]]`);
  await page.keyboard.press("Escape");
  await expectSaved(page);

  await page.locator(".block-content a.page-ref").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(target);
  await expect(page.locator(".linked-refs h2")).toHaveText("1 linked reference");
  await expect(page.locator(".linked-refs .block-content")).toHaveText(`see ${target}`);
});

test("a new tag can be typed with #", async ({ page }) => {
  const tag = unique("idea").toLowerCase();
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type(`thought #${tag}`);
  await expect(page.getByRole("option", { name: `New page: ${tag}` })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("textarea.block-editor")).toHaveValue(`thought #${tag} `);
  await page.keyboard.press("Escape");
  await expect(page.locator(".block-content a.tag")).toHaveText(`#${tag}`);
});

test("renaming a page rewrites the links to it", async ({ page, request }) => {
  const [oldName, newName, source, taken] = [unique("Old"), unique("Renamed"), unique("Source"), unique("Taken")];
  await createPage(request, oldName, ["page content"]);
  await createPage(request, source, [`mentions [[${oldName}]]`]);
  await createPage(request, taken, ["already here"]);
  await page.goto(`/page/${encodeURIComponent(oldName)}`);
  await expect(page.locator(".linked-refs .block-content")).toHaveText(`mentions ${oldName}`);

  // A name that's taken is refused.
  await page.getByRole("heading", { level: 1 }).click();
  await page.getByLabel("Page name").fill(taken);
  await page.keyboard.press("Enter");
  await expect(page.getByText(`A page called "${taken}" already exists.`)).toBeVisible();

  await page.getByRole("heading", { level: 1 }).click();
  await page.getByLabel("Page name").fill(newName);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(newName);
  expect(decodeURIComponent(new URL(page.url()).pathname)).toBe(`/page/${newName}`);
  expect(await outlineText(page)).toBe("page content");
  await expect(page.locator(".linked-refs .block-content")).toHaveText(`mentions ${newName}`);

  await page.goto(`/page/${encodeURIComponent(source)}`);
  await expect(page.locator(".block-content")).toHaveText([`mentions ${newName}`]);
});

test("a bullet zooms into its block, under a breadcrumb trail", async ({ page }) => {
  const name = await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("parent");
  await page.keyboard.press("Enter");
  await page.keyboard.type("child");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.type("grandchild");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expectSaved(page);

  await row(page, "child").getByLabel("Zoom in").click();
  await expect(page.locator(".zoom-header .crumbs")).toHaveText(`${name}›parent`);
  expect(await outlineText(page)).toBe("child\n  grandchild");

  await page.locator(".zoom-header .crumbs").getByRole("link", { name: "parent" }).click();
  await expect.poll(() => outlineText(page)).toBe("parent\n  child\n    grandchild");
});

test("Esc selects a block, Shift+arrows extend the selection, Backspace deletes it", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  for (const [i, text] of ["a", "b", "c"].entries()) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(text);
  }
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await expect(page.locator(".block-row.selected")).toHaveCount(1);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator(".block-row.selected")).toHaveCount(2);

  await page.keyboard.press("Backspace");
  expect(await outlineText(page)).toBe("c");
  await expectSaved(page);
  await page.reload();
  await expect(page.locator(".block-content")).toHaveText(["c"]);
});

test("selected blocks copy as a markdown outline, and an outline pastes as blocks", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("- one\n  - two");

  // Paste it into a new block at the end.
  await row(page, "two").locator(".block-content").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await page.locator("textarea.block-editor").evaluate((editor, text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    editor.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, "- pasted\n  - nested\n- second");
  expect(await outlineText(page)).toBe("one\ntwo\npasted\n  nested\nsecond");
});

test("editing at the edges of a zoomed-in block stays inside it", async ({ page }) => {
  const name = await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("above");
  await page.keyboard.press("Enter");
  await page.keyboard.type("zoomed");
  await page.keyboard.press("Enter");
  await page.keyboard.type("child");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expectSaved(page);

  // The page is loaded, so the block above "zoomed" is in memory, just not on screen.
  await row(page, "zoomed").getByLabel("Zoom in").click();
  expect(await outlineText(page)).toBe("zoomed\n  child");
  const editor = page.locator("textarea.block-editor");

  await row(page, "zoomed").locator(".block-content").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace"); // nothing above it here to join onto
  await page.keyboard.press("ArrowUp"); // nor to move to
  await expect(editor).toHaveValue("zoomed");

  await page.keyboard.press("End");
  await page.keyboard.press("Enter"); // a new first child, on screen
  await page.keyboard.type("new");
  expect(await outlineText(page)).toBe("zoomed\n  new\n  child");

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+Tab"); // would move "child" out of view
  await page.keyboard.press("End");
  await page.keyboard.press("Delete"); // nothing below it here to pull in
  await page.keyboard.press("ArrowDown");
  await expect(editor).toHaveValue("child");
  await page.keyboard.press("Escape");
  await expectSaved(page);

  await page.goto(`/page/${encodeURIComponent(name)}`);
  await expect.poll(() => outlineText(page)).toBe("above\nzoomed\n  new\n  child");
});

test("a page name that can't be written as a link is refused", async ({ page, request }) => {
  const name = unique("Named");
  await createPage(request, name, ["content"]);
  await page.goto(`/page/${encodeURIComponent(name)}`);
  await page.getByRole("heading", { level: 1 }).click();
  await page.getByLabel("Page name").fill(`${name}]]`);
  await page.keyboard.press("Enter");
  await expect(page.getByText("Page names can't contain [[, ]], line breaks or end with ].")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
});

test("the Pages tab lists pages created elsewhere without a reload", async ({ page, request }) => {
  await page.goto("/pages");
  await expect(page.locator(".topbar").getByRole("link", { name: "Pages", exact: true })).toHaveAttribute("aria-current", "page");
  const name = unique("Brand new");
  await createPage(request, name, ["hello"]);
  await expect(page.getByRole("link", { name })).toBeVisible();
});

test("breadcrumb steps show a block's words, not its heading marks, task marker or dates", async ({ page, request }) => {
  const name = unique("Crumb labels");
  const [heading, task, detail] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const op = (id: string, parent: string | null, content: string) => ({
    t: "block", id, page: name, parent, order_key: "a0", content, collapsed: false, base: 0,
  });
  const ops = [
    op(heading, null, "## Meeting notes"),
    op(task, heading, "TODO [#A] call **Ann**\nSCHEDULED: <2026-11-16 Mon>"),
    op(detail, task, "detail"),
  ];
  expect((await request.post("/api/batch", { data: { writer: "e2e", device: "Playwright", ops } })).ok()).toBe(true);

  await page.goto(`/b/${detail}`);
  await expect(page.locator(".zoom-header .crumbs")).toHaveText(`${name}›Meeting notes›call Ann`);
});

test("the page in a zoomed-in block's breadcrumbs opens the page at that block", async ({ page, request }) => {
  const name = unique("Long page");
  const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const op = (id: string, parent: string | null, order_key: string, content: string, collapsed = false) => ({
    t: "block", id, page: name, parent, order_key, content, collapsed, base: 0,
  });
  const [folder, target] = [crypto.randomUUID(), crypto.randomUUID()];
  const ops = Array.from({ length: 40 }, (_, i) => op(crypto.randomUUID(), null, `a${base62[i]}`, `filler ${i}`));
  ops.push(op(folder, null, `a${base62[40]}`, "folder", true), op(target, folder, "a0", "the one we want"));
  expect((await request.post("/api/batch", { data: { writer: "e2e", device: "Playwright", ops } })).ok()).toBe(true);

  await page.goto(`/b/${target}`);
  await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name }).click();
  await expect(page).toHaveURL(`/page/${encodeURIComponent(name)}`); // ?block= is gone once shown
  const row = page.locator(`.block-row[data-block="${target}"]`);
  await expect(row).toBeInViewport(); // scrolled to, and its collapsed parent opened
  await expect(row).toHaveClass(/revealed/);
  await expectSaved(page);
  await page.reload();
  await expect(row).toBeVisible(); // the parent stays open
});

test("Shift+click on a page link in a block is left to the browser (a new window)", async ({ page, context, request }) => {
  const [target, source] = [unique("Window target"), unique("Window source")];
  await createPage(request, target, ["here"]);
  await createPage(request, source, [`go to [[${target}]]`]);
  await page.goto(`/page/${encodeURIComponent(source)}`);
  const [win] = await Promise.all([context.waitForEvent("page"), page.getByRole("link", { name: target }).click({ modifiers: ["Shift"] })]);
  await expect(win).toHaveURL(`/page/${encodeURIComponent(target)}`);
  await expect(page).toHaveURL(`/page/${encodeURIComponent(source)}`);
});

test("the page step in a reference's breadcrumb opens the page at that reference", async ({ page, request }) => {
  const [target, source] = [unique("Heading target"), unique("Heading source")];
  await createPage(request, target, ["the page"]);
  const filler = Array.from({ length: 30 }, (_, i) => `filler ${i}`);
  const ids = await createPage(request, source, [...filler, `about [[${target}]]`]);
  await page.goto(`/page/${encodeURIComponent(target)}`);
  await page.locator(".linked-refs").getByRole("link", { name: source }).click();
  await expect(page).toHaveURL(`/page/${encodeURIComponent(source)}`);
  const row = page.locator(`.block-row[data-block="${ids.at(-1)}"]`);
  await expect(row).toBeInViewport();
  await expect(row).toHaveClass(/revealed/);
});

test("only links that leave NetSeq show a ↗", async ({ page, request }) => {
  const [id] = await createPage(request, unique("Target"), ["see https://example.com/inside"]);
  const name = unique("Arrows");
  await createPage(request, name, ["https://example.com/out", `[[${name} other]] #tagged ((${id}))`]);
  await page.goto(`/page/${encodeURIComponent(name)}`);
  const after = (link: ReturnType<Page["getByRole"]>) => link.evaluate((el) => getComputedStyle(el, "::after").content);

  await expect.poll(() => after(page.getByRole("link", { name: "https://example.com/out" }))).toContain("↗");
  for (const inside of [`${name} other`, "#tagged", "see https://example.com/inside"]) {
    expect(await after(page.getByRole("link", { name: inside, exact: true })), inside).not.toContain("↗");
  }
});

test("each linked reference has the zoomed view's breadcrumb: its page, then its parents", async ({ page, request }) => {
  const [target, source] = [unique("Trail target"), unique("Trail source")];
  await createPage(request, target, ["here"]);
  const [parent, child] = [crypto.randomUUID(), crypto.randomUUID()];
  const op = (id: string, parentId: string | null, content: string) => ({
    t: "block", id, page: source, parent: parentId, order_key: "a0", content, collapsed: false, base: 0,
  });
  const ops = [op(parent, null, "a parent"), op(child, parent, `about [[${target}]]`)];
  expect((await request.post("/api/batch", { data: { writer: "e2e", device: "Playwright", ops } })).ok()).toBe(true);

  await page.goto(`/page/${encodeURIComponent(target)}`);
  await expect(page.locator(".linked-refs .crumbs")).toHaveText(`${source}›a parent`);
  await expect(page.locator(".linked-refs .crumbs a.crumb-page")).toHaveText(source);
});

test("everything you can click in a reference is blue, links back to the page you're on included", async ({ page, request }) => {
  const [target, source] = [unique("Blue target"), unique("Blue source")];
  await createPage(request, target, ["here"]);
  const [parent, child] = [crypto.randomUUID(), crypto.randomUUID()];
  const op = (id: string, parentId: string | null, content: string) => ({
    t: "block", id, page: source, parent: parentId, order_key: "a0", content, collapsed: false, base: 0,
  });
  const ops = [op(parent, null, "a parent"), op(child, parent, `about [[${target}]] and [[${source} other]]`)];
  expect((await request.post("/api/batch", { data: { writer: "e2e", device: "Playwright", ops } })).ok()).toBe(true);
  await page.goto(`/page/${encodeURIComponent(target)}`);

  const refs = page.locator(".linked-refs");
  const accent = "rgb(77, 105, 155)"; // --accent in style.css (light theme: Kanagawa's lotusBlue4, #4d699b)
  await expect(refs.locator(".crumbs a")).toHaveCount(2); // the page, then the parent block
  for (const step of await refs.locator(".crumbs a").all()) await expect(step).toHaveCSS("color", accent);
  const back = refs.getByRole("link", { name: target, exact: true });
  await expect(back).toHaveAttribute("aria-current", "page"); // still announced as the page you're on
  await expect(back).toHaveCSS("color", accent);
  await expect(refs.getByRole("link", { name: `${source} other`, exact: true })).toHaveCSS("color", accent);
});

test("references that follow each other with the same breadcrumb share it", async ({ page, request }) => {
  const [target, source] = [unique("Shared target"), unique("Shared source")];
  await createPage(request, target, ["here"]);
  const [parentA, parentB] = [crypto.randomUUID(), crypto.randomUUID()];
  const top = keysBetween(null, null, 5);
  const [first, second] = keysBetween(null, null, 2);
  const op = (id: string, parent: string | null, order_key: string, content: string) => ({
    t: "block", id, page: source, parent, order_key, content, collapsed: false, base: 0,
  });
  const ops = [
    op(crypto.randomUUID(), null, top[0], `one [[${target}]]`),
    op(crypto.randomUUID(), null, top[1], `two [[${target}]]`),
    op(crypto.randomUUID(), null, top[2], `three [[${target}]]`),
    op(parentA, null, top[3], "parent A"),
    op(crypto.randomUUID(), parentA, first, `a1 [[${target}]]`),
    op(crypto.randomUUID(), parentA, second, `a2 [[${target}]]`),
    op(parentB, null, top[4], "parent B"),
    op(crypto.randomUUID(), parentB, first, `b1 [[${target}]]`),
  ];
  expect((await request.post("/api/batch", { data: { writer: "e2e", device: "Playwright", ops } })).ok()).toBe(true);

  await page.goto(`/page/${encodeURIComponent(target)}`);
  const refs = page.locator(".linked-refs");
  await expect(refs.locator(".crumbs")).toHaveText([source, `${source}›parent A`, `${source}›parent B`]);
  await expect(refs.locator(".block-row")).toHaveCount(6);
  await expect(refs.locator(".ref-root").nth(1).locator(".block-content")).toHaveText([`a1 ${target}`, `a2 ${target}`]);
});

test("a page's name in plain text is a soft link: it opens the page, and Link mentions makes it a reference", async ({ page, request }) => {
  const [target, source] = [unique("Soft"), unique("Source")];
  await createPage(request, target, ["the target page"]);
  await createPage(request, source, [`lunch with ${target.toLowerCase()} today`]);
  await page.goto(`/page/${encodeURIComponent(source)}`);

  // Shown as written, and it opens the page.
  await expect(page.locator(".block-content a.soft-ref")).toHaveText(target.toLowerCase());
  await page.locator(".block-content a.soft-ref").click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(target);

  // Not a reference yet: the page lists it as unlinked, still as a soft link.
  await expect(page.locator(".linked-refs")).toHaveCount(0);
  await page.getByRole("button", { name: "1 unlinked reference" }).click();
  const unlinked = page.locator(".unlinked-refs");
  await expect(unlinked.locator("a.soft-ref")).toHaveText(target.toLowerCase());

  // Only blocks with soft links offer to link them.
  await page.locator(".outline").first().getByLabel("Zoom in").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Copy block ref" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Link mentions" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Linked from the list: it becomes a linked reference.
  await unlinked.getByLabel("Zoom in").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Link mentions" }).click();
  await expectSaved(page);
  await expect(page.locator(".linked-refs h2")).toHaveText("1 linked reference");
  await expect(page.locator(".linked-refs .block-content a.page-ref")).toHaveText(target.toLowerCase());
  await expect(page.locator(".unlinked-refs")).toHaveCount(0);

  // Undo takes it back to plain text, and redo links it again.
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("button", { name: "1 unlinked reference" })).toBeVisible();
  await expect(page.locator(".linked-refs")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".linked-refs h2")).toHaveText("1 linked reference");
  await expectSaved(page);

  await page.goto(`/page/${encodeURIComponent(source)}`);
  await expect(page.locator(".block-content a.page-ref")).toHaveText(target.toLowerCase());
  await expect(page.locator(".block-content a.soft-ref")).toHaveCount(0);
});
