import { nextTick, reactive } from "vue";
import type { Block } from "../../../shared/types";
import { outline } from "../store";
import { commit } from "./undo";

// Showing a particular block in a view: scroll it into the middle of the screen and flash it,
// expanding any collapsed blocks it sits inside first (that's saved, as if you'd clicked them).

/** The block being flashed, which Block.vue marks. */
export const revealed = reactive({ view: null as string | null, id: null as string | null });

const FLASH_MS = 2000;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Returns whether the block was found in the view. */
export async function revealBlock(view: string, id: string): Promise<boolean> {
  const block = outline.get(id);
  if (!block) return false;
  const collapsed: Block[] = [];
  for (let up = outline.get(block.parent ?? ""); up; up = outline.get(up.parent ?? "")) if (up.collapsed) collapsed.push(up);
  if (collapsed.length > 0) commit({ upserts: collapsed.map((b) => ({ ...b, collapsed: false })), deletes: [] }, undefined, { record: false });
  await nextTick();
  const row = [...document.querySelectorAll<HTMLElement>(".block-row[data-block]")].find(
    (r) => r.dataset.view === view && r.dataset.block === id,
  );
  if (!row) return false;
  row.scrollIntoView({ block: "center" });
  Object.assign(revealed, { view, id });
  clearTimeout(timer);
  timer = setTimeout(() => Object.assign(revealed, { view: null, id: null }), FLASH_MS);
  return true;
}
