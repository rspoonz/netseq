import type { Database } from "bun:sqlite";
import { parseOutline, type OutlineItem } from "../shared/markdownOutline";
import { pageKey } from "../shared/names";
import { keyBetween, keysBetween } from "../shared/order";
import { pageNameProblem } from "../shared/refs";
import type { Batch, BatchResult, Op } from "../shared/types";
import { applyBatch, createsCycle } from "./apply";
import { pageMarkdown } from "./export";
import { getPage, pageSummary } from "./read";

// The API for AI agents, described to them by agents.md (served at /agents). Agents read pages as
// markdown outlines and write through three small endpoints (add, edit, move), so they never deal
// with order keys, revs or writer ids. Changes go through applyBatch, like the browser's, so
// they're indexed and show up live in open tabs. Agents can't delete anything, and an edit always
// keeps the text it replaced in the block's history ("Earlier versions").

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
  if (name != null && typeof name !== "string") throw new AgentError("agent must be a name");
  const label = name?.trim().slice(0, 50);
  return { writer: AGENT_WRITER, device: label ? `${label} (agent)` : "Agent" };
}

/** A page as a markdown outline with every block's id, or null if there's no such page. */
export function pageOutline(db: Database, name: string): string | null {
  const { page, blocks } = getPage(db, name);
  return page ? pageMarkdown(blocks, { allIds: true }) : null;
}

type BlockOp = Extract<Op, { t: "block" }>;

interface BlockRow {
  id: string;
  page: string; // the page's name
  page_key: string;
  parent: string | null;
  order_key: string;
  content: string;
  collapsed: number;
  rev: number;
  device: string | null;
}

const BLOCK_ROW =
  "SELECT b.id, p.name AS page, b.page AS page_key, b.parent, b.order_key, b.content, b.collapsed, b.rev, b.device FROM blocks b JOIN pages p ON p.key = b.page";

function findBlock(db: Database, id: string): BlockRow {
  const block = db.query(`${BLOCK_ROW} WHERE b.id = ?`).get(id) as BlockRow | null;
  if (!block) throw new AgentError("no such block", 404);
  return block;
}

/** The blocks directly under `parent` (null: the page's top level), in order. */
function childrenOf(db: Database, page_key: string, parent: string | null): BlockRow[] {
  return db
    .query(`${BLOCK_ROW} WHERE b.page = ? AND b.parent IS ? ORDER BY b.order_key, b.id`)
    .all(page_key, parent) as BlockRow[];
}

/** The op that writes `block` back with `change` made to it. */
function rewrite(block: BlockRow, change: Partial<BlockOp>): BlockOp {
  const { id, page, parent, order_key, content, rev } = block;
  return { t: "block", id, page, parent, order_key, content, collapsed: block.collapsed === 1, base: rev, ...change };
}

type Position = "page" | "parent" | "after" | "before";
const POSITIONS: readonly Position[] = ["page", "parent", "after", "before"];

/** Where blocks go: a page, a parent there, and the sibling keys to go between (null: the start or end). */
interface Place {
  page: string; // the page's name
  parent: string | null;
  lo: string | null;
  hi: string | null;
}

/**
 * The place a position names: the end of a page's top level (`page`), the end of a block's
 * children (`parent`), or right after or before a block, as its sibling (`after`, `before`).
 */
function place(db: Database, position: Position, where: string): Place {
  if (position === "page") {
    const problem = pageNameProblem(where);
    if (problem) throw new AgentError(problem);
    const page = pageSummary(db, pageKey(where))?.name ?? where.trim();
    return { page, parent: null, lo: childrenOf(db, pageKey(page), null).at(-1)?.order_key ?? null, hi: null };
  }
  const block = findBlock(db, where);
  if (position === "parent") {
    const last = childrenOf(db, block.page_key, block.id).at(-1);
    return { page: block.page, parent: block.id, lo: last?.order_key ?? null, hi: null };
  }
  const siblings = childrenOf(db, block.page_key, block.parent);
  const i = siblings.findIndex((b) => b.id === block.id);
  const [lo, hi] = position === "after" ? [siblings[i], siblings[i + 1]] : [siblings[i - 1], siblings[i]];
  return { page: block.page, parent: block.parent, lo: lo?.order_key ?? null, hi: hi?.order_key ?? null };
}

/** The one key from `allowed` that the request gives, and its value. */
function onePosition<P extends string>(body: Record<string, unknown>, allowed: readonly P[]): [P, unknown] {
  const given = allowed.filter((key) => body[key] != null); // null counts as left out, like undefined
  if (given.length !== 1) throw new AgentError(`give one of ${allowed.slice(0, -1).join(", ")} or ${allowed.at(-1)}`);
  return [given[0], body[given[0]]];
}

/** A position's value: a page name for `page`, otherwise a block id. */
function placeArg(position: Position, value: unknown): string {
  if (typeof value !== "string") throw new AgentError(`${position} must be a ${position === "page" ? "page name" : "block id"}`);
  return value;
}

