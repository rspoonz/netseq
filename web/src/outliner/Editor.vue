<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { journalName, journalTitle, pageKey } from "../../../shared/names";
import type { SearchHit } from "../../../shared/types";
import { fetchSearch } from "../api";
import { flush } from "../outbox";
import { editing, isPlacingCaret, outline, pages, startEditing, stopEditing } from "../store";
import { clearActiveEditor, setActiveEditor } from "./active";
import { applyCompletion, matchPages, type RefQuery, refQueryAt } from "./autocomplete";
import { caretCoordinates, caretLine } from "./caret";
import { insertOutline, looksLikeOutline, parseOutline } from "./clipboard";
import * as intents from "./intents";
import { type Command, keyCommand } from "./keymap";
import { topKey } from "./outline";
import { blocksOnScreen, selectBlock } from "./selection";
import { applySlash, matchCommands, type SlashCommand, type SlashQuery, slashQueryAt } from "./slash";
import { commit, redo, undo } from "./undo";

// The block being edited: a plain textarea with the raw text (Logseq's approach). Keys that
// mean something to the outline become commands; everything else is ordinary typing. Typing
// [[ or # offers matching page names, (( searches for a block to reference, and / offers commands.

const props = defineProps<{ id: string; view: string; scope: string | null }>();
const wrap = ref<HTMLElement>();
const textarea = ref<HTMLTextAreaElement>();
const content = computed(() => outline.get(props.id)?.content ?? "");
let shiftEnter = false;

// --- Suggestions: page names after [[ or #, blocks after ((, commands after / -------------

interface Suggestion {
  key: string;
  label: string;
  note: string; // shown before the label
  pick(): void;
}

const completion = ref<RefQuery | null>(null);
const slash = ref<SlashQuery | null>(null);
const active = ref(0);
const popup = ref({ top: 0, left: 0 });

