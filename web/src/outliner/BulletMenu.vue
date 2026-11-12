<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { linkMentions, softLinksIn } from "../../../shared/softlinks";
import { historyFor, notify } from "../notices";
import { outline, softLinkTargets } from "../store";
import { setContent } from "./intents";
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
    <button type="button" role="menuitem" @click="showHistory">Earlier versions</button>
  </div>
</template>
