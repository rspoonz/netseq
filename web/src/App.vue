<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { RouterLink, RouterView } from "vue-router";
import History from "./components/History.vue";
import Notices from "./components/Notices.vue";
import SearchPalette from "./components/SearchPalette.vue";
import { live } from "./events";
import { historyFor } from "./notices";
import { sync } from "./outbox";
import BulletMenu from "./outliner/BulletMenu.vue";
import { undoCommand } from "./outliner/keymap";
import { closeBulletMenu } from "./outliner/menu";
import MobileToolbar from "./outliner/MobileToolbar.vue";
import { clearSelection, handleSelectionKey, selection } from "./outliner/selection";
import { redo, undo } from "./outliner/undo";
import { palette } from "./palette";

function clearSelectionOnClick(): void {
  if (selection.ids.length > 0) clearSelection();
  closeBulletMenu();
}

function onKeydown(event: KeyboardEvent): void {
  // Mod+K opens search from anywhere, even while editing. (Never Ctrl+Alt: that's AltGr.)
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
    event.preventDefault();
    palette.open = !palette.open;
    return;
  }
  // Undo and redo when no block is being edited, e.g. right after deleting selected blocks.
  // Text fields (the block editor, search, the filter, renaming) handle these keys themselves.
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    const command = undoCommand(event);
    if (command) {
      event.preventDefault();
      if (command === "undo") undo();
      else redo();
      return;
    }
  }
  if (event.key === "Escape") {
    closeBulletMenu();
    if (historyFor.value) {
      historyFor.value = null; // closing the panel is all this Esc does
      return;
    }
  }
  handleSelectionKey(event);
}

onMounted(() => {
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("mousedown", clearSelectionOnClick);
});
onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("mousedown", clearSelectionOnClick);
});

// Saving state, but "Offline" when live updates are disconnected even with nothing to save:
// what's on screen may be out of date.
const status = computed(() => (sync.state === "saved" && !live.value ? "offline" : sync.state));
const syncLabel = computed(() => {
  switch (status.value) {
    case "saved":
      return "Saved";
    case "saving":
      return "Saving…";
    case "offline":
      return sync.pending > 0 ? `Offline · ${sync.pending} pending` : "Offline";
    case "error":
      return "Some changes couldn't be saved";
  }
});
</script>

<template>
  <header class="topbar">
    <span class="brand">NetSeq</span>
    <nav>
      <RouterLink to="/">Journals</RouterLink>
      <RouterLink to="/pages">Pages</RouterLink>
    </nav>
    <button type="button" class="search-button" title="Search (Ctrl+K)" @click="palette.open = true">Search</button>
    <span class="sync" :class="status" role="status">{{ syncLabel }}</span>
  </header>
  <main class="content">
    <RouterView />
  </main>
  <MobileToolbar />
  <Notices />
  <History />
  <SearchPalette />
  <BulletMenu />
</template>
