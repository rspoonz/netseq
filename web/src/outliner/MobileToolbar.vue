<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { editing } from "../store";
import { runCommand } from "./active";
import type { Command } from "./keymap";
import { openBulletMenu } from "./menu";

// Outline keys that phone keyboards lack, pinned just above the on-screen keyboard. The buttons
// act on pointerdown and cancel it, so the textarea keeps focus and the keyboard stays up.
// ⋯ opens the block's menu (what right-click on a bullet opens), since iPhones can't long-press it.

const buttons: { action: Command | "menu"; label: string; symbol: string }[] = [
  { action: "outdent", label: "Outdent", symbol: "⇤" },
  { action: "indent", label: "Indent", symbol: "⇥" },
  { action: "moveUp", label: "Move up", symbol: "↑" },
  { action: "moveDown", label: "Move down", symbol: "↓" },
  { action: "mergePrevious", label: "Join with the block above", symbol: "⌫" },
  { action: "cycleTask", label: "TODO / DOING / DONE", symbol: "☐" },
  { action: "undo", label: "Undo", symbol: "↶" },
  { action: "redo", label: "Redo", symbol: "↷" },
  { action: "menu", label: "Block menu", symbol: "⋯" },
  { action: "exit", label: "Done", symbol: "✓" },
];

function press(action: Command | "menu", event: PointerEvent): void {
  if (action !== "menu") {
    runCommand(action);
    return;
  }
  if (!editing.id) return;
  const button = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openBulletMenu(editing.id, button.right, button.top, "bottom-right");
}

const touch = window.matchMedia("(pointer: coarse)").matches;
const visible = computed(() => touch && editing.id !== null);
const bottom = ref(0);

function place(): void {
  const viewport = window.visualViewport;
  if (viewport) bottom.value = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
}

onMounted(() => {
  window.visualViewport?.addEventListener("resize", place);
  window.visualViewport?.addEventListener("scroll", place);
  place();
});
onBeforeUnmount(() => {
  window.visualViewport?.removeEventListener("resize", place);
  window.visualViewport?.removeEventListener("scroll", place);
});
</script>

<template>
  <div v-if="visible" class="mobile-toolbar" :style="{ bottom: `${bottom}px` }">
    <button
      v-for="button in buttons"
      :key="button.action"
      type="button"
      :aria-label="button.label"
      :title="button.label"
      @pointerdown.prevent="press(button.action, $event)"
    >
      {{ button.symbol }}
    </button>
  </div>
</template>
