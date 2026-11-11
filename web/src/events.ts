import { ref } from "vue";
import type { BatchResult, FavouritesChange } from "../../shared/types";
import { applyFavouritesChange } from "./favourites";
import { applyBatchResult, requestRefresh } from "./store";

// Live updates from the server. EventSource reconnects by itself, but events sent while we were
// away aren't replayed, so after any gap (or when the tab comes back into view) views reload
// what they show. `live` says whether the stream is connected (the top bar shows "Offline"
// when it isn't); so does <html data-live="on|off">, for the tests.

export const live = ref(true); // assumed until the first error, so loading the app doesn't flash "Offline"

export function startLiveUpdates(): void {
  let source: EventSource | undefined;
  let missedEvents = false;

  const connect = () => {
    source = new EventSource("/api/events");
    source.addEventListener("change", (event) => {
      applyBatchResult(JSON.parse((event as MessageEvent<string>).data) as BatchResult);
    });
    source.addEventListener("favourites", (event) => {
      applyFavouritesChange(JSON.parse((event as MessageEvent<string>).data) as FavouritesChange);
    });
    source.onopen = () => {
      live.value = true;
      document.documentElement.dataset.live = "on";
      if (missedEvents) requestRefresh();
      missedEvents = false;
    };
    source.onerror = () => {
      live.value = false;
      document.documentElement.dataset.live = "off";
      missedEvents = true;
      // The browser keeps retrying unless the server refused outright; then try again later.
      if (source?.readyState === EventSource.CLOSED) setTimeout(connect, 5_000);
    };
  };

  connect();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") requestRefresh();
  });
}
