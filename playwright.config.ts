import { defineConfig } from "@playwright/test";
import { ageConfirmed } from "./e2e/age-confirmed";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:4173",
    storageState: ageConfirmed("http://127.0.0.1:4173"),
    launchOptions: process.env["PLAYWRIGHT_CHROMIUM_PATH"]
      ? { executablePath: process.env["PLAYWRIGHT_CHROMIUM_PATH"] }
      : {},
  },
  webServer: {
    command: "bun run dev --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
