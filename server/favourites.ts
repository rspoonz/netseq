import type { Database } from "bun:sqlite";
import { pageKey } from "../shared/names";
import { pageNameProblem } from "../shared/refs";
import type { FavouritesChange, PageSummary } from "../shared/types";
import { DELETE_UNUSED_PAGE } from "./apply";

// Favourites: the pages the owner keeps at hand, in their order. They live in the database, so
// every device and agent sees the same list. A page can be a favourite before anything is written
// on it, and stays a page for as long as it is one. Renaming a page keeps it a favourite (the
// table follows the page's key).

/** A list of favourites that isn't one. Answered with a 400. */
export class BadFavourites extends Error {}

const MAX_FAVOURITES = 200;

export function getFavourites(db: Database): PageSummary[] {
  return db
    .query("SELECT p.key, p.name, p.journal_day FROM favourites f JOIN pages p ON p.key = f.page ORDER BY f.position, p.key")
    .all() as PageSummary[];
}

/**
 * Makes `body.pages` (page names, in order) the favourites: the whole list, so adding, removing
 * and reordering are all the same request, and sending it twice is harmless.
 */
export function setFavourites(db: Database, body: unknown, now = Date.now()): FavouritesChange {
  const names = typeof body === "object" && body !== null ? (body as { pages?: unknown }).pages : undefined;
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
    throw new BadFavourites("pages must be a list of page names");
  }
  if (names.length > MAX_FAVOURITES) throw new BadFavourites(`at most ${MAX_FAVOURITES} favourites`);
  const wanted = new Map<string, string>(); // key → name, in order; a page named twice counts once
  for (const name of names as string[]) {
    const problem = pageNameProblem(name);
    if (problem) throw new BadFavourites(problem);
    if (!wanted.has(pageKey(name))) wanted.set(pageKey(name), name.trim());
  }

  return db.transaction((): FavouritesChange => {
    const before = (db.query("SELECT page FROM favourites").all() as { page: string }[]).map((row) => row.page);
    db.query("DELETE FROM favourites").run();
    const pages: PageSummary[] = [];
    let position = 0;
    for (const [key, name] of wanted) {
      const created = db
        .query("INSERT INTO pages (key, name, created_at) VALUES (?, ?, ?) ON CONFLICT (key) DO NOTHING RETURNING key, name, journal_day")
        .get(key, name, now) as PageSummary | null;
      if (created) pages.push(created);
      db.query("INSERT INTO favourites (page, position) VALUES (?, ?)").run(key, position++);
    }
    const removedPages = before.filter(
      (key) => !wanted.has(key) && db.query(`${DELETE_UNUSED_PAGE} RETURNING key`).get(key) !== null,
    );
    return { favourites: getFavourites(db), pages, removedPages };
  })();
}