// Blocks matching what's typed after ((, searched on the server.
const blockHits = ref<SearchHit[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let latestSearch = 0;
watch(
  () => (completion.value?.kind === "block" ? completion.value.query.trim() : ""),
  (query) => {
    clearTimeout(searchTimer);
    if (!query) {
      blockHits.value = [];
      return;
    }
    searchTimer = setTimeout(async () => {
      const call = ++latestSearch;
      const hits = await fetchSearch(query).catch(() => []);
      if (call === latestSearch) blockHits.value = hits.filter((hit) => hit.id !== props.id).slice(0, 10);
    }, 150);
  },
);

const suggestions = computed((): Suggestion[] => {
  const q = completion.value;
  if (q?.kind === "block") {
    return blockHits.value.map((hit) => ({
      key: hit.id,
      label: hit.text,
      note: `${journalTitle(hit.page.name)} · `,
      pick: () => choose(hit.id),
    }));
  }
  if (q) {
    const names = matchPages([...pages.values()].map((page) => page.name), q.query);
    const typed = q.query.trim();
    if (typed && !names.some((name) => pageKey(name) === pageKey(typed))) names.push(typed); // a new page
    return names.map((name) => ({ key: name, label: name, note: isNewPage(name) ? "New page: " : "", pick: () => choose(name) }));
  }
  if (slash.value) {
    return matchCommands(slash.value.query).map((command) => ({
      key: command.label,
      label: command.label,
      note: "",
      pick: () => runSlash(command),
    }));
  }
  return [];
});

// The list can shrink under the highlight (block search results arrive, pages go away).
watch(
  () => suggestions.value.length,
  (count) => {
    if (active.value >= count) active.value = Math.max(0, count - 1);
  },
);

function isNewPage(name: string): boolean {
  return !pages.has(pageKey(name));
}

function updateCompletion(): void {
  const el = textarea.value;
  const collapsed = el !== undefined && el.selectionStart === el.selectionEnd;
  const q = collapsed ? refQueryAt(el.value, el.selectionStart) : null;
  const s = collapsed && !q ? slashQueryAt(el.value, el.selectionStart) : null;
  if (q?.query !== completion.value?.query || q?.kind !== completion.value?.kind || s?.query !== slash.value?.query) {
    active.value = 0;
  }
  completion.value = q;
  slash.value = s;
  if ((q || s) && el) {
    const caret = caretCoordinates(el);
    popup.value = { top: caret.top + caret.height, left: caret.left };
  }
}

function closeSuggestions(): void {
  completion.value = null;
  slash.value = null;
}

/** Puts the chosen page name, or block id, in place of what was typed. */
function choose(name: string): void {
  const el = textarea.value;
  const q = completion.value;
  if (!el || !q) return;
  const { text, caret: offset } = applyCompletion(el.value, q, name);
  const change = intents.setContent(outline, props.id, text);
  if (change) commit(change, caret(), { typing: true });
  completion.value = null;
  startEditing(props.view, props.id, offset);
}

function handleSuggestionKey(event: KeyboardEvent): boolean {
  const count = suggestions.value.length;
  if (count === 0) return false;
  switch (event.key) {
    case "ArrowDown":
      active.value = (active.value + 1) % count;
      return true;
    case "ArrowUp":
      active.value = (active.value - 1 + count) % count;
      return true;
    case "Enter":
    case "Tab":
      suggestions.value[active.value].pick();
      return true;
    case "Escape":
      closeSuggestions();
      return true;
  }
  return false;
}

// --- Slash commands ---------------------------------------------------------------------------

// A command that needs a date first shows a date field in the popup. Focus moves there, so blurs
// into the popup don't count as leaving the editor (see onBlur).
const dating = ref<{ q: SlashQuery; command: SlashCommand } | null>(null);
const day = ref("");
const dateInput = ref<HTMLInputElement>();

async function runSlash(command: SlashCommand): Promise<void> {
  const q = slash.value;
  if (!q) return;
  slash.value = null;
  if ("date" in command) {
    dating.value = { q, command };
    day.value = journalName(new Date());
    await nextTick();
    dateInput.value?.focus();
    return;
  }
  finishSlash(q, command);
}

function finishSlash(q: SlashQuery, command: SlashCommand, date = ""): void {
  const el = textarea.value;
  if (!el) return;
  const { text, caret: offset } = applySlash(el.value, q, command, date);
  const change = intents.setContent(outline, props.id, text);
  if (change) commit(change, caret());
  startEditing(props.view, props.id, offset);
}

function confirmDate(): void {
  const pending = dating.value;
  if (!pending || !day.value) return;
  textarea.value?.focus(); // first, so the date field's blur isn't taken for leaving the editor
  dating.value = null;
  finishSlash(pending.q, pending.command, day.value);
}

function cancelDate(): void {
  const pending = dating.value;
  const el = textarea.value;
  if (!pending || !el) return;
  el.focus();
  dating.value = null;
  // Drop the typed "/command".
  const change = intents.setContent(outline, props.id, el.value.slice(0, pending.q.start) + el.value.slice(pending.q.end));
  if (change) commit(change, caret());
  startEditing(props.view, props.id, pending.q.start);
}

function onDateBlur(event: FocusEvent): void {
  if (focusStaysInside(event)) return;
  dating.value = null;
  leave();
}

// --- Editing --------------------------------------------------------------------------------

function autosize(): void {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function placeCaret(): void {
  const el = textarea.value;
  if (!el || editing.id !== props.id || editing.view !== props.view) return;
  if (document.activeElement !== el) el.focus();
  const offset = Math.min(editing.offset, el.value.length);
  el.setSelectionRange(offset, offset);
}

function caret(): intents.Caret {
  return { id: props.id, offset: textarea.value?.selectionStart ?? 0 };
}

function onInput(event: Event): void {
  const el = event.target as HTMLTextAreaElement;
  // Typing "[[" adds the closing "]]", as in Logseq, and so does "((" at the start or after a space.
  const at = el.selectionStart;
  const typed = (event as InputEvent).data;
  const closing =
    typed === "[" && el.value.slice(at - 2, at) === "[[" && !el.value.startsWith("]]", at)
      ? "]]"
      : typed === "(" && el.value.slice(at - 2, at) === "((" && !el.value.startsWith("))", at) && (at === 2 || /\s/.test(el.value[at - 3]))
        ? "))"
        : null;
  if (closing) {
    el.value = `${el.value.slice(0, at)}${closing}${el.value.slice(at)}`;
    el.setSelectionRange(at, at);
  }
  const change = intents.setContent(outline, props.id, el.value);
  if (change) commit(change, caret(), { typing: true });
  autosize();
  updateCompletion();
}

/** Runs a command; returns whether it was handled (and the key's default should be skipped). */
function run(command: Command): boolean {
  const el = textarea.value;
  if (!el) return false;
  const { selectionStart: start, selectionEnd: end } = el;
  switch (command) {
    case "split":
      return apply(intents.split(outline, props.id, start, end, props.scope));
    case "indent":
      return apply(intents.indent(outline, props.id, start, props.scope), true);
    case "outdent":
      return apply(intents.outdent(outline, props.id, start, props.scope), true);
    case "mergePrevious":
      return apply(intents.mergeWithPrevious(outline, props.id, props.scope));
    case "mergeNext":
      return apply(intents.mergeNext(outline, props.id, props.scope));
    case "moveUp":
      return apply(intents.moveUp(outline, props.id, start, props.scope), true);
    case "moveDown":
      return apply(intents.moveDown(outline, props.id, start, props.scope), true);
    case "collapse":
      return apply(intents.setCollapsed(outline, props.id, true, start), true);
    case "expand":
      return apply(intents.setCollapsed(outline, props.id, false, start), true);
    case "focusPrevious":
      return focusBlock(-1);
    case "focusNext":
      return focusBlock(1);
    case "undo":
      undo();
      return true;
    case "redo":
      redo();
      return true;
    case "cycleTask":
      return apply(intents.cycleMarker(outline, props.id, start), true);
    case "select": {
      const { id, view } = props;
      el.blur(); // may remove an empty block, see onBlur
      if (outline.get(id)) selectBlock(view, id);
      return true;
    }
    case "exit":
      el.blur();
      return true;
  }
}

// `swallow`: keys like Tab are handled even when nothing changes, so focus doesn't leave the editor.
function apply(change: intents.Change | null, swallow = false): boolean {
  if (change) commit(change, caret());
  return change !== null || swallow;
}

/** ↑/↓ from the first or last line: the block above or below on screen, in this view. */
function focusBlock(step: 1 | -1): boolean {
  const el = textarea.value;
  const order = blocksOnScreen(props.view);
  const target = outline.get(order[order.indexOf(props.id) + step] ?? "");
  if (!target || !el) return false;
  startEditing(props.view, target.id, intents.columnTarget(el.value, el.selectionStart, target.content, step < 0 ? "up" : "down"));
  return true;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return; // the input method owns this key
  if (handleSuggestionKey(event)) {
    event.preventDefault();
    return;
  }
  const el = textarea.value!;
  shiftEnter = event.key === "Enter" && event.shiftKey;
  const collapsed = el.selectionStart === el.selectionEnd;
  const command = keyCommand(event, {
    collapsed,
    atStart: collapsed && el.selectionStart === 0,
    atEnd: collapsed && el.selectionEnd === el.value.length,
    onFirstLine: () => caretLine(el).first,
    onLastLine: () => caretLine(el).last,
  });
  if (command && run(command)) event.preventDefault();
}

function onKeyup(event: KeyboardEvent): void {
  if (/^(Arrow|Home|End|Page)/.test(event.key)) updateCompletion(); // the caret moved
}

// Mobile keyboards often report Enter and Backspace only as input events, not as keydowns.
// Undo from the browser's menu (or shaking an iPhone) also arrives here.
function onBeforeInput(event: InputEvent): void {
  const el = textarea.value!;
  let command: Command | null = null;
  if (event.inputType === "historyUndo") command = "undo";
  else if (event.inputType === "historyRedo") command = "redo";
  else if (event.inputType === "insertLineBreak" && !shiftEnter && !event.isComposing) command = "split";
  else if (event.inputType === "deleteContentBackward" && el.selectionStart === 0 && el.selectionEnd === 0) {
    command = "mergePrevious";
  }
  shiftEnter = false;
  if (command && run(command)) event.preventDefault();
}

// Pasting a markdown outline ("- one\n  - two") makes blocks; other text is pasted as text.
function onPaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!looksLikeOutline(text)) return;
  event.preventDefault();
  const change = insertOutline(outline, props.id, parseOutline(text), props.scope);
  if (change) commit(change, caret());
}

