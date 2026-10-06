// agentglass — the receive request handler and its runtime (otlp-hub spec 6–10, 12): OTLP/HTTP JSON and protobuf with
// gzip; the token checked before any body byte is read; size, decompression, record, rate and connection limits;
// host-id pinning per token; ingest scrub; one JSON line per request in the host's day file; 429/503 backpressure.
// Plain node:http types only: src/receive-tls.ts serves the same handler over https (C backend, a separate binary).
// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, arr, str, jsonNodes } from "../../util/json.ts";
import { gunzipCapped, gzipIsize } from "../../util/inflate.ts";
import { createOwn, readOwn, myUid } from "../palette/rundir.ts";
import { OS } from "../../platform/index.ts";
import type { RecvCfg } from "./config.ts";
import { type Tok, type TokStore, tokStore, reloadTokens, checkToken, pinToken, pinnable, tokensFile, dirProblem, live } from "./tokens.ts";
import { decodeTraces, decodeLogs, partialPb, nodeCap } from "./otlppb.ts";
import { scrubResource, scrubNeeded } from "./scrub.ts";
import { hostDir, appendReq, enforce, compressClosed, writePrivate, utcDay } from "./store.ts";

const MB = 1048576;
export const MAX_CONNS = 64; export const HEADER_MS = 10000; export const BODY_MS = 60000; export const LINGER_MS = 5000;
export const TOKEN_INFLIGHT = 8; // request bodies one token may stream at once: a token cannot hold every connection slot
export interface HostStat { requests: number; records: number; bytes: number; last: number; rej: Map<string, number>; scrubbed: number; metrics: number; pin: string; skewMs: number; beatAt: number }
interface Win { t: number[]; b: number[] } // one token name's last minute: request times, decoded bytes (sliding window)
interface Conn { s: Socket; t: ReturnType<typeof setTimeout> | null }
export interface Rt {
  cfg: RecvCfg; toks: TokStore; hosts: Map<string, HostStat>; unauth: Map<string, number>; rate: Map<string, Win>;
  full: boolean; used: number; todayB: number; day: string; enforcedAt: number; started: number; port: number; tlsNote: string; tlsExpires: number;
  conns: Conn[]; inflight: number; busy: Map<string, number>; closing: boolean; clock: () => number;
}
export function newRt(cfg: RecvCfg): Rt {
  return { cfg, toks: tokStore(tokensFile(cfg.dir)), hosts: new Map<string, HostStat>(), unauth: new Map<string, number>(), rate: new Map<string, Win>(),
    full: false, used: 0, todayB: 0, day: "", enforcedAt: 0, started: Date.now(), port: 0, tlsNote: "", tlsExpires: 0, conns: [], inflight: 0, busy: new Map<string, number>(), closing: false, clock: (): number => Date.now() };
}
function bump(m: Map<string, number>, k: string): void { m.set(k, (m.get(k) ?? 0) + 1); }
export function hostStat(rt: Rt, name: string): HostStat {
  let h = rt.hosts.get(name);
  if (!h) { h = { requests: 0, records: 0, bytes: 0, last: 0, rej: new Map<string, number>(), scrubbed: 0, metrics: 0, pin: "", skewMs: 0, beatAt: 0 }; rt.hosts.set(name, h); }
  return h;
}

