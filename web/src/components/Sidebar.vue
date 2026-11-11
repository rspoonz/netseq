<script setup lang="ts">
import { nextTick, ref } from "vue";
import { RouterLink } from "vue-router";
import { journalTitle } from "../../../shared/names";
import { favourites, moveFavourite } from "../favourites";
import { closeDrawer, drawerOpen, sidebarOpen } from "../sidebar";

// The favourites, one click away. Drag one to reorder the list, or press Alt+↑ / Alt+↓ on it.

const list = ref<HTMLElement>();
const dragging = ref<number | null>(null);
const dropAt = ref<number | null>(null); // the gap the dragged favourite would land in: 0 = before the first

function onDragStart(index: number, event: DragEvent): void {
  dragging.value = index;
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", favourites.value[index].name);
}

function onDragOver(index: number, event: DragEvent): void {
  if (dragging.value === null) return; // something else is being dragged over the list
  event.preventDefault();
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  dropAt.value = event.clientY < box.top + box.height / 2 ? index : index + 1;
}

function onDrop(): void {
  const [from, gap] = [dragging.value, dropAt.value];
  endDrag();
  if (from !== null && gap !== null) void moveFavourite(from, gap > from ? gap - 1 : gap);
}

function endDrag(): void {
  dragging.value = null;
  dropAt.value = null;
}

async function onKeydown(index: number, event: KeyboardEvent): Promise<void> {
  if (!event.altKey || event.ctrlKey || event.metaKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
  event.preventDefault();
  const to = index + (event.key === "ArrowUp" ? -1 : 1);
  if (to < 0 || to >= favourites.value.length) return;
  void moveFavourite(index, to);
  await nextTick(); // moving the link takes the focus off it
  list.value?.querySelectorAll<HTMLElement>("a")[to]?.focus();
}
</script>

<template>
  <div v-if="drawerOpen" class="sidebar-backdrop" @click="closeDrawer" />
  <aside v-if="sidebarOpen" class="sidebar" aria-label="Favourites">
    <h2>Favourites</h2>
    <p v-if="favourites.length === 0" class="muted sidebar-hint">Star a page (☆ by its title) to keep it here.</p>
    <ul v-else ref="list" class="favourites" @dragleave.self="dropAt = null">
      <li
        v-for="(page, index) in favourites"
        :key="page.key"
        draggable="true"
        :class="{ 'drop-before': dropAt === index, 'drop-after': dropAt === index + 1 && index === favourites.length - 1 }"
        @dragstart="onDragStart(index, $event)"
        @dragover="onDragOver(index, $event)"
        @drop.prevent="onDrop"
        @dragend="endDrag"
      >
        <RouterLink
          :to="{ name: 'page', params: { name: page.name } }"
          draggable="false"
          @click="closeDrawer"
          @keydown="onKeydown(index, $event)"
        >
          {{ journalTitle(page.name) }}
        </RouterLink>
      </li>
    </ul>
  </aside>
</template>
