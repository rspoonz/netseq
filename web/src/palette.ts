import { reactive } from "vue";

// The search palette (Mod+K, or the Search button).
export const palette = reactive({ open: false });

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
