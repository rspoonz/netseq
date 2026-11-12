<script setup lang="ts">
import { computed, inject, ref, watchEffect } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { renderBlock } from "../../../shared/markdown";
import { pageKey } from "../../../shared/names";
import { blockRefsIn, queriesIn } from "../../../shared/refs";
import { blockText, editing, outline, requestBlocks, softLinkTargets, startEditing } from "../store";
import BlockRefs from "./BlockRefs.vue";
import { textBeforePoint } from "./caret";
import Editor from "./Editor.vue";
import { rawOffset, setCollapsed, toggleDone } from "./intents";
import { INSIDE_QUERY } from "./liveData";
import { openBulletMenu } from "./menu";
import { revealed } from "./reveal";
import QueryResults from "./QueryResults.vue";
import { isSelected } from "./selection";
import { commit } from "./undo";

// One block with its children. Renders itself recursively (an SFC can use its own file name).
// `scope`: the block at the top of a view that shows one block with everything under it (see
// intents.ts); edits never reach outside it.
const props = defineProps<{ id: string; view: string; scope?: string | null }>();
const router = useRouter();
const route = useRoute();
const block = computed(() => outline.get(props.id));
const children = computed(() => outline.childIds(props.id));
const isEditing = computed(() => editing.view === props.view && editing.id === props.id);
const selected = computed(() => isSelected(props.view, props.id));
const flashing = computed(() => revealed.view === props.view && revealed.id === props.id);
// Links to the page being viewed are marked aria-current="page", which screen readers announce.
const here = computed(() => (route.name === "page" ? pageKey(String(route.params.name ?? "")) : undefined));
const html = computed(() => renderBlock(block.value?.content ?? "", blockText, here.value, softLinkTargets.value));
// Fetch the text of referenced blocks we don't have yet.
watchEffect(() => {
  const unknown = blockRefsIn(block.value?.content ?? "").filter((target) => blockText(target) === undefined);
  if (unknown.length > 0) requestBlocks(unknown);
});
const showRefs = ref(false); // the blocks referencing this one, opened from its count
// Blocks inside query results show their queries as text only (two queries could find each other forever).
const insideQuery = inject(INSIDE_QUERY, false);
const queries = computed(() => (insideQuery ? [] : queriesIn(block.value?.content ?? "")));

function onContentClick(event: MouseEvent): void {
  const b = block.value;
  if (!b) return;
  const target = event.target as Element;
  if (target instanceof HTMLInputElement && target.classList.contains("task-check")) {
    event.preventDefault(); // the checkbox shows the new state once the block re-renders
    const change = toggleDone(outline, b.id);
    if (change) commit(change);
    return;
  }
  const link = target.closest<HTMLAnchorElement>("a");
  if (link) {
    // Links to pages and blocks open inside the app, unless a modifier key asks the browser for a
    // new tab or window (as RouterLink does). Other links are left to the browser.
    const { page, blockRef } = link.dataset;
    const modified = event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0;
    if ((page !== undefined || blockRef !== undefined) && !modified) {
      event.preventDefault();
      void router.push(page !== undefined ? { name: "page", params: { name: page } } : { name: "block", params: { id: blockRef } });
    }
    return;
  }
  const shown = textBeforePoint(event.currentTarget as HTMLElement, event.clientX, event.clientY);
  startEditing(props.view, props.id, shown === null ? b.content.length : rawOffset(b.content, shown));
}

function toggle(): void {
  const b = block.value;
  const change = b && setCollapsed(outline, b.id, !b.collapsed);
  if (change) commit(change);
}
</script>

<template>
  <div v-if="block" class="block">
    <div class="block-row" :class="{ selected, revealed: flashing }" :data-block="id" :data-view="view" :data-scope="scope ?? undefined">
      <button
        v-if="children.length > 0"
        type="button"
        class="block-toggle"
        :class="{ collapsed: block.collapsed }"
        :aria-label="block.collapsed ? 'Expand' : 'Collapse'"
        :aria-expanded="!block.collapsed"
        @click="toggle"
      >
        ▾
      </button>
      <RouterLink
        class="block-bullet"
        :class="{ collapsed: block.collapsed && children.length > 0 }"
        :to="{ name: 'block', params: { id } }"
        aria-label="Zoom in"
        @contextmenu.prevent="openBulletMenu(id, $event.clientX, $event.clientY)"
      />
      <Editor v-if="isEditing" :id="id" :view="view" :scope="scope ?? null" />
      <!-- The HTML comes from markdown-it with raw HTML disabled, see shared/markdown.ts. -->
      <div v-else class="block-content" @click="onContentClick" v-html="html" />
      <button
        v-if="block.ref_count"
        type="button"
        class="ref-count"
        :aria-expanded="showRefs"
        :aria-label="`Referenced by ${block.ref_count} ${block.ref_count === 1 ? 'block' : 'blocks'}`"
        :title="`Referenced by ${block.ref_count} ${block.ref_count === 1 ? 'block' : 'blocks'}`"
        @click="showRefs = !showRefs"
      >
        {{ block.ref_count }}
      </button>
    </div>
    <BlockRefs v-if="showRefs && block.ref_count" :id="id" />
    <QueryResults v-for="(query, index) in queries" :key="index" :query="query" :block="id" />
    <div v-if="children.length > 0 && !block.collapsed" class="block-children">
      <Block v-for="child in children" :id="child" :key="child" :view="view" :scope="scope" />
    </div>
  </div>
</template>
