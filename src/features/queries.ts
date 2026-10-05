// agentglass — agent-facing queries: session <ref>, sessions, errors, cost rows (one formatter, project scope inside an agent)
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../model/types.ts";
import { writeSync } from "node:fs";
import { type Obj, base } from "../util/json.ts";
import { H, complete, display, realCwd, screenOut } from "../hooks.ts";
import { S } from "../state.ts";
import { sessions, loadHead, loadTail, subActive } from "../model/sessions.ts";
import { harnessOf, sourceOf, parseEvents, window, isHarness, harnessIds } from "../harness/index.ts";
import { accOf, ledger, rowsOf } from "./usage/ledger.ts";
import { type Acc, modelUses, isoMs, dayKey, heavy } from "./usage/record.ts";
import { type Call, ROWS, DICT, nameOf, localOf } from "./usage/facts.ts";
import { callCutoff } from "./usage/callcache.ts";
import { sessMatches, dayMatches, eachCall } from "./query/eval.ts";
import { sessDim } from "./query/agg.ts";
import { repoShown } from "./query/project.ts";
import { type CliFilter, cliFilter, cliSelect } from "./query/cli.ts";
import { type Rec, type TS, newTS, HB, pct } from "./usage/calls.ts";
import { sessionBill } from "./usage/bill-live.ts";
import { type Src, buildGraph, summary } from "./callgraph/model.ts";
import { loopRuns } from "./detect.ts";
import { scrubText } from "./redact.ts";
import { REDACT } from "./redact-on.ts";
import { jsonSess, discover, JSON_FIELDS } from "./cli.ts";
import { peers } from "./vcs/json.ts";
import { type CmdRec, type OptRec, addCmd, opt } from "./clihelp.ts";
import { type Fmt, fmtArgs, formatRows } from "./format.ts";
import { type Scope, agentHost, agentScope, visible, cliError, realDir } from "./agentenv.ts";
import { type Found, resolveRef } from "../model/sessref.ts";

function r6(c: number): number { return Math.round(c * 1e6) / 1e6; }
// per model over the sessions (their ledger accs, filled by complete()) and local days (null = all): cost desc, then tokens;
// costUsd null when the model has unpriced tokens and no priced cost (unpriced usage never shows as $0)
export function modelRows(ss: Sess[], days: string[] | null): Obj[] {
  const by = new Map<string, number[]>(); // model → [in, out, cacheRead, cacheWrite, cost, unpriced]
  for (const s of ss) for (const u of modelUses(accOf(s), days)) {
    let r = by.get(u.model); if (!r) { r = [0, 0, 0, 0, 0, 0]; by.set(u.model, r); }
    r[0] = (r[0] ?? 0) + u.inTok; r[1] = (r[1] ?? 0) + u.outTok; r[2] = (r[2] ?? 0) + u.cr; r[3] = (r[3] ?? 0) + u.cw; r[4] = (r[4] ?? 0) + u.cost; r[5] = (r[5] ?? 0) + u.unk;
  }
  const ks = [...by.keys()];
  const tok = (k: string): number => { const r = by.get(k) ?? []; return (r[0] ?? 0) + (r[1] ?? 0) + (r[2] ?? 0) + (r[3] ?? 0); };
  const cost = (k: string): number => { const r = by.get(k) ?? []; return r[4] ?? 0; };
  ks.sort((x, y) => cost(y) - cost(x) || tok(y) - tok(x) || (x < y ? -1 : x > y ? 1 : 0));
  const out: Obj[] = [];
  for (const k of ks) {
    const r = by.get(k) ?? []; const c = r[4] ?? 0; const unk = r[5] ?? 0;
    out.push({ model: k, in: r[0] ?? 0, out: r[1] ?? 0, cacheRead: r[2] ?? 0, cacheWrite: r[3] ?? 0, costUsd: c === 0 && unk > 0 ? null : r6(c), unpricedTokens: unk });
  }
  return out;
}

