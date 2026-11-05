import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeOutline } from "../shared/markdownOutline";
import { compareSiblings } from "../shared/order";
import type { Block, PageSummary } from "../shared/types";
import { getPage } from "./read";

// The notes as markdown files, in Logseq's layout: journals/2026_11_04.md and pages/<name>.md,
// a tab per level. Written by `bun run export` (scripts/export.ts). Logseq compatibility is best
// effort: it hasn't been tested against Logseq itself.

export interface ExportResult {
  pages: number;
  blocks: number;
  skipped: { page: string; reason: string }[]; // pages whose file name was taken or too long
}

/**
 * Writes every page that has blocks to `dir`. Everything goes to `<dir>.tmp` first and replaces
 * `dir` only once it's all written, so a failed export leaves the previous one in place, and
 * pages deleted since then disappear.
 */
export function exportMarkdown(db: Database, dir: string): ExportResult {
  const fresh = `${dir}.tmp`;
  const previous = `${dir}.old`;
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(join(fresh, "journals"), { recursive: true });
  mkdirSync(join(fresh, "pages"), { recursive: true });

  const result: ExportResult = { pages: 0, blocks: 0, skipped: [] };
  const used = new Set<string>(); // file names taken, lower-cased: some file systems ignore case
  const keys = db.query("SELECT key FROM pages WHERE EXISTS (SELECT 1 FROM blocks WHERE page = pages.key) ORDER BY key").all() as {
    key: string;
  }[];
  for (const { key } of keys) {
    const { page, blocks } = getPage(db, key);
    if (!page) continue;
    const file = pageFile(page);
    if (used.has(file.toLowerCase())) {
      result.skipped.push({ page: page.name, reason: `another page is also written as ${file}` });
      continue;
    }
    try {
      writeFileSync(join(fresh, file), `${pageMarkdown(blocks)}\n`);
    } catch (e) {
      // A name too long for a file loses just this page. Anything else (a full disk, say) stops
      // the export here, so the previous one stays in place.
      if ((e as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw e;
      result.skipped.push({ page: page.name, reason: "its name is too long for a file name" });
      continue;
    }
    used.add(file.toLowerCase());
    result.pages++;
    result.blocks += blocks.length;
  }

  rmSync(previous, { recursive: true, force: true });
  if (existsSync(dir)) renameSync(dir, previous);
  renameSync(fresh, dir);
  rmSync(previous, { recursive: true, force: true });
  return result;
}

/** Where a page goes: journals/2026_11_04.md, or pages/<name>.md with what file names can't hold encoded. */
export function pageFile(page: PageSummary): string {
  if (page.journal_day !== null) return `journals/${page.key.replaceAll("-", "_")}.md`;
  // "/" becomes "___" (Logseq's namespaces); characters file systems refuse, and "%" itself, become %XX.
  const name = page.name
    .replace(/[%<>:"\\|?*\u0000-\u001f\u007f]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
    .replaceAll("/", "___");
  return `pages/${name.startsWith(".") ? `%2E${name.slice(1)}` : name}.md`; // no hidden files
}

/**
 * A page's blocks as Logseq writes them. Folded blocks get `collapsed:: true`, and blocks that
 * other blocks reference get `id:: <uuid>`, so their ((references)) still resolve.
 */
export function pageMarkdown(blocks: Block[]): string {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const children = new Map<string | null, string[]>();
  for (const b of [...blocks].sort(compareSiblings)) {
    const list = children.get(b.parent);
    if (list) list.push(b.id);
    else children.set(b.parent, [b.id]);
  }
  const childIds = (id: string) => children.get(id) ?? [];
  return writeOutline(
    children.get(null) ?? [],
    { children: childIds, content: (id) => byId.get(id)?.content },
    {
      indent: "\t",
      extraLines: (id) => {
        const b = byId.get(id)!;
        return [
          ...(b.collapsed && childIds(id).length > 0 ? ["collapsed:: true"] : []),
          ...((b.ref_count ?? 0) > 0 ? [`id:: ${b.id}`] : []),
        ];
      },
    },
  );
}
