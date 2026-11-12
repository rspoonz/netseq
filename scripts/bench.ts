// `bun run bench`: how fast NetSeq is on a big graph. Generates a repeatable 100k-block graph in a
// temporary folder (never your notes), times the server's main operations, then opens the app on
// it in Chromium. Takes a minute or so, so it isn't part of `bun run check`. Results: RUNBOOK.md.
import { chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { applyBatch, renamePage } from "../server/apply";
import { backupNow } from "../server/backup";
import { openDb } from "../server/db";
import { exportMarkdown } from "../server/export";
import { startServer } from "../server/main";
import { runQuery } from "../server/query";
import { getJournals, getLinkedRefs, getPage, getRecentPages, RECENT_PAGES } from "../server/read";
import { getAgenda, getUnlinkedRefs, search } from "../server/search";
import { formatDate } from "../shared/blocktext";
import { renderBlock } from "../shared/markdown";
import { dayNumber, journalName, pageKey } from "../shared/names";
import { keysBetween } from "../shared/order";
import { pageNames } from "../shared/softlinks";
import type { Op } from "../shared/types";

const PAGES = 700; // × 100 blocks
const DAYS = 1000; // journal days up to today, × 28 blocks
const BIG_PAGE = "Big page"; // one page with 2,000 blocks
const PORT = 8098;

// --- A repeatable graph ------------------------------------------------------------------------

let seed = 42;
function random(): number {
  // mulberry32: small, seedable, good enough for test data
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (n: number) => Math.floor(random() * n);

const WORDS = "meeting notes project plan review call email draft budget team design test start idea follow up thruster vessel control".split(" ");
const today = new Date();
const dayOffset = (days: number) => journalName(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));
const referable: string[] = []; // block ids to point ((references)) at

function content(): string {
  const roll = pick(100);
  let text = Array.from({ length: 5 + pick(12) }, () => WORDS[pick(WORDS.length)]).join(" ");
  if (roll < 15) text += ` [[Page ${pick(PAGES)}]]`;
  else if (roll < 20) text += ` #tag${pick(50)}`;
  else if (roll < 21 && referable.length > 0) text += ` ((${referable[pick(referable.length)]}))`;
  if (roll >= 30 && roll < 40) text = `TODO ${text}`;
  if (roll >= 40 && roll < 43) text = `DONE ${text}`;
  if (roll >= 30 && roll < 33) text += `\nSCHEDULED: ${formatDate(dayOffset(pick(60) - 30))}`;
  if (roll >= 50 && roll < 52) text += "\nstatus:: draft";
  if (roll >= 60 && roll < 65) text += `\n${WORDS[pick(WORDS.length)]} on a second line`;
  return text;
}

/** A page's blocks: groups of five (one top-level block, three children, one grandchild). */
function pageOps(page: string, count: number): Op[] {
  const keys = keysBetween(null, null, count);
  const ops: Op[] = [];
  let top: string | null = null;
  let previous: string | null = null;
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID();
    const parent: string | null = i % 5 === 0 ? null : i % 5 === 4 ? previous : top;
    ops.push({ t: "block", id, page, parent, order_key: keys[i], content: content(), collapsed: false, base: 0 });
    if (parent === null) top = id;
    previous = id;
    if (pick(100) === 0) referable.push(id);
  }
  return ops;
}

// --- Timing ------------------------------------------------------------------------------------

interface Row {
  label: string;
  ms: number;
  budget: number | null; // null: reported only
}
const rows: Row[] = [];

function time(label: string, budget: number | null, fn: () => unknown, runs = 5): void {
  fn(); // warm-up
  const started = performance.now();
  for (let i = 0; i < runs; i++) fn();
  rows.push({ label, ms: (performance.now() - started) / runs, budget });
}

function report(title: string, list: Row[]): void {
  console.log(`\n${title}`);
  for (const { label, ms, budget } of list) {
    const verdict = budget === null ? "" : ms <= budget ? `ok (budget ${budget} ms)` : `SLOW (budget ${budget} ms)`;
    console.log(`  ${label.padEnd(46)} ${ms.toFixed(1).padStart(9)} ms   ${verdict}`);
  }
}

