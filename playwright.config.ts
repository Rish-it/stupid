import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./frontend/tests",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:8031", browserName: "chromium" },
  webServer: {
    command: "npm run preview --workspace @stupid/frontend -- --port 8031 --strictPort",
    url: "http://127.0.0.1:8031",
    reuseExistingServer: false,
  },
});