// ── responses: OTLP/HTTP (empty Export…ServiceResponse, partial success, google.rpc.Status on errors) ──
const GRPC: Record<string, number> = { "400": 3, "401": 16, "403": 7, "404": 5, "405": 12, "408": 4, "413": 3, "415": 3, "429": 8, "503": 14 };
function statusPb(code: number, msg: string): Uint8Array {
  const m = new TextEncoder().encode(msg); const o: number[] = [8];
  let c = code; while (c >= 128) { o.push((c % 128) | 128); c = Math.floor(c / 128); } o.push(c);
  o.push(18); let n = m.length; while (n >= 128) { o.push((n % 128) | 128); n = Math.floor(n / 128); } o.push(n);
  for (let i = 0; i < m.length; i++) o.push(m[i] ?? 0);
  return new Uint8Array(o);
}
// every response closes its connection: one request per connection keeps the header timeout simple and exact
function send(res: ServerResponse, code: number, pb: boolean, body: string, bin: Uint8Array | null, extra: string[][]): void {
  if (res.headersSent || res.writableEnded) return;
  const h: Record<string, string> = { "Connection": "close", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  for (const e of extra) h[e[0] ?? ""] = e[1] ?? "";
  if (bin) { h["Content-Type"] = "application/x-protobuf"; h["Content-Length"] = String(bin.length); res.writeHead(code, h); res.end(bin); return; }
  h["Content-Type"] = pb ? "text/plain; charset=utf-8" : "application/json";
  const b = new TextEncoder().encode(body);
  h["Content-Length"] = String(b.length); res.writeHead(code, h); res.end(b);
}
function fail(res: ServerResponse, code: number, pb: boolean, msg: string, extra: string[][]): void {
  const g = GRPC[String(code)] ?? 2;
  if (pb) send(res, code, true, "", statusPb(g, msg), extra);
  else send(res, code, false, JSON.stringify({ code: g, message: msg }), null, extra);
}
function header(req: IncomingMessage, k: string): string { const v = req.headers[k]; return typeof v === "string" ? v as string : ""; }

// ── rate limit (spec 10): per token name, a sliding minute ──
function window(rt: Rt, name: string, now: number): Win {
  let w = rt.rate.get(name); if (!w) { w = { t: [], b: [] }; rt.rate.set(name, w); }
  while (w.t.length && (w.t[0] ?? 0) <= now - 60000) { w.t.shift(); w.b.shift(); }
  return w;
}
function retryAfter(w: Win, now: number): string { return String(Math.max(1, Math.ceil(((w.t[0] ?? now) + 60000 - now) / 1000))); }
function windowBytes(w: Win): number { let s = 0; for (const x of w.b) s += x; return s; }

// ── housekeeping: retention, budget, compression of closed days (start, every 10 min, and when the budget is crossed) ──
export function housekeep(rt: Rt, now: number): void {
  const e = enforce(rt.cfg.dir, rt.cfg.maxDiskMB * MB, rt.cfg.retentionDays, now);
  rt.used = e.used; rt.todayB = e.today; rt.full = e.full; rt.day = utcDay(now); rt.enforcedAt = now;
  for (let i = 0; i < 4 && compressClosed(rt.cfg.dir, now) > 0; i++) { /* a few per pass; the next pass takes the rest */ }
}
function accountWrite(rt: Rt, n: number, now: number): void {
  if (utcDay(now) !== rt.day) { housekeep(rt, now); }
  rt.used += n; rt.todayB += n;
  if (rt.todayB > rt.cfg.maxDiskMB * MB) rt.full = true;
  else if (rt.used > rt.cfg.maxDiskMB * MB && now - rt.enforcedAt > 10000) housekeep(rt, now);
}

// the resource's host.id ("" = none)
function resHostId(rs: Obj): string {
  const r = obj(rs["resource"]); if (!r) return "";
  for (const a of arr(r["attributes"])) { const o = obj(a); if (o && str(o["key"]) === "host.id") return str(obj(o["value"])?.["stringValue"]); }
  return "";
}
function recordsOf(rs: Obj, logs: boolean): number {
  let n = 0;
  for (const s of arr(rs[logs ? "scopeLogs" : "scopeSpans"])) { const so = obj(s); if (so) n += arr(so[logs ? "logRecords" : "spans"]).length; }
  return n;
}
// the newest agentglass heartbeat's time in a logs resource (ns string → ms), 0 = none
function beatMs(rs: Obj): number {
  let best = 0;
  for (const s of arr(rs["scopeLogs"])) {
    const so = obj(s); if (!so) continue;
    for (const r of arr(so["logRecords"])) { const ro = obj(r); if (!ro || str(ro["eventName"]) !== "agentglass.heartbeat") continue; const t = str(ro["timeUnixNano"]); const ms = t.length > 6 ? Number(t.slice(0, t.length - 6)) : 0; if (ms > best) best = ms; }
  }
  return best;
}

// one request after its body arrived (decoded, under the caps): pin, scrub, store, answer
function ingest(rt: Rt, res: ServerResponse, tok: Tok, signal: string, pb: boolean, body: Uint8Array, now: number): void {
  const hs = hostStat(rt, tok.name); const logs = signal === "logs";
  const rej = (code: number, why: string, msg: string, extra: string[][]): void => { bump(hs.rej, why); fail(res, code, pb, msg, extra); };
  let root: Obj | null = null; let total = 0; let text = "";
  if (pb) {
    const d = logs ? decodeLogs(body, rt.cfg.maxRecords, nodeCap(rt.cfg.maxRecords), rt.cfg.maxDecodedMB * MB) : decodeTraces(body, rt.cfg.maxRecords, nodeCap(rt.cfg.maxRecords), rt.cfg.maxDecodedMB * MB);
    if (d.err) { if (d.err.indexOf("more than") >= 0) rej(413, "records", d.err, []); else rej(400, "undecodable", "protobuf: " + d.err, []); return; }
    text = d.json;
  } else {
    text = new TextDecoder("utf-8").decode(body);
    const cap = nodeCap(rt.cfg.maxRecords); // the parse tree's size is bounded before it is built
    if (jsonNodes(text, cap) > cap) { rej(413, "values", "more than " + String(cap) + " JSON objects and arrays in one request", []); return; }
  }
  try { root = obj(JSON.parse(text)); } catch (e) { root = null; }
  const key = logs ? "resourceLogs" : "resourceSpans";
  if (!root || !Array.isArray(root[key])) { rej(400, "undecodable", "the body is not an OTLP " + (logs ? "ExportLogsServiceRequest" : "ExportTraceServiceRequest"), []); return; }
  const rss = arr(root[key]);
  for (const r of rss) { const o = obj(r); if (o) total += recordsOf(o, logs); }
  if (total > rt.cfg.maxRecords) { rej(413, "records", "more than " + String(rt.cfg.maxRecords) + (logs ? " log records" : " spans") + " in one request", []); return; }
  // pinning (spec 9.3): the first host.id under a token pins it; others are refused per resource
  let pin = tok.pin; let refused = 0; let refusedIds = ""; let scrubbed = 0; let beat = 0;
  const kept: unknown[] = [];
  const sc = { keepContent: rt.cfg.keepContent, drop: rt.cfg.drop };
  const scrub = logs || scrubNeeded(text, sc); // nothing to scrub (the default span export): stored as it came; logs bodies are always masked
  for (const r of rss) {
    const o = obj(r); if (!o) continue;
    const hid = resHostId(o);
    if (hid && !pinnable(hid)) { refused += recordsOf(o, logs); if (!refusedIds) refusedIds = hid.slice(0, 64); continue; } // unpinnable: never stored, never pins
    if (hid && !pin) {
      const e = pinToken(rt.toks.file, tok.hash, hid);
      if (e) { rej(503, "write", "cannot record the host pin: " + e, [["Retry-After", "60"]]); return; }
      reloadTokens(rt.toks, now, true); // the pin as the file has it now (another of the host's tokens may have pinned first)
      const cur = rt.toks.toks.find((t: Tok) => t.hash === tok.hash);
      pin = cur && cur.pin ? cur.pin : hid; tok.pin = pin;
    }
    if (hid && hid !== pin) { refused += recordsOf(o, logs); if (!refusedIds) refusedIds = hid; continue; }
    const rs1 = scrub ? scrubResource(o, logs, sc) : { rs: o, n: 0 };
    scrubbed += rs1.n;
    if (logs) { const b = beatMs(rs1.rs); if (b > beat) beat = b; }
    kept.push(rs1.rs);
  }
  hs.pin = pin;
  const why = "host.id " + refusedIds + " does not belong to token \"" + tok.name + "\" (pinned to " + pin + "; on a reinstalled machine: agentglass receive token add " + tok.name + " --repin)";
  if (!kept.length && refused) { bump(hs.rej, "host-id"); hs.requests++; fail(res, 403, pb, why, []); return; }
  const only = Object.keys(root).length === 1; // stored as it came only when the root holds nothing but its signal
  const clean: Obj = {}; clean[key] = kept;
  const ls = !scrub && !refused && only && text.length <= LINE_SPLIT && text.indexOf("\n") < 0 ? [text] : splitLines(clean, key, logs);
  const d1 = hostDir(rt.cfg.dir, tok.name, pin, now);
  let e = d1; let n = 0;
  for (const line of ls) { if (e) break; e = appendReq(rt.cfg.dir, tok.name, logs ? "logs" : "traces", line, now); if (!e) n += line.length + 1; }
  if (e) { rej(503, "write", "storage failed: " + e, [["Retry-After", "60"]]); return; } // a retry re-sends: span-id dedup in the reader absorbs lines already written
  accountWrite(rt, n, now);
  hs.requests++; hs.records += total - refused; hs.bytes += n; hs.last = now; hs.scrubbed += scrubbed;
  if (beat) { hs.beatAt = now; hs.skewMs = now - beat; }
  if (refused) {
    bump(hs.rej, "host-id");
    const field = logs ? "rejectedLogRecords" : "rejectedSpans";
    if (pb) send(res, 200, true, "", partialPb(refused, why), []);
    else { const ps: Obj = {}; ps[field] = String(refused); ps["errorMessage"] = why; send(res, 200, false, JSON.stringify({ partialSuccess: ps }), null, []); }
    return;
  }
  if (pb) send(res, 200, true, "", new Uint8Array(0), []);
  else send(res, 200, false, "{}", null, []);
}

// one request → stored lines of at most LINE_SPLIT characters each (a 64 MB request would exceed the reader's line cap):
// split by resource, then by scope, then by chunks of records; each line stays a valid Export…ServiceRequest
export const LINE_SPLIT = 8 * MB; // half the reader's line cap
export function splitLines(root: Obj, key: string, logs: boolean): string[] {
  const whole = JSON.stringify(root); if (whole.length <= LINE_SPLIT) return [whole];
  const sk = logs ? "scopeLogs" : "scopeSpans"; const ik = logs ? "logRecords" : "spans";
  const parts = Math.ceil(whole.length / LINE_SPLIT) + 1; // chunks by record count: one stringify per chunk
  const out: string[] = [];
  const emit = (rs: Obj, sc: Obj, items: unknown[]): void => {
    const s2: Obj = {}; for (const k of Object.keys(sc)) s2[k] = k === ik ? items : sc[k];
    const r2: Obj = {}; for (const k of Object.keys(rs)) r2[k] = k === sk ? [s2] : rs[k];
    const w: Obj = {}; w[key] = [r2];
    const line = JSON.stringify(w);
    if (line.length > LINE_SPLIT && items.length > 1) { const h = Math.ceil(items.length / 2); emit(rs, sc, items.slice(0, h)); emit(rs, sc, items.slice(h)); return; } // skewed sizes: halve again
    out.push(line);
  };
  for (const r of arr(root[key])) {
    const rs = obj(r); if (!rs) continue;
    for (const x of arr(rs[sk])) {
      const sc = obj(x); if (!sc) continue;
      const items = arr(sc[ik]); if (!items.length) { emit(rs, sc, []); continue; }
      const per = Math.max(1, Math.ceil(items.length / parts));
      for (let i = 0; i < items.length; i += per) emit(rs, sc, items.slice(i, i + per));
    }
  }
  return out.length ? out : [whole];
}
const PATHS = ["/v1/traces", "/v1/logs", "/v1/metrics"];
// the request handler (http and https alike)
export function handler(rt: Rt): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const now = rt.clock();
    const sock = req.socket;
    for (const c of rt.conns) if (c.s === sock && c.t) { clearTimeout(c.t); c.t = null; } // headers arrived in time
    // one request per connection: closed once the response is out (the runtime keeps it open despite Connection: close,
    // so an idle client would hold its slot for good); destroyed when the peer does not close its side either
    res.on("finish", () => { sock.end(); const t = setTimeout(() => { sock.destroy(); }, LINGER_MS); sock.on("close", () => { clearTimeout(t); }); });
    const url = String(req.url ?? ""); const q = url.indexOf("?"); const path = q >= 0 ? url.slice(0, q) : url;
    const method = String(req.method ?? "");
    const ctype = header(req, "content-type").split(";")[0]?.trim().toLowerCase() ?? "";
    const pb = ctype === "application/x-protobuf";
    if (path === "/healthz") { if (method === "GET" || method === "HEAD") send(res, 200, true, "ok\n", null, []); else fail(res, 405, false, "method not allowed", [["Allow", "GET"]]); return; }
    if (PATHS.indexOf(path) < 0) { bump(rt.unauth, "not-found"); fail(res, 404, pb, "not found: OTLP/HTTP paths are /v1/traces, /v1/logs, /v1/metrics", []); return; }
    if (method !== "POST") { fail(res, 405, pb, "method not allowed", [["Allow", "POST"]]); return; }
    if (rt.closing) { fail(res, 503, pb, "shutting down", [["Retry-After", "5"]]); return; }
    // the token, before a single body byte is read
    reloadTokens(rt.toks, now, false);
    const auth = header(req, "authorization");
    const m = /^Bearer[ ]+(\S+)$/i.exec(auth);
    const tok = m ? checkToken(rt.toks.toks, m[1] ?? "", now) : null;
    if (!tok) { bump(rt.unauth, auth ? "bad-token" : "no-token"); fail(res, 401, pb, auth ? "unknown, revoked or expired token" : "missing Authorization: Bearer <token> (agentglass receive token add <host>)", [["WWW-Authenticate", "Bearer"]]); return; }
    const hs = hostStat(rt, tok.name);
    const rej = (code: number, why: string, msg: string, extra: string[][]): void => { bump(hs.rej, why); fail(res, code, pb, msg, extra); };
    if (!pb && ctype !== "application/json") { rej(415, "type", "Content-Type must be application/json or application/x-protobuf", []); return; }
    const enc = header(req, "content-encoding").trim().toLowerCase();
    if (enc && enc !== "gzip" && enc !== "identity") { rej(415, "encoding", "Content-Encoding must be gzip or none", []); return; }
    const w = window(rt, tok.name, now);
    if (w.t.length >= rt.cfg.ratePerMin) { rej(429, "rate", "more than " + String(rt.cfg.ratePerMin) + " requests a minute for " + tok.name, [["Retry-After", retryAfter(w, now)]]); return; }
    const signal = path.slice(4);
    if (rt.full && signal !== "metrics") { rej(503, "disk", "disk budget full (receive.maxDiskMB)", [["Retry-After", "60"]]); return; }
    const maxBody = rt.cfg.maxBodyMB * MB;
    const cl = header(req, "content-length");
    if (cl && (!/^\d{1,15}$/.test(cl) || Number(cl) > maxBody)) { rej(413, "size", "body over " + String(rt.cfg.maxBodyMB) + " MB", []); return; }
    const nb = rt.busy.get(tok.name) ?? 0;
    if (nb >= TOKEN_INFLIGHT) { rej(429, "rate", "more than " + String(TOKEN_INFLIGHT) + " requests in flight for " + tok.name, [["Retry-After", "1"]]); return; }
    w.t.push(now); w.b.push(0);
    if (header(req, "expect").toLowerCase() === "100-continue") res.writeContinue();
    // the body under a running cap and a timeout
    const parts: Uint8Array[] = []; let got = 0; let done = false;
    rt.inflight++; rt.busy.set(tok.name, nb + 1);
    const finish = (): void => { if (!done) { done = true; rt.inflight--; rt.busy.set(tok.name, Math.max(0, (rt.busy.get(tok.name) ?? 1) - 1)); clearTimeout(timer); } };
    const timer = setTimeout(() => { if (done) return; finish(); rej(408, "timeout", "request body not complete within " + String(BODY_MS / 1000) + " s", []); req.destroy(); }, BODY_MS);
    req.on("data", (c: Uint8Array) => {
      if (done) return;
      got += c.length;
      if (got > maxBody) { finish(); rej(413, "size", "body over " + String(rt.cfg.maxBodyMB) + " MB", []); req.destroy(); return; }
      parts.push(c);
    });
    req.on("error", () => { finish(); });
    sock.on("close", () => { finish(); }); // a client gone mid-body frees its token's slot at once (not at the body timeout)
    req.on("end", () => {
      if (done) return;
      finish();
      const at = rt.clock();
      let body: Uint8Array = new Uint8Array(got); let o = 0;
      for (let i = 0; i < parts.length; i++) { const p: Uint8Array = parts[i] ?? new Uint8Array(0); body.set(p, o); o += p.length; }
      if (signal === "metrics") { hs.metrics++; hs.last = at; send(res, 200, pb, pb ? "" : "{}", pb ? new Uint8Array(0) : null, []); return; } // accepted and discarded (Decision 4)
      const maxDec = rt.cfg.maxDecodedMB * MB;
      if (enc === "gzip") {
        const isz = gzipIsize(body);
        if (isz > maxDec) { rej(413, "decoded-size", "decompressed body over " + String(rt.cfg.maxDecodedMB) + " MB", []); return; }
        const g = gunzipCapped(body, maxDec);
        if (g.err) { if (g.err.indexOf("over") >= 0) rej(413, "decoded-size", "decompressed body over " + String(rt.cfg.maxDecodedMB) + " MB", []); else rej(400, "undecodable", "gzip: " + g.err, []); return; }
        body = g.out;
      }
      if (windowBytes(w) + body.length > rt.cfg.mbPerMin * MB) { rej(429, "rate", "more than " + String(rt.cfg.mbPerMin) + " MB a minute for " + tok.name, [["Retry-After", retryAfter(w, at)]]); return; }
      w.b[w.b.length - 1] = body.length;
      ingest(rt, res, tok, signal, pb, body, at);
    });
  };
}
// connection cap and header timeout (scriptc: no maxConnections, headersTimeout not enforced): each connection gets
// HEADER_MS to deliver its request headers, the 65th concurrent one is closed at accept
export function onConnection(rt: Rt): (s: Socket) => void {
  return (s: Socket): void => {
    if (rt.conns.length >= MAX_CONNS || rt.closing) { bump(rt.unauth, "connections"); s.destroy(); return; }
    const c: Conn = { s, t: null };
    c.t = setTimeout(() => { c.t = null; bump(rt.unauth, "header-timeout"); s.destroy(); }, HEADER_MS);
    rt.conns.push(c);
    s.on("close", () => { if (c.t) clearTimeout(c.t); const i = rt.conns.indexOf(c); if (i >= 0) rt.conns.splice(i, 1); });
    s.on("error", () => { /* closed by the peer */ });
  };
}

