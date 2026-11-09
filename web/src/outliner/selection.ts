import { reactive } from "vue";
import { outline, startEditing } from "../store";
import { notify } from "../notices";
import { randomUUID } from "../uuid";
import { toMarkdown } from "./clipboard";
import { indent, outdent } from "./intents";
import { commit } from "./undo";

// Selected blocks: Esc in a block selects it, Shift+↑/↓ extends the selection. The selection is
// a range in the order blocks appear on screen, so it works the same in every view.

/** Writes text to the system clipboard. False if it couldn't: no clipboard (plain HTTP), or the browser said no. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const selection = reactive({ view: null as string | null, anchor: null as string | null, ids: [] as string[] });
let focus: string | null = null; // the end of the range that moves

export function selectBlock(view: string, id: string): void {
  selection.view = view;
  selection.anchor = focus = id;
  selection.ids = [id];
}

export function clearSelection(): void {
  selection.view = selection.anchor = focus = null;
  selection.ids = [];
}

export function isSelected(view: string, id: string): boolean {
  return selection.view === view && selection.ids.includes(id);
}

/** The blocks shown in a view, in the order they appear on screen. */
export function blocksOnScreen(view: string): string[] {
  return [...document.querySelectorAll<HTMLElement>(".block-row[data-block]")]
    .filter((row) => row.dataset.view === view)
    .map((row) => row.dataset.block!);
}

function step(direction: 1 | -1, extend: boolean): void {
  const order = blocksOnScreen(selection.view!);
  const next = order[order.indexOf(focus!) + direction];
  if (!next) return;
  focus = next;
  if (!extend) selection.anchor = next;
  const [a, b] = [order.indexOf(selection.anchor!), order.indexOf(next)];
  selection.ids = order.slice(Math.min(a, b), Math.max(a, b) + 1);
}

/** The scope a block is shown in (see intents.ts), as its row says. */
function scopeOnScreen(view: string, id: string): string | null {
  const row = [...document.querySelectorAll<HTMLElement>(".block-row[data-block]")].find(
    (r) => r.dataset.view === view && r.dataset.block === id,
  );
  return row?.dataset.scope ?? null;
}

/** Selected blocks that aren't inside another selected block, top to bottom. */
function topLevel(): string[] {
  const chosen = new Set(selection.ids);
  return selection.ids.filter((id) => {
    for (let parent = outline.get(id)?.parent; parent; parent = outline.get(parent)?.parent) {
      if (chosen.has(parent)) return false;
    }
    return true;
  });
}

/** Keys while blocks are selected, unless they're typed into a text field. */
export function handleSelectionKey(event: KeyboardEvent): void {
  if (selection.ids.length === 0 || !selection.view) return;
  // Includes the Esc that just selected a block: it bubbles up here from the (now blurred) editor.
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  const view = selection.view;
  const mod = event.ctrlKey || event.metaKey;
  switch (event.key) {
    case "Escape":
      clearSelection();
      break;
    case "Enter": {
      const id = focus!;
      clearSelection();
      startEditing(view, id, outline.get(id)?.content.length ?? 0);
      break;
    }
    case "ArrowUp":
    case "ArrowDown":
      step(event.key === "ArrowUp" ? -1 : 1, event.shiftKey);
      break;
    case "Backspace":
    case "Delete":
      commit({ upserts: [], deletes: topLevel() });
      clearSelection();
      break;
    case "Tab": {
      // One block at a time, in order, undone as one step.
      const group = randomUUID();
      for (const id of topLevel()) {
        const scope = scopeOnScreen(view, id);
        const change = event.shiftKey ? outdent(outline, id, 0, scope) : indent(outline, id, 0, scope);
        if (change) commit({ ...change, caret: undefined }, undefined, { group });
      }
      break;
    }
    case "c":
    case "x": {
      if (!mod) return;
      // Cut deletes only once the copy has worked, so blocks are never lost to a failed copy.
      const ids = topLevel();
      const cut = event.key === "x";
      void copyText(toMarkdown(outline, ids)).then((copied) => {
        if (!copied) {
          notify(cut ? "Couldn't copy to the clipboard, so nothing was cut." : "Couldn't copy to the clipboard.");
        } else if (cut) {
          commit({ upserts: [], deletes: ids });
          clearSelection();
        }
      });
      break;
    }
    default:
      return;
  }
  event.preventDefault();
}
