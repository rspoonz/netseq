<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isJournalKey, journalName, journalTitle, pageKey } from "../../../shared/names";
import { pageNameProblem } from "../../../shared/refs";
import { renamePage } from "../api";
import Agenda from "../outliner/Agenda.vue";
import LinkedRefs from "../outliner/LinkedRefs.vue";
import PageOutline from "../outliner/PageOutline.vue";
import { revealBlock } from "../outliner/reveal";
import UnlinkedRefs from "../outliner/UnlinkedRefs.vue";
import { applyBatchResult, lastRename, pages } from "../store";

const props = defineProps<{ name: string }>();
const router = useRouter();
const route = useRoute();
const key = computed(() => pageKey(props.name));
const page = computed(() => pages.get(key.value));
const isToday = computed(() => key.value === journalName(new Date()));
const title = computed(() => (isJournalKey(key.value) ? journalTitle(key.value) : (page.value?.name ?? props.name)));

// Clicking the title renames the page (journal pages are named after their date, so they can't be).
const canRename = computed(() => page.value !== undefined && !isJournalKey(key.value));
const renaming = ref(false);
const draft = ref("");
const error = ref("");
const input = ref<HTMLInputElement>();

async function startRename(): Promise<void> {
  if (!canRename.value) return;
  draft.value = page.value!.name;
  error.value = "";
  renaming.value = true;
  await nextTick();
  input.value?.select();
}

async function finishRename(): Promise<void> {
  if (!renaming.value) return;
  renaming.value = false;
  const from = page.value?.name ?? props.name;
  const to = draft.value.trim();
  if (!to || to === from) return;
  error.value = pageNameProblem(to) ?? "";
  if (error.value) return;
  const outcome = await renamePage(from, to);
  if (!outcome.ok) {
    error.value = outcome.error;
    return;
  }
  applyBatchResult(outcome.result); // which takes this view to the new name, see below
}

// /page/Name?block=<id> opens the page at that block (from breadcrumbs and reference headings).
// It waits until the outline has loaded the page in the address: going from one page to another
// reuses this view, and the address changes before the view does. The ?block= goes once it's
// been shown, so the same link works again.
const loaded = ref<string | null>(null); // key of the page the outline last finished loading
watch([loaded, () => route.query.block], async ([loadedKey, block]) => {
  if (typeof block !== "string" || loadedKey !== pageKey(String(route.params.name ?? ""))) return;
  await revealBlock("page", block);
  void router.replace({ query: {} });
});

// When this page is renamed (here, in another tab or on another device), follow it.
watch(lastRename, (rename) => {
  if (rename?.from === key.value) void router.replace({ name: "page", params: { name: rename.to } });
});
</script>

<template>
  <section>
    <input
      v-if="renaming"
      ref="input"
      v-model="draft"
      class="page-title-input"
      aria-label="Page name"
      @keydown.enter.prevent="finishRename"
      @keydown.escape="renaming = false"
      @blur="finishRename"
    />
    <h1 v-else :class="{ renamable: canRename }" :title="canRename ? 'Click to rename' : undefined" @click="startRename">
      {{ title }}
    </h1>
    <p v-if="error" class="error">{{ error }}</p>
    <PageOutline :name="name" view="page" @ready="loaded = $event" />
    <Agenda v-if="isToday" />
    <LinkedRefs :name="name" />
    <UnlinkedRefs :name="name" />
  </section>
</template>
