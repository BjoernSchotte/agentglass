// agentglass — usage port: the ledger's per-session/per-day records and the primitives harness adapters record usage with
// SPDX-License-Identifier: Apache-2.0
// An adapter's usage(a, line) turns one transcript line into calls of bucket → tool/pend/lines/file/tokens;
// its result lines close a pending call with done() from calls.ts. Everything else (budgets, caching, stats) is the ledger's.
import { price, cost } from "./pricing.ts";
import { type TS, type Cnt, type Pend, newTS, cnt, norm, program, argSummary, patchFiles } from "./calls.ts";
import { type Call, DICT, ROWS, intern, nameOf, dayKey } from "./facts.ts";
import { numAt } from "../../util/text.ts";
export { dayKey };

// one local day of one session; unk = tokens whose price is unknown (um: per model), uc = credits without a rate (kiro); turns = human prompts
// tt = per tool; prog/cmds/files are keyed "<tool>\t<program | command line | path>"; skills "<command | model>\t<skill name>"
// cp = cost per provider ("" = the session's single provider), hc = cost per local hour,
// mt = per model [in, out, cacheRead, cacheWrite, costUsd] (same model key as um)
// act = active minutes, flat sorted merged [s0,e0,s1,e1,…] local minutes of the day (e exclusive, ≤ ACT_MAX intervals)
export interface Day {
  tools: number; tt: Map<string, TS>; prog: Map<string, Cnt>; cmds: Map<string, Cnt>; files: Map<string, Cnt>; skills: Map<string, Cnt>; turns: number; hours: number[]; inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number; add: number; del: number;
  um: Map<string, number>; uc: number; cp: Map<string, number>; hc: number[]; mt: Map<string, number[]>; act: number[];
}
export interface Acc {
  off: number; skip: boolean; stall: number; // next unread byte; inside a >1 MB line; size at which only a partial line was left
  ids: Set<string>; days: Map<string, Day>; model: string;
  pend: Map<string, Pend>; // calls waiting for their result, by call id (not persisted: a restart loses their duration)
  ep: string; // the source's cursor epoch off counts in (SessionSource.epoch)
  x: number[]; xM: number; // the harness adapter's own running state (codex: cumulative token counters; fx: usage snapshot + its mtime)
  pk: string; // claude: "<promptId>\t<command>" of a slash command waiting for its skill base-directory line
  sub: boolean; // a subagent's log (Sess.parent, set by ledger accOf, not persisted): its prompts come from an agent, never a Day.turn
  inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number; tools: number; add: number; del: number;
  uc: number; // credits without a rate (kiro)
  rs: number; // reasoning tokens, a subset of outTok (gemini thoughts, opencode reasoning, codex reasoning_output_tokens)
  bill: string; plan: string; billSrc: string; // billing mode stamped from evidence ("" = not stamped; billSrc "session" | "process")
  calls: Call[]; lastCall: number; // one row per tool call in call order (persisted apart, callcache.ts); index of the newest, -1 none
  t0: number; // first activity (epoch ms), 0 unknown
  al: number; // latest activity booked into Day.act (epoch ms), 0 none
  sp: number[]; // finished calls' [start, end] pairs (epoch ms) not yet in Day.act (not persisted: flushed per line and per chunk)
  vcs: VRef[]; // git linkage: commits, PR/issue/commit links and git-call spans scraped from tool output (vcs.ts), oldest first
  dn: Pend[]; // calls the current line closed (not persisted: the scraper reads and clears it per line)
}
// one scraped git reference: k = commit (v = sha as printed) | pr | issue | link (v = canonical URL; link = a commit URL) |
// gcall (v = "<t0>-<t1>" epoch ms of a commit-making git call); t = call time (epoch ms); how = observed | created | mentioned;
// br/subj = the banner's branch and subject; call/ts = the tool call to jump to
export interface VRef { k: string; v: string; t: number; how: string; br: string; subj: string; call: string; ts: string }
export const L = { ver: 0, done: 0, total: 0, prio: "", prioAt: 0, rlPct: -1, rlWin: 0, rlReset: 0, rlAt: 0 }; // rl* = latest Codex primary rate limit

