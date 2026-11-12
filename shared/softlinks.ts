import MarkdownIt from "markdown-it";
import { proseOnly } from "./blocktext";
import { isJournalKey, pageKey } from "./names";
import { contentLines, formatRef, matchBlockRef, matchMacro, matchPageRef, matchTag } from "./refs";

// Soft links: mentions of a page's name in plain text, without [[ ]], shown as faint links. They
// change nothing in the text and aren't references (linked references, queries and renames
// ignore them) until "Link mentions" writes them as [[links]]. Whole words only, ignoring case,
// as unlinked references match; where names overlap, the longest wins. Mentions of the page being
// viewed are soft links too, like [[links]] to it, so its unlinked references can be linked there.

/** Whether text can soft-link to the page with this name: not journal days, nor very short names. */
export function softLinkable(name: string): boolean {
  const key = pageKey(name);
  return [...key].length >= 3 && !isJournalKey(key); // shorter names would light up too much ordinary text
}

interface TrieNode {
  next: Map<number, TrieNode>; // by UTF-16 code unit of the lower-cased name
  name?: string; // a page name ends here
}

/** The page names text can soft-link to, ready for matching. Build it once per set of names. */
export interface PageNames {
  root: TrieNode;
}

// A trie over the lower-cased names, so matching costs the same however many pages there are.
export function pageNames(names: Iterable<string>): PageNames {
  const root: TrieNode = { next: new Map() };
  for (const raw of names) {
    const name = raw.normalize("NFC").trim();
    if (!softLinkable(name)) continue;
    const lower = lowered(name);
    let node = root;
    for (let i = 0; i < lower.length; i++) {
      let child = node.next.get(lower.charCodeAt(i));
      if (!child) node.next.set(lower.charCodeAt(i), (child = { next: new Map() }));
      node = child;
    }
    node.name ??= name;
  }
  return { root };
}

/**
 * Lower-cased text, the same length as the text, so positions in one are positions in the other.
 * The few characters whose lower case is longer (such as "İ") stay as they are.
 */
function lowered(text: string): string {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return lower;
  let same = "";
  for (const char of text) {
    const small = char.toLowerCase();
    same += small.length === char.length ? small : char;
  }
  return same;
}

export interface Mention {
  start: number;
  end: number;
  name: string; // the page's name, which may differ in case from the text
}

// Word characters, as for unlinked references (server/search.ts): letters, digits and "_".
const WORD = /[\p{L}\p{N}_]/u;

function isWord(char: string): boolean {
  const code = char.charCodeAt(0);
  if (code < 128) return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
  return WORD.test(char);
}

function wordBefore(text: string, index: number): boolean {
  if (index === 0) return false;
  const low = text.charCodeAt(index - 1);
  const start = low >= 0xdc00 && low <= 0xdfff && index >= 2 ? index - 2 : index - 1; // a surrogate pair
  return isWord(text.slice(start, index));
}

function wordAt(text: string, index: number): boolean {
  const code = text.codePointAt(index);
  return code !== undefined && isWord(String.fromCodePoint(code));
}

/** Mentions in text[from, to): where a word starts, the longest name that ends where a word ends. */
function findNames(text: string, lower: string, from: number, to: number, names: PageNames, found: Mention[]): void {
  for (let i = from; i < to; i++) {
    let node = names.root.next.get(lower.charCodeAt(i));
    if (!node || wordBefore(text, i)) continue;
    let best: TrieNode | undefined;
    let end = i;
    for (let j = i + 1; node; j++) {
      if (node.name && !wordAt(text, j)) [best, end] = [node, j];
      node = j < to ? node.next.get(lower.charCodeAt(j)) : undefined;
    }
    if (!best) continue;
    found.push({ start: i, end, name: best.name! });
    i = end - 1;
  }
}

const MARKDOWN_LINK = /!?\[[^\]\n]*\]\([^)\n]*\)/y;

// Finds web and e-mail addresses the way the renderer's markdown-it does (shared/markdown.ts uses
// the same defaults): "scheme:" and "//" addresses, and e-mail addresses. Not bare domains.
const linkify = new MarkdownIt().linkify;
const MAY_HOLD_ADDRESS = /[:@]|\/\//;

/** Where something that isn't plain prose starts at `i` on a line, the index just after it; else -1. */
function skipAt(line: string, i: number, addresses: Map<number, number> | undefined): number {
  const address = addresses?.get(i);
  if (address !== undefined) return address;
  switch (line[i]) {
    case "\\":
      return i + 2;
    case "`": {
      const run = /`+/y;
      run.lastIndex = i;
      const ticks = run.exec(line)![0];
      const close = line.indexOf(ticks, i + ticks.length);
      return close === -1 ? i + ticks.length : close + ticks.length;
    }
    case "!":
    case "[": {
      MARKDOWN_LINK.lastIndex = i;
      const link = MARKDOWN_LINK.exec(line);
      return link ? i + link[0].length : (matchPageRef(line, i)?.end ?? -1);
    }
    case "#":
      return matchTag(line, i)?.end ?? -1;
    case "(":
      return matchBlockRef(line, i)?.end ?? -1;
    case "{":
      return matchMacro(line, i)?.end ?? -1;
    default:
      return -1;
  }
}

/** The soft links in markdown text: mentions of the names outside code, links, tags, ((refs)), {{macros}} and addresses. */
export function mentions(text: string, names: PageNames): Mention[] {
  const found: Mention[] = [];
  if (names.root.next.size === 0) return found;
  const lower = lowered(text);
  for (const { text: line, offset, code } of contentLines(text)) {
    if (code) continue;
    const addresses = MAY_HOLD_ADDRESS.test(line)
      ? new Map((linkify.match(line) ?? []).map((match) => [match.index, match.lastIndex]))
      : undefined;
    let from = 0;
    for (let i = 0; i < line.length; ) {
      const skip = skipAt(line, i, addresses);
      if (skip === -1) {
        i++;
        continue;
      }
      findNames(text, lower, offset + from, offset + i, names, found);
      i = from = Math.min(skip, line.length);
    }
    findNames(text, lower, offset + from, offset + line.length, names, found);
  }
  return found;
}

/**
 * The soft links in a block's text: as `mentions`, leaving out its task marker, dates and properties.
 * Known limit: it reads one line at a time, as scan() in refs.ts does, so it can't see what the
 * renderer makes code or link text across lines (indented code, inline code over two lines,
 * brackets inside a markdown link's text, reference definitions). Mentions there aren't shown as
 * soft links, but Link mentions links them, just as a [[link]] there already counts as a reference.
 */
export function softLinksIn(content: string, names: PageNames): Mention[] {
  return mentions(proseOnly(content), names);
}

/** "Link mentions": the block's text with each soft link written as a [[link]], keeping the text as written. */
export function linkMentions(content: string, names: PageNames): string {
  let result = "";
  let last = 0;
  for (const { start, end } of softLinksIn(content, names)) {
    result += content.slice(last, start) + formatRef(content.slice(start, end), "link");
    last = end;
  }
  return result + content.slice(last);
}
