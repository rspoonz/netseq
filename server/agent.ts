import type { Database } from "bun:sqlite";
import { parseOutline, type OutlineItem } from "../shared/markdownOutline";
import { pageKey } from "../shared/names";
import { keysBetween } from "../shared/order";
import { pageNameProblem } from "../shared/refs";
import type { Batch, BatchResult, Op } from "../shared/types";
import { applyBatch } from "./apply";
import { pageMarkdown } from "./export";
import { getPage, pageSummary } from "./read";

// The API for AI agents, described to them by agents.md (served at /agents). Agents read pages as
// markdown outlines and write through two small endpoints, so they never deal with order keys,
// revs or writer ids. Changes go through applyBatch, like the browser's, so they're indexed and
// show up live in open tabs. Agents can't delete anything, and an edit always keeps the text it
// replaced in the block's history ("Earlier versions").

/** A request the agent API refuses, with the HTTP status and anything else to answer it with. */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The writer id all agent changes share. Agents keep replaced text themselves, so one is enough. */
export const AGENT_WRITER = "agent";

/**
 * Who a change comes from, as people see it in a block's history: "Claude (agent)" for an agent
 * that gave its name, or just "Agent".
 */
function agentWriter(name: unknown): Pick<Batch, "writer" | "device"> {
  if (name !== undefined && typeof name !== "string") throw new AgentError("agent must be a name");
  const label = name?.trim().slice(0, 50);
  return { writer: AGENT_WRITER, device: label ? `${label} (agent)` : "Agent" };
}

/** A page as a markdown outline with every block's id, or null if there's no such page. */
export function pageOutline(db: Database, name: string): string | null {
  const { page, blocks } = getPage(db, name);
  return page ? pageMarkdown(blocks, { allIds: true }) : null;
}

export interface Added {
  result: BatchResult;
  page: string; // the page's name
  ids: string[]; // the new blocks, in outline order
}

const POSITIONS = ["page", "parent", "after", "before"] as const;

/**
 * Adds blocks at one of four places: the end of a page's top level (`page`), the end of a block's
 * children (`parent`), or right after or before a block, as its siblings (`after`, `before`).
 * `text` is either one block's text, or a markdown outline ("- a\n  - b") when it starts with a
 * bullet.
 */
export function addBlocks(db: Database, body: unknown, now = Date.now()): Added {
  if (!isRecord(body)) throw new AgentError("expected a JSON object");
  const given = POSITIONS.filter((key) => body[key] !== undefined);
  if (given.length !== 1) throw new AgentError("give one of page, parent, after or before");
  const [position] = given;
  const where = body[position];
  if (typeof where !== "string") throw new AgentError(`${position} must be a ${position === "page" ? "page name" : "block id"}`);
  const { text } = body;
  const who = agentWriter(body.agent);
  if (typeof text !== "string" || !text.trim()) throw new AgentError("text must be a non-empty string");
  const items = /^\s*[-*+] /.test(text) ? parseOutline(text) : [{ content: text.trim(), children: [] }];

  return db.transaction((): Added => {
    let pageName: string;
    let parentId: string | null = null;
    let lo: string | null; // the new blocks go between these sibling keys (null: the start or end)
    let hi: string | null = null;
    const lastKey = (under: string | null) =>
      (
        db.query("SELECT max(order_key) AS key FROM blocks WHERE page = ? AND parent IS ?").get(pageKey(pageName), under) as {
          key: string | null;
        }
      ).key;

    if (position === "page") {
      const problem = pageNameProblem(where);
      if (problem) throw new AgentError(problem);
      pageName = pageSummary(db, pageKey(where))?.name ?? where.trim();
      lo = lastKey(null);
    } else {
      const block = db
        .query("SELECT b.page, b.parent, b.order_key, p.name FROM blocks b JOIN pages p ON p.key = b.page WHERE b.id = ?")
        .get(where) as { page: string; parent: string | null; order_key: string; name: string } | null;
      if (!block) throw new AgentError("no such block", 404);
      pageName = block.name;
      if (position === "parent") {
        parentId = where;
        lo = lastKey(where);
      } else {
        // The block's neighbour on the other side, in the siblings' (order_key, id) order.
        parentId = block.parent;
        const after = position === "after";
        const neighbour = db
          .query(
            after
              ? "SELECT order_key FROM blocks WHERE page = ?1 AND parent IS ?2 AND (order_key > ?3 OR (order_key = ?3 AND id > ?4)) ORDER BY order_key, id LIMIT 1"
              : "SELECT order_key FROM blocks WHERE page = ?1 AND parent IS ?2 AND (order_key < ?3 OR (order_key = ?3 AND id < ?4)) ORDER BY order_key DESC, id DESC LIMIT 1",
          )
          .get(block.page, block.parent, block.order_key, where) as { order_key: string } | null;
        const other = neighbour?.order_key ?? null;
        [lo, hi] = after ? [block.order_key, other] : [other, block.order_key];
      }
    }

    const ops: Op[] = [];
    const add = (list: OutlineItem[], under: string | null, keys: string[]) => {
      list.forEach((item, i) => {
        const id = crypto.randomUUID();
        const content = withoutOutlineLines(item.content);
        ops.push({ t: "block", id, page: pageName, parent: under, order_key: keys[i], content, collapsed: false, base: 0 });
        add(item.children, id, keysBetween(null, null, item.children.length));
      });
    };
    add(items, parentId, keysBetween(lo, hi, items.length));

    const result = applyBatch(db, { ...who, ops }, now);
    return { result, page: pageSummary(db, pageKey(pageName))!.name, ids: ops.map((op) => op.id) };
  })();
}

