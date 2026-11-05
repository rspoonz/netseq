<script setup lang="ts">
import { computed, provide, watch } from "vue";
import { fetchQuery } from "../api";
import { countRoots, INSIDE_QUERY, useLiveData } from "./liveData";
import RefGroups from "./RefGroups.vue";

// The results of a {{query …}}, below the block that holds it. Editable in place.
const props = defineProps<{ query: string; block: string }>();
provide(INSIDE_QUERY, true);
const view = computed(() => `query:${props.block}`);
const { data, failed, load, settle } = useLiveData({
  view: () => view.value,
  fetch: () => fetchQuery(props.query, props.block),
  groups: (result) => ("error" in result ? [] : result.groups),
});
const result = computed(() => (data.value && !("error" in data.value) ? data.value : null));
const error = computed(() => (data.value && "error" in data.value ? data.value.error : null));
const count = computed(() => countRoots(result.value?.groups));

void load();
watch(() => props.query, settle); // while the query is being typed, wait for a pause
</script>

<template>
  <div class="query-results">
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="failed && !data" class="error">Couldn't run the query.</p>
    <template v-else-if="result">
      <p class="query-count">
        {{ count }} {{ count === 1 ? "result" : "results" }}<template v-if="result.truncated"> (more not shown)</template>
      </p>
      <RefGroups :groups="result.groups" :view="view" />
    </template>
  </div>
</template>