function focusStaysInside(event: FocusEvent): boolean {
  return event.relatedTarget instanceof Node && wrap.value?.contains(event.relatedTarget) === true;
}

function onBlur(event: FocusEvent): void {
  if (focusStaysInside(event)) return; // into the date field
  closeSuggestions();
  leave();
}

function leave(): void {
  // Skip blurs caused by re-rendering after a command (the caret is put back right after), and
  // blurs after a command already moved the caret to another block.
  if (!isPlacingCaret() && editing.id === props.id && editing.view === props.view) {
    stopEditing();
    removeIfLoneEmptyBlock();
  }
  void flush();
}

// Clicking into an empty page and leaving again shouldn't leave an empty block (or page) behind.
function removeIfLoneEmptyBlock(): void {
  const b = outline.get(props.id);
  if (!b || b.content !== "" || b.parent !== null || outline.childIds(b.id).length > 0) return;
  if (outline.childIds(topKey(b.page)).length === 1) commit({ upserts: [], deletes: [b.id] }, undefined, { record: false });
}

onMounted(() => {
  autosize();
  placeCaret();
  setActiveEditor(run);
});
onBeforeUnmount(() => {
  clearActiveEditor(run);
  clearTimeout(searchTimer);
});
watch(() => editing.seq, () => nextTick(placeCaret));
watch(content, (value) => {
  const el = textarea.value;
  if (el && el.value !== value && document.activeElement === el) {
    // Another tab or device changed this block while it's open here (we had no unsent edits):
    // keep the caret where it was, as far as the new text allows.
    const { selectionStart, selectionEnd } = el;
    void nextTick(() => el.setSelectionRange(Math.min(selectionStart, el.value.length), Math.min(selectionEnd, el.value.length)));
  }
  void nextTick(autosize);
});
</script>

