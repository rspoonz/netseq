import { describe, expect, test } from "bun:test";
import { firstLine, nextMarker, parseBlock, plainText, propertyValues, searchText, setDate, setMarker } from "./blocktext";

describe("parseBlock", () => {
  test("a task marker at the start, and a priority on the first line", () => {
    const info = parseBlock("TODO [#A] write the report");
    expect(info).toMatchObject({ marker: "TODO", priority: "A", body: "[#A] write the report" });
  });

  test("a marker must be a whole word at the very start", () => {
    expect(parseBlock("TODOS for today").marker).toBeNull();
    expect(parseBlock("I have a TODO").marker).toBeNull();
    expect(parseBlock("todo lower case").marker).toBeNull();
    expect(parseBlock("DONE").marker).toBe("DONE");
    expect(parseBlock("DOING\nsecond line")).toMatchObject({ marker: "DOING", body: "\nsecond line" });
  });

  test("dates and properties come out of the body", () => {
    const info = parseBlock("LATER call Ann\nSCHEDULED: <2026-11-02 Mon>\nDEADLINE: <2026-11-06 Fri 10:00 .+1w>\nStatus:: waiting for [[Ann]]\nnotes");
    expect(info).toMatchObject({
      marker: "LATER",
      scheduled: 20261102,
      deadline: 20261106,
      props: [["status", "waiting for [[Ann]]"]],
      body: "call Ann\nnotes",
    });
  });

  test("nothing inside fenced code counts", () => {
    const info = parseBlock("```\nSCHEDULED: <2026-11-02 Mon>\nkey:: value\n```");
    expect(info).toMatchObject({ scheduled: null, props: [], body: "```\nSCHEDULED: <2026-11-02 Mon>\nkey:: value\n```" });
  });

  test("malformed dates and lookalike properties stay in the text", () => {
    expect(parseBlock("SCHEDULED: <2026-13-02>").scheduled).toBeNull();
    expect(parseBlock("see https://example.com").props).toEqual([]);
    expect(parseBlock("a priority [#A] on the second line?\n[#B]").priority).toBe("A");
    expect(parseBlock("first\n[#B] second").priority).toBeNull();
  });
});

describe("editing markers and dates", () => {
  test("setMarker replaces, adds or removes the marker", () => {
    expect(setMarker("TODO buy milk", "DONE")).toBe("DONE buy milk");
    expect(setMarker("buy milk", "TODO")).toBe("TODO buy milk");
    expect(setMarker("DONE buy milk", null)).toBe("buy milk");
  });

  test("nextMarker cycles TODO → DOING → DONE → none", () => {
    const seen = [];
    let marker = nextMarker(null);
    for (let i = 0; i < 4; i++) {
      seen.push(marker);
      marker = nextMarker(marker);
    }
    expect(seen).toEqual(["TODO", "DOING", "DONE", null]);
    expect(nextMarker("LATER")).toBe("NOW");
  });

  test("setDate adds a line after the first one, or replaces the existing one", () => {
    expect(setDate("TODO report\nmore", "SCHEDULED", "2026-11-02")).toBe("TODO report\nSCHEDULED: <2026-11-02 Mon>\nmore");
    expect(setDate("TODO report\nSCHEDULED: <2026-11-02 Mon>", "SCHEDULED", "2026-11-05")).toBe(
      "TODO report\nSCHEDULED: <2026-11-05 Thu>",
    );
    expect(setDate("TODO report\nSCHEDULED: <2026-11-02 Mon>", "DEADLINE", "2026-11-06")).toBe(
      "TODO report\nDEADLINE: <2026-11-06 Fri>\nSCHEDULED: <2026-11-02 Mon>",
    );
  });
});

describe("firstLine", () => {
  test("the first line with text, without heading marks, task marker, dates or properties", () => {
    expect(firstLine("## Meeting notes\nmore")).toBe("Meeting notes");
    expect(firstLine("TODO [#A] call Ann\nSCHEDULED: <2026-11-02 Mon>")).toBe("[#A] call Ann");
    expect(firstLine("status:: draft\nThe real text")).toBe("The real text");
    expect(firstLine("\n  \nafter blank lines")).toBe("after blank lines");
    expect(firstLine("#tag is not a heading")).toBe("#tag is not a heading");
    expect(firstLine("")).toBe("");
  });
});

describe("text for searching", () => {
  test("page names lose their brackets, and emphasis markers go", () => {
    expect(plainText("**meet** [[Project X]] about #[[big idea]] and `code`")).toBe("meet Project X about #big idea and code");
    expect(searchText("Ærlig TALT")).toBe("ærlig talt");
    expect(plainText("open tasks: {{query [[Project]]}}")).toBe("open tasks: ");
    expect(plainText("see ((6f1c2a7e-3b4d-4c5e-8f90-a1b2c3d4e5f6))")).toBe("see ");
  });

  test("property values compare as lower-case plain text, each comma-separated part too", () => {
    expect(propertyValues("[[Book]]")).toEqual(["book"]);
    expect(propertyValues("#Reading, [[Big Idea]]")).toEqual(["reading, big idea", "reading", "big idea"]);
  });
});
