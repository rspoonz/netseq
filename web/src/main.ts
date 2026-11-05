import { createApp, watch } from "vue";
import App from "./App.vue";
import { startLiveUpdates } from "./events";
import { notify } from "./notices";
import * as outbox from "./outbox";
import { router } from "./router";
import { applyBatchResult, forgetRefTargets, loadPageList, refreshes } from "./store";
import "./style.css";

outbox.onResult((result) => {
  applyBatchResult(result);
  for (const { block, device } of result.overwrote) {
    notify(`Your edit replaced text written on ${device ?? "another device"}.`, block);
  }
});
outbox.start();
startLiveUpdates();
void loadPageList();
watch(refreshes, () => {
  void loadPageList().catch(() => {});
  forgetRefTargets();
});
createApp(App).use(router).mount("#app");
