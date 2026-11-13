<script setup lang="ts">
import { RouterLink } from "vue-router";
import { firstLine, plainText, PRIORITY } from "../../../shared/blocktext";
import { journalTitle } from "../../../shared/names";
import type { Crumb } from "../../../shared/types";

// A breadcrumb trail of ancestor blocks, each linking to that block zoomed in. With `page`, the
// trail starts with the page, which opens at block `page.at`. `landmark`: this is the view's own
// trail (a navigation landmark), rather than one of many in a list.
defineProps<{ path: Crumb[]; page?: { name: string; at: string }; landmark?: boolean }>();

/** The block's first line as plain text (see firstLine), without its priority: a trail can't show the badge. */
function label(content: string): string {
  const line = plainText(firstLine(content).replace(PRIORITY, "")).replace(/\s+/g, " ").trim();
  return line.length > 40 ? `${line.slice(0, 40)}…` : line || "…";
}
</script>

<template>
  <component
    :is="landmark ? 'nav' : 'div'"
    v-if="page || path.length > 0"
    class="crumbs"
    :aria-label="landmark ? 'Breadcrumbs' : undefined"
  >
    <RouterLink
      v-if="page"
      class="crumb-page"
      :to="{ name: 'page', params: { name: page.name }, query: { block: page.at } }"
      title="Open the page at this block"
    >
      {{ journalTitle(page.name) }}
    </RouterLink>
    <template v-for="(crumb, index) in path" :key="crumb.id">
      <span v-if="index > 0 || page" class="crumb-separator">›</span>
      <RouterLink :to="{ name: 'block', params: { id: crumb.id } }">{{ label(crumb.content) }}</RouterLink>
    </template>
  </component>
</template>
