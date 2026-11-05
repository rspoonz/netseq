<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { BlockTree } from "../../../shared/types";
import { fetchBlockTree } from "../api";
import Block from "../outliner/Block.vue";
import Crumbs from "../outliner/Crumbs.vue";
import { applyTree, outline, refreshes, rememberPageName } from "../store";

// One block with everything under it, under a breadcrumb trail: its page (which opens at the
// block), then the blocks it sits inside.
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
</script>

<template>
  <p v-if="missing" class="muted">This block doesn't exist (any more).</p>
  <p v-else-if="!tree" class="muted">Loading…</p>
  <section v-else>
    <header class="zoom-header">
      <Crumbs :path="tree.path" :page="{ name: tree.page.name, at: id }" landmark />
    </header>
    <div class="outline">
      <Block v-if="exists" :id="id" view="zoom" :scope="id" />
      <p v-else class="muted">This block was deleted.</p>
    </div>
  </section>
</template>
