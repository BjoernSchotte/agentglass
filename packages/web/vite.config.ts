import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
export default defineConfig({
  plugins: [react(), tailwind()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 800, // scripts/size.mjs holds the budgets (gzip)
    manifest: true, assetsInlineLimit: 0, modulePreload: { polyfill: false }, sourcemap: false,
    // each chart library its own viz-* chunk (size.mjs: ≤ 250 KB each, outside the route budgets); only libraries without
    // dependencies shared with the app here (echarts takes zrender along, and tslib, which rollup places) — a chunk that takes shared modules along becomes a static import of the shell
    rollupOptions: { output: { manualChunks: (id: string) => (id.includes("/node_modules/uplot/") ? "viz-uplot"
      : id.includes("/node_modules/echarts/") || id.includes("/node_modules/zrender/") ? "viz-echarts" : undefined) } } },
  test: { environment: "jsdom", globals: true, include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/setup.ts"] },
});
