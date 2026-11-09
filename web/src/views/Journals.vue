<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { dayNumber, journalName, journalTitle } from "../../../shared/names";
import { fetchJournalDays, fetchJournals } from "../api";
import Agenda from "../outliner/Agenda.vue";
import { isBlank } from "../outliner/intents";
import PageOutline from "../outliner/PageOutline.vue";
import { applyPageData, refreshes } from "../store";

// Today's journal, then older days that have something written, five at a time as you scroll.
// This view loads the days itself (their outlines don't), so reloading after missed live updates
// is one request however far you've scrolled. Each reload also notices when a new day has
// begun, and so does a timer set for midnight.

const BATCH = 5;
const today = ref(journalName(new Date()));
const older = ref<string[]>([]);
const status = ref<"loading" | "ready" | "error">("loading");
const sentinel = ref<HTMLElement>();
const finished = ref(false);
const moreFailed = ref(false); // loading older days failed: says so, with Try again
let loadingMore = false;

/** Reloads every day on screen in one request. */
async function reload(): Promise<void> {
  const now = journalName(new Date());
  if (now !== today.value) {
    older.value.unshift(today.value); // yesterday moves down (and drops out below if nothing's on it)
    today.value = now;
  }
  try {
    const names = [today.value, ...older.value];
    const days = await fetchJournalDays(names);
    names.forEach((name, i) => applyPageData(name, days[i]));
    // Today always shows; an older day whose blocks were all deleted (or blanked) elsewhere drops out. (By
    // name: more days may have loaded while this request was out.)
    const emptied = new Set(names.filter((name, i) => i > 0 && days[i].blocks.every((b) => isBlank(b.content))));
    older.value = older.value.filter((name) => !emptied.has(name));
    status.value = "ready";
    if (moreFailed.value) retryMore(); // back online
  } catch {
    if (status.value === "loading") status.value = "error";
  }
}

async function loadMore(): Promise<void> {
  if (loadingMore || finished.value || moreFailed.value || status.value !== "ready") return;
  loadingMore = true;
  try {
    const days = await fetchJournals(dayNumber(older.value.at(-1) ?? today.value), BATCH);
    for (const day of days) {
      if (!day.page) continue;
      applyPageData(day.page.key, day);
      older.value.push(day.page.name);
    }
    if (days.length < BATCH) finished.value = true;
  } catch {
    moreFailed.value = true;
  } finally {
    loadingMore = false;
  }
  // The observer only fires on changes, so keep going while the end of the list is still in view.
  await nextTick();
  if (sentinel.value && sentinel.value.getBoundingClientRect().top < window.innerHeight) void loadMore();
}

function retryMore(): void {
  moreFailed.value = false;
  void loadMore();
}

let observer: IntersectionObserver | undefined;
let midnight: ReturnType<typeof setTimeout> | undefined;

function waitForMidnight(): void {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  midnight = setTimeout(() => {
    void reload();
    waitForMidnight();
  }, next.getTime() - now.getTime());
}

watch(refreshes, reload);
onMounted(async () => {
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void loadMore();
  });
  if (sentinel.value) observer.observe(sentinel.value);
  waitForMidnight();
  await reload();
  void loadMore();
});
onBeforeUnmount(() => {
  observer?.disconnect();
  clearTimeout(midnight);
});
</script>

<template>
  <p v-if="status === 'loading'" class="muted">Loading…</p>
  <p v-else-if="status === 'error'" class="error">Couldn't load the journals.</p>
  <template v-else>
    <section v-for="name in [today, ...older]" :key="name" class="journal-day">
      <h2>
        <RouterLink :to="{ name: 'page', params: { name } }">{{ journalTitle(name) }}</RouterLink>
      </h2>
      <PageOutline :name="name" view="journals" :load="false" />
      <Agenda v-if="name === today" />
    </section>
    <p v-if="moreFailed" class="error">
      Couldn't load older days.
      <button type="button" class="outline-button" @click="retryMore">Try again</button>
    </p>
  </template>
  <div ref="sentinel" class="journal-end" />
</template>
