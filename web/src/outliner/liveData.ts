import { type InjectionKey, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { RefGroup } from "../../../shared/types";
import { applyTree, changes, editing, refreshes } from "../store";

// Views that show blocks the server found (linked references, query results, the agenda) can't
// tell from a change whether it affects them, so they reload once changes settle, and after
// missed live updates. While a block in the view is being edited they wait, so the block you're
// typing in doesn't move or vanish under you.

const SETTLE_MS = 1000;

/** Set inside query results: blocks there don't run their own queries (two queries could find each other forever). */
export const INSIDE_QUERY: InjectionKey<boolean> = Symbol("inside-query");

/** How many blocks a list of groups shows (blocks under them not counted). */
export function countRoots(groups: RefGroup[] | null | undefined): number {
  return groups?.reduce((total, group) => total + group.roots.length, 0) ?? 0;
}

export interface LiveDataOptions<T> {
  view: () => string; // the view the blocks are shown in
  fetch: () => Promise<T>;
  groups: (data: T) => RefGroup[]; // the blocks in the data, to take into the store
}

export function useLiveData<T>(options: LiveDataOptions<T>) {
  const data = shallowRef<T | null>(null);
  // The last load failed. Views say so when that leaves them nothing to show; otherwise they
  // keep what they have, and the top bar's "Offline" says it may be out of date.
  const failed = ref(false);
  let waiting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;

  async function load(): Promise<void> {
    clearTimeout(timer);
    const editingHere = () => editing.view === options.view();
    if (editingHere()) {
      waiting = true;
      return;
    }
    const call = ++latest;
    try {
      const fresh = await options.fetch();
      if (call !== latest) return; // a newer load has started
      if (editingHere()) {
        waiting = true; // editing started while this was loading: load again once it ends
        return;
      }
      for (const group of options.groups(fresh)) applyTree(group.blocks);
      data.value = fresh;
      failed.value = false;
    } catch {
      if (call === latest) failed.value = true; // the next change or refresh tries again
    }
  }

  /** Loads once things have been quiet for a moment. */
  function settle(): void {
    clearTimeout(timer);
    timer = setTimeout(load, SETTLE_MS);
  }

  watch(changes, settle);
  watch(refreshes, load);
  watch(
    () => editing.view,
    (view) => {
      if (waiting && view !== options.view()) {
        waiting = false;
        void load();
      }
    },
  );
  onBeforeUnmount(() => clearTimeout(timer));
  return { data, failed, load, settle };
}
