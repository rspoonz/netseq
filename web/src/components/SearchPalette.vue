<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { journalTitle, pageKey } from "../../../shared/names";
import type { SearchHit } from "../../../shared/types";
import { fetchSearch } from "../api";
import { favourites } from "../favourites";
import { matchPages } from "../outliner/autocomplete";
import { palette, segments } from "../palette";
import { pages } from "../store";

// Search pages (by name, in the browser) and blocks (by text, on the server). Opening a block
// zooms into it. Before anything is typed it lists the favourites, so Ctrl+K then Enter (or a
// few ↓) opens one. To choose a page for something else (see pickPage) it lists only pages.

type Item = { kind: "favourite" | "page" | "new"; name: string } | { kind: "block"; hit: SearchHit };
const KINDS = { favourite: "Favourite", page: "Page", new: "New page" };

const router = useRouter();
const input = ref<HTMLInputElement>();
const query = ref("");
const hits = ref<SearchHit[]>([]);
const searchFailed = ref(false);
const active = ref(0);
let timer: ReturnType<typeof setTimeout> | undefined;
let latest = 0;

const items = computed((): Item[] => {
  const q = query.value.trim();
  if (!q) return favourites.value.map((page) => ({ kind: "favourite", name: page.name }));
  const names = matchPages([...pages.values()].map((page) => page.name), q, 10);
  const list: Item[] = names.map((name) => ({ kind: "page", name }));
  if (!palette.pick) for (const hit of hits.value) list.push({ kind: "block", hit });
  if (!pages.has(pageKey(q))) list.push({ kind: "new", name: q });
  return list;
});

watch(query, (q) => {
  active.value = 0;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const call = ++latest;
    let failed = false;
    const result = q.trim() && !palette.pick ? await fetchSearch(q).catch(() => ((failed = true), [])) : [];
    if (call === latest) {
      hits.value = result;
      searchFailed.value = failed; // page names still show: they're already in the browser
    }
  }, 150);
});

watch(
  () => palette.open,
  async (open) => {
    if (!open) {
      palette.pick = null; // however it was closed, it opens for searching next time
      return;
    }
    query.value = "";
    hits.value = [];
    await nextTick();
    input.value?.focus();
  },
);

function close(): void {
  palette.open = false;
}

function choose(item: Item): void {
  const pick = palette.pick;
  close();
  if (item.kind === "block") void router.push({ name: "block", params: { id: item.hit.id } });
  else if (pick) pick.choose(item.name);
  else void router.push({ name: "page", params: { name: item.name } });
}

function itemKey(item: Item): string {
  return item.kind === "block" ? `block:${item.hit.id}` : `${item.kind}:${item.name}`;
}

function onKeydown(event: KeyboardEvent): void {
  const count = items.value.length;
  switch (event.key) {
    case "ArrowDown":
      if (count > 0) active.value = (active.value + 1) % count;
      break;
    case "ArrowUp":
      if (count > 0) active.value = (active.value - 1 + count) % count;
      break;
    case "Enter": {
      const item = items.value[active.value];
      if (item) choose(item);
      break;
    }
    case "Escape":
      close();
      break;
    default:
      return;
  }
  event.preventDefault();
}
</script>

<template>
  <div v-if="palette.open" class="palette-backdrop" @mousedown.self="close">
    <div class="palette" role="dialog" :aria-label="palette.pick?.title ?? 'Search'">
      <input
        ref="input"
        v-model="query"
        class="palette-input"
        type="search"
        :placeholder="palette.pick ? `${palette.pick.title}…` : 'Search pages and blocks'"
        :aria-label="palette.pick?.title ?? 'Search'"
        autocomplete="off"
        @keydown="onKeydown"
      />
      <ul v-if="items.length > 0" class="palette-list" role="listbox" aria-label="Results">
        <li
          v-for="(item, index) in items"
          :key="itemKey(item)"
          role="option"
          :aria-selected="index === active"
          :class="{ active: index === active }"
          @mousedown.prevent="choose(item)"
          @mousemove="active = index"
        >
          <template v-if="item.kind === 'block'">
            <span class="palette-kind">{{ journalTitle(item.hit.page.name) }}</span>
            <span class="palette-snippet">
              <template v-for="(part, i) in segments(item.hit.text, item.hit.ranges)" :key="i">
                <mark v-if="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template>
              </template>
            </span>
          </template>
          <template v-else>
            <span class="palette-kind">{{ KINDS[item.kind] }}</span>
            <span>{{ journalTitle(item.name) }}</span>
          </template>
        </li>
      </ul>
      <p v-if="searchFailed" class="error palette-error">Couldn't search blocks.</p>
    </div>
  </div>
</template>
