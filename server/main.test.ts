import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BatchResult, HistoryEntry, PageData, QueryResult, RefGroup, SearchHit } from "../shared/types";
import { blockOp } from "./testing";
import { startServer } from "./main";

let base: string;
let stop: () => void;
let root: string;
let handle: (req: Request) => Response | Promise<Response>; // the server's fetch, for headers fetch() won't send

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "netseq-server-"));
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>NetSeq</title>");
  writeFileSync(join(dist, "assets", "app-abc123.js"), "console.log('app')");

  const hosts = new Set(["notes.example"]);
  const server = startServer({ port: 0, dataDir: join(root, "data"), distDir: dist, hosts });
  base = `http://127.0.0.1:${server.server.port}`;
  handle = (req) => server.server.fetch(req);
  stop = () => {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  };
});

afterAll(() => stop());

test("the health check reports the schema version", async () => {
  const res = await fetch(`${base}/api/healthz`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, schema: 2 });
});

test("starting the server makes today's backup", () => {
  expect(readdirSync(join(root, "data", "backups"))).toEqual([expect.stringMatching(/^netseq-\d{4}-\d{2}-\d{2}-\d{6}\.db$/)]);
});

test("a fresh database has no pages", async () => {
  expect(await (await fetch(`${base}/api/pages`)).json()).toEqual([]);
  expect(await (await fetch(`${base}/api/pages/recent`)).json()).toEqual([]);
});

test("answers the extra host names it was given (NETSEQ_HOSTS), and still refuses others", async () => {
  const health = (host: string) => handle(new Request(`${base}/api/healthz`, { headers: { host } }));
  expect((await health("notes.example")).status).toBe(200);
  expect((await health("evil.example")).status).toBe(403);
});

test("unknown API routes are 404", async () => {
  expect((await fetch(`${base}/api/nope`)).status).toBe(404);
});

test("routes inside the app get index.html, with security headers", async () => {
  const res = await fetch(`${base}/page/Some%20Page`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<title>NetSeq</title>");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
});

test("hashed assets are cached for a long time", async () => {
  const res = await fetch(`${base}/assets/app-abc123.js`);
  expect(await res.text()).toBe("console.log('app')");
  expect(res.headers.get("cache-control")).toContain("immutable");
});

test("files outside the build folder are never served", async () => {
  // Decodes to /../data/netseq.db, which exists next to the build folder in this test.
  const res = await fetch(`${base}/..%2fdata%2fnetseq.db`);
  expect(await res.text()).toContain("<title>NetSeq</title>");
});

test("writes must be JSON", async () => {
  const res = await fetch(`${base}/api/pages`, { method: "POST", body: "x", headers: { "content-type": "text/plain" } });
  expect(res.status).toBe(415);
});

function postBatch(writer: string, ops: unknown[]): Promise<Response> {
  return fetch(`${base}/api/batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writer, device: "Test", ops }),
  });
}

test("saved blocks come back from GET /api/page", async () => {
  expect((await postBatch("w", [blockOp("p1", "Saved Page", null, "a0", { content: "hello" })])).status).toBe(200);
  const data = (await (await fetch(`${base}/api/page?name=saved%20page`)).json()) as PageData;
  expect(data.page?.name).toBe("Saved Page");
  expect(data.blocks.map((b) => b.content)).toEqual(["hello"]);
});

test("open event streams receive every batch", async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  await postBatch("w", [blockOp("e1", "Events", null, "a0", { content: "live" })]);
  let text = "";
  while (!text.includes("event: change")) text += decoder.decode((await reader.read()).value);
  while (!text.endsWith("\n\n")) text += decoder.decode((await reader.read()).value);
  const data = JSON.parse(text.split("event: change\ndata: ")[1]!) as BatchResult;
  expect(data.rows.map((r) => r.content)).toEqual(["live"]);
  controller.abort();
});

test("a block's replaced text can be read back", async () => {
  await postBatch("laptop", [blockOp("h1", "History", null, "a0", { content: "first" })]);
  await postBatch("phone", [blockOp("h1", "History", null, "a0", { content: "second" })]); // based on rev 0
  const history = (await (await fetch(`${base}/api/blocks/h1/history`)).json()) as HistoryEntry[];
  expect(history.map((h) => h.content)).toEqual(["first"]);
});

test("journal days can be fetched by name, in the order asked, empty ones included", async () => {
  const ops = [blockOp("j1", "2026-10-30", null, "a0", { content: "a day" })];
  await fetch(`${base}/api/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ writer: "http", device: "Test", ops }),
  });
  const days = (await (await fetch(`${base}/api/journals?days=2026-10-31,2026-10-30`)).json()) as PageData[];
  expect(days.map((day) => [day.page?.key ?? null, day.blocks.length])).toEqual([
    [null, 0],
    ["2026-10-30", 1],
  ]);
  expect((await fetch(`${base}/api/journals?days=not-a-day`)).status).toBe(400);
});

