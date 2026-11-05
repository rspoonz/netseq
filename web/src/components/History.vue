<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { HistoryEntry } from "../../../shared/types";
import { getJSON } from "../api";
import { historyFor } from "../notices";
import { setContent } from "../outliner/intents";
import { commit } from "../outliner/undo";
import { outline } from "../store";

// Earlier versions of one block: text that another tab, device or an agent replaced. Restoring
// one is an ordinary (undoable) edit.

const entries = ref<HistoryEntry[] | null>(null);
const failed = ref(false);
const current = computed(() => (historyFor.value ? outline.get(historyFor.value) : undefined));

watch(
  historyFor,
  async (id) => {
    entries.value = null;
    failed.value = false;
    if (!id) return;
    try {
      entries.value = await getJSON<HistoryEntry[]>(`/api/blocks/${encodeURIComponent(id)}/history`);
    } catch {
      failed.value = true;
    }
  },
  { immediate: true },
);

function restore(entry: HistoryEntry): void {
  const change = historyFor.value ? setContent(outline, historyFor.value, entry.content) : null;
  if (change) commit(change);
  historyFor.value = null;
}
</script>

<template>
  <div v-if="historyFor" class="history" role="dialog" aria-label="Earlier versions">
    <div class="history-header">
      <h2>Earlier versions</h2>
      <button type="button" @click="historyFor = null">Close</button>
    </div>
    <p class="muted history-about">Text another tab, device or an agent replaced. Kept for 30 days.</p>
    <p v-if="current" class="history-now">
      <span class="muted">Now</span>
      <span class="history-text">{{ current.content }}</span>
    </p>
    <p v-if="failed" class="error">Couldn't load the earlier versions.</p>
    <p v-else-if="entries === null" class="muted">Loading…</p>
    <p v-else-if="entries.length === 0" class="muted">No earlier versions.</p>
    <ul v-else class="history-list">
      <li v-for="(entry, index) in entries" :key="index">
        <div class="muted">
          Written on {{ entry.device ?? "an unknown device" }}, replaced {{ new Date(entry.saved_at).toLocaleString() }}
        </div>
        <div class="history-text">{{ entry.content }}</div>
        <button type="button" :disabled="!current" @click="restore(entry)">Restore</button>
      </li>
    </ul>
  </div>
</template>
