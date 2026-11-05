import { expect, test } from "bun:test";
import { type CaretContext, type KeyLike, keyCommand, undoCommand } from "./keymap";

function key(k: string, mods: Partial<Omit<KeyLike, "key">> = {}): KeyLike {
  return { key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods };
}

const middle: CaretContext = { collapsed: true, atStart: false, atEnd: false, onFirstLine: () => false, onLastLine: () => false };
const start: CaretContext = { ...middle, atStart: true, onFirstLine: () => true };
const end: CaretContext = { ...middle, atEnd: true, onLastLine: () => true };

test("Enter splits, Shift+Enter is a newline", () => {
  expect(keyCommand(key("Enter"), middle)).toBe("split");
  expect(keyCommand(key("Enter", { shiftKey: true }), middle)).toBeNull();
});

test("Tab and Shift+Tab indent and outdent", () => {
  expect(keyCommand(key("Tab"), middle)).toBe("indent");
  expect(keyCommand(key("Tab", { shiftKey: true }), middle)).toBe("outdent");
});

test("Backspace and Delete merge only at the edges, with nothing selected", () => {
  expect(keyCommand(key("Backspace"), start)).toBe("mergePrevious");
  expect(keyCommand(key("Backspace"), middle)).toBeNull();
  expect(keyCommand(key("Backspace"), { ...start, collapsed: false })).toBeNull();
  expect(keyCommand(key("Delete"), end)).toBe("mergeNext");
  expect(keyCommand(key("Delete"), middle)).toBeNull();
});

test("arrows leave the block only from its first or last line", () => {
  expect(keyCommand(key("ArrowUp"), start)).toBe("focusPrevious");
  expect(keyCommand(key("ArrowUp"), middle)).toBeNull();
  expect(keyCommand(key("ArrowDown"), end)).toBe("focusNext");
});

test("modified arrows move and collapse blocks", () => {
  expect(keyCommand(key("ArrowUp", { altKey: true, shiftKey: true }), middle)).toBe("moveUp");
  expect(keyCommand(key("ArrowDown", { ctrlKey: true, shiftKey: true }), middle)).toBe("moveDown");
  expect(keyCommand(key("ArrowUp", { ctrlKey: true }), middle)).toBe("collapse");
  expect(keyCommand(key("ArrowDown", { metaKey: true }), middle)).toBe("expand");
});

test("undo and redo", () => {
  expect(keyCommand(key("z", { ctrlKey: true }), middle)).toBe("undo");
  expect(keyCommand(key("Z", { ctrlKey: true, shiftKey: true }), middle)).toBe("redo");
  expect(keyCommand(key("y", { metaKey: true }), middle)).toBe("redo");
  expect(keyCommand(key("z"), middle)).toBeNull();
});

test("undo and redo outside the editor use the same keys", () => {
  expect(undoCommand(key("z", { ctrlKey: true }))).toBe("undo");
  expect(undoCommand(key("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
  expect(undoCommand(key("y", { ctrlKey: true }))).toBe("redo");
  expect(undoCommand(key("z"))).toBeNull();
  expect(undoCommand(key("z", { ctrlKey: true, altKey: true }))).toBeNull(); // AltGr
  expect(undoCommand(key("Backspace", { ctrlKey: true }))).toBeNull();
});

test("AltGr (Ctrl+Alt) is left alone so [ ] { } @ $ can be typed", () => {
  expect(keyCommand(key("Enter", { ctrlKey: true, altKey: true }), middle)).toBeNull();
  expect(keyCommand(key("z", { ctrlKey: true, altKey: true }), middle)).toBeNull();
});

test("Mod+Enter cycles the task marker", () => {
  expect(keyCommand(key("Enter", { ctrlKey: true }), middle)).toBe("cycleTask");
  expect(keyCommand(key("Enter", { metaKey: true }), middle)).toBe("cycleTask");
  expect(keyCommand(key("Enter", { ctrlKey: true, altKey: true }), middle)).toBeNull(); // AltGr
});
