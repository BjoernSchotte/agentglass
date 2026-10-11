// end to end (local-web-api W6): the real agentglass and agentglass-web on a fixture HOME — `agentglass web --no-open`
// prints a one-time link → the live Sessions view shows the fixture rows → a grown session updates within 3 s → a page
// from another port (same site: the cookie goes along) cannot open the WebSocket, a wrong Host gets 421, a second use
// of the link fails. AGENTGLASS_BIN, AGENTGLASS_WEB_BIN: the two binaries.
import { test, expect } from "@playwright/test";
import { copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fixture } from "../../api-contract/test/fixture.ts";

const BIN = process.env.AGENTGLASS_BIN ?? ""; const WEB = process.env.AGENTGLASS_WEB_BIN ?? "";
test.skip(!BIN || !WEB, "set AGENTGLASS_BIN and AGENTGLASS_WEB_BIN");

test("one-time link, live rows, cross-origin and rebinding refused", async ({ page, browser }) => {
  const fx = fixture(); const bin = join(fx.dir, "bin"); mkdirSync(bin);
  copyFileSync(BIN, join(bin, "agentglass")); copyFileSync(WEB, join(bin, "agentglass-web")); chmodSync(join(bin, "agentglass"), 0o755); chmodSync(join(bin, "agentglass-web"), 0o755);
  const env = { ...fx.env, PATH: bin + ":" + (process.env.PATH ?? "") };
  const ag = (...a: string[]) => execFileSync(join(bin, "agentglass"), a, { env, encoding: "utf8" });
  try {
    const out = JSON.parse(ag("web", "--json")) as { url: string; port: number; reused: boolean };
    expect(out.reused).toBe(false); expect(out.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#t=[\w-]{43}$/);
    await page.goto(out.url);
    await expect(page).toHaveURL(/\/sessions$/); // the token left the URL
    await expect(page.getByText("first fixture topic")).toBeVisible();
    await expect(page.getByText("second fixture topic")).toBeVisible();
    // a grown session moves to the top within 3 s
    fx.grow("grown in the e2e test");
    await expect(page.locator("tbody tr").first()).toContainText("first fixture topic", { timeout: 3000 });
    await expect(page.getByText("● live")).toBeVisible();
    // the link again: refused (single use)
    const again = await browser.newPage(); await again.goto(out.url);
    await expect(again.getByText(/used or has expired/)).toBeVisible(); await again.close();
    // a second `agentglass web` reuses the server with a new link
    const two = JSON.parse(ag("web", "--json")) as { url: string; port: number; reused: boolean };
    expect(two.reused).toBe(true); expect(two.port).toBe(out.port); expect(two.url).not.toBe(out.url);
    // another port on 127.0.0.1: same site, the cookie goes along — the Origin check refuses the socket
    const evil = createServer((_, res) => { res.setHeader("Content-Type", "text/html"); res.end(`<script>const w=new WebSocket("ws://127.0.0.1:${out.port}/api/v1/ws");w.onopen=()=>document.title="open";w.onerror=()=>document.title="refused";</script>`); });
    await new Promise<void>((r) => evil.listen(0, "127.0.0.1", () => r()));
    const ep = (evil.address() as { port: number }).port;
    await page.goto("http://127.0.0.1:" + ep + "/"); await expect(page).toHaveTitle("refused");
    evil.close();
    // DNS rebinding: a foreign Host (node:http sends it as given; fetch would replace it)
    const status = await new Promise<number>((res, rej) => request({ host: "127.0.0.1", port: out.port, path: "/", headers: { Host: "evil.example:" + out.port } }, (r) => { r.resume(); res(r.statusCode ?? 0); }).on("error", rej).end());
    expect(status).toBe(421);
  } finally {
    try { ag("web", "--stop"); } catch { /* not running */ }
    fx.done();
  }
});
