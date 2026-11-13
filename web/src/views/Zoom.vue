<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { BlockTree } from "../../../shared/types";
import { fetchBlockTree } from "../api";
import Block from "../outliner/Block.vue";
import Crumbs from "../outliner/Crumbs.vue";
import { openBulletMenu } from "../outliner/menu";
import { applyTree, changes, outline, refreshes, rememberPageName } from "../store";

// One block with everything under it, under a breadcrumb trail: its page (which opens at the
// block), then the blocks it sits inside. The ⋯ beside the trail opens the block's menu, so a
// phone can reach it without editing the block (see menu.ts).
const props = defineProps<{ id: string }>();
const tree = ref<BlockTree | null>(null);
const missing = ref(false);
const exists = computed(() => outline.get(props.id) !== undefined);

async function load(): Promise<void> {
  try {
    const data = await fetchBlockTree(props.id);
    missing.value = data === null;
    if (!data) return;
    rememberPageName(data.page.name);
    applyTree(data.blocks);
    tree.value = data;
  } catch {
    // keep what's shown; the next refresh tries again
  }
}

watch(
  () => props.id,
  () => {
    tree.value = null;
    missing.value = false;
    void load();
  },
  { immediate: true },
);
watch(refreshes, load);
// A move (from here, or another tab or device) leaves the trail showing where the block was:
// fetch it again once the server has the change.
watch(changes, () => {
  const b = outline.get(props.id);
  const shown = tree.value;
  if (b && shown && (b.page !== shown.page.key || b.parent !== (shown.path.at(-1)?.id ?? null))) void load();
});

/** Opens the block menu just below the ⋯, lined up with its right edge so it stays on screen. */
function openMenu(event: MouseEvent): void {
  const button = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openBulletMenu(props.id, button.right, button.bottom, "top-right");
}
</script>

<template>
  <p v-if="missing" class="muted">This block doesn't exist (any more).</p>
  <p v-else-if="!tree" class="muted">Loading…</p>
  <section v-else>
    <header class="zoom-header">
      <Crumbs :path="tree.path" :page="{ name: tree.page.name, at: id }" landmark />
      <button
        v-if="exists"
        type="button"
        class="icon-button"
        aria-label="Block menu"
        aria-haspopup="menu"
        title="Block menu"
        @click="openMenu"
      >
        ⋯
      </button>
    </header>
    <div class="outline">
      <Block v-if="exists" :id="id" view="zoom" :scope="id" />
      <p v-else class="muted">This block was deleted.</p>
    </div>
  </section>
</template>