export function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
export function todayKey(): string { return dayKey(new Date()); }
// local midnight today (ms); scriptc has no new Date(y, m, d)
export function startOfDay(): number { const t = new Date(); return t.getTime() - ((t.getHours() * 60 + t.getMinutes()) * 60 + t.getSeconds()) * 1000 - t.getMilliseconds(); }
// last n local days, oldest first (anchored at noon so DST shifts can't skip a day)
export function lastDays(n: number): string[] {
  const noon = startOfDay() + 43200000; const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(noon - i * 86400000)));
  return out;
}
export function nlines(s: string): number { if (!s) return 0; const n = s.split("\n").length; return s.endsWith("\n") ? n - 1 : n; }

export function newAcc(): Acc {
  return { off: 0, skip: false, stall: -1, ids: new Set<string>(), days: new Map<string, Day>(), model: "", pend: new Map<string, Pend>(), ep: "", x: [], xM: 0, pk: "", sub: false,
    inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0, tools: 0, add: 0, del: 0, uc: 0, rs: 0, bill: "", plan: "", billSrc: "", calls: [], lastCall: -1, t0: 0, al: 0, sp: [], vcs: [], dn: [] };
}
// billing evidence: transcript ("session") beats the live environment ("process"); the first conclusive session result
// stays (a mid-session switch keeps the first mode); current config is never stamped — it is only assumed at display time
export function stamp(a: Acc, bill: string, plan: string, src: string): void {
  if (src === "config" || !bill) return;
  if (a.billSrc === "" || (src === "session" && a.billSrc !== "session")) { a.bill = bill; a.plan = plan; a.billSrc = src; }
}
export function zeros(n: number): number[] { const z: number[] = []; for (let i = 0; i < n; i++) z.push(0); return z; }
export function newDay(): Day {
  return { tools: 0, tt: new Map<string, TS>(), prog: new Map<string, Cnt>(), cmds: new Map<string, Cnt>(), files: new Map<string, Cnt>(), skills: new Map<string, Cnt>(), turns: 0, hours: zeros(24), inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0, add: 0, del: 0,
    um: new Map<string, number>(), uc: 0, cp: new Map<string, number>(), hc: zeros(24), mt: new Map<string, number[]>(), act: [] };
}
// timestamp → day bucket + local hour; the conversion is cached per UTC hour prefix (lines arrive in order)
// tsIso/tsMs: the time of the last bucket() call, for the call rows tool() appends (0 = none: Date.now() fallback)
let tsKey = ""; let tsDay = ""; let tsHour = 0; let tsIso = ""; let tsMs = 0;
export function bucket(a: Acc, ms: number, iso: string): Day {
  if (iso) {
    const k = iso.slice(0, 13);
    if (k !== tsKey) { const d = new Date(iso); tsKey = k; tsDay = dayKey(d); tsHour = d.getHours(); }
    if (iso !== tsIso) { tsIso = iso; tsMs = isoMs(iso); }
  } else { const d = new Date(ms > 0 ? ms : Date.now()); tsKey = ""; tsDay = dayKey(d); tsHour = d.getHours(); tsIso = ""; tsMs = ms > 0 ? ms : 0; }
  if (tsMs > 0 && (a.t0 === 0 || tsMs < a.t0)) a.t0 = tsMs; // earliest, not first: side files (fx, kiro) are read before the log
  if (a.sp.length) flushSpans(a);
  let d = a.days.get(tsDay);
  if (!d) { d = newDay(); a.days.set(tsDay, d); }
  if (tsMs > 0) actMark(a, d, tsMs); // never for the Date.now() fallback: an untimed line says nothing about when work happened
  return d;
}