// the session's subagents (by parent id, newest first) — without buildView()
export function kidsOf(s: Sess): Sess[] {
  const out: Sess[] = [];
  if (s.parent) return out;
  for (const k of sessions.values()) if (k.parent === s.id && k.h === s.h) out.push(k);
  return out.sort((a, b) => b.mtime - a.mtime);
}
// every event of a session, read whole in 4 MB windows
export function allEvents(s: Sess): Ev[] {
  const src = sourceOf(s.h); const st = src.stat(s); const evs: Ev[] = [];
  if (!st) return evs;
  let at = 0;
  while (at < st.size) {
    const r = src.lines(s, at, Math.min(st.size, at + window(src, 4194304)));
    for (const l of r.lines) parseEvents(s.h, l, evs, s);
    if (r.next <= at) break;
    at = r.next;
  }
  return evs;
}
function spawnOf(s: Sess): string { const f = harnessOf(s.h).spawnOf; return f ? f(s) : ""; }
const TEXT_MAX = 200;
export function errText(t: string): string { const c = t.length > TEXT_MAX ? t.slice(0, TEXT_MAX) : t; return REDACT ? scrubText(c) : c; }
function argOf(tool: string, arg: string, s: Sess): string { return REDACT ? display("tool:" + tool, arg, s) : arg; }

// per tool over sessions: calls, errors, p50/max duration (from the duration histogram), most calls first
export function toolRows(ss: Sess[], max: number): Obj[] {
  const by = new Map<string, TS>();
  for (const s of ss) for (const d of accOf(s).days.values()) for (const [name, t] of heavy(d).tt) {
    let m = by.get(name); if (!m) { m = newTS(); by.set(name, m); }
    m.n = m.n + t.n; m.err = m.err + t.err; m.dn = m.dn + t.dn; if (t.max > m.max) m.max = t.max;
    for (let i = 0; i < HB; i++) m.hist[i] = (m.hist[i] ?? 0) + (t.hist[i] ?? 0);
  }
  const ks = [...by.keys()];
  const n = (k: string): number => { const t = by.get(k); return t ? t.n : 0; };
  ks.sort((x, y) => n(y) - n(x) || (x < y ? -1 : x > y ? 1 : 0));
  const out: Obj[] = [];
  for (const k of ks.slice(0, max)) { const t = by.get(k) ?? newTS(); const p = pct(t.hist, 0.5, t.max); out.push({ name: display("tool", k, null), calls: t.n, errors: t.err, p50Ms: t.dn > 0 && p >= 0 ? p : null, maxMs: t.dn > 0 ? t.max : null }); }
  return out;
}
// changed files over sessions (+/- lines), most changed first
export function fileRows(ss: Sess[], max: number): Obj[] {
  const by = new Map<string, number[]>(); // path → [add, del]
  const own = new Map<string, Sess>();
  for (const s of ss) for (const d of accOf(s).days.values()) for (const [k, c] of heavy(d).files) {
    const p = k.slice(k.indexOf("\t") + 1); if (!p) continue;
    let r = by.get(p); if (!r) { r = [0, 0]; by.set(p, r); own.set(p, s); }
    r[0] = (r[0] ?? 0) + c.add; r[1] = (r[1] ?? 0) + c.del;
  }
  const tot = (k: string): number => { const r = by.get(k) ?? []; return (r[0] ?? 0) + (r[1] ?? 0); };
  const ks = [...by.keys()]; ks.sort((x, y) => tot(y) - tot(x) || (x < y ? -1 : x > y ? 1 : 0));
  const out: Obj[] = [];
  for (const k of ks.slice(0, max)) { const r = by.get(k) ?? []; const s = own.get(k); out.push({ path: REDACT && s ? display("file", k, s) : k, add: r[0] ?? 0, del: r[1] ?? 0 }); }
  return out;
}
interface ErrRec { s: Sess; tool: string; r: Rec }
// the ledger's failed calls of one session (last 10 per tool per day), newest first
export function errRecs(s: Sess, a: Acc): ErrRec[] {
  const out: ErrRec[] = [];
  for (const d of a.days.values()) for (const [name, t] of heavy(d).tt) for (const r of t.errs) out.push({ s, tool: name, r });
  return out.sort((x, y) => recMs(y.r) - recMs(x.r));
}
function recMs(r: Rec): number { return r.t > 0 ? r.t : isoMs(r.ts); }
// result text per call id from parsed events
function resultTexts(evs: Ev[]): Map<string, string> { const m = new Map<string, string>(); for (const e of evs) if (e.kind === "result" && e.id) m.set(e.id, e.text); return m; }

