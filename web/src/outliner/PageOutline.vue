<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { pageKey } from "../../../shared/names";
import { fetchPage } from "../api";
import { applyPageData, outline, refreshes, rememberPageName } from "../store";
import Block from "./Block.vue";
import { firstBlock } from "./intents";
import { topKey } from "./outline";
import { commit } from "./undo";

// A page's outline. Loads the page itself unless the parent already did (`load: false`).
const props = withDefaults(defineProps<{ name: string; view: string; load?: boolean }>(), { load: true });
const emit = defineEmits<{ ready: [key: string] }>(); // the page (this key) has loaded and is on screen
const key = computed(() => pageKey(props.name));
const roots = computed(() => outline.childIds(topKey(key.value)));
const status = ref<"loading" | "ready" | "error">(props.load ? "loading" : "ready");

watch(
  () => props.name,
  async (name) => {
    rememberPageName(name);
    if (!props.load) return;
    status.value = "loading";
    try {
      applyPageData(pageKey(name), await fetchPage(name));
      status.value = "ready";
      await nextTick();
      emit("ready", pageKey(name));
    } catch {
      status.value = "error";
    }
  },
  { immediate: true },
);

// After missing live updates, quietly reload (keeping what's on screen if that fails). A parent
// that loaded the page reloads it too.
watch(refreshes, async () => {
  if (!props.load) return;
  try {
    applyPageData(key.value, await fetchPage(props.name));
  } catch {
    // offline: the next refresh will catch up
  }
});

function start(): void {
  commit(firstBlock(key.value), undefined, { view: props.view });
}
</script>

<template>
  <p v-if="status === 'loading'" class="muted">Loading…</p>
  <p v-else-if="status === 'error'" class="error">Couldn't load this page.</p>
  <div v-else class="outline">
    <Block v-for="id in roots" :id="id" :key="id" :view="view" />
    <button v-if="roots.length === 0" type="button" class="outline-start" @click="start">
      Click here to start writing
    </button>
  </div>
</template>
