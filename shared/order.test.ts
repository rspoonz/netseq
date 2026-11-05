import { expect, test } from "bun:test";
import { compareSiblings, isValidKey, keyBetween, keysBetween } from "./order";

test("keys sort between their neighbours", () => {
  const first = keyBetween(null, null);
  const last = keyBetween(first, null);
  const middle = keyBetween(first, last);
  expect(first < middle && middle < last).toBe(true);
  expect(keyBetween(null, first) < first).toBe(true);
});

test("several keys at once stay in order", () => {
  const keys = keysBetween("a0", "a1", 3);
  expect(keys).toHaveLength(3);
  expect([...keys].sort()).toEqual(keys);
  expect(keys.every((k) => k > "a0" && k < "a1")).toBe(true);
});

test("equal neighbours don't throw: the new key goes after them", () => {
  expect(keyBetween("a0", "a0") > "a0").toBe(true);
});

test("siblings with the same key are ordered by id", () => {
  const sorted = [
    { order_key: "a1", id: "x" },
    { order_key: "a0", id: "z" },
    { order_key: "a1", id: "b" },
  ].sort(compareSiblings);
  expect(sorted.map((s) => s.id)).toEqual(["z", "b", "x"]);
});

test("isValidKey rejects malformed keys", () => {
  expect(isValidKey("a0")).toBe(true);
  expect(isValidKey("")).toBe(false);
  expect(isValidKey("a0 ")).toBe(false);
});
