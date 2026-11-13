<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { journalTitle, pageKey } from "../../../shared/names";
import { pageNameProblem } from "../../../shared/refs";
import { linkMentions, softLinksIn } from "../../../shared/softlinks";
import { fetchPage } from "../api";
import { historyFor, notify } from "../notices";
import { pickPage } from "../palette";
import { applyPageData, outline, rememberPageName, softLinkTargets } from "../store";
import { moveToPage, setContent } from "./intents";
import { bulletMenu, closeBulletMenu } from "./menu";
import { copyText } from "./selection";
import { commit } from "./undo";

// What a bullet's right-click menu offers.

const position = computed(() =>
  bulletMenu.above
    ? { right: `${window.innerWidth - bulletMenu.x}px`, bottom: `${window.innerHeight - bulletMenu.y}px` }
    : { left: `${bulletMenu.x}px`, top: `${bulletMenu.y}px` },
);

async function copyRef(): Promise<void> {
  const id = bulletMenu.id;
  closeBulletMenu();
  if (!id) return;
  const copied = await copyText(`((${id}))`);
  notify(copied ? "Block reference copied: paste it into any block." : "Couldn't copy to the clipboard.");
}

const hasSoftLinks = computed(() => {
  const b = bulletMenu.id ? outline.get(bulletMenu.id) : undefined;
  return b !== undefined && softLinksIn(b.content, softLinkTargets.value).length > 0;
});

/** Writes the block's soft links as [[links]], as one step that undo takes back. */
function linkAll(): void {
  const b = bulletMenu.id ? outline.get(bulletMenu.id) : undefined;
  closeBulletMenu();
  const change = b && setContent(outline, b.id, linkMentions(b.content, softLinkTargets.value));
  if (change) commit(change);
}

/** Asks for a page, then moves the block (with everything under it) to the end of it. */
function chooseMoveTarget(): void {
  const id = bulletMenu.id;
  closeBulletMenu();
  if (id) pickPage("Move to page", (name) => void moveTo(id, name));
}

async function moveTo(id: string, name: string): Promise<void> {
  const problem = pageNameProblem(name);
  if (problem) {
    notify(problem);
    return;
  }
  rememberPageName(name); // so a new page gets the name as typed
  const key = pageKey(name);
  try {
    applyPageData(key, await fetchPage(name)); // its blocks, to go after the last one
  } catch {
    notify("Couldn't move the block: the page didn't load.");
    return;
  }
  const change = moveToPage(outline, id, key);
  if (!change) return;
  commit(change);
  notify(`Moved to ${journalTitle(name.trim())}.`);
}

/** On any device, at any time: the device whose text was replaced never gets a notice. */
function showHistory(): void {
  historyFor.value = bulletMenu.id;
  closeBulletMenu();
}

onMounted(() => {
  window.addEventListener("scroll", closeBulletMenu, true);
  window.addEventListener("resize", closeBulletMenu);
});
onBeforeUnmount(() => {
  window.removeEventListener("scroll", closeBulletMenu, true);
  window.removeEventListener("resize", closeBulletMenu);
});
</script>

<template>
  <div
    v-if="bulletMenu.id"
    class="bullet-menu"
    role="menu"
    :style="position"
    @mousedown.stop
  >
    <button type="button" role="menuitem" @click="copyRef">Copy block ref</button>
    <button v-if="hasSoftLinks" type="button" role="menuitem" @click="linkAll">Link mentions</button>
    <button type="button" role="menuitem" @click="chooseMoveTarget">Move to page…</button>
    <button type="button" role="menuitem" @click="showHistory">Earlier versions</button>
  </div>
</template>