// one session in full: the --json fields plus turns, timing, models, tools, errors, files, repeats, subagents, cost basis;
// models/tools/errors/files/repeats cover the session and its subagents (complete() reads only these)
export function sessionObj(s: Sess): Obj {
  const fam = [s].concat(kidsOf(s));
  for (const x of fam) { loadHead(x); loadTail(x); complete(x); }
  const evs: Ev[][] = []; const srcs: Src[] = [];
  for (let i = 0; i < fam.length; i++) { const x = fam[i]; const e = allEvents(x); evs.push(e); srcs.push({ evs: e, live: i === 0 ? x.pid > 0 : subActive(x), kind: x.kind, spawn: i === 0 ? "" : spawnOf(x) }); }
  const sm = summary(buildGraph(srcs, Date.now()));
  const o = jsonSess(s); o["costUsd"] = s.cost < 0 ? null : r6(s.cost);
  o["turns"] = sm.turns; o["wallMs"] = Math.round(sm.wall); o["activeMs"] = Math.round(sm.active);
  o["models"] = modelRows(fam, null);
  o["tools"] = toolRows(fam, 15);
  const texts = new Map<string, string>();
  for (const e of evs) for (const [k, v] of resultTexts(e)) texts.set(k, v);
  let er: ErrRec[] = [];
  for (const x of fam) er = er.concat(errRecs(x, accOf(x)));
  er.sort((x, y) => recMs(y.r) - recMs(x.r));
  const errs: Obj[] = [];
  for (const e of er.slice(0, 10)) { const t = e.r.id ? texts.get(e.r.id) : undefined; errs.push({ ts: e.r.ts || null, tool: display("tool", e.tool, e.s), arg: argOf(e.tool, e.r.arg, e.s), text: t === undefined ? null : errText(t), session: e.s.id }); }
  o["errors"] = errs;
  o["files"] = fileRows(fam, 15);
  const reps: Obj[] = [];
  for (let i = 0; i < fam.length; i++) for (const r of loopRuns(evs[i] ?? [], 3)) reps.push({ tool: display("tool", r.tool, fam[i]), arg: argOf(r.tool, r.arg, fam[i]), n: r.n, ts: r.ts || null, session: fam[i].id });
  o["repeats"] = reps;
  const subs: Obj[] = [];
  for (const k of fam.slice(1)) subs.push({ id: k.id, kind: k.kind, costUsd: k.cost < 0 ? null : r6(k.cost), tools: k.tools });
  o["subagents"] = subs;
  const b = sessionBill(s);
  o["costBasis"] = { mode: b.bill, plan: b.plan, source: b.src, why: b.why };
  return o;
}

// ── time ─────────────────────────────────────────────────────────────────────
// local midnight of a YYYY-MM-DD day (-1 if no such day); scriptc parses no local date-time strings, so: UTC noon of
// that date minus the local clock there, nudged by an hour when a DST switch sits in between
export function midnightOf(key: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return -1;
  const noon = new Date(key + "T12:00:00.000Z"); const t = noon.getTime();
  if (!(t > 0)) return -1;
  let m = t - ((noon.getHours() * 60 + noon.getMinutes()) * 60 + noon.getSeconds()) * 1000;
  const h = new Date(m).getHours(); if (h === 23) m += 3600000; else if (h === 1) m -= 3600000;
  return dayKey(new Date(m)) === key ? m : -1;
}
// today | <n>h | <n>d (n calendar days: today and the n-1 before) | YYYY-MM-DD (local midnight) → epoch ms; else -1
export function parseSince(s: string, now: number): number {
  if (s === "today") return midnightOf(dayKey(new Date(now)));
  const m = /^(\d+)([hd])$/.exec(s);
  if (m) { const n = Number(m[1] ?? "0"); if (n <= 0) return -1; return m[2] === "h" ? now - n * 3600000 : midnightOf(dayKey(new Date(now - (n - 1) * 86400000))); }
  return midnightOf(s);
}

