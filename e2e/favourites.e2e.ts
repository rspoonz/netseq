import { type APIRequestContext, expect, test } from "@playwright/test";
import { createPage, unique } from "./helpers";

// Favourites are one list for the whole database, so every test here starts and ends with none.
async function setFavourites(request: APIRequestContext, pages: string[]): Promise<void> {
  expect((await request.put("/api/favourites", { data: { pages } })).ok()).toBe(true);
}

test.beforeEach(({ request }) => setFavourites(request, []));
test.afterEach(({ request }) => setFavourites(request, []));

test("starring a page keeps it in the sidebar, one click from anywhere", async ({ page, request }) => {
  const name = unique("Starred");
  await createPage(request, name, ["content"]);
  await page.goto(`/page/${encodeURIComponent(name)}`);
  const sidebar = page.getByRole("complementary", { name: "Favourites" });
  await expect(sidebar).toContainText("Star a page");

  await page.getByRole("button", { name: "Add to favourites" }).click();
  await expect(sidebar.getByRole("link", { name })).toHaveAttribute("aria-current", "page");

  await page.goto("/"); // it's stored on the server, so it's there after a reload
  await sidebar.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);

  await page.getByRole("button", { name: "Remove from favourites" }).click();
  await expect(sidebar.getByRole("link")).toHaveCount(0);
});

test("a page with nothing on it can be a favourite, and a renamed one stays", async ({ page }) => {
  const name = unique("Empty");
  await page.goto(`/page/${encodeURIComponent(name)}`);
  await page.getByRole("button", { name: "Add to favourites" }).click();
  const sidebar = page.getByRole("complementary", { name: "Favourites" });
  await expect(sidebar.getByRole("link", { name })).toBeVisible();

  await page.getByRole("heading", { level: 1 }).click();
  await page.getByLabel("Page name").fill(`${name} renamed`);
  await page.keyboard.press("Enter");
  await expect(sidebar.getByRole("link")).toHaveText([`${name} renamed`]);
  await expect(page.getByRole("button", { name: "Remove from favourites" })).toBeVisible();
});

test("favourites changed elsewhere show up live, and Alt+↑ moves one up", async ({ page, request }) => {
  const [first, second, third] = [unique("Fav a"), unique("Fav b"), unique("Fav c")];
  await page.goto("/");
  const links = page.getByRole("complementary", { name: "Favourites" }).getByRole("link");
  await expect(links).toHaveCount(0);
  await setFavourites(request, [first, second, third]);
  await expect(links).toHaveText([first, second, third]);

  await links.nth(2).focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(links).toHaveText([first, third, second]);
  await expect(links.nth(1)).toBeFocused(); // so it can move again
  const saved = (await (await request.get("/api/favourites")).json()) as { name: string }[];
  expect(saved.map((p) => p.name)).toEqual([first, third, second]);
});

test("dragging a favourite reorders the list", async ({ page, request }) => {
  const [first, second, third] = [unique("Drag a"), unique("Drag b"), unique("Drag c")];
  await setFavourites(request, [first, second, third]);
  await page.goto("/");
  const items = page.getByRole("complementary", { name: "Favourites" }).getByRole("listitem");
  await expect(items).toHaveCount(3);
  const box = (await items.nth(0).boundingBox())!;
  await items.nth(2).dragTo(items.nth(0), { targetPosition: { x: box.width / 2, y: 2 } }); // onto its top half: before it
  await expect(items).toHaveText([third, first, second]);
});

test("Ctrl+K lists the favourites before anything is typed", async ({ page, request }) => {
  const [first, second] = [unique("Quick a"), unique("Quick b")];
  await setFavourites(request, [first, second]);
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("option")).toHaveText([`Favourite${first}`, `Favourite${second}`]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(second);
});

test("the sidebar can be hidden, and stays hidden after a reload", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.getByRole("complementary", { name: "Favourites" });
  await expect(sidebar).toBeVisible();
  await page.getByRole("button", { name: "Favourites", exact: true }).click();
  await expect(sidebar).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Favourites", exact: true })).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).toHaveCount(0);
});
