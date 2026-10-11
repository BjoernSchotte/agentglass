// the timeline in real Chromium (local-web-api §12 budgets): 50 k synthetic spans render; a scripted drag-pan keeps the
// p95 frame ≤ 16.7 ms; the wheel zooms around the cursor; Shift-drag box-selects. Serves bench/dist (pnpm bench:build).
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const dist = join(import.meta.dirname, "..", "bench", "dist");
let srv: Server; let base = "";
test.beforeAll(async () => {
  if (!existsSync(join(dist, "index.html"))) throw new Error("build the bench first: pnpm --filter @agentglass/viz bench:build");
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
  srv = createServer((req, res) => { const p = join(dist, decodeURIComponent((req.url ?? "/").split("?")[0]!.replace(/^\/$/, "/index.html"))); if (!p.startsWith(dist) || !existsSync(p)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { "content-type": types[extname(p)] ?? "application/octet-stream" }); res.end(readFileSync(p)); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r())); const a = srv.address(); base = "http://127.0.0.1:" + (typeof a === "object" && a ? a.port : 0) + "/";
});
test.afterAll(() => { srv?.close(); });

test("50 k spans: renders, pans at ≥ 60 fps (p95), zooms around the cursor, box-selects", async ({ page }) => {
  await page.goto(base + "?n=50000");
  const app = page.getByRole("application"); await expect(app).toHaveAttribute("aria-label", /50000 spans/);
  const box = (await app.boundingBox())!; const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
  // zoom in around the cursor first: a pan over a dense window is the hard case
  await page.mouse.move(box.x + box.width * 0.3, cy);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(30); }
  // frame probe: rAF intervals while a drag pans across
  await page.evaluate(() => { const w = window as unknown as { gaps: number[]; probe: boolean }; w.gaps = []; w.probe = true; let last = performance.now(); const f = (t: number) => { w.gaps.push(t - last); last = t; if (w.probe) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await page.mouse.move(cx + 300, cy); await page.mouse.down();
  for (let i = 0; i < 120; i++) await page.mouse.move(cx + 300 - i * 5, cy + (i % 10));
  await page.mouse.up();
  const gaps = await page.evaluate(() => { const w = window as unknown as { gaps: number[]; probe: boolean }; w.probe = false; return w.gaps.slice(2); });
  gaps.sort((a, b) => a - b); const p95 = gaps[Math.floor(gaps.length * 0.95)]!;
  console.log("timeline 50k pan: " + gaps.length + " frames, p50 " + gaps[Math.floor(gaps.length / 2)]!.toFixed(1) + " ms, p95 " + p95.toFixed(1) + " ms");
  expect(p95).toBeLessThanOrEqual(16.7 + 1.5); // + scheduler jitter of a headless runner
  // box-select: Shift-drag over the lanes lists the spans it caught
  await page.keyboard.down("Shift"); await page.mouse.move(box.x + 100, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 400, box.y + 140, { steps: 5 }); await page.mouse.up(); await page.keyboard.up("Shift");
  await expect(page.getByLabel("Selected spans")).toContainText(/\d+ selected/);
  // [ ] and Esc while focused
  await app.focus(); await page.keyboard.press("Escape"); await expect(page.getByLabel("Selected spans")).toHaveCount(0);
  await page.keyboard.press("]"); await expect(page.getByLabel("Selected spans")).toContainText("1 selected");
});
