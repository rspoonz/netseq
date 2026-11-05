import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [vue()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    // The Bun server handles the API; `bun run dev` starts both.
    proxy: { "/api": "http://127.0.0.1:8080" },
  },
});