export interface Edited {
  result: BatchResult | null; // null: the text was already this, so nothing was saved
  id: string;
  page: string; // the page's name
}

/**
 * Replaces a block's text, keeping the old text in its history. With `expect` (the text the agent
 * read), a block that has changed since is left alone and the answer is a 409 with its text now.
 */
export function editBlock(db: Database, body: unknown, now = Date.now()): Edited {
  if (!isRecord(body)) throw new AgentError("expected a JSON object");
  const { id, content, expect } = body;
  const who = agentWriter(body.agent);
  if (typeof id !== "string") throw new AgentError("id must be a block id");
  if (typeof content !== "string") throw new AgentError("content must be a string");
  if (expect !== undefined && typeof expect !== "string") throw new AgentError("expect must be the block's text");
  const text = withoutOutlineLines(content);

  return db.transaction((): Edited => {
    const block = db
      .query(
        "SELECT b.parent, b.order_key, b.content, b.collapsed, b.rev, b.device, p.name AS page FROM blocks b JOIN pages p ON p.key = b.page WHERE b.id = ?",
      )
      .get(id) as {
      parent: string | null;
      order_key: string;
      content: string;
      collapsed: number;
      rev: number;
      device: string | null;
      page: string;
    } | null;
    if (!block) throw new AgentError("no such block", 404);
    if (typeof expect === "string" && comparable(expect) !== comparable(block.content)) {
      throw new AgentError("the block has changed since you read it", 409, { content: block.content });
    }
    // Saving the same text again would only mark the block as the agent's.
    if (block.content.trimEnd() === text) return { result: null, id, page: block.page };
    // The browser only keeps text another device overwrote; an agent's edit always keeps it.
    db.query("INSERT INTO block_history (block, content, device, saved_at) VALUES (?, ?, ?, ?)").run(
      id,
      block.content,
      block.device,
      now,
    );
    const op: Op = {
      t: "block",
      id,
      page: block.page,
      parent: block.parent,
      order_key: block.order_key,
      content: text,
      collapsed: block.collapsed === 1,
      base: block.rev,
    };
    return { result: applyBatch(db, { ...who, ops: [op] }, now), id, page: block.page };
  })();
}

// The page outline shows ids and folding as `id::` and `collapsed::` lines under each block. They
// aren't part of the block's text, so an agent that copies them back doesn't add them to it.
function withoutOutlineLines(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^\s*(id|collapsed):: /.test(line))
    .join("\n")
    .trimEnd();
}

// Whether the block still says what the agent read. Agents copy text out of the page outline, so
// indentation and the outline's own lines don't count.
function comparable(text: string): string {
  return withoutOutlineLines(text)
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
