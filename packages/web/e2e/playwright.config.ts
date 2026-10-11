import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "*.e2e.ts", timeout: 60_000, workers: 1, reporter: "line", use: { browserName: "chromium", headless: true } });
