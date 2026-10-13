import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: ".", testMatch: "*.e2e.ts", timeout: 120_000, workers: 1, reporter: "line", use: { browserName: "chromium", headless: true, viewport: { width: 1280, height: 800 } } });
