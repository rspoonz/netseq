import type { Block } from "../../../shared/types";
import * as outbox from "../outbox";
import { editing, outline, saveOp, startEditing } from "../store";
import type { Caret, Change } from "./intents";

// The one way blocks change: apply locally, queue for the server, and remember the previous
// states so the change can be undone. Undo and redo are just more changes.

interface Entry {
  before: Map<string, Block | null>; // null = the block didn't exist
  after: Map<string, Block | null>;
  caretBefore?: Caret;
  caretAfter?: Caret;
  typingIn?: string; // set while consecutive keystrokes in one block are being grouped
  group?: string;
  at: number;
}

const LIMIT = 200;
const TYPING_PAUSE_MS = 1000;
const undoStack: Entry[] = [];
const redoStack: Entry[] = [];

export interface CommitOptions {
  typing?: boolean; // group with the previous keystrokes in the same block
  record?: boolean; // false: not undoable (housekeeping)
  view?: string; // the view the caret goes to, if it isn't the current one
  group?: string; // commits with the same group are undone together
}

export function commit(change: Change, caretBefore?: Caret, options: CommitOptions = {}): void {
  const before = new Map<string, Block | null>();
  for (const b of change.upserts) if (!before.has(b.id)) before.set(b.id, copy(outline.get(b.id)));
  for (const id of change.deletes) {
    for (const sub of outline.subtree(id)) if (!before.has(sub)) before.set(sub, copy(outline.get(sub)));
  }

  apply(change.upserts, change.deletes);

  if (options.record !== false) {
    const typingIn = options.typing ? change.upserts[0]?.id : undefined;
    record(before, caretBefore, change.caret ?? caretBefore, typingIn, options.group);
  }
  if (change.caret) startEditing(options.view ?? editing.view, change.caret.id, change.caret.offset);
}

export function undo(): void {
  const entry = undoStack.pop();
  if (!entry) return;
  restore(entry.before);
  redoStack.push(entry);
  placeCaret(entry.caretBefore);
}

export function redo(): void {
  const entry = redoStack.pop();
  if (!entry) return;
  restore(entry.after);
  undoStack.push(entry);
  placeCaret(entry.caretAfter);
}

function record(
  before: Map<string, Block | null>,
  caretBefore?: Caret,
  caretAfter?: Caret,
  typingIn?: string,
  group?: string,
): void {
  const now = Date.now();
  const top = undoStack.at(-1);
  if (group && top?.group === group) {
    for (const [id, state] of before) if (!top.before.has(id)) top.before.set(id, state);
    top.after = snapshot(top.before.keys());
    top.caretAfter = caretAfter;
    return;
  }
  const after = snapshot(before.keys());
  if (typingIn && top?.typingIn === typingIn && now - top.at < TYPING_PAUSE_MS) {
    top.after = after;
    top.caretAfter = caretAfter;
    top.at = now;
    return;
  }
  undoStack.push({ before, after, caretBefore, caretAfter, typingIn, group, at: now });
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0;
}

function restore(states: Map<string, Block | null>): void {
  const upserts: Block[] = [];
  const deletes: string[] = [];
  for (const [id, state] of states) {
    // Keep the rev and reference count we know now: they record what the server has, not what
    // the block looks like.
    const now = outline.get(id);
    if (state) upserts.push({ ...state, rev: now?.rev ?? state.rev, ref_count: now?.ref_count ?? state.ref_count });
    else deletes.push(id);
  }
  apply(upserts, deletes);
}

// Writes before deletes, as on the server, so a block moved out of a deleted one survives.
function apply(upserts: Block[], deletes: string[]): void {
  for (const b of upserts) {
    outline.upsert(b);
    outbox.queue(saveOp(b));
  }
  for (const id of deletes) {
    outline.remove(id);
    outbox.queue({ t: "delete", id });
  }
}

function placeCaret(caret?: Caret): void {
  if (caret && outline.get(caret.id)) startEditing(editing.view, caret.id, caret.offset);
}

function snapshot(ids: Iterable<string>): Map<string, Block | null> {
  return new Map([...ids].map((id) => [id, copy(outline.get(id))] as const));
}

function copy(block: Block | undefined): Block | null {
  return block ? { ...block } : null;
}
