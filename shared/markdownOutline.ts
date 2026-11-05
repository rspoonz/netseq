// Blocks as a markdown outline: a "- " bullet per block, one indent per level, and a block's
// further lines indented to line up under its text. Used for copying blocks (two spaces per
// level) and for the markdown export (a tab per level, as Logseq writes its files).

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