// ── errors ───────────────────────────────────────────────────────────────────
const SCAN_MAX = 67108864; // bytes read per command to find result texts by call id
// result texts and call arguments of the given call ids, found by scanning the session's lines (indexOf prefilter, parse
// only hit lines); stops once every result is found (a call's line comes before its result's)
interface Found2 { text: Map<string, string>; arg: Map<string, string> }
function textsById(s: Sess, ids: string[], budget: number[]): Found2 {
  const out: Found2 = { text: new Map<string, string>(), arg: new Map<string, string>() };
  const src = sourceOf(s.h); const st = src.stat(s);
  if (!st || !ids.length) return out;
  let at = 0;
  while (at < st.size && out.text.size < ids.length && (budget[0] ?? 0) > 0) {
    const r = src.lines(s, at, Math.min(st.size, at + window(src, 4194304)));
    const used = (r.next - at) * src.unit; budget[0] = (budget[0] ?? 0) - used;
    for (const l of r.lines) {
      let hit = false; for (const id of ids) if (!out.text.has(id) && l.indexOf(id) >= 0) { hit = true; break; }
      if (!hit) continue;
      const evs: Ev[] = []; parseEvents(s.h, l, evs, s);
      for (const e of evs) {
        if (!e.id || ids.indexOf(e.id) < 0) continue;
        if (e.kind === "result" && !out.text.has(e.id)) out.text.set(e.id, e.text);
        else if (e.kind === "tool" && !out.arg.has(e.id)) { const k = e.text.indexOf("\u0000"); out.arg.set(e.id, k >= 0 ? e.text.slice(k + 1) : ""); }
      }
    }
    if (r.next <= at) break;
    at = r.next;
  }
  return out;
}
// the local days from sinceMs through today, oldest first
export function daysFrom(sinceMs: number, now: number): string[] {
  const out: string[] = []; const last = dayKey(new Date(now));
  let k = dayKey(new Date(Math.max(sinceMs, 0) > 0 ? sinceMs : now));
  for (let i = 0; i < 4000; i++) { out.push(k); if (k >= last) break; const m = midnightOf(k); if (m < 0) break; k = dayKey(new Date(m + 36 * 3600000)); }
  return out;
}
interface ErrItem { s: Sess; tool: string; t: number; ts: string; ms: number; id: string; arg: string; argKnown: boolean }
// failed calls, newest first: the filter language's call rows (status error; every call within the rows' retention) and,
// for older days or without rows, the ledger's recent failures (last 10 per tool per day); source says which were read
export function errorRows(ref: string, sinceMs: number, limit: number, sc: Scope, cf: CliFilter): { rows: Obj[]; source: string } {
  let ss: Sess[] = [];
  if (ref) { const f = resolveOrFail(ref, false, sc); ss = [f].concat(kidsOf(f)); }
  else for (const s of sessions.values()) if (s.mtime >= sinceMs && visible(s, sc)) ss.push(s);
  const fam = new Set<string>();
  for (const s of ss) {
    if (cf.needsHead && !s.headDone) loadHead(s);
    if (!sessMatches(cf.f, s)) continue;
    rowsOf(s); complete(s); fam.add(s.path);
  }
  const items: ErrItem[] = []; const srcs: string[] = [];
  const cut = ROWS.on ? Math.max(callCutoff(), sinceMs) : Number.MAX_SAFE_INTEGER;
  if (ROWS.on) {
    srcs.push("calls");
    // the days to read: from since (or the oldest row of these sessions) through today
    let first = Math.max(sinceMs, callCutoff()); if (sinceMs <= 0) { first = Date.now(); for (const p of fam) { const a = ledger.get(p); if (a) for (const c of a.calls) if (c.t < first) first = c.t; } first = Math.max(first, callCutoff()); }
    eachCall(cf.f, daysFrom(first, Date.now()), (s: Sess, c: Call): void => {
      if (c.err !== 1 || c.t < sinceMs || !fam.has(s.path)) return;
      items.push({ s, tool: nameOf(DICT.tool, c.tool), t: c.t, ts: new Date(c.t).toISOString(), ms: c.ms, id: c.cid, arg: "", argKnown: false });
    });
  }
  // before the rows' retention (or without rows): the recent failures; call clauses cannot test them, so then there are none
  if (sinceMs < cut && !cf.f.call.length && !cf.f.rowx.length) {
    let used = false;
    for (const p of fam) { const s = sessions.get(p); if (!s) continue; for (const e of errRecs(s, accOf(s))) { const t = recMs(e.r); if (t >= sinceMs && t < cut) { used = true; items.push({ s, tool: e.tool, t, ts: e.r.ts || (e.r.t > 0 ? new Date(e.r.t).toISOString() : ""), ms: e.r.ms, id: e.r.id, arg: e.r.arg, argKnown: true }); } } }
    if (used || !ROWS.on) srcs.push("recent");
  }
  items.sort((x, y) => y.t - x.t);
  const er = limit > 0 ? items.slice(0, limit) : items;
  const want = new Map<string, string[]>(); // session path → call ids
  for (const e of er) if (e.id) { let w = want.get(e.s.path); if (!w) { w = []; want.set(e.s.path, w); } if (w.indexOf(e.id) < 0) w.push(e.id); }
  const budget = [SCAN_MAX]; const texts = new Map<string, string>(); const args = new Map<string, string>();
  for (const [path, ids] of want) {
    const s = sessions.get(path); if (!s) continue;
    const f = textsById(s, ids, budget);
    for (const [k, v] of f.text) texts.set(path + "\u0000" + k, v);
    for (const [k, v] of f.arg) args.set(path + "\u0000" + k, v);
  }
  const rows: Obj[] = [];
  for (const e of er) {
    const key = e.s.path + "\u0000" + e.id;
    const t = e.id ? texts.get(key) : undefined;
    const a = e.argKnown ? e.arg : e.id ? args.get(key) : undefined;
    rows.push({ ts: e.ts || null, harness: e.s.h, session: e.s.id, tool: display("tool", e.tool, e.s), arg: a === undefined ? null : argOf(e.tool, a, e.s), text: t === undefined ? null : errText(t), durationMs: e.ms >= 0 ? e.ms : null });
  }
  return { rows, source: srcs.join("+") };
}

