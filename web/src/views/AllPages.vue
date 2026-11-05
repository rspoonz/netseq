<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { journalTitle } from "../../../shared/names";
import type { PageSummary } from "../../../shared/types";
import { fetchRecentPages } from "../api";
import { useLiveData } from "../outliner/liveData";
import { pages, pagesLoaded } from "../store";

// Opens on the named pages changed most recently, because a list of every page stops being useful
// once there are hundreds (journal days are left out: the Journals tab has them). Typing in the
// filter, or "Show all", lists every page from the list the app already keeps up to date: named
// pages A–Z, then journal days newest first, so the dates don't crowd out the rest. One filter
// covers both; for a day it matches the date and weekday as shown ("2026-11", "tue").
const filter = ref("");
const showAll = ref(false);
const all = computed(() => [...pages.values()]);
const named = computed(() => all.value.filter((page) => page.journal_day === null).sort((a, b) => (a.key < b.key ? -1 : 1)));
const days = computed(() => all.value.filter((page) => page.journal_day !== null).sort((a, b) => b.journal_day! - a.journal_day!));

// Reloaded a moment after any change, here or on another device.
const { data: recentData, failed: recentFailed, load } = useLiveData({ view: () => "all-pages", fetch: fetchRecentPages, groups: () => [] });
void load();
const recent = computed(() => (recentData.value ?? []).map((page) => pages.get(page.key) ?? page)); // a rename shows straight away

const words = computed(() => filter.value.normalize("NFC").toLowerCase().split(/\s+/).filter(Boolean));
// Every page once you filter or ask for it, and when nothing has been written on a named page yet.
const listAll = computed(() => showAll.value || words.value.length > 0 || recentData.value?.length === 0);
function matches(page: PageSummary): boolean {
  const text = page.journal_day === null ? page.key : journalTitle(page.name).toLowerCase();
  return words.value.every((word) => text.includes(word));
}
const shownNamed = computed(() => named.value.filter(matches));
const shownDays = computed(() => days.value.filter(matches));

function count(shown: number, total: number, one: string, many: string): string {
  const noun = total === 1 ? one : many;
  return words.value.length > 0 ? `${shown} of ${total} ${noun}` : `${total} ${noun}`;
}
</script>

<template>
  <section>
    <p v-if="!pagesLoaded" class="muted">Loading…</p>
    <p v-else-if="all.length === 0" class="muted">No pages yet.</p>
    <template v-else>
      <input v-model="filter" class="page-filter" type="search" placeholder="Filter" aria-label="Filter pages" autocomplete="off" />
      <p class="muted page-count">
        {{ count(shownNamed.length, named.length, "page", "pages") }},
        {{ count(shownDays.length, days.length, "journal day", "journal days") }}
      </p>
      <template v-if="!listAll">
        <h2 class="page-section">Recently changed</h2>
        <p v-if="recentFailed && recentData === null" class="error">Couldn't load the recently changed pages.</p>
        <p v-else-if="recentData === null" class="muted">Loading…</p>
        <template v-else>
          <ul class="page-list recent-pages">
            <li v-for="page in recent" :key="page.key">
              <RouterLink :to="{ name: 'page', params: { name: page.name } }">{{ page.name }}</RouterLink>
            </li>
          </ul>
          <button type="button" class="outline-button" @click="showAll = true">Show all</button>
        </template>
      </template>
      <template v-else>
        <ul v-if="shownNamed.length > 0" class="page-list">
          <li v-for="page in shownNamed" :key="page.key">
            <RouterLink :to="{ name: 'page', params: { name: page.name } }">{{ page.name }}</RouterLink>
          </li>
        </ul>
        <template v-if="shownDays.length > 0">
          <h2 class="page-section">Journal days</h2>
          <ul class="page-list days">
            <li v-for="page in shownDays" :key="page.key">
              <RouterLink :to="{ name: 'page', params: { name: page.name } }">{{ journalTitle(page.name) }}</RouterLink>
            </li>
          </ul>
        </template>
      </template>
    </template>
  </section>
</template>
