// agentglass-web's server (local-web-api §4–5): static UI, /api/v1 (cookie auth, CSRF, Host/Origin checks, limits,
// security headers, no CORS ever), WebSocket /api/v1/ws (requests + shared subscriptions), SSE /api/v1/stream
// (fallback, Last-Event-ID resume). The only data source is the serve child (Upstream); web.log lines carry method,
// path without query, status and time — never tokens, cookies or values.
import type { Server, ServerWebSocket } from "bun";
import { Auth, hostOk, originOk, namesOf, same, rand, SESSION_MS } from "./auth.ts";
import { Upstream, type Ev, type Obj, type Reply, type Listener } from "./stdio.ts";
import { BODY_MAX, FRAME_MAX, STREAMS_MAX, REQ_PER_S, QUEUE_MAX, HB_MS, Rate } from "./limits.ts";

export interface Asset { file: string | Blob; type: string }
export interface Opts { port: number; hostname?: string; names?: string[]; up: Upstream; auth: Auth; assets: Map<string, Asset>; log?: (line: string) => void }
export const HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Resource-Policy": "same-origin",
};
// methods a client may call; everything else is unknown_method (no generic passthrough)
const METHODS = new Set(["meta", "sessions.list", "sessions.get", "events.list", "cost.get", "wait.get", "alerts.list", "fleet.hosts", "repos.list", "skills.get", "graph.get", "team.status", "team.report", "team.sessions", "team.activity"]);
const HTTP_OF: Record<string, number> = { bad_param: 400, bad_filter: 400, bad_request: 400, unknown_method: 404, not_found: 404, no_team: 404, ambiguous: 409, too_many: 429, read_only: 403, internal: 503 };
interface WsData { sid: string; subs: Map<string, { params: Obj; f: Listener }>; n: number }

