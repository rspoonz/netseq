import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { applyBatch } from "./apply";
import { openDb } from "./db";
import { EventHub } from "./events";
import { getFavourites } from "./favourites";
import { handleMcp } from "./mcp";
import { blockOp, checkTree, outlineOf, writer } from "./testing";

let db: Database;
let hub: EventHub;
let published: string[];

beforeEach(() => {
  db = openDb(":memory:");
  hub = new EventHub();
  published = [];
  hub.publish = (event) => void published.push(event);
});

afterEach(() => {
  checkTree(db);
  db.close();
});

function post(message: unknown): Promise<Response> {
  const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) };
  return handleMcp(new Request("http://localhost/mcp", init), db, hub);
}

async function rpc(method: string, params?: unknown): Promise<any> {
  const res = await post({ jsonrpc: "2.0", id: 1, method, params });
  expect(res.status).toBe(200);
  return res.json();
}

/** Calls a tool: its text, and whether it reported an error. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const { result } = await rpc("tools/call", { name, arguments: args });
  return { text: result.content[0].text, isError: result.isError === true };
}

test("initialize agrees on a protocol version and says what NetSeq is", async () => {
  const { result } = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  expect(result.protocolVersion).toBe("2025-03-26");
  expect(result.capabilities).toEqual({ tools: {} });
  expect(result.serverInfo.name).toBe("netseq");
  expect(result.instructions).toContain("personal outliner");
  expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe("2025-06-18");
});

test("notifications get 202 and no answer; other methods and shapes get JSON-RPC errors", async () => {
  const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect([notified.status, await notified.text()]).toEqual([202, ""]);
  expect((await rpc("ping")).result).toEqual({});
  expect((await rpc("resources/list")).error.code).toBe(-32601);
  expect((await rpc("tools/call", { name: "nope" })).error.code).toBe(-32602);
  expect((await post([{ jsonrpc: "2.0", id: 1, method: "ping" }])).status).toBe(400);
  expect((await handleMcp(new Request("http://localhost/mcp"), db, hub)).status).toBe(405);
});

test("every tool has a description and a schema, and only delete_block is marked destructive", async () => {
  const { tools } = (await rpc("tools/list")).result as { tools: any[] };
  expect(tools.map((tool) => tool.name)).toEqual([
    "list_pages", "read_page", "search", "query", "add_blocks", "edit_block", "move_block", "delete_block", "rename_page", "set_favourites",
  ]);
  for (const tool of tools) {
    expect(tool.description.length).toBeGreaterThan(20);
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.run).toBeUndefined();
  }
  expect(tools.filter((tool) => tool.annotations.destructiveHint).map((tool) => tool.name)).toEqual(["delete_block"]);
  expect(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual(["list_pages", "read_page", "search", "query"]);
});

test("an agent finds its way around: pages, a page, a block, search and a query", async () => {
  applyBatch(db, {
    ...writer,
    ops: [
      blockOp("a", "Project", null, "a0", { content: "Plan with [[Alice]]" }),
      blockOp("b", "Project", "a", "a0", { content: "TODO write it down" }),
      blockOp("j", "2026-11-05", null, "a0", { content: "a day" }),
    ],
  });
  await call("set_favourites", { pages: ["Project"] });
  expect(JSON.parse((await call("list_pages")).text)).toEqual({
    favourites: ["Project"],
    recently_changed: ["Project"],
    pages: ["Alice", "Project"],
    journal_days: { count: 1, first: "2026-11-05", last: "2026-11-05" },
  });
  expect((await call("read_page", { name: "project" })).text).toBe("- Plan with [[Alice]]\n  id:: a\n\t- TODO write it down\n\t  id:: b");
  expect((await call("read_page", { block: "b" })).text).toBe("- TODO write it down\n  id:: b");
  expect(await call("read_page", { name: "Nowhere" })).toEqual({ text: '{\n "error": "no such page"\n}', isError: true });
  expect(JSON.parse((await call("search", { query: "write" })).text)).toEqual([{ id: "b", page: "Project", text: "TODO write it down" }]);
  expect((await call("query", { query: "(task TODO)" })).text).toBe("## Project\n\n- TODO write it down\n  id:: b");
  expect((await call("query", { query: "(task DONE)" })).text).toBe("No blocks match.");
  expect((await call("query", { query: "(task" })).isError).toBe(true);
  expect((await call("query", { query: "x", today: "tomorrow" })).isError).toBe(true);
});

test("an agent writes: add, edit, move, rename, and open tabs hear of each change", async () => {
  const added = JSON.parse((await call("add_blocks", { page: "Notes", text: "- one\n- two", agent: "Claude" })).text);
  expect(added.page).toBe("Notes");
  const [one, two] = added.ids as string[];
  expect((await call("edit_block", { id: one, expect: "one", content: "first" })).isError).toBe(false);
  const stale = await call("edit_block", { id: one, expect: "one", content: "again" });
  expect([stale.isError, JSON.parse(stale.text).content]).toEqual([true, "first"]);
  expect((await call("move_block", { id: two, indent: true })).isError).toBe(false);
  expect(outlineOf(db, "notes")).toBe("first\n  two");
  expect(JSON.parse((await call("rename_page", { from: "Notes", to: "Ideas" })).text)).toEqual({ page: "Ideas" });
  expect((await call("rename_page", { from: "Notes", to: "Ideas" })).isError).toBe(true); // no such page any more
  expect(outlineOf(db, "ideas")).toBe("first\n  two");
  await call("set_favourites", { pages: ["Ideas"] });
  expect(getFavourites(db).map((page) => page.name)).toEqual(["Ideas"]);
  expect(published).toEqual(["change", "change", "change", "change", "favourites"]);
});

test("delete_block needs the block's text, takes everything under it, and hands back what it removed", async () => {
  const { ids } = JSON.parse((await call("add_blocks", { page: "Notes", text: "- keep\n- gone\n  - under it" })).text);
  expect((await call("delete_block", { id: ids[1] })).isError).toBe(true); // no expect
  const stale = await call("delete_block", { id: ids[1], expect: "something else" });
  expect([stale.isError, JSON.parse(stale.text).content]).toEqual([true, "gone"]);
  expect(outlineOf(db, "notes")).toBe("keep\ngone\n  under it");

  const deleted = JSON.parse((await call("delete_block", { id: ids[1], expect: "gone" })).text);
  expect(deleted).toEqual({ id: ids[1], page: "Notes", deleted: 2, outline: "- gone\n\t- under it" });
  expect(outlineOf(db, "notes")).toBe("keep");
  await call("add_blocks", { page: "Notes", text: deleted.outline }); // which puts it back
  expect(outlineOf(db, "notes")).toBe("keep\ngone\n  under it");
});
