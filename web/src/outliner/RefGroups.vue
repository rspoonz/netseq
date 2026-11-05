<script setup lang="ts">
import type { RefGroup } from "../../../shared/types";
import Block from "./Block.vue";
import Crumbs from "./Crumbs.vue";

// Blocks shown away from their page, under the same breadcrumb as a zoomed-in block (their page,
// which opens at the first of them, then the blocks they sit inside), editable in place. Blocks
// that follow each other with the same breadcrumb share it. Blocks from one page stay together,
// in the order the server sends them.
defineProps<{ groups: RefGroup[]; view: string }>();

/** The group's blocks in runs of neighbours with the same breadcrumb. */
function runs(group: RefGroup): string[][] {
  const trail = (root: string) => (group.paths[root] ?? []).map((crumb) => crumb.id).join("/");
  const result: string[][] = [];
  for (const root of group.roots) {
    const last = result.at(-1);
    if (last && trail(last[0]) === trail(root)) last.push(root);
    else result.push([root]);
  }
  return result;
}
</script>

<template>
  <div v-for="group in groups" :key="group.page.key" class="ref-group">
    <div v-for="run in runs(group)" :key="run[0]" class="ref-root">
      <Crumbs :path="group.paths[run[0]]" :page="{ name: group.page.name, at: run[0] }" />
      <div class="outline">
        <Block v-for="root in run" :id="root" :key="root" :view="view" :scope="root" />
      </div>
    </div>
  </div>
</template>
