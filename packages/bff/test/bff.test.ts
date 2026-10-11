// agentglass-web (local-web-api W4): auth boundary, Host/Origin/CSRF, limits, shared subscriptions, slow clients,
// headers and logs — an in-process server on 127.0.0.1:0 over a fake serve child
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Auth, namesOf, hostOk, originOk } from "../src/auth.ts";
import { Upstream } from "../src/stdio.ts";
import { startServer, HEADERS } from "../src/http.ts";
import { fake, type Fake } from "./fake.ts";

let fk: Fake; let up: Upstream; let auth: Auth; let now = 1_000_000; let srv: ReturnType<typeof startServer>; let logs: string[];
let base = ""; let host = "";
beforeEach(async () => {
  fk = fake(); now = Date.now(); up = new Upstream(fk.spawn); await up.start();
  auth = new Auth("", () => now); logs = [];
  srv = startServer({ port: 0, up, auth, assets: new Map([["/index.html", { file: new Blob(['<!doctype html><meta name="csp-nonce" content="__CSP_NONCE__"><p>ui']), type: "text/html" }]]), log: (l) => logs.push(l) });
  base = "http://127.0.0.1:" + srv.port; host = "127.0.0.1:" + srv.port;
});
afterEach(() => { srv.stop(); up.stop(); });
const origin = () => ({ Origin: base });
async function login(): Promise<{ cookie: string; csrf: string }> {
  const t = auth.mint();
  const r = await fetch(base + "/api/v1/session", { method: "POST", headers: { ...origin(), "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) });
  expect(r.status).toBe(200);
  const sc = r.headers.get("set-cookie") ?? "";
  return { cookie: sc.split(";")[0]!, csrf: ((await r.json()) as { csrf: string }).csrf };
}
function ws(cookie: string, o = base): Promise<WebSocket> {
  return new Promise((res, rej) => { const w = new WebSocket(base.replace("http", "ws") + "/api/v1/ws", { headers: { Cookie: cookie, Origin: o } } as never); w.onopen = () => res(w); w.onerror = () => rej(new Error("ws refused")); w.onclose = (e) => rej(new Error("closed " + e.code)); });
}
function next(w: WebSocket, f: (m: Record<string, unknown>) => boolean, ms = 3000): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("timeout")), ms); w.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); if (f(m)) { clearTimeout(t); res(m); } }); });
}

