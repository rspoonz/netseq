import { expect, test } from "@playwright/test";
import { createPage, expectSaved, unique } from "./helpers";

// What you see when the server can't be reached: the app says so, rather than looking empty.

const down = { status: 500, body: "down" };

test("the top bar says Offline while live updates are disconnected, even with nothing to save", async ({ page }) => {
  const events = (url: URL) => url.pathname === "/api/events";
  await page.route(events, (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("status")).toHaveText("Offline");

  await page.unroute(events);
  await expectSaved(page); // reconnected
});

test("a page whose linked references can't be loaded says so", async ({ page, request }) => {
  const name = unique("Unreachable refs");
  await createPage(request, name, ["here"]);
  await page.route((url) => url.pathname === "/api/refs", (route) => route.fulfill(down));
  await page.goto(`/page/${encodeURIComponent(name)}`);
  await expect(page.getByText("Couldn't load the linked references.")).toBeVisible();
});

test("search that can't reach the server says so, and still finds pages by name", async ({ page, request }) => {
  const name = unique("Findable");
  await createPage(request, name, ["x"]);
  await page.goto("/");
  await page.route((url) => url.pathname === "/api/search", (route) => route.fulfill(down));
  await page.keyboard.press("Control+k");
  await page.keyboard.type(name);
  await expect(page.getByText("Couldn't search blocks.")).toBeVisible();
  await expect(page.getByRole("option").filter({ hasText: name }).first()).toBeVisible();
});

test("the journals say when older days can't be loaded, and Try again loads them", async ({ page, request }) => {
  await createPage(request, "2001-05-01", ["an old day"]);
  const olderDays = (url: URL) => url.pathname === "/api/journals" && url.searchParams.has("before");
  await page.route(olderDays, (route) => route.fulfill(down));
  await page.goto("/");
  await expect(page.getByText("Couldn't load older days.")).toBeVisible();

  await page.unroute(olderDays);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Couldn't load older days.")).toBeHidden();
  await expect(page.locator(".journal-day").nth(1)).toBeVisible(); // at least the 2001 day
});
