<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue";
import { historyFor, notify } from "../notices";
import { bulletMenu, closeBulletMenu } from "./menu";
import { copyText } from "./selection";

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
    <button type="button" role="menuitem" @click="showHistory">Earlier versions</button>
  </div>
</template>
