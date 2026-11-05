<script setup lang="ts">
import { computed } from "vue";
import { fetchBlockRefs } from "../api";
import { useLiveData } from "./liveData";
import RefGroups from "./RefGroups.vue";

// The blocks that reference a block, opened from its reference count.
const props = defineProps<{ id: string }>();
const view = computed(() => `blockrefs:${props.id}`);
const { data, failed, load } = useLiveData({ view: () => view.value, fetch: () => fetchBlockRefs(props.id), groups: (groups) => groups });
void load();
</script>

<template>
  <div class="block-refs">
    <p v-if="failed && !data" class="error">Couldn't load the blocks that reference this one.</p>
    <p v-else-if="!data" class="muted">Loading…</p>
    <RefGroups v-else :groups="data" :view="view" />
  </div>
</template>
