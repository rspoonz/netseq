// Which editing command a key press means. Kept free of the DOM so it can be unit-tested.

export type Command =
  | "split"
  | "indent"
  | "outdent"
  | "mergePrevious"
  | "mergeNext"
  | "focusPrevious"
  | "focusNext"
  | "moveUp"
  | "moveDown"
  | "collapse"
  | "expand"
  | "undo"
  | "redo"
  | "cycleTask" // TODO → DOING → DONE → none
  | "select" // stop editing and select the block
  | "exit"; // stop editing

export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface CaretContext {
  collapsed: boolean; // no text selected
  atStart: boolean;
  atEnd: boolean;
  onFirstLine(): boolean; // measured lazily: only arrow keys need it
  onLastLine(): boolean;
}

export function keyCommand(e: KeyLike, caret: CaretContext): Command | null {
  const mod = e.ctrlKey || e.metaKey;
  // AltGr arrives as Ctrl+Alt on Windows, and Norwegian layouts type [ ] { } @ $ with it.
  if (mod && e.altKey) return null;
  const plain = !mod && !e.altKey;

  switch (e.key) {
    case "Enter":
      if (mod && !e.shiftKey) return "cycleTask";
      return plain && !e.shiftKey ? "split" : null;
    case "Tab":
      return plain ? (e.shiftKey ? "outdent" : "indent") : null;
    case "Backspace":
      return plain && caret.collapsed && caret.atStart ? "mergePrevious" : null;
    case "Delete":
      return plain && caret.collapsed && caret.atEnd ? "mergeNext" : null;
    case "ArrowUp":
    case "ArrowDown": {
      const up = e.key === "ArrowUp";
      if (e.shiftKey && (e.altKey || mod)) return up ? "moveUp" : "moveDown";
      if (mod) return up ? "collapse" : "expand";
      if (plain && !e.shiftKey && caret.collapsed && (up ? caret.onFirstLine() : caret.onLastLine())) {
        return up ? "focusPrevious" : "focusNext";
      }
      return null;
    }
    case "Escape":
      return "select";
    case "z":
    case "Z":
    case "y":
      return undoCommand(e);
  }
  return null;
}

/** Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo: in the editor, and anywhere else outside a text field. */
export function undoCommand(e: KeyLike): "undo" | "redo" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "z" || e.key === "Z") return e.shiftKey ? "redo" : "undo";
  if (e.key === "y" && !e.shiftKey) return "redo";
  return null;
}