// ── active time: per session-day minute intervals; a line within ACT.gap minutes of the last activity extends it ──
export const ACT = { gap: 5 }; // repo.idleGapMin (set at startup by features/repos/ident.ts); applies to newly indexed lines
const ACT_MAX = 200;
// local minute of day of an epoch ms; cached per minute (lines arrive in order). Offsets are whole minutes, so the
// minute boundary is the same locally and in UTC.
let amKey = -1; let amMin = 0;
function minOf(ms: number): number { const k = Math.floor(ms / 60000); if (k !== amKey) { amKey = k; const t = new Date(ms); amMin = t.getHours() * 60 + t.getMinutes(); } return amMin; }
function minOfAt(ms: number): number { const t = new Date(ms); return t.getHours() * 60 + t.getMinutes(); }
function dayAt(a: Acc, ms: number): Day { const k = dayKey(new Date(ms)); let d = a.days.get(k); if (!d) { d = newDay(); a.days.set(k, d); } return d; }
// [s, e) into a flat sorted merged list (overlapping and adjacent intervals merge); over ACT_MAX the closest pair merges
export function addSpan(act: number[], s0: number, e0: number): void {
  const s = Math.max(0, s0); const e = Math.min(1440, e0); if (e <= s) return;
  const n = act.length;
  if (n >= 2) { // fast paths: lines arrive in order, so nearly every call touches the last interval
    const ls = act[n - 2] ?? 0; const le = act[n - 1] ?? 0;
    if (s >= ls && e <= le) return;
    if (s >= ls && s <= le) { act[n - 1] = e; return; }
    if (s > le) { act.push(s); act.push(e); capSpans(act); return; }
  } else if (n === 0) { act.push(s); act.push(e); return; }
  let i = 0; while (i < n && (act[i] ?? 0) < s) i += 2; // first interval starting at or after s
  act.splice(i, 0, s, e);
  const out: number[] = [];
  for (let j = 0; j < act.length; j += 2) {
    const a0 = act[j] ?? 0; const a1 = act[j + 1] ?? 0; const m = out.length;
    if (m && a0 <= (out[m - 1] ?? 0)) { if (a1 > (out[m - 1] ?? 0)) out[m - 1] = a1; } else { out.push(a0); out.push(a1); }
  }
  act.length = 0; for (const x of out) act.push(x);
  capSpans(act);
}
function capSpans(act: number[]): void {
  while (act.length > ACT_MAX * 2) {
    let bi = 1; let bg = 1e9;
    for (let j = 1; j + 1 < act.length; j += 2) { const g = (act[j + 1] ?? 0) - (act[j] ?? 0); if (g < bg) { bg = g; bi = j; } }
    act.splice(bi, 2); // drop the end of one and the start of the next: the two become one
  }
}
// one timestamped line: extends the session's latest activity when within the gap (across midnight: both days), else a new minute
export function actMark(a: Acc, d: Day, ms: number): void {
  const m = minOf(ms); const gap = ms - a.al;
  if (a.al > 0 && gap >= 0 && gap <= ACT.gap * 60000) {
    const pm = minOfAt(a.al);
    if (m >= pm && Math.floor(ms / 60000) - Math.floor(a.al / 60000) === m - pm) addSpan(d.act, pm, m + 1); // same local day
    else { const prev = a.days.get(dayKey(new Date(a.al))); if (prev && prev !== d) addSpan(prev.act, pm, 1440); addSpan(d.act, 0, m + 1); }
  } else addSpan(d.act, m, m + 1);
  if (ms > a.al) a.al = ms;
}
// [t0, t1] minute-wise, split at local midnights into each day's bucket
export function actSpan(a: Acc, t0: number, t1: number): void {
  let t = t0;
  for (let guard = 0; t < t1 && guard < 3; guard++) {
    const m0 = minOfAt(t); const startMin = Math.floor(t / 60000) * 60000;
    const dayEnd = startMin + (1440 - m0) * 60000; // the next local midnight (± a DST hour, then the guard ends it)
    const end = Math.min(t1, dayEnd);
    addSpan(dayAt(a, t).act, m0, end >= dayEnd ? 1440 : m0 + Math.floor((end - startMin) / 60000) + 1);
    t = dayEnd;
  }
  if (t1 > a.al) a.al = t1;
}
export function flushSpans(a: Acc): void {
  const sp = a.sp.slice(); a.sp.length = 0;
  for (let i = 0; i + 1 < sp.length; i += 2) actSpan(a, numAt(sp, i, 0), numAt(sp, i + 1, 0));
}
export function spanMin(act: number[]): number { let n = 0; for (let i = 0; i + 1 < act.length; i += 2) n += (act[i + 1] ?? 0) - (act[i] ?? 0); return n; }
// minutes covered by any of the lists (parallel sessions count once)
export function unionMin(lists: number[][]): number {
  const iv: number[][] = [];
  for (const l of lists) for (let i = 0; i + 1 < l.length; i += 2) iv.push([numAt(l, i, 0), numAt(l, i + 1, 0)]);
  iv.sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
  let n = 0; let cs = -1; let ce = -1;
  for (const v of iv) {
    const s = v[0] ?? 0; const e = v[1] ?? 0;
    if (s > ce) { if (ce > cs) n += ce - cs; cs = s; ce = e; } else if (e > ce) ce = e;
  }
  if (ce > cs) n += ce - cs;
  return n;
}
// one call: counters + a fact row carrying the model of the message that issued it ("" unknown; mq: MQ_MSG | MQ_TURN | MQ_SESS)
export function tool(a: Acc, d: Day, name: string, model: string, mq: number): TS {
  a.tools++; d.tools++;
  let st = d.tt.get(name);
  if (!st) { st = newTS(); d.tt.set(name, st); }
  st.n = st.n + 1;
  st.h[tsHour] = (st.h[tsHour] ?? 0) + 1;
  d.hours[tsHour] = (d.hours[tsHour] ?? 0) + 1;
  if (!ROWS.on) return st;
  a.calls.push({ t: tsMs > 0 ? tsMs : Date.now(), tool: intern(DICT.tool, name), model: intern(DICT.model, model), mq, progs: [], cmds: [], files: [], ms: -1, err: -1, out: 0, cid: "" });
  a.lastCall = a.calls.length - 1;
  return st;
}
function newest(a: Acc): Call | null { return a.lastCall >= 0 && a.lastCall < a.calls.length ? a.calls[a.lastCall] : null; }
function addId(xs: number[], i: number): void { if (i >= 0 && xs.indexOf(i) < 0) xs.push(i); }
// remember a call until its result shows up; shell commands are counted now, their errors on the result
export function pend(a: Acc, d: Day, st: TS, name: string, id: string, t: number, ts: string, arg: string, cmds: string[]): void {
  const sh: Cnt[] = []; const row = newest(a);
  for (const c of cmds) {
    const n = norm(c); if (!n) continue;
    const pg = program(n);
    sh.push(cnt(d.prog, name + "\t" + pg)); sh.push(cnt(d.cmds, name + "\t" + n));
    if (row) { addId(row.progs, intern(DICT.prog, pg)); addId(row.cmds, intern(DICT.cmd, n)); }
  }
  if (row) row.cid = id;
  if (!id) return;
  if (a.pend.size > 2000) a.pend.clear(); // results that never came (skipped >1 MB lines, crashes): don't leak
  a.pend.set(id, { t: t > 0 ? t : 0, ts, arg: argSummary(arg), st, sh, row, sp: a.sp, name, cmd: cmds.join("\n").slice(0, 4096), id, end: 0, dn: a.dn });
}
// the result names the real tool (pi MCP behind a proxy): move the call's one count to that row of the same day
export function retool(a: Acc, p: Pend, name: string): void {
  p.name = name;
  const d = bucket(a, p.t, p.ts);
  let key = ""; let found = false;
  for (const [k, v] of d.tt) if (v === p.st) { key = k; found = true; break; }
  if (!found || key === name) return;
  const h = tsHour; const o = p.st;
  o.n = o.n - 1; o.h[h] = Math.max(0, (o.h[h] ?? 0) - 1);
  if (o.n <= 0) d.tt.delete(key);
  let st = d.tt.get(name);
  if (!st) { st = newTS(); d.tt.set(name, st); }
  st.n = st.n + 1; st.h[h] = (st.h[h] ?? 0) + 1;
  p.st = st;
  if (p.row) p.row.tool = intern(DICT.tool, name);
}
// a changed file: the day's counter, and the newest call row when it is this tool's (adapters book files right after tool())
export function file(a: Acc, d: Day, name: string, path: string, add: number, del: number): void {
  if (!path) return;
  const c = cnt(d.files, name + "\t" + path);
  c.add = c.add + add; c.del = c.del + del;
  const r = newest(a);
  if (r && nameOf(DICT.tool, r.tool) === name) addId(r.files, intern(DICT.file, path));
}
// human prompts (what the transcript shows as user events), on the local day of the prompt; root sessions only
export function turn(a: Acc, ms: number, iso: string, n: number): void { if (n > 0 && !a.sub) { const d = bucket(a, ms, iso); d.turns = d.turns + n; } }
export function skill(d: Day, source: string, name: string): void { if (name) cnt(d.skills, source + "\t" + name); }
export interface SkillUse { name: string; source: string; n: number }
// skill uses over the given local days (null = all), most used first
export function skillUses(a: Acc, days: string[] | null): SkillUse[] {
  const m = new Map<string, number>();
  for (const [k, d] of a.days) { if (days && days.indexOf(k) < 0) continue; for (const [sk, c] of d.skills) m.set(sk, (m.get(sk) ?? 0) + c.n); }
  const out: SkillUse[] = [];
  for (const [sk, n] of m) { const i = sk.indexOf("\t"); out.push({ name: sk.slice(i + 1), source: sk.slice(0, i), n }); }
  return out.sort((x, y) => y.n - x.n || (x.name < y.name ? -1 : x.name > y.name ? 1 : x.source < y.source ? -1 : 1));
}
export function isoMs(iso: string): number {
  if (!iso) return 0;
  const d = new Date(iso.replace(/(\.\d{3})\d+/, "$1")); const t = d.getTime(); // the runtime's Date rejects more than 3 fraction digits
  return t > 0 ? t : 0;
}
export function lines(a: Acc, d: Day, nAdd: number, nDel: number): void {
  a.add = a.add + nAdd;
  a.del = a.del + nDel;
  d.add = d.add + nAdd;
  d.del = d.del + nDel;
}
function count(a: Acc, d: Day, nIn: number, nOut: number, nCr: number, w5: number, w1: number): void {
  // ponytail: spelled out — scriptc rejects some `obj.field += n` pairs on one line (SC1043)
  a.inTok = a.inTok + nIn; a.outTok = a.outTok + nOut; a.cr = a.cr + nCr; a.cw = a.cw + w5 + w1;
  d.inTok = d.inTok + nIn; d.outTok = d.outTok + nOut; d.cr = d.cr + nCr; d.cw = d.cw + w5 + w1;
}
// the per-model key of um/mt: the model as booked without gemini's leading "?" (its unpriced marker)
function mkey(model: string): string { const m = model.startsWith("?") ? model.slice(1) : model; return m || "unknown"; }
function slot(d: Day, model: string): number[] {
  const k = mkey(model); let r = d.mt.get(k);
  if (!r) { r = [0, 0, 0, 0, 0]; d.mt.set(k, r); }
  return r;
}
// tokens into the day's per-model bucket (totals are count()'s or the adapter's own business)
export function modelTok(d: Day, model: string, nIn: number, nOut: number, nCr: number, nCw: number): void {
  const r = slot(d, model);
  r[0] = (r[0] ?? 0) + nIn; r[1] = (r[1] ?? 0) + nOut; r[2] = (r[2] ?? 0) + nCr; r[3] = (r[3] ?? 0) + nCw;
}
// a priced amount: session + day totals, the provider's share, the local hour of the last bucket() call, the model's bucket
export function addCost(a: Acc, d: Day, usd: number, prov: string, model: string): void {
  a.cost = a.cost + usd; d.cost = d.cost + usd; // spelled out: SC1043
  d.cp.set(prov, (d.cp.get(prov) ?? 0) + usd);
  d.hc[tsHour] = (d.hc[tsHour] ?? 0) + usd;
  const r = slot(d, model); r[4] = (r[4] ?? 0) + usd;
}
// tokens without a price, per model
export function unpriced(a: Acc, d: Day, model: string, n: number): void {
  a.unk = a.unk + n; d.unk = d.unk + n;
  const k = mkey(model); d.um.set(k, (d.um.get(k) ?? 0) + n);
}
// credits without a $ rate (kiro): a unit of their own, never mixed into tokens
export function credits(a: Acc, d: Day, n: number): void { a.uc = a.uc + n; d.uc = d.uc + n; }
// the harness reports its own cost (OpenCode, pi): booked as is; usd <= 0 = unknown (0 for models it has no price for) → priced like tokens()
export function usageExact(a: Acc, d: Day, model: string, nIn: number, nOut: number, nCr: number, w5: number, w1: number, usd: number, prov = ""): void {
  if (usd <= 0) { tokens(a, d, model, nIn, nOut, nCr, w5, w1, prov); return; }
  count(a, d, nIn, nOut, nCr, w5, w1);
  modelTok(d, model, nIn, nOut, nCr, w5 + w1);
  addCost(a, d, usd, prov, model);
  const f = bookTap; if (f) f({ model, nIn, nOut, cr: nCr, cw: w5 + w1, cost: usd, unk: 0, exact: true, prov });
}
export function tokens(a: Acc, d: Day, model: string, nIn: number, nOut: number, nCr: number, w5: number, w1: number, prov = ""): void {
  count(a, d, nIn, nOut, nCr, w5, w1);
  modelTok(d, model, nIn, nOut, nCr, w5 + w1);
  const p = price(model);
  const usd = p ? cost(p, nIn, nOut, nCr, w5, w1) : 0; const unk = p ? 0 : nIn + nOut + nCr + w5 + w1;
  if (p) addCost(a, d, usd, prov, model);
  else unpriced(a, d, model, unk);
  const f = bookTap; if (f) f({ model, nIn, nOut, cr: nCr, cw: w5 + w1, cost: usd, unk, exact: false, prov });
}
// reasoning tokens: already inside out (adapters fold them in), kept apart for the OTLP export's reasoning attribute
export function reasoning(a: Acc, d: Day, n: number): void { if (n > 0) a.rs = a.rs + n; }
// one booking as tokens()/usageExact() made it (Claude fallback iterations: one per attempt), for the OTLP exporter's
// per-request spans; prov = honest-costs' provider key ("" = the session's single provider). null outside the exporter.
export interface Booking { model: string; nIn: number; nOut: number; cr: number; cw: number; cost: number; unk: number; exact: boolean; prov: string }
let bookTap: ((b: Booking) => void) | null = null;
export function setBookTap(f: ((b: Booking) => void) | null): void { bookTap = f; }

