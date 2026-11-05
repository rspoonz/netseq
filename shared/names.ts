// Page names are case-insensitive. The normalised form is a page's key everywhere
// (database, refs, client store), so this is the only place that decides it.
export function pageKey(name: string): string {
  return name.normalize("NFC").trim().toLowerCase();
}

// Journal pages are named after their date, e.g. "2026-11-02". The database derives
// pages.journal_day with the same pattern (server/db.ts), so keep the two in step.
const JOURNAL_NAME = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isJournalKey(key: string): boolean {
  return JOURNAL_NAME.test(key);
}

/** The journal page name for a calendar date, in local time. */
export function journalName(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * How a journal page is shown: its date and weekday, e.g. "2026-11-02 Mon" (the weekday in the
 * browser's language). Other names come back unchanged.
 */
export function journalTitle(name: string, locale?: string): string {
  const match = JOURNAL_NAME.exec(name.trim());
  if (!match) return name;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const date = new Date(year, month, day);
  // Reject dates that don't exist (2026-02-30 would silently roll over into March).
  if (date.getMonth() !== month || date.getDate() !== day) return name;
  return `${match[0]} ${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date)}`;
}
/** A journal day as a number, "2026-11-02" → 20261102 (how the database stores days). */
export function dayNumber(name: string): number {
  return Number(name.replaceAll("-", ""));
}

/** The journal page name for a day number, 20261102 → "2026-11-02". */
export function dayName(day: number): string {
  const digits = String(day).padStart(8, "0");
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}
