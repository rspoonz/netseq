import { describe, expect, test } from "bun:test";
import { isJournalKey, journalName, journalTitle, pageKey } from "./names";

describe("pageKey", () => {
  test("ignores case and surrounding whitespace", () => {
    expect(pageKey("  My Page ")).toBe("my page");
  });

  test("treats composed and decomposed Unicode as the same name", () => {
    expect(pageKey("Résumé")).toBe(pageKey("Résumé"));
  });

  test("lower-cases non-ASCII letters", () => {
    expect(pageKey("ÆØÅ")).toBe("æøå");
  });
});

describe("journal names", () => {
  test("journalName uses the local calendar date", () => {
    expect(journalName(new Date(2026, 10, 2, 23, 59))).toBe("2026-11-02");
  });

  test("isJournalKey only accepts ISO dates", () => {
    expect(isJournalKey("2026-11-02")).toBe(true);
    expect(isJournalKey("2026-11-2")).toBe(false);
    expect(isJournalKey("nov 2nd, 2026")).toBe(false);
  });

  test("journalTitle shows a journal day's date and weekday, and leaves other names alone", () => {
    expect(journalTitle("2026-11-02", "en-GB")).toBe("2026-11-02 Mon");
    expect(journalTitle("2026-11-03", "nb-NO")).toBe("2026-11-03 tir.");
    expect(journalTitle("Project X")).toBe("Project X");
    expect(journalTitle("2026-02-30")).toBe("2026-02-30");
  });
});
