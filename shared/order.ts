import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

// Siblings are ordered by fractional keys ("a0", "a0V", "a1", …) with the block id as the
// tie-break. Compare with plain < (never localeCompare): SQLite sorts the same way.

export function compareSiblings(a: { order_key: string; id: string }, b: { order_key: string; id: string }): number {
  if (a.order_key !== b.order_key) return a.order_key < b.order_key ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A key that sorts between `before` and `after`; null means the start or end of the list. */
export function keyBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, usableUpperBound(before, after));
}

/** `count` keys, in order, between `before` and `after`. */
export function keysBetween(before: string | null, after: string | null, count: number): string[] {
  return generateNKeysBetween(before, usableUpperBound(before, after), count);
}

// Two siblings can briefly share a key (two devices inserting at the same spot) until the
// server repairs it. Placing the new key just after `before` beats failing.
function usableUpperBound(before: string | null, after: string | null): string | null {
  return before !== null && after !== null && before >= after ? null : after;
}

export function isValidKey(key: string): boolean {
  // The library's base-62 digits, any length: keys grow by about a character per five inserts
  // in the same spot, and a refused key would lose the block.
  if (!/^[0-9A-Za-z]+$/.test(key)) return false;
  try {
    generateKeyBetween(key, null); // throws for keys the library considers malformed
    return true;
  } catch {
    return false;
  }
}
