import { expect, type Page, test } from "@playwright/test";
import { createPage, expectSaved, openFreshPage, outlineText, startWriting, unique } from "./helpers";

async function waitForLive(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-live", "on");
}

test("an edit in one tab shows up in another", async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  const name = await openFreshPage(first);
  await second.goto(`/page/${encodeURIComponent(name)}`);
  await waitForLive(second);

  await startWriting(first);
  await first.keyboard.type("hello from the first tab");
  await expect(second.locator(".block-content")).toHaveText(["hello from the first tab"]);

  await first.keyboard.press("Enter");
  await first.keyboard.type("and a child");
  await first.keyboard.press("Tab");
  await expect.poll(() => outlineText(second)).toBe("hello from the first tab\n  and a child");
});

test("text replaced by another device can be restored from its history", async ({ browser }) => {
  const laptop = await browser.newContext();
  const phone = await browser.newContext();
  const onLaptop = await laptop.newPage();
  const onPhone = await phone.newPage();

  const name = await openFreshPage(onLaptop);
  await startWriting(onLaptop);
  await onLaptop.keyboard.type("original");
  await onLaptop.keyboard.press("Escape");
  await expectSaved(onLaptop);
  await onPhone.goto(`/page/${encodeURIComponent(name)}`);
  await expect(onPhone.locator(".block-content")).toHaveText(["original"]);

  // The phone edits the block while offline, and meanwhile the laptop edits it too.
  await phone.setOffline(true);
  await onPhone.locator(".block-content").click();
  await onPhone.keyboard.press("End");
  await onPhone.keyboard.type(" + phone");
  await onLaptop.locator(".block-content").click();
  await onLaptop.keyboard.press("End");
  await onLaptop.keyboard.type(" + laptop");
  await onLaptop.keyboard.press("Escape");
  await expectSaved(onLaptop);

  // Back online, the phone's save wins, and it says what it replaced.
  await phone.setOffline(false);
  await expectSaved(onPhone);
  await expect(onLaptop.locator(".block-content")).toHaveText(["original + phone"]);
  await expect(onPhone.locator(".notice")).toContainText("Your edit replaced text written on");
  await onPhone.getByRole("button", { name: "View" }).click();
  const onPhoneHistory = onPhone.getByRole("dialog", { name: "Earlier versions" });
  await expect(onPhoneHistory).toContainText("original + laptop");
  await onPhone.keyboard.press("Escape");
  await expect(onPhoneHistory).toBeHidden();

  // The laptop, whose text was replaced, gets no notice: its bullet menu has the earlier versions.
  await onLaptop.locator(".block-bullet").first().click({ button: "right" });
  await onLaptop.getByRole("menuitem", { name: "Earlier versions" }).click();
  const history = onLaptop.getByRole("dialog", { name: "Earlier versions" });
  await expect(history).toContainText("Kept for 30 days");
  await expect(history).toContainText("original + laptop");
  await history.getByRole("button", { name: "Restore" }).click();
  await expect.poll(() => outlineText(onLaptop)).toBe("original + laptop");
  await expect(onPhone.locator(".block-content")).toHaveText(["original + laptop"]);

  await laptop.close();
  await phone.close();
});

test("a tab with unsaved edits follows a rename made elsewhere, and saves onto the renamed page", async ({ page, request }) => {
  const [oldName, newName] = [unique("Before"), unique("After")];
  await createPage(request, oldName, ["first"]);
  await page.goto(`/page/${encodeURIComponent(oldName)}`);
  await expect(page.locator(".block-content")).toHaveText(["first"]);

  // Hold this tab's saves, so its edit is still unsent when the rename happens.
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/batch", async (route) => {
    await released;
    await route.continue();
  });
  await page.locator(".block-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" x");
  await expect(page.getByRole("status")).toHaveText("Saving…");
  await page.keyboard.type("y");

  expect((await request.post("/api/rename", { data: { from: oldName, to: newName } })).ok()).toBe(true);
  await expect(page).toHaveURL(`/page/${encodeURIComponent(newName)}`);
  release();
  await expectSaved(page);
  await expect(page.getByText("Your edit replaced text")).toHaveCount(0);

  const before = await (await request.get(`/api/page?name=${encodeURIComponent(oldName)}`)).json();
  expect(before.page).toBeNull();
  const after = await (await request.get(`/api/page?name=${encodeURIComponent(newName)}`)).json();
  expect(after.blocks.map((b: { content: string }) => b.content)).toEqual(["first xy"]);
});
