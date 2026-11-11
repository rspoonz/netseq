import { expect, test } from "@playwright/test";
import { createPage, expectSaved, openFreshPage, unique } from "./helpers";

test("typing (( finds a block, and the reference shows its text and leads to it", async ({ page, request }) => {
  const word = unique("launch");
  const [id] = await createPage(request, unique("Plans"), [`${word} on friday`]);
  await openFreshPage(page);
  await page.getByRole("button", { name: "Click here to start writing" }).click();

  await page.keyboard.type("see ((");
  const editor = page.locator("textarea.block-editor");
  await expect(editor).toHaveValue("see (())"); // closed automatically
  await page.keyboard.type(word);
  await expect(page.getByRole("listbox", { name: "Blocks" }).getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Enter");
  await expect(editor).toHaveValue(`see ((${id}))`);
  await page.keyboard.press("Escape");
  await expectSaved(page);

  const ref = page.locator(".block-ref");
  await expect(ref).toHaveText(`${word} on friday`);
  await ref.click();
  await expect(page).toHaveURL(`/b/${id}`);
});

test("a referenced block shows how many blocks reference it, and lists them", async ({ page, request }) => {
  const target = unique("Target");
  const [id] = await createPage(request, target, ["the referenced block"]);
  await createPage(request, unique("Elsewhere"), [`first ((${id}))`, `second ((${id}))`]);
  await page.goto(`/page/${encodeURIComponent(target)}`);

  const count = page.getByRole("button", { name: "Referenced by 2 blocks" });
  await expect(count).toHaveText("2");
  await count.click();
  await expect(page.locator(".block-refs .block-content")).toHaveText(["first the referenced block", "second the referenced block"]);
});

test("a reference keeps up when the block it shows changes elsewhere", async ({ page, request }) => {
  const [id] = await createPage(request, unique("Source"), ["before"]);
  const name = await openFreshPage(page);
  await createPage(request, name, [`quote: ((${id}))`]);
  await page.reload();
  await expect(page.locator(".block-ref")).toHaveText("before");

  const res = await request.post("/api/batch", {
    data: {
      writer: "other",
      device: "Other device",
      ops: [{ t: "block", id, page: "Source", parent: null, order_key: "a0", content: "after", collapsed: false, base: 0 }],
    },
  });
  expect(res.ok()).toBe(true);
  await expect(page.locator(".block-ref")).toHaveText("after");
});

test("right-clicking a bullet copies a reference to its block", async ({ page, context, request }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const name = unique("Copy");
  const [id] = await createPage(request, name, ["copy me"]);
  await page.goto(`/page/${encodeURIComponent(name)}`);
  await page.getByLabel("Zoom in").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy block ref" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`((${id}))`);
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page).toHaveURL(`/page/${encodeURIComponent(name)}`); // the right-click didn't zoom in
});

test("the count appears as soon as another device references the block", async ({ page, request }) => {
  const target = unique("Live");
  await createPage(request, target, ["watch me"]);
  await page.goto(`/page/${encodeURIComponent(target)}`);
  await expect(page.locator(".block-content")).toHaveText(["watch me"]);
  await expect(page.locator(".ref-count")).toHaveCount(0);

  const id = await page.locator(".block-row").first().getAttribute("data-block");
  await createPage(request, unique("Other"), [`about ((${id}))`]);
  await expect(page.getByRole("button", { name: "Referenced by 1 block" })).toBeVisible();
});

test("a reference to a block that's only a link still leads to the block, and from there to its page", async ({ page, request }) => {
  const source = unique("Music server");
  const [id] = await createPage(request, source, ["https://music.example.com/"]);
  const name = unique("Network");
  await createPage(request, name, [`((${id}))`]);
  await page.goto(`/page/${encodeURIComponent(name)}`);

  const ref = page.locator(".block-ref");
  await expect(ref).toHaveText("https://music.example.com/");
  await ref.click(); // zooms in, rather than opening the link
  await expect(page).toHaveURL(`/b/${id}`);
  await page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: source }).click();
  await expect(page).toHaveURL(`/page/${encodeURIComponent(source)}`);
  await expect(page.locator(`.block-row[data-block="${id}"]`)).toHaveClass(/revealed/);
});

test("a reference is a real link: Enter on it zooms in, Ctrl+click opens it in a new tab", async ({ page, context, request }) => {
  const [id] = await createPage(request, unique("Target"), ["the target"]);
  const name = unique("Linking");
  await createPage(request, name, [`see ((${id}))`]);
  await page.goto(`/page/${encodeURIComponent(name)}`);
  const ref = page.getByRole("link", { name: "the target" });

  const [tab] = await Promise.all([context.waitForEvent("page"), ref.click({ modifiers: ["ControlOrMeta"] })]);
  await expect(tab).toHaveURL(`/b/${id}`);
  await expect(page).toHaveURL(`/page/${encodeURIComponent(name)}`); // this tab stayed put
  await tab.close();

  await ref.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`/b/${id}`);
});
