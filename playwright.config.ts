import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./frontend/tests",
  fullyParallel: true,
  workers: process.env.CI ? 4 : 3,
  use: { baseURL: "http://127.0.0.1:8031", browserName: "chromium" },
  webServer: [{
    command: "npm run preview --workspace @stupid/frontend -- --port 8031 --strictPort",
    url: "http://127.0.0.1:8031",
    reuseExistingServer: false,
  }, {
    command: "npm run dev --workspace @stupid/frontend -- --port 8032 --strictPort",
    url: "http://127.0.0.1:8032",
    reuseExistingServer: false,
  }],
});
