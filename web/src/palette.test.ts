import { expect, test } from "bun:test";
import { segments } from "./palette";

test("segments mark the matched parts of a snippet", () => {
  expect(segments("Meeting with Ann", [[0, 4], [13, 16]])).toEqual([
    { text: "Meet", hit: true },
    { text: "ing with ", hit: false },
    { text: "Ann", hit: true },
  ]);
  expect(segments("no hits", [])).toEqual([{ text: "no hits", hit: false }]);
});
