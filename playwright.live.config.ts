import { defineConfig } from "@playwright/test";

/**
 * LIVE browser tests: real Chromium driving the real app against a real (local) Supabase stack —
 * GoTrue auth, PostgREST + RLS, Realtime over websockets, real Postgres with every migration.
 * Start the stack first: scripts/live-stack/README.md. Run: bunx playwright test -c playwright.live.config.ts
 */
export default defineConfig({
  testDir: "./e2e/live",
  globalSetup: "./e2e/live/global-setup.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  outputDir: "./test-results/live",
  use: {
    baseURL: process.env["LIVE_APP_URL"] ?? "http://127.0.0.1:4173",
    viewport: { width: 1280, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env["PLAYWRIGHT_CHROMIUM_PATH"] ?? "/opt/pw-browsers/chromium",
      args: ["--no-sandbox"],
    },
  },
});
