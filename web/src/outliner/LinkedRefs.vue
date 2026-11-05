<script setup lang="ts">
import { computed, watch } from "vue";
import { pageKey } from "../../../shared/names";
import { fetchRefs } from "../api";
import { countRoots, useLiveData } from "./liveData";
import RefGroups from "./RefGroups.vue";

// Blocks on other pages that reference this page.
const props = defineProps<{ name: string }>();
const view = computed(() => `refs:${pageKey(props.name)}`);
const { data, failed, load } = useLiveData({ view: () => view.value, fetch: () => fetchRefs(props.name), groups: (groups) => groups });
const count = computed(() => countRoots(data.value));

watch(
  () => props.name,
  () => {
    data.value = null;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <p v-if="failed && !data" class="error">Couldn't load the linked references.</p>
  <section v-if="data && count > 0" class="linked-refs">
    <h2>{{ count }} linked {{ count === 1 ? "reference" : "references" }}</h2>
    <RefGroups :groups="data" :view="view" />
  </section>
</template>
