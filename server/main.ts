import type { Database } from "bun:sqlite";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { AgentError, addBlocks, editBlock, pageOutline } from "./agent";
import { applyBatch, BadBatch, parseBatch, pruneHistory, renamePage } from "./apply";
import { dailyBackup } from "./backup";
import { openDb, schemaVersion } from "./db";
import { EventHub } from "./events";
import { checkRequest, parseHosts, withSecurityHeaders } from "./guard";
import { dayNumber, isJournalKey, journalName } from "../shared/names";
import { pageNameProblem } from "../shared/refs";
import { QueryError, runQuery } from "./query";
import { getBlockRefs, getBlocks, getBlockTree, getHistory, getJournals, getLinkedRefs, getPage, getRecentPages, RECENT_PAGES } from "./read";
import { getAgenda, getUnlinkedRefs, search } from "./search";

export interface ServerOptions {
  port: number;
  dataDir: string;
  distDir: string;
  hosts?: ReadonlySet<string>; // host names to answer besides localhost, e.g. a proxy's (NETSEQ_HOSTS)
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Where the notes live: $NETSEQ_DATA, or data/ next to the code. Used by the server and scripts/. */
export function dataDirFromEnv(): string {
  return resolve(process.env.NETSEQ_DATA ?? join(import.meta.dir, "..", "data"));
}

export function startServer({ port, dataDir, distDir, hosts }: ServerOptions) {
  const db = openDb(join(dataDir, "netseq.db"));
  const hub = new EventHub();
  pruneHistory(db);
  const pruner = setInterval(() => pruneHistory(db), DAY_MS);
  // Today's backup, if there isn't one yet. Checked every hour rather than at a set time, so a
  // laptop that sleeps through the night still gets one.
  const backupDir = join(dataDir, "backups");
  backUpToday(db, backupDir);
  const backups = setInterval(() => backUpToday(db, backupDir), HOUR_MS);

  const server = Bun.serve({
    hostname: "127.0.0.1", // there is no login yet, so never listen on other interfaces
    port,
    async fetch(req, server) {
      const denied = checkRequest(req, hosts);
      if (denied) return withSecurityHeaders(denied);
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/api/events") {
        server.timeout(req, 0); // the stream stays open; the hub's pings show it's alive
        return withSecurityHeaders(hub.connect());
      }
      return withSecurityHeaders(await route(req, url, db, hub, distDir));
    },
    error(err) {
      console.error(err);
      return withSecurityHeaders(Response.json({ error: "internal error" }, { status: 500 }));
    },
  });

  function stop(): void {
    clearInterval(pruner);
    clearInterval(backups);
    hub.close();
    server.stop(true);
    db.close();
  }
  return { server, db, hub, stop };
}

// A failed backup (disk full, say) is logged and tried again within the hour; the server carries on.
function backUpToday(db: Database, dir: string): void {
  try {
    const file = dailyBackup(db, dir);
    if (file) console.log(`Backed up to ${file}`);
  } catch (e) {
    console.error("Backup failed:", e);
  }
}

const AGENT_GUIDE = join(import.meta.dir, "agents.md");

async function route(req: Request, url: URL, db: Database, hub: EventHub, distDir: string): Promise<Response> {
  if (url.pathname.startsWith("/api/")) return api(req, url, db, hub);
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  // What NetSeq is and how to use its API, for AI agents.
  if (url.pathname === "/agents") return markdown(Bun.file(AGENT_GUIDE));
  return serveStatic(url.pathname, distDir);
}

