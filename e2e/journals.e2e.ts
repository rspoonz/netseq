import { expect, test } from "@playwright/test";
import { createPage, journalTitle as title, unique } from "./helpers";

test("coming back to the journals reloads every day on screen in one request", async ({ page, request }) => {
  await createPage(request, "2001-02-01", ["an old day"]);
  await createPage(request, "2001-02-02", ["another old day"]);
  await page.goto("/");
  await expect(page.locator(".journal-day").nth(1)).toBeVisible(); // at least one older day loaded

  const requests: string[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (url.pathname === "/api/page" || url.pathname === "/api/journals") requests.push(url.pathname + url.search);
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // as when the tab comes back
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatch(/^\/api\/journals\?days=/);
});

test("at midnight the new day becomes today", async ({ page }) => {
  await page.clock.install({ time: new Date(2031, 4, 6, 23, 59, 30) });
  await page.goto("/");
  const heading = page.locator(".journal-day").first().locator(":scope > h2");
  await expect(heading).toHaveText(await title(page, "2031-05-06"));
  await page.clock.runFor("01:00");
  await expect(heading).toHaveText(await title(page, "2031-05-07"));
});

test("the Pages tab lists named pages, the most recently changed first, each with the day it changed", async ({ page, request }) => {
  // Named so that A–Z order is the opposite of the order they were changed in.
  const [first, second] = [unique("Recent b"), unique("Recent a")];
  await createPage(request, first, ["one"]);
  await createPage(request, second, [`links to [[${second} stub]]`]);
  await createPage(request, "2001-03-06", ["a journal day"]);
  await createPage(request, first, ["changed again"]); // now the most recently changed
  await page.goto("/pages");
  const rows = page.locator(".page-list li");
  const today = await title(page, await page.evaluate(() => new Date().toLocaleDateString("sv")));
  await expect(rows.first()).toHaveText(`${first}${today}`);
  // A page that's only linked to is a page too. No journal day: the Journals tab has those.
  await expect(rows.nth(1)).toContainText(second);
  await expect(rows.nth(2)).toContainText(second);
  await expect(page.locator(".page-list").getByRole("link", { name: `${second} stub` })).toBeVisible();
  await expect(rows.filter({ hasText: /^2001-03-06/ })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0); // nothing to filter with: Ctrl+K finds pages
});

test("the Pages tab loads more pages as you scroll", async ({ page, request }) => {
  const prefix = unique("Many");
  const ops = Array.from({ length: 60 }, (_, i) => ({
    t: "block", id: crypto.randomUUID(), page: `${prefix} ${i}`, parent: null, order_key: "a0", content: "x", collapsed: false, base: 0,
  }));
  expect((await request.post("/api/batch", { data: { writer: "e2e", device: "Playwright", ops } })).ok()).toBe(true);
  await page.goto("/pages");
  const rows = page.locator(".page-list li");
  await expect(rows).toHaveCount(50);
  await rows.last().scrollIntoViewIfNeeded();
  await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(60); // the rest, or the next 50
});
