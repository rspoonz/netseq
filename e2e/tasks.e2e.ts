import { expect, test } from "@playwright/test";
import { createPage, expectSaved, journalTitle, openFreshPage, startWriting, unique } from "./helpers";

test("a task gets a checkbox, and Ctrl+Enter cycles its marker", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("TODO buy milk");
  await page.keyboard.press("Escape");
  const checkbox = page.getByRole("checkbox", { name: "Done" });
  await expect(checkbox).not.toBeChecked();

  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await expect(page.locator(".task-done")).toContainText("buy milk");

  await page.locator(".task-text").click();
  const editor = page.locator("textarea.block-editor");
  await expect(editor).toHaveValue("DONE buy milk");
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveValue("buy milk");
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveValue("TODO buy milk");
  await page.keyboard.press("Control+Enter");
  await expect(editor).toHaveValue("DOING buy milk");
  await expectSaved(page);
});

test("/scheduled picks a date, and an overdue task shows in today's agenda", async ({ page }) => {
  const task = unique("pay rent");
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type(`TODO ${task} /sched`);
  await expect(page.getByRole("option", { name: "Scheduled" })).toBeVisible();
  await page.keyboard.press("Enter");

  const date = page.getByLabel("Scheduled");
  await expect(date).toBeFocused();
  await date.fill("2020-01-02");
  await date.press("Enter");
  const editor = page.locator("textarea.block-editor");
  await expect(editor).toBeFocused(); // still editing
  await expect(editor).toHaveValue(`TODO ${task} \nSCHEDULED: <2020-01-02 Thu>`);
  await page.keyboard.press("Escape");
  await expect(page.locator(".task-dates")).toHaveText(`Scheduled: ${await journalTitle(page, "2020-01-02")}`);
  await expectSaved(page);

  await page.goto("/");
  await expect(page.locator(".agenda")).toContainText(task);
});

test("a query lists matching blocks from other pages, and keeps up with changes", async ({ page, request }) => {
  const tag = unique("proj").toLowerCase();
  await createPage(request, unique("Tasks"), [`TODO alpha [[${tag}]]`, `DONE beta [[${tag}]]`, "TODO gamma"]);
  await openFreshPage(page);
  await startWriting(page);
  await page.locator("textarea.block-editor").fill(`{{query (and [[${tag}]] (task TODO))}}`);
  await page.keyboard.press("Escape");

  const results = page.locator(".query-results");
  await expect(results.locator(".query-count")).toHaveText("1 result");
  await expect(results.locator(".task-text")).toHaveText(["alpha " + tag]);

  // Ticking it off in the results takes it out of them.
  await results.getByRole("checkbox", { name: "Done" }).click();
  await expect(results.locator(".query-count")).toHaveText("0 results");
});

test("a query with a mistake says what's wrong", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.locator("textarea.block-editor").fill("{{query (task SOMEDAY)}}");
  await page.keyboard.press("Escape");
  await expect(page.locator(".query-results .error")).toHaveText("(task) takes markers such as TODO and DONE, not SOMEDAY.");
});
