import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwind()],
  build: { outDir: "dist", emptyOutDir: true, manifest: true, assetsInlineLimit: 0, modulePreload: { polyfill: false }, sourcemap: false },
  test: { environment: "jsdom", globals: true, include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/setup.ts"] },
});
