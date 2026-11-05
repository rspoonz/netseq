import { expect, test } from "@playwright/test";
import { openFreshPage, outlineText, startWriting } from "./helpers";

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
  await menu.getByRole("menuitem", { name: "Earlier versions" }).tap();
  await expect(page.getByRole("dialog", { name: "Earlier versions" })).toBeVisible();
});
