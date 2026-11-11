import { ref, watch } from "vue";
import { pageKey } from "../../shared/names";
import type { FavouritesChange, PageSummary } from "../../shared/types";
import { getJSON } from "./api";
import { notify } from "./notices";
import { lastRename, pages } from "./store";

// Favourites: the pages kept at hand in the sidebar and at the top of search. The server holds
// the list, so it's the same on every device; live updates keep it current. A change shows
// straight away and is put back if it couldn't be saved.

export const favourites = ref<PageSummary[]>([]);

export function isFavourite(name: string): boolean {
  const key = pageKey(name);
  return favourites.value.some((page) => page.key === key);
}

export async function loadFavourites(): Promise<void> {
  favourites.value = await getJSON<PageSummary[]>("/api/favourites");
}

/** Takes in a change to the favourites, made here or elsewhere. */
export function applyFavouritesChange(change: FavouritesChange): void {
  favourites.value = change.favourites;
  for (const page of change.pages) pages.set(page.key, page);
  for (const key of change.removedPages) pages.delete(key);
}

let latest = 0;

async function save(list: PageSummary[]): Promise<void> {
  const before = favourites.value;
  const call = ++latest;
  favourites.value = list;
  try {
    const res = await fetch("/api/favourites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pages: list.map((page) => page.name) }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const change = (await res.json()) as FavouritesChange;
    if (call === latest) applyFavouritesChange(change);
  } catch {
    if (call === latest) favourites.value = before;
    notify("Couldn't save your favourites.");
  }
}

/** Adds the page at the end of the favourites, or takes it out. */
export function toggleFavourite(name: string): Promise<void> {
  const key = pageKey(name);
  const without = favourites.value.filter((page) => page.key !== key);
  if (without.length < favourites.value.length) return save(without);
  return save([...without, pages.get(key) ?? { key, name: name.trim(), journal_day: null }]);
}

/** Moves the favourite at `from` so that it sits at `to` in the list. */
export function moveFavourite(from: number, to: number): Promise<void> {
  const list = [...favourites.value];
  if (from === to || !list[from] || to < 0 || to >= list.length) return Promise.resolve();
  list.splice(to, 0, ...list.splice(from, 1));
  return save(list);
}

// A renamed page keeps its place under its new name.
watch(lastRename, (rename) => {
  if (!rename) return;
  const key = pageKey(rename.to);
  favourites.value = favourites.value.map((page) =>
    page.key === rename.from ? (pages.get(key) ?? { key, name: rename.to, journal_day: null }) : page,
  );
});
