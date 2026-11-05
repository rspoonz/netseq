import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the built app on its own port, with a fresh database per run.
// Files are named *.e2e.ts so `bun test` (which picks up *.test.* and *.spec.*) leaves them alone.
const PORT = 8099;

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  workers: 1, // one server and one database
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `rm -rf e2e/.data && bun run build && NETSEQ_DATA=e2e/.data PORT=${PORT} bun server/main.ts`,
    url: `http://127.0.0.1:${PORT}/api/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: "**/mobile.e2e.ts" },
    { name: "phone", use: { ...devices["Pixel 7"] }, testMatch: "**/mobile.e2e.ts" },
  ],
});