<template>
  <div ref="wrap" class="block-editor-wrap">
    <textarea
      ref="textarea"
      class="block-editor"
      rows="1"
      :value="content"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="onKeyup"
      @click="updateCompletion"
      @beforeinput="onBeforeInput"
      @paste="onPaste"
      @blur="onBlur"
    />
    <div v-if="dating" class="ref-popup date-popup" :style="{ top: `${popup.top}px`, left: `${popup.left}px` }">
      <input
        ref="dateInput"
        v-model="day"
        type="date"
        :aria-label="dating.command.label"
        @keydown.enter.prevent="confirmDate"
        @keydown.escape.prevent="cancelDate"
        @blur="onDateBlur"
      />
      <button type="button" @click="confirmDate" @blur="onDateBlur">Insert</button>
    </div>
    <ul
      v-else-if="suggestions.length > 0"
      class="ref-popup"
      :class="{ blocks: completion?.kind === 'block' }"
      role="listbox"
      :aria-label="completion ? (completion.kind === 'block' ? 'Blocks' : 'Pages') : 'Commands'"
      :style="{ top: `${popup.top}px`, left: `${popup.left}px` }"
    >
      <li
        v-for="(item, index) in suggestions"
        :key="item.key"
        role="option"
        :aria-selected="index === active"
        :class="{ active: index === active }"
        @mousedown.prevent="item.pick()"
      >
        <span v-if="item.note" class="muted">{{ item.note }}</span>{{ item.label }}
      </li>
    </ul>
  </div>
</template>
