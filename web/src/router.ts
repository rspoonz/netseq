import { createRouter, createWebHistory } from "vue-router";
import AllPages from "./views/AllPages.vue";
import Journals from "./views/Journals.vue";
import Page from "./views/Page.vue";
import Zoom from "./views/Zoom.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "journals", component: Journals },
    { path: "/page/:name", name: "page", component: Page, props: true },
    { path: "/pages", name: "pages", component: AllPages },
    { path: "/b/:id", name: "block", component: Zoom, props: true },
  ],
});
