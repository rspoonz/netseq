import { reactive } from "vue";

// The search palette (Mod+K, or the Search button). With `pick` set it only lists pages, and
// hands the chosen one to `pick.choose` instead of opening it. Closing it clears `pick`.
export const palette = reactive({
  open: false,
  pick: null as { title: string; choose: (name: string) => void } | null,
});

/** Opens the palette to choose a page (an existing one, or a new name). */
export function pickPage(title: string, choose: (name: string) => void): void {
  palette.pick = { title, choose };
  palette.open = true;
}

/** Splits text into plain and highlighted parts, for showing where search words matched. */
export function segments(text: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const [start, end] of ranges) {
    if (start > last) parts.push({ text: text.slice(last, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    last = end;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}
