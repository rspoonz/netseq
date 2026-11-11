import { computed, reactive } from "vue";

// The sidebar (favourites). On a wide window it sits beside the notes and stays as you left it;
// on a narrow one (a phone) it slides over them, and closes when you pick something.

const media = window.matchMedia("(min-width: 60rem)"); // the same width as in style.css
const KEY = "netseq.sidebar";

function remembered(): boolean {
  try {
    return localStorage.getItem(KEY) !== "closed";
  } catch {
    return true; // storage is blocked: open, and not remembered
  }
}

const state = reactive({ wide: media.matches, pinned: remembered(), drawer: false });

media.addEventListener("change", (event) => {
  state.wide = event.matches;
  state.drawer = false;
});

export const sidebarOpen = computed(() => (state.wide ? state.pinned : state.drawer));

/** Whether the sidebar is open over the notes, rather than beside them. */
export const drawerOpen = computed(() => !state.wide && state.drawer);

export function toggleSidebar(): void {
  if (!state.wide) {
    state.drawer = !state.drawer;
    return;
  }
  state.pinned = !state.pinned;
  try {
    localStorage.setItem(KEY, state.pinned ? "open" : "closed");
  } catch {
    // not remembered
  }
}

export function closeDrawer(): void {
  state.drawer = false;
}
