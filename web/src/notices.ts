import { reactive, ref } from "vue";

// Short messages at the bottom of the screen, and which block's history panel is open.

export interface Notice {
  id: number;
  text: string;
  block?: string; // offers "View" to open this block's history
}

export const notices = reactive<Notice[]>([]);
export const historyFor = ref<string | null>(null);

const SHOW_MS = 15_000;
let nextId = 1;

export function notify(text: string, block?: string): void {
  const notice = { id: nextId++, text, block };
  notices.push(notice);
  setTimeout(() => dismiss(notice.id), SHOW_MS);
}

export function dismiss(id: number): void {
  const index = notices.findIndex((notice) => notice.id === id);
  if (index !== -1) notices.splice(index, 1);
}
