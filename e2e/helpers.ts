import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { keysBetween } from "../shared/order";

/** How the app shows a journal day ("2026-11-02 Mon"), with the weekday as this browser writes it. */
export function journalTitle(page: Page, day: string): Promise<string> {
  return page.evaluate((d) => {
    const [y, m, dd] = d.split("-").map(Number);
    return `${d} ${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(new Date(y, m - 1, dd))}`;
  }, day);
}

/** A name no other test uses. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Creates a page with top-level blocks, straight through the API. Returns the blocks' ids. */
export async function createPage(request: APIRequestContext, name: string, contents: string[]): Promise<string[]> {
  const keys = keysBetween(null, null, contents.length);
  const ops = contents.map((content, i) => ({
    t: "block",
    id: crypto.randomUUID(),
    page: name,
    parent: null,
    order_key: keys[i],
    content,
    collapsed: false,
    base: 0,
  }));
  const res = await request.post("/api/batch", { data: { writer: "e2e", device: "Playwright", ops } });
  expect(res.ok()).toBe(true);
  return ops.map((op) => op.id);
}

/** Opens a page with a name no other test uses, and returns that name. */
export async function openFreshPage(page: Page): Promise<string> {
  const name = `E2E ${Date.now()} ${Math.random().toString(36).slice(2, 7)}`;
  await page.goto(`/page/${encodeURIComponent(name)}`);
  return name;
}

/** Clicks "start writing" on an empty page, which opens the editor in its first block. */
export async function startWriting(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Click here to start writing" }).click();
  await expect(page.locator("textarea.block-editor")).toBeFocused();
}

/** The first outline on screen as indented text, one block per line; the open editor shows its value. */
export function outlineText(page: Page): Promise<string> {
  return page
    .locator(".outline")
    .first()
    .evaluate((root) => {
      const lines: string[] = [];
      const walk = (list: Element, depth: number) => {
        for (const block of list.querySelectorAll(":scope > .block")) {
          const row = block.querySelector(":scope > .block-row")!;
          const editor = row.querySelector("textarea");
          const text = editor ? editor.value : (row.querySelector(".block-content")?.textContent ?? "");
          lines.push("  ".repeat(depth) + text);
          const children = block.querySelector(":scope > .block-children");
          if (children) walk(children, depth + 1);
        }
      };
      walk(root, 0);
      return lines.join("\n");
    });
}

export async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByRole("status")).toHaveText("Saved", { timeout: 10_000 });
}
