<script setup lang="ts">
import { computed } from "vue";
import { fetchAgenda } from "../api";
import { countRoots, useLiveData } from "./liveData";
import RefGroups from "./RefGroups.vue";

// Shown with today's journal: unfinished tasks scheduled or due today or earlier.
const { data, failed, load } = useLiveData({ view: () => "agenda", fetch: fetchAgenda, groups: (groups) => groups });
const count = computed(() => countRoots(data.value));
void load();
</script>

<template>
  <p v-if="failed && !data" class="error">Couldn't load today's scheduled tasks and deadlines.</p>
  <section v-if="data && count > 0" class="agenda">
    <h2>Scheduled and deadlines</h2>
    <RefGroups :groups="data" view="agenda" />
  </section>
</template>