// ── cost rows ────────────────────────────────────────────────────────────────
export const BY = ["day", "model", "harness", "project", "session"];
// Rows by key (cost desc; days in date order) + a final "total" row, summed from the ledger's day buckets (per model Day.mt /
// Day.um) of the days the filter keeps — the filter language's semantics: a day counts when it passes the day clauses
// and, with call clauses, holds a matching call row (totals() of the shared aggregation counts the same days);
// keys from the shared dimensions (project = the repo's name); costUsd null for all-unpriced rows
export function costRows(sinceKey: string, by: string, sc: Scope, cf: CliFilter): Obj[] {
  const acc = new Map<string, number[]>(); // key → [in, out, cacheRead, cacheWrite, cost, unpriced]
  const who = new Map<string, string[]>(); // key → session paths
  const tot = [0, 0, 0, 0, 0, 0]; const all: string[] = [];
  const sum = (r: number[], v: number[]): void => { for (let i = 0; i < 6; i++) r[i] = (r[i] ?? 0) + (v[i] ?? 0); };
  const add = (k: string, s: Sess, v: number[]): void => {
    let r = acc.get(k); if (!r) { r = [0, 0, 0, 0, 0, 0]; acc.set(k, r); }
    sum(r, v);
    let w = who.get(k); if (!w) { w = []; who.set(k, w); } if (w.indexOf(s.path) < 0) w.push(s.path);
  };
  const f = cf.f; const from = midnightOf(sinceKey);
  const cands: Sess[] = [];
  for (const s of sessions.values()) {
    if (s.mtime < from || !visible(s, sc)) continue;
    if (cf.needsHead && !s.headDone) loadHead(s);
    if (!sessMatches(f, s)) continue;
    complete(s); cands.push(s);
  }
  // with call clauses: the session-days holding a matching row
  const hit = new Set<string>();
  if (f.needsCalls) { const ps = new Set<string>(); for (const s of cands) ps.add(s.path); eachCall(f, daysFrom(from, Date.now()), (s: Sess, c: Call): void => { if (ps.has(s.path)) hit.add(s.path + "\t" + localOf(c.t).day); }); }
  for (const s of cands) {
    const a = accOf(s); let used = false;
    for (const [k, d] of a.days) {
      if (k < sinceKey) continue;
      if (f.needsCalls ? !hit.has(s.path + "\t" + k) : !dayMatches(f, s, k, d)) continue;
      const v = [d.inTok, d.outTok, d.cr, d.cw, d.cost, d.unk];
      if (d.inTok + d.outTok + d.cr + d.cw + d.unk === 0 && d.cost === 0) continue;
      used = true;
      sum(tot, v);
      if (by === "model") {
        const ms = new Set<string>();
        for (const [m, r] of d.mt) { ms.add(m); add(m, s, [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 0, r[4] ?? 0, d.um.get(m) ?? 0]); }
        for (const [m, n] of d.um) if (!ms.has(m)) add(m, s, [0, 0, 0, 0, 0, n]);
      } else add(by === "day" ? k : by === "session" ? s.h + ":" + s.id : sessDim(by, s)[0] || "(unknown)", s, v);
    }
    if (used) all.push(s.path);
  }
  const row = (k: string, r: number[], n: number): Obj => {
    const c = r[4] ?? 0; const unk = r[5] ?? 0;
    return { key: k, in: r[0] ?? 0, out: r[1] ?? 0, cacheRead: r[2] ?? 0, cacheWrite: r[3] ?? 0, costUsd: c === 0 && unk > 0 ? null : r6(c), unpricedTokens: unk, sessions: n };
  };
  const ks = [...acc.keys()];
  const cost = (k: string): number => { const r = acc.get(k) ?? []; return r[4] ?? 0; };
  if (by === "day") ks.sort(); else ks.sort((x, y) => cost(y) - cost(x) || (x < y ? -1 : x > y ? 1 : 0));
  const out: Obj[] = [];
  for (const k of ks) out.push(row(k, acc.get(k) ?? [], (who.get(k) ?? []).length));
  out.push(row("total", tot, all.length));
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function out(text: string): void { try { writeSync(1, screenOut(text) + "\n"); } catch (e) { process.exit(0); } }
export interface QOpts { ref: string; root: boolean; since: string; sinceMs: number; cwd: string; limit: number; live: boolean; subs: boolean; harness: string; by: string; check: boolean; json: boolean; f: Fmt; filters: string[]; pinned: boolean }
const VAL = ["--since", "--cwd", "--limit", "--harness", "--format", "--fields", "--by", "--filter"];
const ALWAYS = ["--agent", "--no-agent", "--redact", "--all-projects", "--project-only", "--format", "--fields"];
// one command's options; anything not in allowed (or ALWAYS) is a usage error
export function qopts(cmd: string, args: string[], allowed: string[], refOk: boolean): QOpts {
  const o: QOpts = { ref: "", root: false, since: "", sinceMs: 0, cwd: "", limit: 0, live: false, subs: false, harness: "", by: "", check: false, json: false, f: fmtArgs(args), filters: [], pinned: false };
  const bad = (m: string): never => cliError("usage", m, "agentglass " + cmd + " --help", 2);
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("-")) { if (!refOk || o.ref) bad("unexpected argument " + a); o.ref = a; continue; }
    if (allowed.indexOf(a) < 0 && ALWAYS.indexOf(a) < 0) bad("unknown option " + a);
    const v = VAL.indexOf(a) >= 0 ? args[++i] ?? "" : "";
    if (VAL.indexOf(a) >= 0 && !v) bad(a + " needs a value");
    if (a === "--root") o.root = true;
    else if (a === "--live") o.live = true;
    else if (a === "--subagents") o.subs = true;
    else if (a === "--check") o.check = true;
    else if (a === "--json") o.json = true;
    else if (a === "--harness") { o.harness = v; if (!isHarness(v)) bad("--harness must be one of " + harnessIds().join(", ")); }
    else if (a === "--limit") { o.limit = Number(v); if (!(o.limit > 0) || !Number.isInteger(o.limit)) bad("--limit needs a positive whole number"); }
    else if (a === "--since") { o.since = v; o.sinceMs = parseSince(v, Date.now()); if (o.sinceMs < 0) bad("--since must be today, <n>h, <n>d or YYYY-MM-DD"); }
    else if (a === "--cwd") o.cwd = realDir(v);
    else if (a === "--by") o.by = v;
    else if (a === "--filter") o.filters.push(v);
    else if (a === "--pinned") o.pinned = true;
  }
  return o;
}
// --filter / --pinned with --harness (and --live) as clauses; a bad expression exits 2 with a caret
export function qfilter(o: QOpts): CliFilter { return cliFilter(o.filters, o.harness, o.live, o.pinned, false); }
// a reference that must resolve (exit 2/3/4 otherwise); an id outside the agent-mode scope is not found (current/parent are the agent's own)
function resolveOrFail(ref: string, root: boolean, sc: Scope): Sess {
  const f: Found = resolveRef(ref, root, (x: Sess): boolean => visible(x, sc));
  if (!f.s) {
    if (f.code === 4) cliError("ambiguous", f.msg, "candidates: " + f.cands.slice(0, 5).map((c: Sess) => c.h + ":" + c.id).join(", ") + (f.cands.length > 5 ? ", …" : ""), 4);
    cliError(f.err || "not_found", f.msg, f.hint, f.code || 3);
  }
  const s = f.s as Sess;
  if (ref !== "current" && ref !== "parent" && !visible(s, sc)) cliError("out_of_scope", "session " + s.id + " belongs to another project", "use --all-projects", 3);
  return s;
}
export const COST_FIELDS = ["key", "in", "out", "cacheRead", "cacheWrite", "costUsd", "unpricedTokens", "sessions"];
function envelope(rows: Obj[], source: string, sc: Scope): string { return JSON.stringify({ rows, source, scope: sc.name }); }
// json → the {rows, source, scope} envelope (compact inside an agent and in pipes); other formats → bare rows
export function printEnvelope(rows: Obj[], source: string, sc: Scope, f: Fmt, tableCols: string[], known: string[]): void {
  const fmt = f.fmt || (agentHost().on || process.stdout.isTTY !== true ? "json" : "table");
  if (fmt !== "json") { out(formatRows(rows, { fmt, fields: f.fields }, false, tableCols, known, false)); return; }
  const r = f.fields.length ? JSON.parse(formatRows(rows, { fmt: "json", fields: f.fields }, false, tableCols, known, false)) as Obj[] : rows;
  out(envelope(r, source, sc));
}