async function api(req: Request, url: URL, db: Database, hub: EventHub): Promise<Response> {
  const params = url.searchParams;
  const block = /^\/api\/blocks\/([^/]+)(\/history|\/refs)?$/.exec(url.pathname);
  if (block && req.method === "GET") {
    if (block[2] === "/history") return Response.json(getHistory(db, block[1]));
    if (block[2] === "/refs") return Response.json(getBlockRefs(db, block[1]));
    const tree = getBlockTree(db, block[1]);
    return tree ? Response.json(tree) : Response.json({ error: "no such block" }, { status: 404 });
  }
  switch (`${req.method} ${url.pathname}`) {
    case "GET /api/healthz":
      return Response.json({ ok: true, schema: schemaVersion(db) });
    case "GET /api/pages":
      return Response.json(db.query("SELECT key, name, journal_day FROM pages ORDER BY key").all());
    case "GET /api/pages/recent":
      return Response.json(getRecentPages(db, RECENT_PAGES));
    case "GET /api/page": {
      const name = params.get("name");
      if (!name?.trim()) return badRequest("name is required");
      return Response.json(getPage(db, name));
    }
    case "GET /api/refs": {
      const name = params.get("name");
      if (!name?.trim()) return badRequest("name is required");
      return Response.json(getLinkedRefs(db, name));
    }
    case "GET /api/blocks": {
      const ids = (params.get("ids") ?? "").split(",").filter(Boolean);
      if (ids.length === 0 || ids.length > 200) return badRequest("ids must list 1 to 200 block ids");
      return Response.json(getBlocks(db, ids));
    }
    case "GET /api/unlinked": {
      const name = params.get("name");
      if (!name?.trim()) return badRequest("name is required");
      return Response.json(getUnlinkedRefs(db, name));
    }
    case "GET /api/search":
      return Response.json(search(db, (params.get("q") ?? "").slice(0, 500)));
    case "GET /api/query": {
      try {
        return Response.json(runQuery(db, params.get("q") ?? "", today(params), params.get("block")));
      } catch (e) {
        if (e instanceof QueryError) return badRequest(e.message);
        throw e;
      }
    }
    case "GET /api/agenda":
      return Response.json(getAgenda(db, today(params)));
    case "POST /api/rename": {
      const body = (await req.json().catch(() => null)) as { from?: unknown; to?: unknown } | null;
      if (typeof body?.from !== "string" || typeof body.to !== "string" || body.to.length > 500) {
        return badRequest("from and to must be page names");
      }
      const problem = pageNameProblem(body.to);
      if (problem) return badRequest(problem);
      const outcome = renamePage(db, body.from, body.to);
      if (!outcome.ok) {
        const error = outcome.status === 404 ? "no such page" : "a page with that name already exists";
        return Response.json({ error }, { status: outcome.status });
      }
      hub.publish("change", outcome.result);
      return Response.json(outcome.result);
    }
    case "GET /api/journals": {
      // ?days=2026-11-03,2026-11-02: those days, in that order (for reloading what's on screen).
      const days = params.get("days");
      if (days !== null) {
        const names = days.split(",");
        if (names.length > 500 || !names.every(isJournalKey)) return badRequest("days must list up to 500 ISO dates");
        return Response.json(names.map((name) => getPage(db, name)));
      }
      const before = Number(params.get("before"));
      if (!Number.isInteger(before)) return badRequest("before must be a yyyymmdd day");
      const limit = Math.min(50, Math.max(1, Number(params.get("limit")) || 5));
      return Response.json(getJournals(db, before, limit));
    }
    case "GET /api/agent/page": {
      const name = params.get("name");
      if (!name?.trim()) return badRequest("name is required");
      const outline = pageOutline(db, name);
      return outline === null ? Response.json({ error: "no such page" }, { status: 404 }) : markdown(outline);
    }
    case "POST /api/agent/add":
    case "POST /api/agent/edit": {
      const body = await req.json().catch(() => null);
      try {
        const { result, ...reply } = url.pathname.endsWith("/add") ? addBlocks(db, body) : editBlock(db, body);
        if (result) hub.publish("change", result);
        return Response.json(reply);
      } catch (e) {
        if (e instanceof AgentError) return Response.json({ error: e.message, ...e.details }, { status: e.status });
        throw e;
      }
    }
    case "POST /api/batch": {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return badRequest("invalid JSON");
      }
      try {
        const result = applyBatch(db, parseBatch(body));
        hub.publish("change", result);
        return Response.json(result);
      } catch (e) {
        if (e instanceof BadBatch) return badRequest(e.message);
        throw e;
      }
    }
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

/** The browser's today (yyyymmdd), since the server's clock may be in another time zone. */
function today(params: URLSearchParams): number {
  const day = params.get("today") ?? "";
  return /^\d{8}$/.test(day) ? Number(day) : dayNumber(journalName(new Date()));
}

function markdown(body: string | Blob): Response {
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-cache" } });
}

function badRequest(error: string): Response {
  return Response.json({ error }, { status: 400 });
}

async function serveStatic(pathname: string, distDir: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const file = resolve(distDir, "." + decoded);
  if (file.startsWith(distDir + sep) && (await isFile(file))) {
    // Vite gives everything under assets/ a content hash, so those files never change.
    const cache = pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(Bun.file(file), { headers: { "Cache-Control": cache } });
  }
  // Anything else is a route inside the app.
  const index = join(distDir, "index.html");
  if (await isFile(index)) return new Response(Bun.file(index), { headers: { "Cache-Control": "no-cache" } });
  return new Response("The web app isn't built yet: run `bun run build`, or `bun run dev` while developing.", {
    status: 404,
  });
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = dataDirFromEnv();
  const distDir = resolve(import.meta.dir, "..", "web", "dist");
  const hosts = parseHosts(process.env.NETSEQ_HOSTS);
  const { server } = startServer({ port, dataDir, distDir, hosts });
  console.log(`NetSeq is running at http://localhost:${server.port} (data in ${dataDir})`);
  if (hosts.size > 0) console.log(`Also answering requests for: ${[...hosts].join(", ")}`);
}