// --- Server ------------------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "netseq-bench-"));
const removeRoot = () => rmSync(root, { recursive: true, force: true });
// Ctrl+C (or a kill) skips `finally`, so the generated graph is removed here too.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    removeRoot();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}
try {
  const db = openDb(join(root, "netseq.db")); // a real file, so saves include the disk sync
  const writer = { writer: "bench", device: "Bench" };
  let started = performance.now();
  // Every 50 pages, a pause for the event loop, so Ctrl+C is handled straight away.
  for (let p = 0; p < PAGES; p++) {
    applyBatch(db, { ...writer, ops: pageOps(`Page ${p}`, 100) });
    if (p % 50 === 0) await Bun.sleep(0);
  }
  for (let d = DAYS - 1; d >= 0; d--) {
    applyBatch(db, { ...writer, ops: pageOps(dayOffset(-d), 28) });
    if (d % 50 === 0) await Bun.sleep(0);
  }
  applyBatch(db, { ...writer, ops: pageOps(BIG_PAGE, 2000) });
  const { n: blocks } = db.query("SELECT count(*) AS n FROM blocks").get() as { n: number };
  console.log(`Generated ${blocks} blocks on ${PAGES + DAYS + 1} pages in ${((performance.now() - started) / 1000).toFixed(1)} s (${root})`);

  const todayNumber = dayNumber(dayOffset(0));
  const { page: popular } = db.query("SELECT page, count(*) AS n FROM refs GROUP BY page ORDER BY n DESC LIMIT 1").get() as { page: string };
  const sample = db.query("SELECT id, page, parent, order_key, content FROM blocks WHERE page = 'page 5' LIMIT 1").get() as {
    id: string;
    parent: string | null;
    order_key: string;
    content: string;
  };
  let base = (db.query("SELECT rev FROM blocks WHERE id = ?").get(sample.id) as { rev: number }).rev;
  let pasted = 0;

  time("save one block (a keystroke)", 100, () => {
    const op: Op = { t: "block", id: sample.id, page: "Page 5", parent: sample.parent, order_key: sample.order_key, content: `${sample.content} ${base}`, collapsed: false, base };
    base = applyBatch(db, { ...writer, ops: [op] }).rev;
  });
  time("paste 100 blocks", 100, () => applyBatch(db, { ...writer, ops: pageOps(`Pasted ${pasted++}`, 100) }));
  time("open a 100-block page", 100, () => getPage(db, "Page 7"));
  time(`open the ${BIG_PAGE.toLowerCase()} (2,000 blocks)`, 100, () => getPage(db, BIG_PAGE));
  time("journals: 5 days", 100, () => getJournals(db, todayNumber + 1, 5));
  time('search "thruster vessel"', 100, () => search(db, "thruster vessel"));
  time('search "zzz" (no hits)', 100, () => search(db, "zzz"));
  time(`linked references of the most linked page`, 100, () => getLinkedRefs(db, popular));
  time('unlinked references of "thruster"', 100, () => getUnlinkedRefs(db, "thruster"));
  time("query (task TODO DOING), 500 shown", 100, () => runQuery(db, "(task TODO DOING)", todayNumber, null));
  time("query (and [[Page 1]] (task TODO))", 100, () => runQuery(db, "(and [[Page 1]] (task TODO))", todayNumber, null));
  time("agenda", 100, () => getAgenda(db, todayNumber));
  time("recently changed pages", 100, () => getRecentPages(db, RECENT_PAGES));
  time("rename the most linked page (and back)", 100, () => {
    const name = (db.query("SELECT name FROM pages WHERE key = ?").get(popular) as { name: string }).name;
    renamePage(db, name, `${name} renamed`);
    renamePage(db, `${name} renamed`, name);
  }, 2);
  // What the browser does per block shown: here with two plain-text mentions of page names in each.
  const allNames = (db.query("SELECT name FROM pages").all() as { name: string }[]).map((row) => row.name);
  const bigTexts = (db.query("SELECT content FROM blocks WHERE page = ?").all(pageKey(BIG_PAGE)) as { content: string }[]).map(
    ({ content }) => `${content} with Page ${pick(PAGES)} and page ${pick(PAGES)}`,
  );
  time(`soft links: index ${allNames.length} page names`, 100, () => pageNames(allNames));
  const names = pageNames(allNames);
  time("render 2,000 blocks with soft links", 500, () => {
    for (const text of bigTexts) renderBlock(text, undefined, undefined, names);
  });
  time("backup (once a day; the server waits)", 1000, () => backupNow(db, join(root, "bench-backups"), "netseq"), 1);
  time("export (own process; the server doesn't wait)", null, () => exportMarkdown(db, join(root, "export")), 1);
  db.close();
  report("Server, on the generated graph:", rows);

  // --- Browser ---------------------------------------------------------------------------------

  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: resolve(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`bun run build failed:\n${build.stderr.toString()}`);
  const server = startServer({ port: PORT, dataDir: root, distDir: resolve(import.meta.dir, "..", "web", "dist") });
  const browser = await chromium.launch();
  const browserRows: Row[] = [];
  try {
    const page = await browser.newPage();
    const url = `http://localhost:${PORT}`;
    await page.goto(`${url}/pages`); // loads the app once, so the timings below don't include it
    await page.waitForSelector(".content");

    // Code that runs in the page is passed as text: this file is type-checked with the server's
    // settings, which leave out the browser's types on purpose.
    const outlineCount = (min: number) =>
      page.waitForFunction(`(document.querySelector(".outline")?.querySelectorAll(".block-content").length ?? 0) >= ${min}`, undefined, {
        timeout: 60_000,
      });

    started = performance.now();
    await page.goto(`${url}/page/${encodeURIComponent(BIG_PAGE)}`);
    await outlineCount(2000);
    browserRows.push({ label: `open the ${BIG_PAGE.toLowerCase()} (2,000 blocks)`, ms: performance.now() - started, budget: 1000 });

    started = performance.now();
    await page.goto(`${url}/page/${encodeURIComponent("Page 7")}`);
    await outlineCount(100);
    browserRows.push({ label: "open a 100-block page", ms: performance.now() - started, budget: 1000 });

    started = performance.now();
    await page.goto(url);
    await outlineCount(28);
    browserRows.push({ label: "open the journals (today shown)", ms: performance.now() - started, budget: 1000 });

    // Typing on the big page: from each keydown to the next frame after the text changed.
    await page.goto(`${url}/page/${encodeURIComponent(BIG_PAGE)}`);
    await outlineCount(2000);
    await page.locator(".outline .block-content").nth(1000).click();
    await page.locator(".block-editor").waitFor();
    await page.evaluate(`(() => {
      window.latencies = [];
      let down = 0;
      document.addEventListener("keydown", () => (down = performance.now()), true);
      document.addEventListener("input", () => requestAnimationFrame(() => window.latencies.push(performance.now() - down)), true);
    })()`);
    await page.keyboard.type("typing on a big page", { delay: 60 });
    await page.waitForTimeout(500);
    const latencies = ((await page.evaluate("window.latencies")) as number[]).sort((a, b) => a - b);
    browserRows.push({ label: "a keystroke on the big page (median)", ms: latencies[Math.floor(latencies.length / 2)], budget: 50 });
    browserRows.push({ label: "a keystroke on the big page (slowest)", ms: latencies[latencies.length - 1], budget: 100 });
  } finally {
    await browser.close();
    server.stop();
  }
  report("Browser (Chromium), on the generated graph:", browserRows);
  rows.push(...browserRows);

  const slow = rows.filter((row) => row.budget !== null && row.ms > row.budget);
  console.log(slow.length === 0 ? "\nEverything is within budget." : `\n${slow.length} over budget: ${slow.map((row) => row.label).join("; ")}`);
  if (slow.length > 0) process.exitCode = 1;
} finally {
  removeRoot();
}
