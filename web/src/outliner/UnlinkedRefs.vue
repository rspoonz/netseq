<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { pageKey } from "../../../shared/names";
import { fetchUnlinked } from "../api";
import { countRoots, useLiveData } from "./liveData";
import RefGroups from "./RefGroups.vue";

// Blocks on other pages that mention this page's name without linking to it. Loaded with the
// page, so the heading can say how many there are; the list itself stays folded until opened.
const props = defineProps<{ name: string }>();
const open = ref(false);
const view = computed(() => `unlinked:${pageKey(props.name)}`);
const { data, failed, load } = useLiveData({ view: () => view.value, fetch: () => fetchUnlinked(props.name), groups: (groups) => groups });
const count = computed(() => countRoots(data.value));

watch(
  () => props.name,
  () => {
    open.value = false;
    data.value = null;
    void load();
  },
  { immediate: true },
);
</script>

<template>
  <p v-if="failed && !data" class="error">Couldn't load the unlinked references.</p>
  <section v-if="data && count > 0" class="unlinked-refs">
    <h2>
      <button type="button" class="section-toggle" :aria-expanded="open" @click="open = !open">
        {{ count }} unlinked {{ count === 1 ? "reference" : "references" }}
      </button>
    </h2>
    <RefGroups v-if="open" :groups="data" :view="view" />
  </section>
</template>