function json(o: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(o), { status, headers: { ...HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
}
function fail(status: number, code: string, msg: string): Response { return json({ err: { code, msg } }, status); }
function replyResponse(r: Reply): Response { return r.ok ? json(r.ok) : json({ err: r.err }, HTTP_OF[r.err?.code ?? ""] ?? 500); }
// query → protocol params (numbers and booleans where the protocol takes them)
function paramsOf(u: URL): Obj {
  const p: Obj = {};
  for (const [k, v] of u.searchParams) p[k] = k === "limit" || k === "since" ? Number(v) : k === "subagents" ? v === "true" : v;
  return p;
}

export function startServer(o: Opts): { server: Server<WsData>; port: number; stop: () => void } {
  const rate = new Rate(REQ_PER_S); let streams = 0; const names = o.names ?? namesOf("127.0.0.1", {}, "");
  const log = (m: string, path: string, status: number, t0: number) => o.log?.(new Date().toISOString() + " " + m + " " + path + " " + status + " " + (performance.now() - t0).toFixed(1) + "ms");
  let port = o.port;
  const server: Server<WsData> = Bun.serve<WsData>({
    hostname: o.hostname ?? "127.0.0.1", port: o.port, idleTimeout: 30,
    async fetch(req, srv) {
      const t0 = performance.now(); const u = new URL(req.url); let res: Response | undefined;
      try { res = await route(req, u, srv); } catch { res = fail(500, "internal", "internal error"); }
      if (res) log(req.method, u.pathname, res.status, t0); else log(req.method, u.pathname, 101, t0);
      return res;
    },
    websocket: {
      maxPayloadLength: FRAME_MAX, idleTimeout: 120, sendPings: true,
      open(ws) { streams++; },
      close(ws) { streams--; for (const s of ws.data.subs.values()) o.up.unsubscribe(s.params, s.f); ws.data.subs.clear(); },
      async message(ws, raw) {
        if (!rate.hit("ws:" + ws.data.sid)) { send(ws, { id: null, err: { code: "too_many", msg: "over " + REQ_PER_S + " requests a second" } }); return; }
        let q: Obj; try { q = JSON.parse(String(raw)) as Obj; } catch { send(ws, { id: null, err: { code: "bad_request", msg: "not JSON" } }); return; }
        const id = (typeof q.id === "string" || typeof q.id === "number") ? q.id : null; const m = String(q.m ?? ""); const p = (q.p && typeof q.p === "object" ? q.p : {}) as Obj;
        if (id === null) { send(ws, { id: null, err: { code: "bad_request", msg: "a request needs an id" } }); return; }
        if (m === "sub") {
          if (ws.data.subs.size >= 16) { send(ws, { id, err: { code: "too_many", msg: "16 subscriptions per socket" } }); return; }
          const cid = "c" + ++ws.data.n; const from = typeof p.from === "string" ? p.from : ""; const params: Obj = { ...p }; delete params.from;
          // events wait until the client has the sub's id: the answer goes out first
          let held: Ev[] | null = [];
          const f: Listener = (e: Ev) => { if (held) held.push(e); else send(ws, { ...e, sub: cid }); };
          ws.data.subs.set(cid, { params, f });
          const r = await o.up.subscribe(params, from, f);
          if (r.err) { ws.data.subs.delete(cid); send(ws, { id, err: r.err }); return; }
          send(ws, { id, ok: { sub: cid, resumed: !!r.resumed } });
          const q = held; held = null; for (const e of q) send(ws, { ...e, sub: cid }); return;
        }
        if (m === "unsub") { const s = ws.data.subs.get(String(p.sub)); if (!s) { send(ws, { id, err: { code: "not_found", msg: "no subscription " + String(p.sub) } }); return; } o.up.unsubscribe(s.params, s.f); ws.data.subs.delete(String(p.sub)); send(ws, { id, ok: {} }); return; }
        if (!METHODS.has(m)) { send(ws, { id, err: { code: "unknown_method", msg: "unknown method " + JSON.stringify(m) } }); return; }
        const r = await o.up.request(m, p); send(ws, { id, ...r });
      },
    },
  });
  port = server.port ?? o.port;
  // a slow client: over QUEUE_MAX unsent bytes the socket closes 1013 (it resumes from its last event id)
  function send(ws: ServerWebSocket<WsData>, v: unknown): void {
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify(v));
    if (ws.getBufferedAmount() > QUEUE_MAX) ws.close(1013, "client too slow");
  }

  async function route(req: Request, u: URL, srv: Server<WsData>): Promise<Response | undefined> {
    if (!hostOk(req.headers.get("host"), port, names)) return fail(421, "bad_host", "wrong Host");
    const api = u.pathname.startsWith("/api/");
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "POST") return fail(405, "bad_request", "method not allowed");
    if (req.method === "POST" && !originOk(req.headers.get("origin"), port, names)) return fail(403, "bad_origin", "foreign Origin");
    if (!api) return await asset(u.pathname);
    let body: Obj = {};
    if (req.method === "POST") {
      if (Number(req.headers.get("content-length") ?? "0") > BODY_MAX) return fail(413, "oversize", "body over 64 KB");
      const text = await req.text(); if (text.length > BODY_MAX) return fail(413, "oversize", "body over 64 KB");
      try { body = text ? JSON.parse(text) as Obj : {}; } catch { return fail(400, "bad_request", "body is not JSON"); }
    }
    if (u.pathname === "/api/v1/session" && req.method === "POST") {
      const s = o.auth.exchange(typeof body.token === "string" ? body.token : "");
      if (!s) return fail(401, "unauthorized", "the link was used or expired: run agentglass web again");
      return json({ csrf: s.csrf }, 200, { "Set-Cookie": "agw=" + s.id + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + String(SESSION_MS / 1000) });
    }
    const s = o.auth.session(req.headers.get("cookie"));
    if (!s) return fail(401, "unauthorized", "no session: open the link agentglass web printed");
    if (u.pathname === "/api/v1/session") return json({ csrf: s.csrf }); // a reload: the cookie's CSRF token (same-origin reads only: no CORS)
    if (req.method === "POST" && !same(req.headers.get("x-ag-csrf") ?? "", s.csrf)) return fail(403, "bad_csrf", "missing or wrong X-AG-CSRF");
    if (!rate.hit("http:" + s.id)) return fail(429, "too_many", "over " + REQ_PER_S + " requests a second");
    if (o.up.down) return fail(503, "internal", "agentglass serve is down: restart agentglass web");
    const p = u.pathname;
    if (p === "/api/v1/ws") {
      if (!originOk(req.headers.get("origin"), port, names)) return fail(403, "bad_origin", "foreign Origin");
      if (streams >= STREAMS_MAX) return fail(503, "too_many", STREAMS_MAX + " streams are open");
      return srv.upgrade(req, { data: { sid: s.id, subs: new Map(), n: 0 } }) ? undefined : fail(400, "bad_request", "WebSocket upgrade failed");
    }
    if (p === "/api/v1/stream") return sse(req, u);
    if (p === "/api/v1/commands") return fail(403, "read_only", "commands are not in this release");
    if (req.method !== "GET") return fail(404, "not_found", "no such route");
    if (p === "/api/v1/meta") return replyResponse(await o.up.request("meta"));
    if (p === "/api/v1/sessions") return replyResponse(await o.up.request("sessions.list", paramsOf(u)));
    const gm = /^\/api\/v1\/sessions\/([^/]+)\/graph$/.exec(p);
    if (gm) { const q: Obj = { ref: decodeURIComponent(gm[1]!) }; for (const k of ["from", "to"]) { const v = u.searchParams.get(k); if (v !== null) q[k] = Number(v); } return replyResponse(await o.up.request("graph.get", q)); }
    const em = /^\/api\/v1\/sessions\/([^/]+)\/events$/.exec(p);
    if (em) { const q: Obj = { ref: decodeURIComponent(em[1]!) }; for (const k of ["filter", "preset"]) { const v = u.searchParams.get(k); if (v !== null) q[k] = v; } const l = u.searchParams.get("limit"); if (l !== null) q.limit = Number(l); return replyResponse(await o.up.request("events.list", q)); }
    if (p.startsWith("/api/v1/sessions/")) { const dt = u.searchParams.get("detail"); return replyResponse(await o.up.request("sessions.get", { ref: decodeURIComponent(p.slice(17)), ...(dt ? { detail: dt } : {}) })); }
    if (p === "/api/v1/wait") { const q: Obj = {}; for (const k of ["since", "by", "filter"]) { const v = u.searchParams.get(k); if (v !== null) q[k] = v; } const l = u.searchParams.get("limit"); if (l !== null) q.limit = Number(l); return replyResponse(await o.up.request("wait.get", q)); } // since stays text: 7d
    if (p === "/api/v1/skills") { const q: Obj = {}; for (const k of ["period", "sort", "harness", "repo", "filter"]) { const v = u.searchParams.get(k); if (v !== null) q[k] = v; } const a = u.searchParams.get("advice"); if (a !== null) q.advice = Number(a); return replyResponse(await o.up.request("skills.get", q)); }
    if (p === "/api/v1/repos") { const q: Obj = {}; const d = u.searchParams.get("days"); if (d !== null) q.days = Number(d); const f = u.searchParams.get("filter"); if (f !== null) q.filter = f; return replyResponse(await o.up.request("repos.list", q)); }
    if (p === "/api/v1/fleet") return replyResponse(await o.up.request("fleet.hosts"));
    if (p === "/api/v1/alerts") return replyResponse(await o.up.request("alerts.list", paramsOf(u)));
    if (p === "/api/v1/cost") { const q: Obj = {}; for (const k of ["harness", "by", "since", "filter"]) { const v = u.searchParams.get(k); if (v !== null) q[k] = v; } return replyResponse(await o.up.request("cost.get", q)); } // since stays text: today | 7d | 2026-10-01
    const tm = /^\/api\/v1\/team\/(status|report|sessions|activity)$/.exec(p);
    if (tm) return replyResponse(await o.up.request("team." + tm[1], paramsOf(u)));
    return fail(404, "not_found", "no such route");
  }

  // SSE: one topic per stream (?topic=sessions&filter=…), resume by Last-Event-ID; ends when the client is too slow
  function sse(req: Request, u: URL): Response {
    if (streams >= STREAMS_MAX) return fail(503, "too_many", STREAMS_MAX + " streams are open");
    const params = paramsOf(u); if (!params.topic) params.topic = "sessions";
    const from = req.headers.get("last-event-id") ?? "";
    let f: Listener = () => {}; let hb: Timer | null = null; let queued = 0;
    const stream = new ReadableStream<string>({
      start(c) {
        streams++;
        const end = () => { if (hb) clearInterval(hb); hb = null; o.up.unsubscribe(params, f); streams--; try { c.close(); } catch { /* closed */ } };
        f = (e: Ev) => {
          const chunk = (e.ev ? "id: " + e.ev + "\n" : "") + "event: " + e.k + "\n" + "data: " + JSON.stringify(e.d ?? {}) + "\n\n";
          queued = c.desiredSize !== null && c.desiredSize < 0 ? queued + chunk.length : 0;
          if (queued > QUEUE_MAX) { end(); return; }
          c.enqueue(chunk);
        };
        hb = setInterval(() => c.enqueue(": hb\n\n"), HB_MS);
        req.signal.addEventListener("abort", end);
        void o.up.subscribe(params, from, f).then((r) => { if (r.err) { c.enqueue("event: error\ndata: " + JSON.stringify(r.err) + "\n\n"); end(); } });
      },
    });
    return new Response(stream, { headers: { ...HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
  }

  async function asset(path: string): Promise<Response> {
    const page = !o.assets.has(path) || path === "/index.html"; // the SPA: unknown paths get the page
    const a = o.assets.get(path) ?? o.assets.get("/index.html");
    if (!a) return new Response("agentglass-web: the UI is not built", { status: 404, headers: HEADERS });
    if (page) { // a fresh nonce per page: <style> elements the UI's libraries inject carry it, nothing else may style
      const n = rand(16); const html = (await (typeof a.file === "string" ? Bun.file(a.file) : a.file).text()).replace("__CSP_NONCE__", n);
      return new Response(html, { headers: { ...HEADERS, "Content-Security-Policy": HEADERS["Content-Security-Policy"]!.replace("style-src 'self'", "style-src 'self' 'nonce-" + n + "'"), "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
    }
    const body = typeof a.file === "string" ? Bun.file(a.file) : a.file;
    return new Response(body, { headers: { ...HEADERS, "Content-Type": a.type, "Cache-Control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" } });
  }
  return { server, port, stop: () => server.stop(true) };
}
