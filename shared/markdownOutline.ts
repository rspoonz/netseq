// Blocks as a markdown outline: a "- " bullet per block, one indent per level, and a block's
// further lines indented to line up under its text. Used for copying blocks (two spaces per
// level), the markdown export (a tab per level, as Logseq writes its files) and the agent API.
// parseOutline reads one back, for pasting and for agents adding blocks.

export interface OutlineSource {
  children(id: string): readonly string[];
  content(id: string): string | undefined; // undefined: no such block, left out
}

export interface OutlineOptions {
  indent?: string; // one level; two spaces by default
  extraLines?: (id: string) => string[]; // written right after the block's first line, e.g. properties
}

export function writeOutline(ids: readonly string[], source: OutlineSource, options: OutlineOptions = {}): string {
  const { indent = "  ", extraLines = () => [] } = options;
  const lines: string[] = [];
  const write = (id: string, depth: number) => {
    const content = source.content(id);
    if (content === undefined) return;
    const pad = indent.repeat(depth);
    const [first, ...rest] = content.split("\n");
    lines.push(`${pad}- ${first}`, ...[...extraLines(id), ...rest].map((line) => `${pad}  ${line}`));
    for (const child of source.children(id)) write(child, depth + 1);
  };
  for (const id of ids) write(id, 0);
  return lines.join("\n");
}

export interface OutlineItem {
  content: string;
  children: OutlineItem[];
}

const BULLET = /^(\s*)[-*+] (.*)$/;

/** Whether pasted text is an outline of "- item" lines rather than ordinary text. */
export function looksLikeOutline(text: string): boolean {
  const lines = text.trim().split(/\r?\n/);
  return lines.length > 1 && BULLET.test(lines[0]);
}

export function parseOutline(text: string): OutlineItem[] {
  const roots: OutlineItem[] = [];
  const stack: { indent: number; block: OutlineItem }[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const bullet = BULLET.exec(line);
    if (bullet) {
      const indent = bullet[1].length;
      const block: OutlineItem = { content: bullet[2], children: [] };
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      (stack.length > 0 ? stack[stack.length - 1].block.children : roots).push(block);
      stack.push({ indent, block });
    } else if (stack.length > 0) {
      // A continuation line of the item above, minus the indentation of the item's text.
      const top = stack[stack.length - 1];
      const leading = line.length - line.trimStart().length;
      top.block.content += "\n" + line.slice(Math.min(leading, top.indent + 2));
    } else if (line.trim()) {
      roots.push({ content: line.trim(), children: [] });
    }
  }
  const tidy = (blocks: OutlineItem[]): OutlineItem[] =>
    blocks.map((b) => ({ content: b.content.trimEnd(), children: tidy(b.children) }));
  return tidy(roots);
}