test("no cookie → 401; the static shell needs none", async () => {
  expect((await fetch(base + "/api/v1/sessions")).status).toBe(401);
  expect((await fetch(base + "/")).status).toBe(200);
});
test("token exchange: cookie flags, single use, expiry after 2 min", async () => {
  const t = auth.mint();
  const post = (tok: string) => fetch(base + "/api/v1/session", { method: "POST", headers: { ...origin(), "Content-Type": "application/json" }, body: JSON.stringify({ token: tok }) });
  const r = await post(t); expect(r.status).toBe(200);
  const c = r.headers.get("set-cookie") ?? "";
  expect(c).toContain("HttpOnly"); expect(c).toContain("SameSite=Strict"); expect(c).toContain("Path=/");
  expect((await post(t)).status).toBe(401);
  const t2 = auth.mint(); now += 121_000; expect((await post(t2)).status).toBe(401);
});
test("GET /api/v1/session: the cookie's CSRF token after a reload; none without a cookie", async () => {
  const { cookie, csrf } = await login();
  expect(((await (await fetch(base + "/api/v1/session", { headers: { Cookie: cookie } })).json()) as { csrf: string }).csrf).toBe(csrf);
  expect((await fetch(base + "/api/v1/session")).status).toBe(401);
});
test("the session reads the API through the child", async () => {
  const { cookie } = await login();
  const r = await fetch(base + "/api/v1/sessions", { headers: { Cookie: cookie } });
  expect(r.status).toBe(200); expect(((await r.json()) as { data: unknown[] }).data.length).toBe(1);
  expect(r.headers.get("cache-control")).toBe("no-store");
});
test("--host 0.0.0.0: this machine's addresses and hostname pass, others do not", () => {
  const n = namesOf("0.0.0.0", { eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }], lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }] }, "box");
  expect(hostOk("192.168.1.20:8080", 8080, n)).toBe(true); expect(hostOk("box.local:8080", 8080, n)).toBe(true); expect(hostOk("localhost:8080", 8080, n)).toBe(true);
  expect(hostOk("evil.example:8080", 8080, n)).toBe(false); expect(hostOk("[fe80::1]:8080", 8080, n)).toBe(false);
  expect(originOk("http://192.168.1.20:8080", 8080, n)).toBe(true); expect(originOk("http://192.168.1.20:9999", 8080, n)).toBe(false); expect(originOk("http://evil.example:8080", 8080, n)).toBe(false);
  expect(namesOf("127.0.0.1", { eth0: [{ address: "192.168.1.20", family: "IPv4", internal: false }] }, "box")).toEqual(["127.0.0.1", "localhost", "[::1]"]);
});
test("wrong Host → 421 (DNS rebinding)", async () => {
  const r = await fetch(base + "/", { headers: { Host: "evil.example:" + srv.port } });
  expect(r.status).toBe(421);
});
test("POST with a foreign Origin → 403; without X-AG-CSRF → 403", async () => {
  const { cookie } = await login();
  expect((await fetch(base + "/api/v1/commands", { method: "POST", headers: { Cookie: cookie, Origin: "http://evil.example" }, body: "{}" })).status).toBe(403);
  const r = await fetch(base + "/api/v1/commands", { method: "POST", headers: { Cookie: cookie, ...origin() }, body: "{}" });
  expect(r.status).toBe(403); expect(((await r.json()) as { err: { code: string } }).err.code).toBe("bad_csrf");
});
test("WebSocket: no cookie → refused; foreign Origin → refused; with both → request through the child", async () => {
  await expect(ws("agw=nope")).rejects.toThrow();
  const { cookie } = await login();
  await expect(ws(cookie, "http://evil.example")).rejects.toThrow();
  const r1 = await fetch(base + "/api/v1/ws", { headers: { Cookie: cookie, Origin: "http://evil.example", Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
  expect(r1.status).toBe(403);
  const r0 = await fetch(base + "/api/v1/ws", { headers: { Upgrade: "websocket", Connection: "Upgrade", Origin: base, "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } });
  expect(r0.status).toBe(401);
  const w = await ws(cookie);
  const p = next(w, (m) => m.id === 1); w.send(JSON.stringify({ id: 1, m: "meta" }));
  expect(((await p).ok as { version: string }).version).toBe("fake");
  const q = next(w, (m) => m.id === 2); w.send(JSON.stringify({ id: 2, m: "shell", p: { argv: ["rm"] } }));
  expect(((await q).err as { code: string }).code).toBe("unknown_method");
  w.close();
});
test("an answer over 64 KB reaches the client (the frame cap is for what clients send)", async () => {
  const { cookie } = await login(); const w = await ws(cookie);
  const p = next(w, (m) => m.id === 7, 3000); w.send(JSON.stringify({ id: 7, m: "sessions.get", p: { ref: "claude:a1" } }));
  const r = await p; expect(((r.ok as { files: unknown[] }).files).length).toBe(3000);
  // and a client frame over 64 KB is still refused
  const closed = new Promise<number>((res) => { w.onclose = (e) => res(e.code); });
  w.send(JSON.stringify({ id: 8, m: "meta", p: { pad: "x".repeat(70 * 1024) } }));
  expect([1006, 1009]).toContain(await Promise.race([closed, Bun.sleep(2000).then(() => -1)])); // closed (Bun: abnormal close)
});
test("two tabs subscribing sessions → one upstream sub; a patch reaches both; resume from the last id", async () => {
  const { cookie } = await login();
  const a = await ws(cookie); const b = await ws(cookie);
  const sa = next(a, (m) => m.k === "snapshot"); a.send(JSON.stringify({ id: 1, m: "sub", p: { topic: "sessions" } }));
  const snap = await sa;
  const sb = next(b, (m) => m.k === "snapshot"); b.send(JSON.stringify({ id: 1, m: "sub", p: { topic: "sessions" } })); await sb;
  expect(fk.subs).toBe(1);
  const pa = next(a, (m) => m.k === "patch"); const pb = next(b, (m) => m.k === "patch"); fk.patch("changed");
  const got = await pa; await pb;
  expect(JSON.stringify(got)).toContain("changed");
  // a third tab resumes after the snapshot: it gets the patch, not a snapshot
  const c = await ws(cookie);
  const pc = next(c, (m) => m.k === "patch"); const ack = next(c, (m) => m.id === 9);
  c.send(JSON.stringify({ id: 9, m: "sub", p: { topic: "sessions", from: snap.ev } }));
  expect(((await ack).ok as { resumed: boolean }).resumed).toBe(true); await pc;
  expect(fk.subs).toBe(1);
  a.close(); b.close(); c.close();
});
test("the sub's answer comes before its first event", async () => {
  const { cookie } = await login(); const w = await ws(cookie); const seen: string[] = [];
  w.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); seen.push(m.id === 1 ? "ack" : m.k); });
  const s = next(w, (m) => m.k === "snapshot"); w.send(JSON.stringify({ id: 1, m: "sub", p: { topic: "sessions" } })); await s;
  // a second socket on the warm topic: the snapshot is replayed at once — still after the answer
  const w2 = await ws(cookie); const seen2: string[] = [];
  w2.addEventListener("message", (e) => { const m = JSON.parse(String(e.data)); seen2.push(m.id === 1 ? "ack" : m.k); });
  const s2 = next(w2, (m) => m.k === "snapshot"); w2.send(JSON.stringify({ id: 1, m: "sub", p: { topic: "sessions" } })); await s2;
  expect(seen[0]).toBe("ack"); expect(seen2[0]).toBe("ack");
  w.close(); w2.close();
});
test("a slow WebSocket client over 2 MB is closed with 1013", async () => {
  const { cookie } = await login(); const w = await ws(cookie);
  const s = next(w, (m) => m.k === "snapshot"); w.send(JSON.stringify({ id: 1, m: "sub", p: { topic: "sessions" } })); await s;
  const closed = new Promise<number>((r) => { w.onclose = (e) => r(e.code); });
  const big = "x".repeat(256 * 1024);
  for (let i = 0; i < 80; i++) fk.patch(big); // 20 MB: more than the loopback socket buffers take
  const code = await Promise.race([closed, Bun.sleep(5000).then(() => -1)]);
  expect(code).toBe(1013);
});
test("body over 64 KB → 413", async () => {
  const { cookie, csrf } = await login();
  const r = await fetch(base + "/api/v1/commands", { method: "POST", headers: { Cookie: cookie, ...origin(), "X-AG-CSRF": csrf }, body: "x".repeat(65 * 1024) });
  expect(r.status).toBe(413);
});
test("120 requests at once → 429 (more than two one-second windows can take)", async () => {
  const { cookie } = await login();
  const rs = await Promise.all(Array.from({ length: 120 }, () => fetch(base + "/api/v1/meta", { headers: { Cookie: cookie } })));
  expect(rs.some((r) => r.status === 429)).toBe(true);
});
test("the page: a fresh style nonce in the meta tag and the CSP, per response", async () => {
  const a = await fetch(base + "/"); const b = await fetch(base + "/sessions");
  const na = /content="([^"]+)"/.exec(await a.text())![1]!; const nb = /content="([^"]+)"/.exec(await b.text())![1]!;
  expect(na).not.toBe("__CSP_NONCE__"); expect(na).not.toBe(nb);
  expect(a.headers.get("content-security-policy")).toContain("style-src 'self' 'nonce-" + na + "'");
  expect(a.headers.get("content-security-policy")).toContain("script-src 'self';");
});
test("every response has the security headers and no Access-Control-*", async () => {
  const { cookie } = await login();
  for (const r of [await fetch(base + "/"), await fetch(base + "/api/v1/meta", { headers: { Cookie: cookie } }), await fetch(base + "/api/v1/sessions")]) {
    for (const [k, v] of Object.entries(HEADERS)) if (k !== "Content-Security-Policy") expect(r.headers.get(k)).toBe(v);
    expect(r.headers.get("content-security-policy")).toMatch(/^default-src 'self'; script-src 'self'; style-src 'self'( 'nonce-[\w-]+')?; style-src-attr 'unsafe-inline';/);
    for (const k of r.headers.keys()) expect(k.toLowerCase().startsWith("access-control-")).toBe(false);
  }
});
test("SSE: snapshot then patch with ids", async () => {
  const { cookie } = await login();
  const ac = new AbortController();
  const r = await fetch(base + "/api/v1/stream?topic=sessions", { headers: { Cookie: cookie }, signal: ac.signal });
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  const rd = r.body!.getReader(); const dec = new TextDecoder(); let text = "";
  const until = async (s: string) => { const end = Date.now() + 3000; while (!text.includes(s) && Date.now() < end) { const c = await rd.read(); if (c.done) break; text += dec.decode(c.value); } };
  await until("event: snapshot"); fk.patch("via sse"); await until("via sse");
  expect(text).toMatch(/id: e1-\d+\nevent: snapshot/); expect(text).toContain("event: patch");
  ac.abort();
});
test("web.log: method, path, status — no token, cookie or query values", async () => {
  const t = auth.mint();
  await fetch(base + "/api/v1/session", { method: "POST", headers: { ...origin() }, body: JSON.stringify({ token: t }) });
  const { cookie } = await login();
  await fetch(base + "/api/v1/sessions?filter=secretword", { headers: { Cookie: cookie } });
  const all = logs.join("\n");
  expect(all).toContain("GET /api/v1/sessions 200");
  expect(all).not.toContain(t); expect(all).not.toContain(cookie.split("=")[1]!); expect(all).not.toContain("secretword");
});
test("the child dies → restarted, subscriptions come back", async () => {
  const { cookie } = await login(); const w = await ws(cookie);
  const s = next(w, (m) => m.k === "snapshot"); w.send(JSON.stringify({ id: 1, m: "sub", p: { topic: "sessions" } })); await s;
  const again = next(w, (m) => m.k === "snapshot", 3000); fk.crash();
  await again; expect(fk.started).toBe(2);
  w.close();
});
