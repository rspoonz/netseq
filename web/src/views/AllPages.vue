<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { journalName, journalTitle } from "../../../shared/names";
import { fetchRecentPages } from "../api";
import { useLiveData } from "../outliner/liveData";
import { pages } from "../store";

// Every named page, the most recently changed first, more as you scroll, set like the notes on
// the Journals tab (the same bullets and line height). The day each last changed is beside it
// where there's room, so not on a phone. There's nothing to filter with here: search (Ctrl+K)
// finds a page by name from anywhere. However far you've scrolled, a reload is one request for
// the pages on screen.

const BATCH = 50;
const limit = ref(BATCH);
const sentinel = ref<HTMLElement>();
const { data, failed, load } = useLiveData({ view: () => "all-pages", fetch: () => fetchRecentPages(limit.value), groups: () => [] });
// A rename shows straight away, from the list the app keeps up to date.
const list = computed(() => (data.value ?? []).map((page) => ({ ...page, name: pages.get(page.key)?.name ?? page.name })));
const more = computed(() => data.value !== null && data.value.length >= limit.value);

/** The day a page last changed, written like a journal day. */
function day(changed: number): string {
  return journalTitle(journalName(new Date(changed)));
}

let loadingMore = false;

async function loadMore(): Promise<void> {
  if (loadingMore || !more.value || failed.value) return;
  loadingMore = true;
  limit.value += BATCH;
  await load();
  loadingMore = false;
  await fill();
}

// The observer only fires on changes, so keep going while the end of the list is still in view.
async function fill(): Promise<void> {
  await nextTick();
  if (sentinel.value && sentinel.value.getBoundingClientRect().top < window.innerHeight) void loadMore();
}

async function retry(): Promise<void> {
  await load();
  await fill();
}

let observer: IntersectionObserver | undefined;

onMounted(async () => {
  observer = new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) void loadMore();
  });
  if (sentinel.value) observer.observe(sentinel.value);
  await retry();
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <p v-if="failed && data === null" class="error">Couldn't load the pages.</p>
  <p v-else-if="data === null" class="muted">Loading…</p>
  <p v-else-if="list.length === 0" class="muted">No pages yet.</p>
  <template v-else>
    <ul class="page-list">
      <li v-for="page in list" :key="page.key">
        <RouterLink :to="{ name: 'page', params: { name: page.name } }">{{ page.name }}</RouterLink>
        <time :datetime="new Date(page.changed).toISOString()">{{ day(page.changed) }}</time>
      </li>
    </ul>
    <p v-if="failed" class="error">
      Couldn't load more pages.
      <button type="button" class="outline-button" @click="retry">Try again</button>
    </p>
  </template>
  <div ref="sentinel" class="journal-end" />
</template>
