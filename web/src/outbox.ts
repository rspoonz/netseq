import { reactive } from "vue";
import type { Batch, BatchResult, Op } from "../../shared/types";
import { notify } from "./notices";

// Changes waiting to reach the server. Each op carries a block's full state, so only the latest
// op per block matters and resending is always safe. The queue is kept in sessionStorage, so
// it survives a reload or the browser discarding a background tab.

const STORAGE_KEY = "netseq:outbox";
const WRITER_KEY = "netseq:writer";

// One writer id per tab. sessionStorage keeps it across reloads of the tab, so the server
// doesn't mistake this tab's own earlier edits for another device's.
export const writer = tabWriterId();
export const device = deviceLabel();

export type SyncState = "saved" | "saving" | "offline" | "error";
export const sync = reactive({ state: "saved" as SyncState, pending: 0 });

let pending = new Map<string, Op>();
let inFlight: Map<string, Op> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let firstQueuedAt: number | null = null;
let retryDelay = 0;
let offline = false;
let rejected = false;
let flushing: Promise<void> | null = null;
let handleResult: (result: BatchResult) => void = () => {};

export function onResult(handler: (result: BatchResult) => void): void {
  handleResult = handler;
}

export function isPending(id: string): boolean {
  return pending.has(id) || (inFlight?.has(id) ?? false);
}

/** Every unsent op, the newest per block. */
export function pendingOps(): Op[] {
  return [...new Map([...(inFlight ?? []), ...pending]).values()];
}

export function queue(op: Op): void {
  pending.set(op.id, op);
  firstQueuedAt ??= Date.now();
  save();
  refresh();
  schedule();
}

/** Sends what's queued now. Only one request is in flight at a time. */
export function flush(options: { keepalive?: boolean } = {}): Promise<void> {
  if (!flushing && pending.size > 0) {
    flushing = send(options).finally(() => {
      flushing = null;
    });
  }
  return flushing ?? Promise.resolve();
}

/** Sends everything queued and waits for it. False if the server can't be reached. */
export async function drain(): Promise<boolean> {
  for (let attempt = 0; attempt < 10 && pendingOps().length > 0; attempt++) {
    await flush();
    if (offline) return false;
  }
  return pendingOps().length === 0;
}

async function send(options: { keepalive?: boolean }): Promise<void> {
  clearTimeout(timer);
  firstQueuedAt = null;
  const sending = pending;
  inFlight = sending;
  pending = new Map();
  refresh();

  const batch: Batch = { writer, device, ops: [...sending.values()] };
  let retry = false;
  try {
    const res = await fetch("/api/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      keepalive: options.keepalive,
    });
    if (res.ok) {
      const result = (await res.json()) as BatchResult;
      inFlight = null; // before handling the result, so isPending() only covers newer edits
      offline = false;
      retryDelay = 0;
      rejected = false; // saving works again
      handleResult(result);
    } else if (res.status === 400) {
      // The server says these ops are malformed: a bug rather than a network problem, so
      // resending can't help. Say so while the text is still on screen.
      inFlight = null;
      rejected = true;
      refused(batch.ops, await reasonOf(res));
    } else {
      retry = true;
    }
  } catch {
    retry = true;
  }

  if (retry) {
    // Put the batch back, except where newer edits to the same blocks were queued meanwhile.
    for (const [id, op] of sending) if (!pending.has(id)) pending.set(id, op);
    inFlight = null;
    offline = true;
    retryDelay = Math.min(30_000, Math.max(1_000, retryDelay * 2));
  }
  save();
  refresh();
  if (pending.size > 0) schedule(retry ? retryDelay : undefined);
}

/** Starts sending: resends anything left from before a reload, and flushes when leaving the page. */
export function start(): void {
  if (pending.size > 0) schedule(0);
  window.addEventListener("online", () => {
    retryDelay = 0;
    if (pending.size > 0) schedule(0);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush({ keepalive: true });
  });
  window.addEventListener("pagehide", () => void flush({ keepalive: true }));
  window.addEventListener("beforeunload", (event) => {
    if (pendingOps().length > 0) event.preventDefault(); // asks before closing with unsaved changes
  });
}

function schedule(delay?: number): void {
  clearTimeout(timer);
  // By default: 300 ms after the last change, but at least every 1.5 s while typing goes on.
  const wait = delay ?? Math.max(0, Math.min(300, 1500 - (Date.now() - (firstQueuedAt ?? Date.now()))));
  timer = setTimeout(() => void flush(), wait);
}

function refresh(): void {
  sync.pending = new Set([...(inFlight?.keys() ?? []), ...pending.keys()]).size;
  sync.state = rejected ? "error" : sync.pending === 0 ? "saved" : offline ? "offline" : "saving";
}

function save(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pendingOps()));
  } catch {
    // Storage full or unavailable: the queue still lives in memory.
  }
}

function refused(ops: Op[], reason: string): void {
  console.error("The server refused some changes:", reason, ops);
  notify(`The server refused some changes (${reason}). They're still on screen: copy anything you need before reloading.`);
}

async function reasonOf(res: Response): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

function restore(): void {
  try {
    for (const op of JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as Op[]) {
      pending.set(op.id, op.t === "block" ? { ...op, base: op.base ?? 0 } : op); // queues saved before `base` existed
    }
  } catch {
    // Unreadable leftovers: start empty.
  }
  refresh();
}

function tabWriterId(): string {
  try {
    const saved = sessionStorage.getItem(WRITER_KEY);
    if (saved) return saved;
    const id = crypto.randomUUID();
    sessionStorage.setItem(WRITER_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

restore();
