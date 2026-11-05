import { expect, test } from "@playwright/test";
import { createPage, openFreshPage, outlineText, unique } from "./helpers";

test("Ctrl+K searches blocks, and opening a hit zooms into it", async ({ page, request }) => {
  const word = unique("zebra");
  const [id] = await createPage(request, unique("Animals"), [`a ${word} lives here`, "something else"]);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  const input = page.getByRole("dialog", { name: "Search" }).getByLabel("Search");
  await expect(input).toBeFocused();

  await input.fill(word.toUpperCase());
  const hit = page.getByRole("option").filter({ hasText: `a ${word} lives here` });
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark")).toHaveText(word);
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(`/b/${id}`);
  expect(await outlineText(page)).toBe(`a ${word} lives here`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("search finds pages by name, and Escape closes it", async ({ page, request }) => {
  const name = unique("Recipes");
  await createPage(request, name, ["pancakes"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Search" }).click();
  await page.keyboard.type(name.slice(0, 12));
  await expect(page.getByRole("option", { name: `Page ${name}` })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("unlinked references list blocks that mention the page without linking it", async ({ page, request }) => {
  const name = unique("Wombat");
  await createPage(request, name, ["the page itself"]);
  await createPage(request, unique("Zoo"), [`saw a ${name.toLowerCase()} today`, `and a [[${name}]]`]);
  await page.goto(`/page/${encodeURIComponent(name)}`);
  await expect(page.locator(".linked-refs h2")).toHaveText("1 linked reference");

  // The count shows straight away; the list stays folded until the count is clicked.
  await expect(page.locator(".unlinked-refs h2")).toHaveText("1 unlinked reference");
  await expect(page.locator(".unlinked-refs .block-content")).toHaveCount(0);
  await page.getByRole("button", { name: "1 unlinked reference" }).click();
  await expect(page.locator(".unlinked-refs .block-content")).toHaveText(`saw a ${name.toLowerCase()} today`);
});

test("the unlinked count is hidden while there are none, and follows mentions made elsewhere", async ({ page, request }) => {
  const name = await openFreshPage(page);
  await createPage(request, name, ["the page"]);
  await page.reload();
  await expect(page.locator(".block-content")).toHaveText(["the page"]);
  await expect(page.locator(".unlinked-refs")).toHaveCount(0);

  await createPage(request, unique("Elsewhere"), [`thinking about ${name}`]);
  await expect(page.locator(".unlinked-refs h2")).toHaveText("1 unlinked reference");
  await createPage(request, unique("Elsewhere"), [`more on ${name.toLowerCase()}`]);
  await expect(page.locator(".unlinked-refs h2")).toHaveText("2 unlinked references");
  await expect(page.locator(".unlinked-refs .block-content")).toHaveCount(0);
});

test("linked references update when another device links to the page", async ({ page, request }) => {
  const name = await openFreshPage(page);
  await createPage(request, name, ["the page"]);
  await page.reload();
  await expect(page.locator(".block-content")).toHaveText(["the page"]);
  await expect(page.locator(".linked-refs")).toHaveCount(0);

  await createPage(request, unique("Elsewhere"), [`about [[${name}]]`]);
  await expect(page.locator(".linked-refs h2")).toHaveText("1 linked reference");
});
