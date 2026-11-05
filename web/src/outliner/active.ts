import type { Command } from "./keymap";

// The open editor's command handler, so the mobile toolbar can drive it.

type Runner = (command: Command) => boolean;
let current: Runner | null = null;

export function setActiveEditor(run: Runner): void {
  current = run;
}

export function clearActiveEditor(run: Runner): void {
  if (current === run) current = null;
}

export function runCommand(command: Command): boolean {
  return current?.(command) ?? false;
}
