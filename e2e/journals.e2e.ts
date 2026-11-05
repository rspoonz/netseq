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

test("the Pages tab lists named pages, then journal days newest first, under one filter", async ({ page, request }) => {
  const [alpha, beta] = [unique("Filterable alpha"), unique("Filterable beta")];
  await createPage(request, alpha, ["x"]);
  await createPage(request, beta, ["y"]);
  await createPage(request, "2001-03-04", ["a journal day"]);
  await createPage(request, "2001-03-05", ["the next day"]);
  await page.goto("/pages");
  await page.getByRole("button", { name: "Show all" }).click();
  await expect(page.getByRole("link", { name: alpha })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Journal days" })).toBeVisible();
  const [day4, day5] = [await title(page, "2001-03-04"), await title(page, "2001-03-05")];

  // Filtering by the date, or by date and weekday as shown, finds journal days (newest first).
  await page.getByLabel("Filter pages").fill("2001-03-0");
  await expect(page.locator(".page-list li")).toHaveText([day5, day4]);
  await page.getByLabel("Filter pages").fill(day4.toLowerCase());
  await expect(page.locator(".page-list li")).toHaveText([day4]);

  await page.getByLabel("Filter pages").fill(`FILTERABLE ${beta.split(" ")[1]}`);
  await expect(page.locator(".page-list li")).toHaveText([beta]);
  await expect(page.getByRole("heading", { name: "Journal days" })).toHaveCount(0);
  await expect(page.locator(".page-count")).toContainText("1 of");
});

test("the Pages tab opens on the recently changed pages; the filter and Show all list every page", async ({ page, request }) => {
  // Named so that A–Z order is the opposite of the order they were changed in.
  const [first, second] = [unique("Recent b"), unique("Recent a")];
  await createPage(request, first, ["one"]);
  await createPage(request, second, ["two"]);
  await createPage(request, "2001-03-06", ["a journal day"]);
  await createPage(request, first, ["changed again"]); // now the most recently changed
  await page.goto("/pages");
  const recent = page.locator(".recent-pages li");
  await expect(recent.first()).toHaveText(first);
  await expect(recent.nth(1)).toHaveText(second); // not the journal day: the Journals tab has those
  await expect(recent.filter({ hasText: "2001-03-06" })).toHaveCount(0);

  await page.getByLabel("Filter pages").fill(second);
  await expect(page.getByRole("heading", { name: "Recently changed" })).toHaveCount(0);
  await expect(page.locator(".page-list li")).toHaveText([second]);
  await page.getByLabel("Filter pages").fill("");
  await expect(recent.first()).toHaveText(first);

  await page.getByRole("button", { name: "Show all" }).click();
  await expect(page.getByRole("heading", { name: "Recently changed" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: second })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Journal days" })).toBeVisible();
});
