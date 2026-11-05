import MarkdownIt, { type StateInline } from "markdown-it";
import { parseBlock, PRIORITY } from "./blocktext";
import { dayName, journalTitle, pageKey } from "./names";
import { matchBlockRef, matchMacro, matchPageRef, matchTag } from "./refs";

// Block text → HTML for the browser. Raw HTML in notes is escaped (html: false), and markdown-it
// refuses javascript: and similar links. Page references become links carrying data-page, which
// the app intercepts to navigate without reloading. Everything that goes into the HTML from the
// block's text passes through markdown-it or escapeHtml.

type RefMeta = { name: string; kind: "link" | "tag" };

/** A referenced block's text: undefined while it's being fetched, null if it doesn't exist. */
export type BlockLookup = (id: string) => string | null | undefined;

type RenderEnv = {
  blockText?: BlockLookup;
  nested?: boolean; // rendering a referenced block's text: its own references aren't expanded
  here?: string; // key of the page being viewed: links to it are marked aria-current="page"
};

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const escape = md.utils.escapeHtml;

// markdown-it's text rule swallows runs of characters that can't start any markup. "(" isn't
// one of the characters it stops at, so ((block references)) would never be seen. This copy of
// the rule (markdown-it 15) stops there too.
const TEXT_STOPS = new Set([..."\n!#$%&*+-:<=>@[\\]^_`{}~("].map((char) => char.charCodeAt(0)));
md.inline.ruler.at("text", (state: StateInline, silent: boolean) => {
  let pos = state.pos;
  while (pos < state.posMax && !TEXT_STOPS.has(state.src.charCodeAt(pos))) pos++;
  if (pos === state.pos) return false;
  if (!silent) state.pending += state.src.slice(state.pos, pos);
  state.pos = pos;
  return true;
});

// {{query …}} and other macros: shown as written. Block.vue shows a query's results below the block.
md.inline.ruler.before("link", "macro", (state: StateInline, silent: boolean) => {
  const match = matchMacro(state.src, state.pos);
  if (!match) return false;
  if (!silent) state.push("macro", "", 0).content = state.src.slice(state.pos, match.end);
  state.pos = match.end;
  return true;
});
md.renderer.rules.macro = (tokens, index) => `<code class="macro">${escape(tokens[index].content)}</code>`;