export interface Added {
  result: BatchResult;
  page: string; // the page's name
  ids: string[]; // the new blocks, in outline order
}

/**
 * Adds blocks at a position (see `place`). `text` is either one block's text, or a markdown
 * outline ("- a\n  - b") when it starts with a bullet.
 */
export function addBlocks(db: Database, body: unknown, now = Date.now()): Added {
  if (!isRecord(body)) throw new AgentError("expected a JSON object");
  const [position, value] = onePosition(body, POSITIONS);
  const where = placeArg(position, value);
  const { text } = body;
  const who = agentWriter(body.agent);
  if (typeof text !== "string" || !text.trim()) throw new AgentError("text must be a non-empty string");
  const items = /^\s*[-*+] /.test(text) ? parseOutline(text) : [{ content: text.trim(), children: [] }];
  if (hasEmptyBlock(items)) throw new AgentError("every block needs some text");

  return db.transaction((): Added => {
    const to = place(db, position, where);
    const ops: Op[] = [];
    const add = (list: OutlineItem[], under: string | null, keys: string[]) => {
      list.forEach((item, i) => {
        const id = crypto.randomUUID();
        const content = withoutOutlineLines(item.content);
        ops.push({ t: "block", id, page: to.page, parent: under, order_key: keys[i], content, collapsed: false, base: 0 });
        add(item.children, id, keysBetween(null, null, item.children.length));
      });
    };
    add(items, to.parent, keysBetween(to.lo, to.hi, items.length));

    const result = applyBatch(db, { ...who, ops }, now);
    return { result, page: pageSummary(db, pageKey(to.page))!.name, ids: ops.map((op) => op.id) };
  })();
}

export interface Moved {
  result: BatchResult;
  id: string;
  page: string; // the name of the page the block is on now
}

const MOVES = [...POSITIONS, "indent", "outdent"] as const;

/**
 * Moves a block, and everything under it, to a position (see `place`), or indents or outdents it
 * like Tab and Shift+Tab. Indenting makes it the last child of the block above it at its level.
 * Outdenting puts it right after its parent, and the blocks below it there become its children,
 * as Logseq does by default. The block keeps its id, so refs to it still work.
 */
export function moveBlock(db: Database, body: unknown, now = Date.now()): Moved {
  if (!isRecord(body)) throw new AgentError("expected a JSON object");
  const { id } = body;
  if (typeof id !== "string") throw new AgentError("id must be a block id");
  const [position, value] = onePosition(body, MOVES);
  if ((position === "indent" || position === "outdent") && value !== true) throw new AgentError(`${position} must be true`);
  const who = agentWriter(body.agent);

  return db.transaction((): Moved => {
    const block = findBlock(db, id);
    const ops: BlockOp[] = [];
    const moveTo = (to: Place): BlockOp => {
      if (to.parent !== null && createsCycle(db, id, to.parent)) {
        throw new AgentError("a block can't move under itself or a block under it");
      }
      const op = rewrite(block, { page: to.page, parent: to.parent, order_key: keyBetween(to.lo, to.hi) });
      ops.push(op);
      return op;
    };

    if (position === "indent") {
      const siblings = childrenOf(db, block.page_key, block.parent);
      const previous = siblings[siblings.findIndex((b) => b.id === id) - 1];
      if (!previous) throw new AgentError("there's no block above it at its level to indent it under");
      moveTo(place(db, "parent", previous.id));
      if (previous.collapsed) ops.push(rewrite(previous, { collapsed: false })); // so the block stays in view
    } else if (position === "outdent") {
      if (block.parent === null) throw new AgentError("it's already at the top level");
      const siblings = childrenOf(db, block.page_key, block.parent);
      const following = siblings.slice(siblings.findIndex((b) => b.id === id) + 1);
      const moved = moveTo(place(db, "after", block.parent));
      if (following.length > 0) {
        const keys = keysBetween(childrenOf(db, block.page_key, id).at(-1)?.order_key ?? null, null, following.length);
        following.forEach((sibling, i) => ops.push(rewrite(sibling, { parent: id, order_key: keys[i] })));
        moved.collapsed = false; // so they stay in view
      }
    } else {
      const where = placeArg(position, value);
      if (where === id && (position === "after" || position === "before")) {
        throw new AgentError("a block can't move next to itself");
      }
      moveTo(place(db, position, where));
    }

    const result = applyBatch(db, { ...who, ops }, now);
    return { result, id, page: findBlock(db, id).page };
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
  if (expect != null && typeof expect !== "string") throw new AgentError("expect must be the block's text");
  const text = withoutOutlineLines(content);

  return db.transaction((): Edited => {
    const block = findBlock(db, id);
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
    return { result: applyBatch(db, { ...who, ops: [rewrite(block, { content: text })] }, now), id, page: block.page };
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

// Whether any block in an outline would have no text once the outline's own lines are taken out.
function hasEmptyBlock(items: OutlineItem[]): boolean {
  return items.some((item) => !withoutOutlineLines(item.content).trim() || hasEmptyBlock(item.children));
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
