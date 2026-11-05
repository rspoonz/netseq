import { describe, expect, test } from "bun:test";
import { applySlash, matchCommands, SLASH_COMMANDS, type SlashCommand, slashQueryAt } from "./slash";

function command(label: string): SlashCommand {
  return SLASH_COMMANDS.find((c) => c.label === label)!;
}

/** Runs a command typed where the "|" is. */
function run(text: string, label: string, day = "") {
  const caret = text.indexOf("|");
  const plain = text.replace("|", "");
  const q = slashQueryAt(plain, caret)!;
  const result = applySlash(plain, q, command(label), day, new Date(2026, 10, 3));
  return result.text.slice(0, result.caret) + "|" + result.text.slice(result.caret);
}

describe("slashQueryAt", () => {
  test("a slash at the start or after a space starts a command", () => {
    expect(slashQueryAt("/sch", 4)).toEqual({ start: 0, end: 4, query: "sch" });
    expect(slashQueryAt("buy milk /to", 12)).toEqual({ start: 9, end: 12, query: "to" });
    expect(slashQueryAt("and/or", 6)).toBeNull();
    expect(slashQueryAt("/to do", 6)).toBeNull();
  });

  test("commands starting with the query come first", () => {
    expect(matchCommands("d").map((c) => c.label)).toEqual(["DOING", "DONE", "Deadline", "Date picker", "TODO", "Scheduled", "Today", "Yesterday"]);
    expect(matchCommands("zzz")).toEqual([]);
  });
});

describe("applySlash", () => {
  test("a marker goes at the start of the block, wherever it was typed", () => {
    expect(run("buy milk /to|", "TODO")).toBe("TODO buy milk |");
    expect(run("TODO buy milk /don|", "DONE")).toBe("DONE buy milk |");
  });

  test("a date goes on the line after the first", () => {
    expect(run("report /sch|", "Scheduled", "2026-11-05")).toBe("report |\nSCHEDULED: <2026-11-05 Thu>");
    expect(run("report\nmore /dead|", "Deadline", "2026-11-06")).toBe("report\nDEADLINE: <2026-11-06 Fri>\nmore |");
  });

  test("days and the date picker insert journal links", () => {
    expect(run("due /tom|", "Tomorrow")).toBe("due [[2026-11-04]]|");
    expect(run("due /dat|!", "Date picker", "2026-12-24")).toBe("due [[2026-12-24]]|!");
  });

  test("a query puts the caret inside the braces", () => {
    expect(run("/que|", "Query")).toBe("{{query |}}");
  });
});
