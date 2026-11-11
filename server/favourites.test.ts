import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { applyBatch, renamePage } from "./apply";
import { openDb } from "./db";
import { BadFavourites, getFavourites, setFavourites } from "./favourites";
import { blockOp, writer } from "./testing";

let db: Database;

beforeEach(() => {
  db = openDb(":memory:");
});

afterEach(() => db.close());

const names = () => getFavourites(db).map((page) => page.name);
const pageKeys = () => (db.query("SELECT key FROM pages ORDER BY key").all() as { key: string }[]).map((row) => row.key);

test("the list sent becomes the favourites, in that order", () => {
  applyBatch(db, { ...writer, ops: [blockOp("a", "Alpha", null, "a0"), blockOp("b", "Beta", null, "a0")] });
  expect(setFavourites(db, { pages: ["beta", "Alpha"] }).favourites.map((page) => page.name)).toEqual(["Beta", "Alpha"]);
  setFavourites(db, { pages: ["Alpha", "Beta", "ALPHA"] }); // reordered; a page named twice counts once
  expect(names()).toEqual(["Alpha", "Beta"]);
  setFavourites(db, { pages: ["Beta"] });
  expect(names()).toEqual(["Beta"]);
  expect(pageKeys()).toEqual(["alpha", "beta"]); // Alpha has a block, so it's still a page
});

test("a page can be a favourite before anything is written on it, and goes when it stops being one", () => {
  const added = setFavourites(db, { pages: ["Someday"] });
  expect(added.pages).toEqual([{ key: "someday", name: "Someday", journal_day: null }]);
  expect(pageKeys()).toEqual(["someday"]);
  const removed = setFavourites(db, { pages: [] });
  expect(removed).toEqual({ favourites: [], pages: [], removedPages: ["someday"] });
  expect(pageKeys()).toEqual([]);
});

test("deleting a favourite's last block keeps the page and the favourite", () => {
  applyBatch(db, { ...writer, ops: [blockOp("a", "Alpha", null, "a0")] });
  setFavourites(db, { pages: ["Alpha"] });
  expect(applyBatch(db, { ...writer, ops: [{ t: "delete", id: "a" }] }).removedPages).toEqual([]);
  expect(names()).toEqual(["Alpha"]);
});

test("a renamed page stays a favourite, in its place", () => {
  applyBatch(db, { ...writer, ops: [blockOp("a", "Alpha", null, "a0"), blockOp("b", "Beta", null, "a0")] });
  setFavourites(db, { pages: ["Alpha", "Beta"] });
  renamePage(db, "Alpha", "Zeta");
  expect(names()).toEqual(["Zeta", "Beta"]);
});

test("anything but a list of usable page names is refused, and changes nothing", () => {
  setFavourites(db, { pages: ["Keep"] });
  for (const body of [null, {}, { pages: "Keep" }, { pages: [1] }, { pages: ["ok", " "] }, { pages: ["a]]b"] }]) {
    expect(() => setFavourites(db, body)).toThrow(BadFavourites);
  }
  expect(names()).toEqual(["Keep"]);
});
