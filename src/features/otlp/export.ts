// agentglass — `agentglass export --otlp <url>`: history and backfill to any OTLP/HTTP backend, resumable, no duplicates
// SPDX-License-Identifier: Apache-2.0
import { writeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { H, complete, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import type { Sess } from "../../model/types.ts";
import { sessions, loadHead } from "../../model/sessions.ts";
import { harnessIds, isHarness, epochOf } from "../../harness/index.ts";
import { HOME } from "../../util/fs.ts";
import { curlBin, otlpDir } from "../../util/http.ts";
import { gzipProbe } from "../../util/gzip.ts";
import { dayKey } from "../usage/record.ts";
import { parse as parseQuery } from "../query/parse.ts";
import type { Clause } from "../query/types.ts";
import { type Compiled, compile, sessMatches } from "../query/eval.ts";
import { discover, opts as watchOpts, watch } from "../cli.ts";
import { agentScope, visible, errLine } from "../agentenv.ts";
import { opt, setOptions } from "../clihelp.ts";
import { newLive, liveTick, liveStop } from "./live.ts";
import { type XTurn } from "./types.ts";
import { newSessB, finish, fxChat } from "./build.ts";
import { encodeRequest } from "./encode.ts";
import { type OtlpCfg, loadCfg, envMap, endpointOf, expandHeaders, plainOk, safeUrl } from "./config.ts";
import { type ExpState, loadState, saveState, lock, unlock, marked, markTurn, markFx } from "./state.ts";
import { type Native, detectNative, applyPolicy, projectDirs } from "./native.ts";
import { GZ, sendBatch } from "./send.ts";

export interface ExOpts {
  url: string; since: number; until: number; harness: string; ids: string[]; filter: string; subagents: boolean;
  native: string; status: boolean; content: boolean; resend: boolean; dry: boolean; batch: number; compression: string; json: boolean;
}
const MAX_BYTES = 4194304; // one request body at most (spec 5.1)
const QUIET_MS = 600000; // one-shot: a turn without a close marker counts as finished after 10 quiet minutes

// local midnight of a YYYY-MM-DD day (the runtime parses ISO dates as UTC only)
function localMidnight(day: string): number {
  const u = Date.parse(day + "T00:00:00Z"); if (!(u > 0)) return NaN;
  const d = new Date(u); const mins = d.getHours() * 60 + d.getMinutes();
  return dayKey(d) === day ? u - mins * 60000 : u + (1440 - mins) * 60000;
}
// 30m | 24h | 7d | YYYY-MM-DD | all → epoch ms (0 = no bound); NaN = invalid
export function timeArg(v: string, now: number): number {
  if (v === "all") return 0;
  const m = /^(\d+)([mhd])$/.exec(v);
  if (m) return now - Number(m[1] ?? "0") * (m[2] === "m" ? 60000 : m[2] === "h" ? 3600000 : 86400000);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return localMidnight(v);
  return NaN;
}
function clauseText(c: Clause): string { return (c.neg ? "not " : "") + c.key + " " + c.op + " " + c.vals.join(","); }
// session clauses only: a call/day/content clause selects calls or days, not whole sessions
export function sessFilter(src: string): { f: Compiled | null; err: string } {
  if (!src.trim()) return { f: null, err: "" };
  const p = parseQuery(src);
  if (p.err) return { f: null, err: "--filter: " + p.err.msg + " (at column " + String(p.err.col + 1) + ")" };
  for (const c of p.cs) {
    const one = compile([c], "json");
    const f = one.f;
    if (one.err) return { f: null, err: "--filter: " + one.err.msg };
    if (f && (f.day.length || f.call.length || f.dayKeys !== null || f.content.length || f.rowx.length)) return { f: null, err: "export --filter takes session clauses only: " + clauseText(c) };
  }
  const all = compile(p.cs, "json");
  return all.err ? { f: null, err: "--filter: " + all.err.msg } : { f: all.f, err: "" };
}
// an http(s) URL without spaces or control characters (it goes into curl's config as one line)
export function urlErr(url: string): string {
  return /^https?:\/\/[^/\s]/i.test(url) && !/[\s\u0000-\u001f\u007f]/.test(url) ? "" : "--otlp needs an http(s) URL (got " + safeUrl(url).replace(/[\u0000-\u001f\u007f]/g, "?") + ")";
}
// export's options: the JSON help lists them, `export --help` prints them (cli.ts, from the record)
setOptions("export", [
  opt("--otlp", "<url>", "the OTLP/HTTP endpoint (else otlp.endpoint, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_ENDPOINT)", "", []),
  opt("--since", "30m|24h|7d|YYYY-MM-DD|all", "send what happened from then on", "7d", []),
  opt("--until", "30m|24h|7d|YYYY-MM-DD", "and up to then", "", []),
  opt("--harness", harnessIds().join("|"), "only this harness", "", harnessIds()),
  opt("--session", "<id>", "only this session (repeatable)", "", []),
  opt("--filter", "'<session clauses>'", "only the matching sessions (repeatable, ANDed)", "", []),
  opt("--no-subagents", "", "leave subagent sessions out", "", []),
  opt("--content", "", "also send prompts, outputs and tool I/O, each cut to otlp.contentMax", "off", []),
  opt("--resend", "", "send again what the endpoint already accepted (same ids)", "", []),
  opt("--dry-run", "", "print the OTLP/JSON requests, send nothing", "", []),
  opt("--batch", "N", "spans per request, 1–100000 (at most 4 MB)", "otlp.batch, 512", []),
  opt("--compression", "gzip|none", "request body compression", "otlp.compression, gzip", ["gzip", "none"]),
  opt("--native", "warn|skip|include", "turns of a harness that exports OTLP itself: warn, leave new ones to it, or send", "otlp.native, warn", ["warn", "skip", "include"]),
  opt("--status", "", "the last export to the endpoint, gzip support, the harnesses' own telemetry", "", []),
  opt("--json", "", "the summary as JSON on stdout", "", []),
]);
export function parseExport(args: string[], c: OtlpCfg, now: number, env: Map<string, string>): { o: ExOpts; err: string } {
  const o: ExOpts = { url: "", since: now - 7 * 86400000, until: 0, harness: "", ids: [], filter: "", subagents: true, native: c.native, status: false, content: c.content, resend: false, dry: false, batch: c.batch, compression: "", json: false };
  let flag = "";
  const val = (i: number, name: string): string => { const v = args[i + 1]; if (v === undefined || v.startsWith("--")) throw new Error(name + " needs a value"); return v; };
  try {
    for (let i = 1; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a === "--otlp") { flag = val(i, a); i++; }
      else if (a === "--since" || a === "--until") { const v = val(i, a); i++; const t = timeArg(v, now); if (isNaN(t)) throw new Error(a + " takes 30m, 24h, 7d, YYYY-MM-DD or all (got " + v + ")"); if (a === "--since") o.since = t; else o.until = t; }
      else if (a === "--harness") { o.harness = val(i, a); i++; if (!isHarness(o.harness)) throw new Error("--harness must be one of " + harnessIds().join(", ")); }
      else if (a === "--session") { o.ids.push(val(i, a)); i++; }
      else if (a === "--filter") { o.filter = o.filter ? o.filter + " and " + val(i, a) : val(i, a); i++; }
      else if (a === "--subagents") o.subagents = true;
      else if (a === "--no-subagents") o.subagents = false;
      else if (a === "--native") { o.native = val(i, a); i++; if (["warn", "skip", "include"].indexOf(o.native) < 0) throw new Error("--native takes warn, skip or include"); }
      else if (a === "--status") o.status = true;
      else if (a === "--content") o.content = true;
      else if (a === "--resend") o.resend = true;
      else if (a === "--dry-run") o.dry = true;
      else if (a === "--batch") { const n = Number(val(i, a)); i++; if (!(Number.isInteger(n) && n >= 1 && n <= 100000)) throw new Error("--batch needs a whole number of spans, 1–100000"); o.batch = n; }
      else if (a === "--compression") { o.compression = val(i, a); i++; if (o.compression !== "gzip" && o.compression !== "none") throw new Error("--compression takes gzip or none"); }
      else if (a === "--json") o.json = true;
      else if (a === "--redact" || a === "--agent" || a === "--no-agent" || a === "--all-projects" || a === "--project-only") { /* read at startup (redact-on.ts, agentenv.ts) */ }
      else throw new Error("unknown option " + a + " (agentglass export --help lists the options)");
    }
  } catch (e) { return { o, err: e instanceof Error ? e.message : String(e) }; }
  if (o.until > 0 && o.until <= o.since) return { o, err: "--until must be after --since" };
  const sf = sessFilter(o.filter); if (sf.err) return { o, err: sf.err };
  o.url = endpointOf(flag, c, env);
  if (!o.url && !o.dry && !o.status) return { o, err: "no endpoint: pass --otlp <url>, set \"otlp\": {\"endpoint\": …} in ~/.agentglass/config.json, or OTEL_EXPORTER_OTLP_ENDPOINT" };
  const ue = o.url ? urlErr(o.url) : ""; if (ue) return { o, err: ue };
  return { o, err: "" };
}

// whole turns per request, ≤ max spans and ≤ maxBytes; a turn larger than either goes alone, split by spans only when its
// body alone exceeds maxBytes (its requests share the turn: it is marked when all of them got through)
export interface Batch { turns: XTurn[]; json: string; spans: number }
function part(t: XTurn, from: number, to: number): XTurn {
  return { h: t.h, rootId: t.rootId, path: t.path, key: t.key, index: t.index, traceId: t.traceId, t0: t.t0, t1: t.t1, closed: t.closed, closedBy: t.closedBy, compacted: t.compacted, ver: t.ver, cwd: t.cwd, branch: t.branch, remote: t.remote, spans: t.spans.slice(from, to), fx: t.fx, fxOn: t.fxOn };
}
export function batches(turns: XTurn[], max: number, maxBytes: number, c: OtlpCfg): Batch[] {
  const out: Batch[] = []; let cur: XTurn[] = []; let n = 0; let bytes = 0;
  const flush = (): void => { if (cur.length) out.push({ turns: cur, json: encodeRequest(cur, c), spans: n }); cur = []; n = 0; bytes = 0; };
  for (const t of turns) {
    const one = encodeRequest([t], c); const sz = one.length;
    if (t.spans.length > max || sz > maxBytes) {
      flush();
      if (sz <= maxBytes) { out.push({ turns: [t], json: one, spans: t.spans.length }); continue; }
      let k = Math.max(1, Math.ceil(t.spans.length * maxBytes / sz / 2)); // spans per piece: about half the limit's worth
      let i = 0;
      while (i < t.spans.length) {
        const p = part(t, i, Math.min(t.spans.length, i + k)); const js = encodeRequest([p], c);
        if (js.length > maxBytes && k > 1) { k = Math.max(1, Math.floor(k / 2)); continue; }
        out.push({ turns: [p], json: js, spans: p.spans.length }); i += p.spans.length;
      }
      continue;
    }
    if (cur.length && (n + t.spans.length > max || bytes + sz > maxBytes)) flush();
    cur.push(t); n += t.spans.length; bytes += sz;
  }
  flush();
  return out;
}

// a send's bookkeeping: a turn is accepted (marked, its fx totals the new base) once every request carrying a part of it
// got through; a failed part keeps the whole turn for the retry
export interface Acks { left: Map<string, number>; failed: Set<string> }
function tkey(t: XTurn): string { return t.path + "\u0000" + t.key; }
export function acks(bs: Batch[]): Acks {
  const left = new Map<string, number>(); for (const x of bs) for (const t of x.turns) left.set(tkey(t), (left.get(tkey(t)) ?? 0) + 1);
  return { left, failed: new Set<string>() };
}
// the turns this request completed
export function ack(a: Acks, x: Batch, ok: boolean): XTurn[] {
  const out: XTurn[] = [];
  for (const t of x.turns) {
    const k = tkey(t);
    if (!ok) { a.failed.add(k); continue; }
    const n = (a.left.get(k) ?? 1) - 1; a.left.set(k, n);
    if (n <= 0 && !a.failed.has(k)) out.push(t);
  }
  return out;
}

// ── selection and building ──
interface Sel { roots: Sess[]; warns: string[] }
function select(o: ExOpts): Sel {
  const f = sessFilter(o.filter).f;
  const roots: Sess[] = []; const sc = agentScope(process.argv.slice(2)); // inside a coding agent: its project only, unless widened
  for (const s of sessions.values()) {
    if (s.parent && s.depth > 0) continue; // subagents travel with their root session
    if (!visible(s, sc)) continue;
    if (o.harness && s.h !== o.harness) continue;
    if (o.ids.length && !o.ids.some((id: string) => s.id === id || s.id.startsWith(id))) continue;
    if (o.since > 0 && s.mtime > 0 && s.mtime < o.since) continue; // nothing written since: no turn starts inside
    if (f && !sessMatches(f, s)) continue;
    roots.push(s);
  }
  roots.sort((a, b) => a.mtime - b.mtime || (a.path < b.path ? -1 : 1));
  return { roots, warns: [] };
}
// fx keeps session totals only (usage-v2.json): the newest turn of a session in a send carries what grew since the totals
// this endpoint already accepted (all of it with resend); the session's older turns carry none, so a failed request loses
// nothing and no sum over the backend counts twice. A turn older than the accepted one sends nothing (it was covered);
// a newer one with smaller totals means a rewritten usage file: it sends its totals whole. Recomputed from the turn's own
// totals on every call: a retry sends the same delta.
export function fxDelta(turns: XTurn[], st: ExpState | null, resend: boolean): void {
  const top = new Map<string, XTurn>();
  for (const t of turns) { if (!t.fx.length) continue; const p = top.get(t.path); if (!p || t.t0 >= p.t0) top.set(t.path, t); }
  for (const t of turns) {
    const c = t.fx.length ? fxChat(t) : null; if (!c) continue;
    const m = !resend && st ? st.sessions.get(t.path) : undefined; const base = m ? m.fx : []; const at = m ? m.fxAt : 0;
    let back = false; for (let i = 0; i < t.fx.length; i++) if ((t.fx[i] ?? 0) < (base[i] ?? 0)) back = true;
    const on = top.get(t.path) === t && t.t0 >= at;
    const d = t.fx.map((v: number, i: number) => !on ? 0 : back ? v : v - (base[i] ?? 0));
    c.nIn = d[0] ?? 0; c.nOut = d[1] ?? 0; c.cr = d[2] ?? 0; c.cw = d[3] ?? 0; c.cost = d[4] ?? 0; c.unk = d[5] ?? 0;
    c.hasUsage = d.some((v: number) => v > 0); c.total = c.hasUsage; t.fxOn = on;
  }
}
// a turn the endpoint accepted (after markTurn): the totals it carried the delta up to become the new base
export function fxAccepted(st: ExpState, t: XTurn): void { if (t.fxOn) markFx(st, t.path, t.fx, t.t0); }
export interface Built { turns: XTurn[]; sessions: number; marked: number; native: number; warns: string[] }
// every selected session's closed turns that start in [since, until), not yet marked (unless resend), not left to the harness
export function build(o: ExOpts, st: ExpState | null, skipFrom: Map<string, number>, now: number): Built {
  const r: Built = { turns: [], sessions: 0, marked: 0, native: 0, warns: [] };
  const sel = select(o);
  for (const s of sel.roots) {
    let ts: XTurn[] = [];
    try {
      complete(s); // billing label (honest-costs) and the ledger's view of the session
      ts = finish(newSessB(s, o.subagents ? s.subs : []), { now, quietMs: QUIET_MS, content: o.content, subagents: o.subagents });
    } catch (e) { r.warns.push("skipped " + s.h + " session " + s.id + ": " + (e instanceof Error ? e.message : String(e))); continue; }
    let any = false;
    for (const t of ts) {
      if (t.t0 < o.since || (o.until > 0 && t.t0 >= o.until)) continue;
      if (st && !o.resend && marked(st, s.path, t.key)) { r.marked++; continue; }
      const sk = skipFrom.get(s.h); if (sk !== undefined && t.t0 >= sk) { r.native++; continue; }
      r.turns.push(t); any = true;
    }
    if (any) r.sessions++;
  }
  return r;
}
function nativeNow(roots: Sess[]): Native[] {
  const pids = new Map<string, number[]>();
  for (const s of sessions.values()) {
    if (s.pid > 0) { const l = pids.get(s.h) ?? []; if (l.indexOf(s.pid) < 0) l.push(s.pid); pids.set(s.h, l); }
  }
  for (const s of roots) if (s.h === "gemini" && !s.cwd && !s.headDone) loadHead(s); // its cwd comes from the log
  return detectNative(pids, HOME, projectDirs(roots));
}

// ── output ──
function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
// a failure: inside an agent one JSON line {"error": {code, message}}, else "agentglass: msg" (as err)
function fail(code: string, msg: string): void { errLine("agentglass", code, msg, ""); }
function err(line: string): void { try { writeSync(2, "agentglass: " + line + "\n"); } catch (e) { /* closed */ } }
function when(ms: number): string { return ms > 0 ? new Date(ms).toISOString() : "never"; }
function realSleep(ms: number): void { try { execFileSync("sleep", [String(Math.max(0, ms) / 1000)]); } catch (e) { /* interrupted */ } }

export function dryRun(o: ExOpts, c: OtlpCfg, now: number): string[] {
  const st = o.url ? loadState(o.url) : null;
  const b = build(o, st, new Map<string, number>(), now);
  fxDelta(b.turns, st, o.resend);
  c.content = o.content;
  return batches(b.turns, o.batch, MAX_BYTES, c).map((x: Batch) => x.json);
}
function status(o: ExOpts, c: OtlpCfg): number {
  const st = o.url ? loadState(o.url) : null;
  const ns = nativeNow(select(o).roots);
  const gz = o.compression || c.compression;
  const probe = (() => { const d = join(otlpDir(), "tmp"); try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch (e) { /* exists */ } return gzipProbe(d); })();
  const gzState = gz === "none" ? "off (compression none)" : !probe ? "off (this build cannot write compressed bodies)" : st && !st.gzip ? "off (" + (st.gzipNote || "the endpoint refused gzip") + "; --compression gzip tries again)" : "on";
  if (o.json) {
    const hs = ns.map((n: Native) => ({ harness: n.h, native: n.on, source: n.src || null, nativeSince: st && st.nativeSince.has(n.h) ? when(st.nativeSince.get(n.h) ?? 0) : null }));
    out(JSON.stringify({ endpoint: o.url ? safeUrl(o.url) : null, policy: o.native, lastExport: st && st.last ? when(st.last) : null, gzip: gzState, sessions: st ? st.sessions.size : 0, harnesses: hs }));
    return 0;
  }
  out("endpoint     " + (o.url ? safeUrl(o.url) : "(none set)"));
  out("policy       --native " + o.native + (o.native === "warn" ? " (export everything, warn about harnesses that export themselves)" : ""));
  out("last export  " + (st ? when(st.last) : "never") + (st ? "  (" + String(st.sessions.size) + " sessions tracked)" : ""));
  out("gzip         " + gzState);
  out("");
  out("harness   own OTLP export   since (skip policy)        source");
  for (const n of ns) {
    const since = st && st.nativeSince.has(n.h) ? when(st.nativeSince.get(n.h) ?? 0) : "-";
    out(n.h.padEnd(10) + n.on.padEnd(18) + since.padEnd(27) + (n.src || "-"));
  }
  return 0;
}
// exit 0 = everything sent (or nothing to send), 1 = some requests failed (the rest is marked), 2 = usage, 3 = locked
export function runExport(o: ExOpts, c: OtlpCfg): number {
  const now = Date.now();
  c.content = o.content; // the flag adds to the config
  for (const w of c.warns) err(w);
  if (o.status) return status(o, c);
  if (o.dry) { for (const l of dryRun(o, c, now)) out(l); return 0; }
  if (!curlBin()) { fail("usage", "export needs curl (AGENTGLASS_CURL)"); return 2; }
  const hx = expandHeaders(c, envMap());
  if (hx.err) { fail("usage", hx.err); return 2; }
  const pe = plainOk(o.url, c, hx.headers.length > 0); if (pe) { fail("usage", pe); return 2; }
  const held = lock(o.url);
  if (held !== 0) { fail("busy", "another export to " + safeUrl(o.url) + " is running, pid " + String(held)); return 3; }
  try {
    const st = loadState(o.url); if (st.warn) err(st.warn);
    const ns = nativeNow(select(o).roots);
    const pol = applyPolicy(ns, o.native, st, now);
    for (const n of pol.notes) err(n);
    const b = build(o, st, pol.skipFrom, now);
    for (const w of b.warns) err(w);
    fxDelta(b.turns, st, o.resend);
    // compression: config/flag, the endpoint's record, and whether this runtime can write the bytes
    let gz = (o.compression || c.compression) === "gzip";
    if (gz && !st.gzip && o.compression !== "gzip") { gz = false; err(safeUrl(o.url) + " takes uncompressed JSON only (" + (st.gzipNote || "recorded earlier") + "); --compression gzip tries again"); }
    if (gz) { const d = join(otlpDir(), "tmp"); try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch (e) { /* exists */ } if (!gzipProbe(d)) { gz = false; GZ.note = "this build cannot write compressed bodies: sending uncompressed"; err(GZ.note); } }
    const bs = batches(b.turns, o.batch, MAX_BYTES, c);
    const ak = acks(bs);
    let spans = 0; let reqs = 0; let bad = 0; let rejected = 0; const msgs: string[] = []; const sent = new Set<string>(); const sess = new Set<string>();
    for (const x of bs) {
      const r = sendBatch({ url: o.url, headers: hx.headers, timeoutS: c.timeoutS, gzip: gz && !GZ.off, live: false }, x.json, realSleep);
      reqs++;
      if (r.gzipRefused) { gz = false; st.gzip = false; st.gzipNote = "refused gzip on " + new Date().toISOString().slice(0, 10); err(safeUrl(o.url) + " refused gzip: sending uncompressed JSON (remembered; --compression gzip tries again)"); }
      const done = ack(ak, x, r.ok);
      if (r.ok) {
        spans += x.spans; rejected += r.rejected; if (r.msg) msgs.push(r.msg);
        for (const t of done) { const ss = sessions.get(t.path); markTurn(st, t.path, t.h, t.rootId, ss ? epochOf(ss) : "", t.key); fxAccepted(st, t); sent.add(tkey(t)); sess.add(t.path); }
        st.last = Date.now(); saveState(o.url, st); // an interrupted run keeps what got through
      } else { bad++; msgs.push(r.msg); }
    }
    if (o.compression === "gzip" && !st.gzip && bad === 0 && bs.length) { st.gzip = true; st.gzipNote = ""; }
    saveState(o.url, st);
    const summary = { endpoint: safeUrl(o.url), spans, turns: sent.size, sessions: sess.size, requests: reqs, failedRequests: bad, rejectedSpans: rejected, skippedMarked: b.marked, skippedNative: b.native, errors: msgs.slice(0, 10) };
    if (o.json) out(JSON.stringify(summary));
    else if (!bs.length) err("nothing to export" + (b.marked ? " (" + String(b.marked) + " turns already sent — --resend sends them again)" : "") + (b.native ? " (" + String(b.native) + " turns left to the harnesses' own export)" : ""));
    else {
      err("exported " + String(spans) + " spans in " + String(sent.size) + " turns from " + String(sess.size) + " sessions (" + String(reqs) + " requests)" + (rejected ? ", " + String(rejected) + " spans rejected by the backend" : ""));
      if (bad) err(String(bad) + " of " + String(reqs) + " requests failed: " + (msgs[msgs.length - 1] ?? "") + " — run export again to retry them");
    }
    return bad ? 1 : 0;
  } finally { unlock(o.url); }
}

// ── agentglass --watch --otlp <url> ──
function liveExport(args: string[]): number {
  const c = loadCfg(); const env = envMap(); const now = Date.now();
  for (const w of c.warns) err(w);
  let flag = ""; let since = now; let subagents = true; let native = c.native; let comp = ""; let batch = c.batch; let filter = ""; let harness = "";
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ""; const v = args[i + 1] ?? "";
    if (a === "--otlp") { flag = v; i++; }
    else if (a === "--since") { const t = timeArg(v, now); if (isNaN(t)) { fail("usage", "--since takes 30m, 24h, 7d, YYYY-MM-DD or all (got " + v + ")"); return 2; } since = t; i++; }
    else if (a === "--content") c.content = true;
    else if (a === "--no-subagents") subagents = false;
    else if (a === "--native") { native = v; i++; if (["warn", "skip", "include"].indexOf(native) < 0) { fail("usage", "--native takes warn, skip or include"); return 2; } }
    else if (a === "--compression") { comp = v; i++; if (comp !== "gzip" && comp !== "none") { fail("usage", "--compression takes gzip or none"); return 2; } }
    else if (a === "--batch") { batch = Number(v); i++; if (!(Number.isInteger(batch) && batch >= 1 && batch <= 100000)) { fail("usage", "--batch needs a whole number of spans, 1–100000"); return 2; } }
    else if (a === "--filter") { filter = filter ? filter + " and " + v : v; i++; }
    else if (a === "--harness") { harness = v; i++; if (!isHarness(harness)) { fail("usage", "--harness must be one of " + harnessIds().join(", ")); return 2; } }
  }
  const sf = sessFilter(filter); if (sf.err) { fail("usage", sf.err); return 2; }
  const url = endpointOf(flag.startsWith("--") ? "" : flag, c, env);
  if (!url) { fail("usage", "--otlp needs a URL"); return 2; }
  const ue = urlErr(url); if (ue) { fail("usage", ue); return 2; }
  if (!curlBin()) { fail("usage", "export needs curl (AGENTGLASS_CURL)"); return 2; }
  const hx = expandHeaders(c, envMap()); if (hx.err) { fail("usage", hx.err); return 2; }
  const pe = plainOk(url, c, hx.headers.length > 0); if (pe) { fail("usage", pe); return 2; }
  const held = lock(url); if (held !== 0) { fail("busy", "another export to " + safeUrl(url) + " is running, pid " + String(held)); return 3; }
  const st = loadState(url); if (st.warn) err(st.warn);
  let gz = (comp || c.compression) === "gzip" && (st.gzip || comp === "gzip");
  if (gz) { const d = join(otlpDir(), "tmp"); try { mkdirSync(d, { recursive: true, mode: 0o700 }); } catch (e) { /* exists */ } if (!gzipProbe(d)) { gz = false; err("this build cannot write compressed bodies: sending uncompressed"); } }
  const cf = sf.f; // session clauses select what is exported
  const L = newLive(since); L.content = c.content; L.subagents = subagents;
  const sc = agentScope(args);
  L.want = (s: Sess): boolean => (!harness || s.h === harness) && (!cf || sessMatches(cf, s)) && visible(s, sc);
  let skipFrom = new Map<string, number>(); let nativeAt = 0;
  L.skip = (t: XTurn): boolean => { const sk = skipFrom.get(t.h); return marked(st, t.path, t.key) || (sk !== undefined && t.t0 >= sk); };
  const sendWith = (timeoutS: number) => (turns: XTurn[]): boolean => {
    let all = true;
    fxDelta(turns, st, false);
    const bs = batches(turns, batch, MAX_BYTES, c); const ak = acks(bs);
    for (const x of bs) {
      const r = sendBatch({ url, headers: hx.headers, timeoutS, gzip: gz && !GZ.off, live: true }, x.json, realSleep);
      if (r.gzipRefused) { gz = false; st.gzip = false; st.gzipNote = "refused gzip on " + new Date().toISOString().slice(0, 10); err(safeUrl(url) + " refused gzip: sending uncompressed JSON"); }
      const done = ack(ak, x, r.ok);
      if (!r.ok) { all = false; if (L.fails === 0) err("otlp: " + r.msg + " — retrying with backoff"); continue; }
      if (r.msg) err("otlp: " + r.msg);
      for (const t of done) { const ss = sessions.get(t.path); markTurn(st, t.path, t.h, t.rootId, ss ? epochOf(ss) : "", t.key); fxAccepted(st, t); }
      st.last = Date.now(); saveState(url, st);
    }
    return all;
  };
  const send = sendWith(c.timeoutS);
  let statusAt = now;
  err("otlp: exporting finished turns to " + safeUrl(url) + (since < now ? " (catching up since " + new Date(since).toISOString() + ")" : "") + "; Ctrl+C stops");
  watch(watchOpts(args), {
    tick: (t: number): void => {
      if (t - nativeAt >= 60000) { // the harnesses' own export: re-checked every minute
        nativeAt = t;
        const roots: Sess[] = []; for (const s of sessions.values()) if (L.b.has(s.path)) roots.push(s);
        const d = applyPolicy(nativeNow(roots), native, st, t); skipFrom = d.skipFrom;
        for (const n of d.notes) err(n);
      }
      liveTick(L, t, send);
      if (t - statusAt >= 60000) { statusAt = t; err("otlp: " + String(L.sent) + " spans sent, " + String(L.qSpans) + " queued, last ok " + (L.lastOk ? new Date(L.lastOk).toISOString() : "never")); }
    },
    stop: (): void => { try { liveStop(L, sendWith(Math.min(5, c.timeoutS)), 5000); saveState(url, st); } finally { unlock(url); } },
  });
  return -1; // the poll loop keeps the process alive
}

// first in line: the generic CLI handler would take `export --json` for a --json snapshot (and --watch for plain JSONL)
H.cli.unshift((args: string[]): boolean => {
  if (args.indexOf("--watch") >= 0 && args.indexOf("--otlp") >= 0) { S.cli = true; const rc = liveExport(args); if (rc >= 0) process.exit(rc); return true; }
  if (args[0] !== "export" || args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) return false; // export --help: the generic help handler
  S.cli = true;
  const c = loadCfg();
  const p = parseExport(args, c, Date.now(), envMap());
  if (p.err) { fail("usage", p.err); process.exit(2); }
  discover();
  process.exit(runExport(p.o, c));
  return true;
});
