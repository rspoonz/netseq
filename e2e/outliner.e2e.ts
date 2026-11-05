import { expect, test } from "@playwright/test";
import { expectSaved, openFreshPage, outlineText, startWriting } from "./helpers";

test("typing, Enter and Tab build an outline that survives a reload", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("two");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.type("three");
  await page.keyboard.press("Shift+Tab");
  expect(await outlineText(page)).toBe("one\n  two\nthree");

  await expectSaved(page);
  await page.reload();
  await expect(page.locator(".block-content").first()).toHaveText("one");
  expect(await outlineText(page)).toBe("one\n  two\nthree");
});

test("Backspace at the start joins blocks and Enter splits them again", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("alpha");
  await page.keyboard.press("Enter");
  await page.keyboard.type("beta");
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  expect(await outlineText(page)).toBe("alphabeta");

  await page.keyboard.press("Enter"); // the caret sits at the join
  expect(await outlineText(page)).toBe("alpha\nbeta");
});

test("arrow keys move between blocks", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  const editor = page.locator("textarea.block-editor");

  await page.keyboard.press("ArrowUp");
  await expect(editor).toHaveValue("first");
  await page.keyboard.press("ArrowDown");
  await expect(editor).toHaveValue("second");
});

test("blocks move with Alt+Shift+arrows, and undo puts them back", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  for (const [i, text] of ["a", "b", "c"].entries()) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(text);
  }
  await page.keyboard.press("Alt+Shift+ArrowUp");
  expect(await outlineText(page)).toBe("a\nc\nb");

  await page.keyboard.press("Control+z");
  expect(await outlineText(page)).toBe("a\nb\nc");
  await page.keyboard.press("Control+Shift+z");
  expect(await outlineText(page)).toBe("a\nc\nb");
});

test("deleting selected blocks can be undone and redone without opening a block", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  for (const [i, text] of ["keep", "one", "two"].entries()) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(text);
  }
  await page.keyboard.press("Escape"); // selects "two"
  await page.keyboard.press("Shift+ArrowUp"); // and "one"
  await page.keyboard.press("Backspace");
  await expect(page.locator(".block-content")).toHaveText(["keep"]);

  await page.keyboard.press("Control+z");
  await expect(page.locator(".block-content")).toHaveText(["keep", "one", "two"]);
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".block-content")).toHaveText(["keep"]);
  await page.keyboard.press("Control+z");
  await expectSaved(page);
  await page.reload();
  await expect(page.locator(".block-content")).toHaveText(["keep", "one", "two"]);
});

test("cut keeps the blocks, and says so, when the clipboard can't be written", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("stays");
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error("not allowed"));
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+x");
  await expect(page.locator(".notice")).toContainText("Couldn't copy to the clipboard, so nothing was cut.");
  await expect(page.locator(".block-content")).toHaveText(["stays"]);
});

test("collapsing hides children, and stays collapsed after a reload", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("parent");
  await page.keyboard.press("Enter");
  await page.keyboard.type("child");
  await page.keyboard.press("Tab");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Control+ArrowUp");
  expect(await outlineText(page)).toBe("parent");

  await expectSaved(page);
  await page.reload();
  await expect(page.locator(".block-content")).toHaveText(["parent"]);
  await page.getByRole("button", { name: "Expand" }).click();
  expect(await outlineText(page)).toBe("parent\n  child");
});

test("edits made offline are saved once the connection is back", async ({ page, context }) => {
  await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.type("before");
  await expectSaved(page);

  await context.setOffline(true);
  await page.keyboard.press("Enter");
  await page.keyboard.type("while offline");
  await expect(page.getByRole("status")).toContainText("Offline");

  await context.setOffline(false);
  await expectSaved(page);
  await page.reload();
  await expect(page.locator(".block-content")).toHaveText(["before", "while offline"]);
});

test("a refused save says so, and the next edit saves the block and clears the error", async ({ page }) => {
  await openFreshPage(page);
  await startWriting(page);
  const refusal = { status: 400, contentType: "application/json", body: JSON.stringify({ error: "op 0: bad parent" }) };
  await page.route("**/api/batch", (route) => route.fulfill(refusal), { times: 1 });
  await page.keyboard.type("refused");
  await expect(page.locator(".notice")).toContainText("The server refused some changes (op 0: bad parent)");
  await expect(page.getByRole("status")).toHaveText("Some changes couldn't be saved");

  await page.keyboard.type(" then saved"); // each save carries the whole block, so nothing is missing
  await expectSaved(page);
  await page.reload();
  await expect(page.locator(".block-content")).toHaveText(["refused then saved"]);
});

test("leaving an empty page without typing doesn't create it", async ({ page, request }) => {
  const name = await openFreshPage(page);
  await startWriting(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Click here to start writing" })).toBeVisible();
  await expectSaved(page);
  const data = await (await request.get(`/api/page?name=${encodeURIComponent(name)}`)).json();
  expect(data.page).toBeNull();
});

test("today's journal is on the home page", async ({ page }) => {
  await page.goto("/");
  // The day's own heading and outline (today's agenda sits in the same section).
  const heading = page.locator(".journal-day").first().locator(":scope > h2");
  const outline = page.locator(".journal-day").first().locator(":scope > .outline");
  await expect(heading).toContainText(String(new Date().getFullYear()));
  await expect(outline).toBeVisible();

  // Today's journal is shared by every run against this database, so it may already have notes.
  const start = outline.getByRole("button", { name: "Click here to start writing" });
  if (await start.isVisible()) {
    await start.click();
  } else {
    await outline.locator(".block-content").last().click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
  }
  const note = `a note for today ${Date.now()}`;
  await page.keyboard.type(note);
  await expectSaved(page);
  await page.reload();
  await expect(outline.locator(".block-content").last()).toHaveText(note);
});