const ERR_FIELDS = ["ts", "harness", "session", "tool", "arg", "text", "durationMs"];
const SESS_FIELDS = JSON_FIELDS.concat(["project"]);
// tools and subagents become lists here (the --json counts are their lengths' sums / lengths)
const SESSION_FIELDS = JSON_FIELDS.filter((f: string) => f !== "tools" && f !== "subagents").concat(["turns", "wallMs", "activeMs", "models", "tools", "errors", "files", "repeats", "subagents", "costBasis"]);
const LIST_COLS = ["updated", "harness", "title", "project", "costUsd", "tools", "status"];
function session(args: string[]): void {
  const o = qopts("session", args, ["--root"], true);
  const sc = agentScope(args);
  discover();
  const s = resolveOrFail(o.ref || (agentHost().on ? "current" : "last"), o.root, sc);
  out(formatRows([sessionObj(s)], o.f, true, [], SESSION_FIELDS, false));
}
function list(args: string[]): void {
  const o = qopts("sessions", args, ["--since", "--cwd", "--limit", "--live", "--subagents", "--harness", "--filter", "--pinned"], false);
  const sc = agentScope(args);
  const since = o.since ? o.sinceMs : Date.now() - 86400000; // default: the last 24 h
  const cf = qfilter(o);
  discover();
  const cands: Sess[] = [];
  for (const s of sessions.values()) {
    if ((!o.subs && s.depth !== 0) || s.mtime < since || !visible(s, sc)) continue;
    if (o.cwd) { const c = realDir(realCwd(s)); if (c !== o.cwd && !c.startsWith(o.cwd + "/")) continue; }
    cands.push(s);
  }
  const ss = cliSelect(cf, cands);
  ss.sort((a, b) => b.mtime - a.mtime);
  const rows: Obj[] = [];
  const sel = o.limit > 0 ? ss.slice(0, o.limit) : ss;
  for (const s of sel) { loadHead(s); loadTail(s, true); complete(s); peers(s); } // all indexed first: the git attribution is built once (cli.ts snapshot)
  for (const s of sel) { const r = jsonSess(s); r["costUsd"] = s.cost < 0 ? null : r6(s.cost); r["project"] = repoShown(s); rows.push(r); }
  out(formatRows(rows, o.f, false, LIST_COLS, SESS_FIELDS, false));
}
function errors(args: string[]): void {
  const o = qopts("errors", args, ["--since", "--limit", "--harness", "--filter", "--pinned"], true);
  const sc = agentScope(args);
  const cf = qfilter(o);
  discover();
  // without a ref: the last 24 h unless --since says otherwise (all history would read every log head in scope)
  const since = o.since || o.ref ? o.sinceMs : Date.now() - 86400000;
  const r = errorRows(o.ref, since, o.limit || 20, sc, cf);
  printEnvelope(r.rows, r.source, sc, o.f, ERR_FIELDS, ERR_FIELDS);
}

