// Types shared by the server and the browser.

export interface PageSummary {
  key: string;
  name: string;
  journal_day: number | null;
}

/** A named page with when it last changed, for the Pages tab. */
export interface RecentPage extends PageSummary {
  changed: number; // when one of its blocks was last saved, or the page was created if it has none (ms)
}

/** A block, as the server stores it and the browser holds it. */
export interface Block {
  id: string;
  page: string; // page key
  parent: string | null; // null = top level of the page
  order_key: string;
  content: string;
  collapsed: boolean;
  rev: number; // the server's change counter at the block's last change; 0 = not saved yet
  ref_count?: number; // how many blocks reference this one with ((id)); filled in by the server
}

/**
 * A change sent to the server. Each op is idempotent: a block op carries the block's full
 * state, so resending one is always safe and only the latest op per block matters.
 */
export type Op =
  | {
      t: "block";
      id: string;
      page: string; // page name; the server derives the key
      parent: string | null;
      order_key: string;
      content: string;
      collapsed: boolean;
      base: number; // the rev this edit started from (0 for a new block), to spot overwrites
    }
  | { t: "delete"; id: string }; // also deletes everything under the block

export interface Batch {
  writer: string; // one per browser tab
  device: string; // shown to people, e.g. "Firefox on Linux"
  ops: Op[];
}

export interface BatchResult {
  rev: number;
  rows: Block[]; // every block this batch wrote or repaired, as now stored
  deleted: string[];
  pages: PageSummary[]; // pages this batch created
  removedPages: string[]; // keys of pages left with no blocks and no refs
  overwrote: Overwrite[]; // text this batch replaced that another tab or device had written
  refCounts: Record<string, number>; // new ref_count of blocks whose references this batch changed
  renamed?: { from: string; to: string }; // a rename: the old page key, and the new name
}

/** The favourites after a change to them, with the pages that change created or removed. */
export interface FavouritesChange {
  favourites: PageSummary[]; // in the owner's order
  pages: PageSummary[]; // pages created: a page can be a favourite before anything is written on it
  removedPages: string[]; // keys of unused pages that stopped being favourites
}

export interface Overwrite {
  block: string;
  device: string | null; // the device whose text was replaced
}

export interface HistoryEntry {
  content: string;
  device: string | null;
  saved_at: number;
}

/** One step of a breadcrumb trail. */
export interface Crumb {
  id: string;
  content: string;
}

/** Blocks on one page shown elsewhere (linked references, query results, the agenda). */
export interface RefGroup {
  page: PageSummary;
  roots: string[]; // the blocks found, each shown with everything under it, in page order
  paths: Record<string, Crumb[]>; // each root's ancestors, outermost first
  blocks: Block[]; // the roots and everything under them
}

/** A block with everything under it, for zooming in. */
export interface BlockTree {
  page: PageSummary;
  path: Crumb[]; // ancestors, outermost first
  blocks: Block[]; // the block itself first, then everything under it
}

export interface PageData {
  page: PageSummary | null; // null = nothing written on this page yet
  blocks: Block[];
  rev: number; // the change counter when this copy was taken
}

/** A block that matches a search, with a snippet of its text. */
export interface SearchHit {
  id: string;
  page: PageSummary;
  text: string; // plain text around the first match
  ranges: [number, number][]; // where the search words are in `text` (start, end)
}

/** The blocks a {{query …}} matches, grouped like linked references. */
export interface QueryResult {
  groups: RefGroup[];
  truncated: boolean; // more blocks matched than are shown
}
