import { expect, test } from "@playwright/test";
import { createPage, expectSaved, openFreshPage, outlineText, startWriting, unique } from "./helpers";

test("the toolbar indents without closing the keyboard", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");

  await page.getByRole("button", { name: "Indent" }).tap();
  expect(await outlineText(page)).toBe("one\n  two");
  await expect(page.locator("textarea.block-editor")).toBeFocused();

  await page.getByRole("button", { name: "Outdent" }).tap();
  expect(await outlineText(page)).toBe("one\ntwo");
});

test("collapse arrows show without hovering, and tapping one folds the block", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("parent");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Indent" }).tap();
  await page.keyboard.type("child");
  await page.getByRole("button", { name: "Done", exact: true }).tap();

  await page.mouse.move(1, 1); // the test's mouse rests over the block; a phone has no hover at all
  const arrow = page.getByRole("button", { name: "Collapse" });
  await expect(arrow).toHaveCSS("opacity", "1");
  await arrow.tap();
  await expect(page.locator(".block-content")).toHaveText(["parent"]);
});

test("the toolbar's ⋯ opens the block menu, which iPhones can't open by long-pressing a bullet", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("a block");
  await page.getByRole("button", { name: "Block menu" }).tap();
  const menu = page.getByRole("menu");
  await expect(menu).toBeInViewport({ ratio: 1 }); // above the toolbar, not off the edge
  await expect(menu.getByRole("menuitem", { name: "Move to page…" })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Earlier versions" }).tap();
  await expect(page.getByRole("dialog", { name: "Earlier versions" })).toBeVisible();
});

test("zoomed in, the ⋯ beside the trail opens the block menu without editing the block", async ({ page, request }) => {
  const source = unique("Zoom source");
  const target = unique("Zoom target");
  await createPage(request, source, ["moves"]);
  await createPage(request, target, ["already here"]);
  await page.goto(`/page/${encodeURIComponent(source)}`);
  await page.locator(".block-bullet").tap();
  await expect(page).toHaveURL(/\/b\//);

  await page.locator(".zoom-header").getByRole("button", { name: "Block menu" }).tap();
  const menu = page.getByRole("menu");
  await expect(menu).toBeInViewport({ ratio: 1 }); // below the ⋯, not off the right edge
  await expect(page.locator("textarea.block-editor")).toHaveCount(0); // no keyboard needed
  await menu.getByRole("menuitem", { name: "Move to page…" }).tap();
  const picker = page.getByRole("dialog", { name: "Move to page" });
  await picker.getByRole("searchbox").fill(target);
  await expect(picker.getByRole("option")).toContainText(target);
  await page.keyboard.press("Enter");
  await expect(page.locator(".notice")).toContainText(`Moved to ${target}.`);

  await expectSaved(page);
  await page.goto(`/page/${encodeURIComponent(target)}`);
  await expect(page.locator(".block-content")).toHaveText(["already here", "moves"]);
});

test("☰ opens the favourites over the notes; picking one opens it and closes them", async ({ page, request }) => {
  const name = `Phone favourite ${Date.now()}`;
  expect((await request.put("/api/favourites", { data: { pages: [name] } })).ok()).toBe(true);
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Favourites" });
  await expect(sidebar).toHaveCount(0); // closed until asked for
  await expect(page.locator(".topbar")).toBeInViewport({ ratio: 1 });

  await page.getByRole("button", { name: "Favourites", exact: true }).tap();
  await sidebar.getByRole("link", { name }).tap();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(sidebar).toHaveCount(0);

  // Going anywhere else closes them too: a tab, even the one already open.
  for (const tab of ["Pages", "Pages", "Journals"]) {
    await page.getByRole("button", { name: "Favourites", exact: true }).tap();
    await expect(sidebar).toBeVisible();
    await page.locator(".topbar").getByRole("link", { name: tab, exact: true }).tap();
    await expect(sidebar).toHaveCount(0);
  }

  await page.goto("/pages"); // on a phone a page's name gets the whole line: no date beside it
  await expect(page.locator(".page-list a").first()).toBeVisible();
  await expect(page.locator(".page-list time").first()).toBeHidden();
  await page.goto(`/page/${encodeURIComponent(name)}`);
  await page.getByRole("button", { name: "Remove from favourites" }).tap();
  await page.getByRole("button", { name: "Favourites", exact: true }).tap();
  await expect(sidebar).toContainText("Star a page");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // nothing sticks out sideways
});
