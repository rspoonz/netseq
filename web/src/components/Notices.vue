<script setup lang="ts">
import { dismiss, historyFor, notices } from "../notices";

function view(id: number, block: string): void {
  historyFor.value = block;
  dismiss(id);
}
</script>

<template>
  <div class="notices" aria-live="polite">
    <div v-for="notice in notices" :key="notice.id" class="notice">
      <span>{{ notice.text }}</span>
      <button v-if="notice.block" type="button" @click="view(notice.id, notice.block)">View</button>
      <button type="button" aria-label="Dismiss" @click="dismiss(notice.id)">✕</button>
    </div>
  </div>
</template>