// ((block id)): the referenced block's first line, which Block.vue makes clickable.
md.inline.ruler.before("link", "block_ref", (state: StateInline, silent: boolean) => {
  const match = matchBlockRef(state.src, state.pos);
  if (!match) return false;
  if (!silent) state.push("block_ref", "", 0).content = match.id;
  state.pos = match.end;
  return true;
});
// A real link to the block (keyboard, new tab), which Block.vue opens inside the app. Links in the
// referenced text are shown as text (see page_ref), so the reference is one link. Inside another
// reference it's just "…".
md.renderer.rules.block_ref = (tokens, index, _options, env) => {
  if (isNested(env)) return '<span class="block-ref">…</span>';
  const { blockText } = (env ?? {}) as RenderEnv;
  const id = escape(tokens[index].content);
  const link = (className: string, html: string) => `<a class="${className}" href="/b/${id}" data-block-ref="${id}">${html}</a>`;
  const text = blockText?.(tokens[index].content);
  if (text === undefined) return link("block-ref", "…");
  if (text === null) return link("block-ref missing", "missing block");
  const line = (parseBlock(text).body.split("\n").find((l) => l.trim()) ?? "").replace(/^#{1,6}\s+/, "");
  return link("block-ref", md.renderInline(line, { nested: true } satisfies RenderEnv));
};

md.inline.ruler.before("link", "page_ref", (state: StateInline, silent: boolean) => {
  const match = matchPageRef(state.src, state.pos) ?? matchTag(state.src, state.pos);
  if (!match) return false;
  if (!silent) state.push("page_ref", "", 0).meta = { name: match.name, kind: match.kind } satisfies RefMeta;
  state.pos = match.end;
  return true;
});
md.renderer.rules.page_ref = (tokens, index, _options, env) => {
  const { name, kind } = tokens[index].meta as RefMeta;
  const [label, className] = kind === "tag" ? [`#${name}`, "tag"] : [journalTitle(name), "page-ref"];
  // Inside a ((reference)) the whole reference is one link to its block, so links in it are just text.
  if (isNested(env)) return `<span class="${className}">${escape(label)}</span>`;
  return pageLink(name, label, className, (env as RenderEnv | undefined)?.here);
};

function isNested(env: unknown): boolean {
  return (env as RenderEnv | undefined)?.nested === true;
}

function pageLink(name: string, label: string, className: string, here?: string): string {
  const href = `/page/${encodeURIComponent(name)}`;
  const current = here !== undefined && pageKey(name) === here ? ' aria-current="page"' : "";
  return `<a class="${className}" href="${href}" data-page="${escape(name)}"${current}>${escape(label)}</a>`;
}

// [#A] priorities.
const PRIORITY_HERE = new RegExp(`^${PRIORITY.source}`);
md.inline.ruler.before("link", "priority", (state: StateInline, silent: boolean) => {
  const match = PRIORITY_HERE.exec(state.src.slice(state.pos, state.pos + 4));
  if (!match) return false;
  if (!silent) state.push("priority", "", 0).content = match[1];
  state.pos += match[0].length;
  return true;
});
md.renderer.rules.priority = (tokens, index) => {
  const priority = tokens[index].content;
  return `<span class="priority priority-${priority.toLowerCase()}" title="Priority ${priority}">${priority}</span>`;
};

// Ordinary links leave the app: they open in a new tab, and class "external" shows a ↗ after them.
const renderLinkOpen = md.renderer.rules.link_open ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  if (isNested(env)) return '<span class="ref-link">'; // see page_ref
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  tokens[index].attrSet("class", "external");
  return renderLinkOpen(tokens, index, options, env, self);
};
const renderLinkClose = md.renderer.rules.link_close ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_close = (tokens, index, options, env, self) =>
  isNested(env) ? "</span>" : renderLinkClose(tokens, index, options, env, self);

export function renderMarkdown(content: string, env: RenderEnv = {}): string {
  return md.render(content, env).trimEnd(); // markdown-it ends its HTML with a newline
}

/**
 * A whole block: its markdown, plus a checkbox for tasks, and its dates and properties underneath.
 * `blockText` finds the text of blocks it references. `here` is the key of the page being viewed.
 */
export function renderBlock(content: string, blockText?: BlockLookup, here?: string): string {
  const env: RenderEnv = { blockText, here };
  const info = parseBlock(content);
  let html = info.body.trim() ? renderMarkdown(info.body, env) : "";
  if (info.marker) {
    const done = info.marker === "DONE";
    const checkbox =
      info.marker === "CANCELED" ? "" : `<input type="checkbox" class="task-check" aria-label="Done"${done ? " checked" : ""}>`;
    html =
      `<div class="task task-${info.marker.toLowerCase()}">${checkbox}` +
      `<span class="marker">${info.marker}</span><div class="task-text">${html}</div></div>`;
  }
  const dates: string[] = [];
  for (const [label, day] of [["Scheduled", info.scheduled], ["Deadline", info.deadline]] as const) {
    if (day) dates.push(`<span class="task-date">${label}: ${pageLink(dayName(day), journalTitle(dayName(day)), "date-ref", here)}</span>`);
  }
  if (dates.length > 0) html += `<div class="task-dates">${dates.join("")}</div>`;
  if (info.props.length > 0) {
    const rows = info.props.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${md.renderInline(value, env)}</dd></div>`);
    html += `<dl class="props">${rows.join("")}</dl>`;
  }
  return html;
}