// ── lifecycle shared by the http and https entry points ──
// one instance per directory (spec 6): 1 = ours, 0 = another live receive holds it, -1 = the lock is not ours / unusable
export function takeRecvLock(dir: string, pid: number): number {
  const p = join(dir, "receive.lock");
  for (let i = 0; i < 2; i++) {
    if (createOwn(p, String(pid) + "\n")) return 1;
    const b = readOwn(p, myUid(), OS.fileInfo, 64); if (!b) return -1;
    const t = new TextDecoder().decode(b).trim(); const h = /^\d{1,10}$/.test(t) ? Number(t) : 0;
    if (h > 0 && h !== pid) { let alive = true; try { process.kill(h, 0); } catch (e) { alive = false; } if (alive && OS.procOwner(h) === myUid()) return 0; }
    try { unlinkSync(p); } catch (e) { return -1; }
  }
  return 0;
}
export function releaseRecvLock(dir: string): void { for (const f of ["receive.lock", "port"]) { try { unlinkSync(join(dir, f)); } catch (e) { /* gone */ } } }
// before listening: private dir, a usable token file, the lock, the first housekeeping. "" ok, else [exit code, why]
export function boot(rt: Rt): { code: number; err: string } {
  const d = dirProblem(rt.cfg.dir, true); if (d) return { code: 2, err: d };
  reloadTokens(rt.toks, rt.clock(), true);
  if (rt.toks.err) return { code: 2, err: rt.toks.err };
  const l = takeRecvLock(rt.cfg.dir, process.pid);
  if (l === 0) return { code: 3, err: "another agentglass receive serves " + rt.cfg.dir };
  if (l < 0) return { code: 2, err: join(rt.cfg.dir, "receive.lock") + " is not a regular file of yours — remove it" };
  housekeep(rt, rt.clock());
  return { code: 0, err: "" };
}
export function statusObj(rt: Rt, now: number): Obj {
  const hosts: Obj = {};
  const toks = rt.toks.toks;
  const names: string[] = []; for (const t of toks) if (names.indexOf(t.name) < 0) names.push(t.name);
  for (const k of rt.hosts.keys()) if (names.indexOf(k) < 0) names.push(k);
  for (const n of names.sort()) {
    const h = rt.hosts.get(n); const rej: Obj = {};
    if (h) for (const k of h.rej.keys()) rej[k] = h.rej.get(k) ?? 0;
    let exp = 0; let pin = h ? h.pin : ""; let active = 0;
    for (const t of toks) if (t.name === n && live(t, now)) { active++; if (t.pin) pin = t.pin; if (t.expires && (!exp || t.expires < exp)) exp = t.expires; }
    hosts[n] = { tokens: active, requests: h ? h.requests : 0, records: h ? h.records : 0, bytes: h ? h.bytes : 0, lastSeen: h ? h.last : 0, rejected: rej,
      scrubbed: h ? h.scrubbed : 0, metricsDiscarded: h ? h.metrics : 0, hostId: pin, tokenExpires: exp, heartbeatSkewMs: h && h.beatAt ? h.skewMs : null };
  }
  const un: Obj = {}; for (const k of rt.unauth.keys()) un[k] = rt.unauth.get(k) ?? 0;
  return { pid: process.pid, listen: rt.cfg.listen, port: rt.port, dir: rt.cfg.dir, startedAt: rt.started, at: now, hosts, refused: un,
    disk: { usedBytes: rt.used, todayBytes: rt.todayB, maxBytes: rt.cfg.maxDiskMB * MB, full: rt.full }, retentionDays: rt.cfg.retentionDays, tls: rt.tlsNote, tlsExpires: rt.tlsExpires };
}
export function writeStatus(rt: Rt, now: number): void { writePrivate(join(rt.cfg.dir, "status.json"), JSON.stringify(statusObj(rt, now)) + "\n"); }
// after listen: the port file, the 10 s status flush and the 10 min housekeeping; returns a stop function
export function started(rt: Rt, port: number): () => void {
  rt.port = port;
  writePrivate(join(rt.cfg.dir, "port"), String(port) + "\n");
  writeStatus(rt, rt.clock());
  const st = setInterval(() => { writeStatus(rt, rt.clock()); }, 10000);
  const hk = setInterval(() => { housekeep(rt, rt.clock()); }, 600000);
  return (): void => { clearInterval(st); clearInterval(hk); };
}
// SIGTERM/SIGINT (spec 6): stop accepting, give requests in flight up to 5 s, release the lock, exit 0
export function onSignals(rt: Rt, close: (done: () => void) => void, stop: () => void): void {
  const quit = (): void => {
    if (rt.closing) return;
    rt.closing = true; stop();
    const end = (): void => { writeStatus(rt, rt.clock()); releaseRecvLock(rt.cfg.dir); process.exit(0); };
    close(() => { /* every connection ended */ });
    const t0 = rt.clock();
    const poll = setInterval(() => { if (rt.inflight === 0 || rt.clock() - t0 > 5000) { clearInterval(poll); for (const c of rt.conns) c.s.destroy(); end(); } }, 50);
  };
  process.on("SIGTERM", quit); process.on("SIGINT", quit);
}