export interface ModelUse { model: string; inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number } // unk = unpriced tokens (um)
// per-model tokens/cost/unpriced over the given local days (null = all): cost desc, then tokens desc, then model
export function modelUses(a: Acc, days: string[] | null): ModelUse[] {
  const by = new Map<string, ModelUse>();
  const use = (k: string): ModelUse => { let u = by.get(k); if (!u) { u = { model: k, inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0 }; by.set(k, u); } return u; };
  for (const [k, d] of a.days) {
    if (days && days.indexOf(k) < 0) continue;
    for (const [m, r] of d.mt) { const u = use(m); u.inTok += r[0] ?? 0; u.outTok += r[1] ?? 0; u.cr += r[2] ?? 0; u.cw += r[3] ?? 0; u.cost += r[4] ?? 0; }
    for (const [m, n] of d.um) { const u = use(m); u.unk += n; }
  }
  const out = [...by.values()];
  out.sort((x, y) => y.cost - x.cost || (y.inTok + y.outTok) - (x.inTok + x.outTok) || (x.model < y.model ? -1 : x.model > y.model ? 1 : 0));
  return out;
}

// every file an apply_patch-style patch touches: lines and per-file counts
export function patchLines(a: Acc, d: Day, name: string, patch: string): void {
  for (const f of patchFiles(patch)) { lines(a, d, f.add, f.del); file(a, d, name, f.p, f.add, f.del); }
}