const SCOPE_OPTS: OptRec[] = [opt("--all-projects", "", "inside an agent: every project (default: the current one)", "", []), opt("--project-only", "", "inside an agent: only the current project, over a configured agent.scope all", "", [])];
const FMT_OPTS: OptRec[] = [opt("--format", "json|jsonl|csv|table", "output format", "json in an agent or a pipe, table on a terminal", ["json", "jsonl", "csv", "table"]), opt("--fields", "a,b,c", "only these fields, in this order (nested: tokens_in, git_commits; lists stay JSON arrays)", "", [])];
function rec(c: string, usage: string, summary: string, options: OptRec[], fields: string[]): CmdRec { return { cmd: c, usage, summary, options: options.concat(FMT_OPTS, SCOPE_OPTS), fields, group: "cmd" }; }
const SINCE = opt("--since", "today|<n>h|<n>d|YYYY-MM-DD", "only from then on", "24h", []);
const HARNESS = opt("--harness", harnessIds().join("|"), "only this harness", "", harnessIds());
const FILTER = opt("--filter", "'<expr>'", "only what matches (the filter language, repeatable; e.g. 'tool is Bash', 'repo is x and cost > 2')", "", []);
const PINNED = opt("--pinned", "", "also apply the filter pinned in the TUI", "", []);
addCmd(rec("session", "agentglass session [<ref>]", "one session: cost, models, tools, errors, files, repeats, subagents\n(<ref> = current | last | parent | <id> | <id prefix ≥ 6> | <harness>:<id>; default current in an agent, else last)",
  [opt("--root", "", "a subagent's root session instead", "", [])], SESSION_FIELDS), "cost");
addCmd(rec("sessions", "agentglass sessions [--since 24h]", "sessions, newest first (--cwd <dir>, --limit N, --live, --subagents, --harness h, --filter expr)",
  [SINCE, opt("--cwd", "<dir>", "only sessions in this directory or below it", "", []), opt("--limit", "N", "at most N sessions", "", []), opt("--live", "", "only sessions with a running agent", "", []), opt("--subagents", "", "include subagent sessions", "", []), HARNESS, FILTER, PINNED], SESS_FIELDS), "cost");
addCmd(rec("errors", "agentglass errors [<ref>] [--since 24h]", "failed tool calls, newest first (--limit N, default 20, --filter expr; <ref>: that session and its subagents, all its history)",
  [SINCE, opt("--limit", "N", "at most N errors", "20", []), HARNESS, FILTER, PINNED], ERR_FIELDS), "cost");

H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: these commands own their flags
  const c = args[0] ?? "";
  if ((c !== "session" && c !== "sessions" && c !== "errors") || args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) return false;
  S.cli = true;
  if (c === "session") session(args); else if (c === "sessions") list(args); else errors(args);
  process.exit(0);
});