test("search, queries and the agenda answer over HTTP; a bad query is a 400 with a message", async () => {
  const ops = [
    blockOp("t1", "Errands", null, "a0", { content: "TODO buy stamps\nSCHEDULED: <2026-11-01 Sun>" }),
    blockOp("t2", "Errands", null, "a1", { content: "DONE post the letter" }),
  ];
  const post = await fetch(`${base}/api/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ writer: "http", device: "Test", ops }),
  });
  expect(post.status).toBe(200);

  const hits = (await (await fetch(`${base}/api/search?q=stamps`)).json()) as SearchHit[];
  expect(hits.map((hit) => hit.id)).toEqual(["t1"]);

  const query = (await (await fetch(`${base}/api/query?q=${encodeURIComponent("(task TODO)")}&block=x`)).json()) as QueryResult;
  expect(query.groups.flatMap((group) => group.roots)).toEqual(["t1"]);

  const bad = await fetch(`${base}/api/query?q=${encodeURIComponent("(task")}`);
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "(task) takes markers such as TODO and DONE." });

  const agenda = (await (await fetch(`${base}/api/agenda?today=20261103`)).json()) as RefGroup[];
  expect(agenda.flatMap((group) => group.roots)).toEqual(["t1"]);
  const before = (await (await fetch(`${base}/api/agenda?today=20261031`)).json()) as RefGroup[];
  expect(before).toEqual([]);
});

test("/agents serves the agent guide as markdown, and every endpoint it lists exists", async () => {
  const res = await fetch(`${base}/agents`);
  expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  const guide = await res.text();
  expect(guide).toStartWith("# NetSeq: a guide for AI agents");
  const endpoints = [...guide.matchAll(/`(GET|POST|PUT) (\/api\/[^`?\s]+)/g)].map((m) => [m[1], m[2]] as const);
  expect(endpoints.length).toBeGreaterThanOrEqual(7);
  for (const [method, path] of endpoints) {
    const init = method !== "GET" ? { method, headers: { "content-type": "application/json" }, body: "{}" } : {};
    const answer = await (await fetch(`${base}${path}`, init)).text();
    expect(`${method} ${path}: ${answer}`).not.toContain('"not found"');
  }
});

test("agents add, edit and move blocks over HTTP; open tabs hear of it", async () => {
  const controller = new AbortController();
  const events = (await fetch(`${base}/api/events`, { signal: controller.signal })).body!.getReader();
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/agent/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const appended = await post("add", { page: "Agent Notes", text: "- TODO first\n  - detail" });
  const { page, ids } = (await appended.json()) as { page: string; ids: string[] };
  expect(page).toBe("Agent Notes");
  let text = "";
  while (!text.includes("TODO first")) text += new TextDecoder().decode((await events.read()).value);
  controller.abort();

  expect((await post("edit", { id: ids[0], content: "DONE first" })).status).toBe(200);
  const inserted = (await (await post("add", { before: ids[1], text: "summary" })).json()) as { ids: string[] };
  const outline = await (await fetch(`${base}/api/agent/page?name=agent%20notes`)).text();
  expect(outline).toBe(
    `- DONE first\n  id:: ${ids[0]}\n\t- summary\n\t  id:: ${inserted.ids[0]}\n\t- detail\n\t  id:: ${ids[1]}`,
  );
  const history = (await (await fetch(`${base}/api/blocks/${ids[0]}/history`)).json()) as HistoryEntry[];
  expect(history.map((h) => [h.content, h.device])).toEqual([["TODO first", "Agent"]]);

  const moved = await post("move", { id: ids[1], outdent: true });
  expect(await moved.json()).toEqual({ id: ids[1], page: "Agent Notes" });
  expect(await (await fetch(`${base}/api/agent/page?name=agent%20notes`)).text()).toBe(
    `- DONE first\n  id:: ${ids[0]}\n\t- summary\n\t  id:: ${inserted.ids[0]}\n- detail\n  id:: ${ids[1]}`,
  );
  expect(await (await post("move", { id: ids[0], indent: true })).json()).toEqual({
    error: "there's no block above it at its level to indent it under",
  });

  expect((await fetch(`${base}/api/agent/page?name=nowhere`)).status).toBe(404);
  expect(await (await post("edit", { id: "missing", content: "x" })).json()).toEqual({ error: "no such block" });
  const stale = await post("edit", { id: ids[0], content: "x", expect: "TODO first" });
  expect([stale.status, await stale.json()]).toEqual([409, { error: "the block has changed since you read it", content: "DONE first" }]);
  expect((await post("add", "not an object")).status).toBe(400);
});

test("favourites are set as one list; open tabs hear of it, and /llms.txt is the agent guide too", async () => {
  const controller = new AbortController();
  const events = (await fetch(`${base}/api/events`, { signal: controller.signal })).body!.getReader();
  const put = (body: unknown) =>
    fetch(`${base}/api/favourites`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const set = await put({ pages: ["Agent Notes", "Not written yet"] });
  expect(set.status).toBe(200);
  let text = "";
  while (!text.includes("event: favourites")) text += new TextDecoder().decode((await events.read()).value);
  controller.abort();
  const list = (await (await fetch(`${base}/api/favourites`)).json()) as { name: string }[];
  expect(list.map((page) => page.name)).toEqual(["Agent Notes", "Not written yet"]);

  expect([(await put({ pages: "Agent Notes" })).status, (await put({ pages: [] })).status]).toEqual([400, 200]);
  expect(await (await fetch(`${base}/api/favourites`)).json()).toEqual([]);
  expect(await (await fetch(`${base}/llms.txt`)).text()).toStartWith("# NetSeq: a guide for AI agents");
});

test("/mcp answers MCP clients over HTTP, as a client sends its requests", async () => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
  const post = (message: unknown) => fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(message) });
  const init = await post({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  expect(init.headers.get("content-type")).toStartWith("application/json");
  expect(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
  expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);

  const call = await post({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "add_blocks", arguments: { page: "Via MCP", text: "hello" } } });
  const { id, result } = (await call.json()) as { id: string; result: { content: { text: string }[] } };
  expect([id, JSON.parse(result.content[0].text).page]).toEqual(["a", "Via MCP"]);
  expect(await (await fetch(`${base}/api/agent/page?name=via%20mcp`)).text()).toContain("- hello");

  expect((await fetch(`${base}/mcp`)).status).toBe(405); // no stream to listen on
  const crossSite = await handle(new Request(`${base}/mcp`, { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body: "{}" }));
  expect(crossSite.status).toBe(403); // a website open in the same browser can't call tools
});

test("the web app's page points agents to /agents", async () => {
  const html = await Bun.file(join(import.meta.dir, "..", "web", "index.html")).text();
  expect(html).toContain('<link rel="help" type="text/markdown" href="/agents" />');
});
