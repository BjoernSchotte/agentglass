// agentglass — filter language: attribute values, compile clauses to predicates, lifting (spec §2, §3)
// SPDX-License-Identifier: Apache-2.0
// A view has a row entity; a clause on another entity is lifted: on a session row, call clauses mean "has a call that
// matches all of them" (the same call), day clauses "has a day bucket that matches all of them" (the same day).
import { HOME } from "../../util/fs.ts";
import type { Sess } from "../../model/types.ts";
import { sessions, titleOf, working, parentOf } from "../../model/sessions.ts";
import { type Day, L, todayKey, dayKey, startOfDay } from "../usage/record.ts";
import { type Call, DICT, nameOf, extOf, localOf } from "../usage/facts.ts";
import { mcpServer, program, norm } from "../usage/calls.ts";
import { accOf, ledger } from "../usage/ledger.ts";
import { callCutoff } from "../usage/callcache.ts";
import type { Attr, Clause, QErr, Val } from "./types.ts";
import { attrOf, canonEnum, isNumeric, weekdayIndex } from "./attrs.ts";
import { printClause, suggest } from "./parse.ts";
import { repoVals } from "./project.ts";
export { callCutoff };

export type Ctx = "list" | "stats" | "json" | "watch" | "procs";
export interface Compiled {
  key: string;            // canonical text + resolved relative dates: cache key
  cs: Clause[];           // the clauses compiled (pinned flags kept)
  sess: ((s: Sess) => boolean)[];
  day: ((s: Sess, dk: string, d: Day) => boolean)[];
  call: ((s: Sess, c: Call) => boolean)[];
  event: ((s: Sess, kind: string, tool: string, args: string) => boolean)[];
  content: Clause[];      // content ~ / !~ clauses (the full-text search runs elsewhere)
  dayKeys: string[] | null; // known day keys passing the day/weekday clauses, sorted; null = no day clause (scriptc: no Set | null members)
  rowx: ((s: Sess, c: Call) => boolean)[]; // per-row tests of session attributes a call refines (model): rows only, never lifted alone
  needsCalls: boolean;    // any call clause or row refinement: totals and aggregates must read call rows
  dimmed: Clause[];       // clauses that do not apply in this ctx (procs: all but harness/repo/cwd/live)
}
export const EMPTY: Compiled = { key: "", cs: [], sess: [], day: [], call: [], event: [], content: [], dayKeys: null, rowx: [], needsCalls: false, dimmed: [] };

// later specs add attributes: register(attr) for the metadata + extend() for behaviour
export interface Ext { sess: ((s: Sess) => Val) | null; resolve: ((v: string) => { v: string; err: string }) | null }
const EXT = new Map<string, Ext>();
export function extend(key: string, x: Ext): void { EXT.set(key, x); }

// ── values ──
function V(ss: string[]): Val { return { n: 0, ss, unk: false }; }
function N(n: number): Val { return { n, ss: [], unk: false }; }
const UNK: Val = { n: 0, ss: ["unknown"], unk: true };
function home(p: string): string { return p === "~" ? HOME : p.startsWith("~/") ? HOME + p.slice(1) : p; }
// subagents have no process of their own: they are live while their parent is
export function livePid(s: Sess): number { if (s.pid) return s.pid; const p = parentOf(s); return p ? p.pid : 0; }
function stateOf(s: Sess): string {
  if (s.stuck) return "stuck";
  if (s.attention) return "attention";
  const pid = livePid(s);
  if (pid && working(s)) return "busy";
  return pid ? "idle" : "ended";
}
function errorsOf(s: Sess): number { const a = ledger.get(s.path); let n = 0; if (a) for (const d of a.days.values()) for (const st of d.tt.values()) n += st.err; return n; }
// session model ∪ the models of its call rows, per (path, L.ver)
const models = new Map<string, { ver: number; ss: string[] }>();
function modelsOf(s: Sess): Val {
  const hit = models.get(s.path); if (hit && hit.ver === L.ver) return hit.ss.length ? V(hit.ss) : UNK;
  const set = new Set<string>(); if (s.model) set.add(s.model.toLowerCase());
  const a = ledger.get(s.path);
  if (a) { const seen = new Set<number>(); for (const c of a.calls) if (c.model >= 0 && !seen.has(c.model)) { seen.add(c.model); set.add(nameOf(DICT.model, c.model).toLowerCase()); } }
  const ss = [...set]; models.set(s.path, { ver: L.ver, ss });
  return ss.length ? V(ss) : UNK;
}
function haystack(s: Sess): string { return (titleOf(s) + " " + s.cwd + " " + s.id + " " + s.h + " " + s.name + " " + s.branch + " " + s.kind).toLowerCase(); }
export function sessVal(key: string, s: Sess): Val {
  const x = EXT.get(key); if (x && x.sess) { const f = x.sess; return f(s); }
  switch (key) {
    case "harness": return V([s.h]);
    case "repo": return V(repoVals(s));
    case "cwd": return V([home(s.cwd).toLowerCase()]);
    case "branch": return V([s.branch.toLowerCase()]);
    case "model": return modelsOf(s);
    case "title": return V([titleOf(s).toLowerCase()]);
    case "id": return V([s.id.toLowerCase()]);
    case "agent": return V([s.kind.toLowerCase()]);
    case "subagent": return V([s.parent !== "" ? "true" : "false"]);
    case "live": return V([livePid(s) > 0 ? "true" : "false"]);
    case "archived": return V([s.archived ? "true" : "false"]);
    case "state": return V([stateOf(s)]);
    case "cost": return s.cost < 0 ? UNK : N(s.cost);
    case "tokens": return N(s.inTok + s.outTok + s.cacheRTok + s.cacheWTok);
    case "tokens.in": return N(s.inTok);
    case "tokens.out": return N(s.outTok);
    case "tokens.cache_read": return N(s.cacheRTok);
    case "tokens.cache_write": return N(s.cacheWTok);
    case "tools": return N(s.tools);
    case "errors": return N(errorsOf(s));
    case "error_rate": return s.tools > 0 ? N(errorsOf(s) / s.tools) : UNK;
    case "lines": return N(s.linesAdd + s.linesDel);
    case "lines.added": return N(s.linesAdd);
    case "lines.removed": return N(s.linesDel);
    case "age": return N(Date.now() - Math.max(s.last, s.mtime));
    case "text": return V([haystack(s)]);
  }
  return V([]);
}
// weekday of a local day key, 0 = Sunday (Sakamoto; no Date parsing of local strings)
export function weekdayOf(dk: string): number {
  let y = Number(dk.slice(0, 4)); const m = Number(dk.slice(5, 7)); const d = Number(dk.slice(8, 10));
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  if (m < 3) y -= 1;
  return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + (t[m - 1] ?? 0) + d) % 7;
}
const WD = ["su", "mo", "tu", "we", "th", "fr", "sa"];
export function dayVal(key: string, s: Sess, dk: string, d: Day): Val {
  switch (key) {
    case "day": return V([dk]);
    case "weekday": return V([WD[weekdayOf(dk)] ?? ""]);
    case "day.cost": return d.cost === 0 && d.unk > 0 ? UNK : N(d.cost);
    case "day.tokens": return N(d.inTok + d.outTok + d.cr + d.cw);
    case "day.tools": return N(d.tools);
  }
  return sessVal(key, s);
}
function names(dc: { ids: Map<string, number>; names: string[] }, xs: number[]): string[] { const o: string[] = []; for (const x of xs) o.push(nameOf(dc, x).toLowerCase()); return o; }
export function callVal(key: string, s: Sess, c: Call): Val {
  switch (key) {
    case "tool": return V([nameOf(DICT.tool, c.tool).toLowerCase()]);
    case "server": return V([mcpServer(nameOf(DICT.tool, c.tool)).toLowerCase()]);
    case "program": return V(names(DICT.prog, c.progs));
    case "command": return V(names(DICT.cmd, c.cmds));
    case "file": return V(names(DICT.file, c.files));
    case "ext": { const o: string[] = []; for (const f of c.files) { const e = extOf(nameOf(DICT.file, f)); if (o.indexOf(e) < 0) o.push(e); } return V(o); }
    case "status": return V([c.err === 1 ? "error" : c.err === 0 ? "ok" : "unknown"]);
    case "duration": return c.ms < 0 ? UNK : N(c.ms);
    case "out": return c.err < 0 ? UNK : N(c.out);
    case "hour": return N(localOf(c.t).hour);
    case "model": return c.model < 0 ? UNK : V([nameOf(DICT.model, c.model).toLowerCase()]);
    case "day": return V([localOf(c.t).day]);
    case "weekday": return V([WD[localOf(c.t).wd] ?? ""]);
  }
  return sessVal(key, s);
}

// ── clause values → matchers ──
const UNIT: Record<string, number> = { k: 1e3, m: 1e6, ms: 1, s: 1000, h: 3600000, d: 86400000, b: 1, kb: 1024, mb: 1048576, gb: 1073741824, g: 1073741824 };
// a numeric clause value in the attribute's base unit (usd, tokens, bytes, ms, ratio 0–1); NaN when unparsable
export function numOf(type: string, v: string): number {
  const m = /^\$?(-?\d+(?:\.\d+)?)([a-zA-Z%]*)$/.exec(v.trim()); if (!m) return NaN;
  const n = Number(m[1] ?? ""); const u = (m[2] ?? "").toLowerCase();
  if (!u) return type === "ratio" && n > 1 ? NaN : n;
  if (u === "%") return n / 100;
  if (type === "dur") return u === "m" ? n * 60000 : n * (UNIT[u] ?? NaN);
  if (type === "tok") return u === "k" ? n * 1e3 : u === "m" ? n * 1e6 : NaN;
  if (type === "size") return u === "m" ? n * 1048576 : u === "k" ? n * 1024 : n * (UNIT[u] ?? NaN);
  return NaN;
}
// today / yesterday / -Nd / YYYY-MM-DD → a local day key
export function dateOf(v: string): string {
  const l = v.toLowerCase();
  if (l === "today") return todayKey();
  const back = l === "yesterday" ? 1 : /^-\d+d$/.test(l) ? Number(l.slice(1, -1)) : -1;
  if (back >= 0) return dayKey(new Date(startOfDay() + 43200000 - back * 86400000)); // noon: DST shifts cannot skip a day
  return l;
}
// glob over a path ("*" = within one segment, "**" = across); without a "/" the pattern matches the basename
function glob(p: string, s: string): boolean {
  const target = p.indexOf("/") < 0 ? s.slice(s.lastIndexOf("/") + 1) : s;
  return globAt(p, 0, target, 0);
}
function globAt(p: string, i: number, s: string, j: number): boolean {
  while (i < p.length) {
    const c = p.charAt(i);
    if (c === "*") {
      const deep = p.charAt(i + 1) === "*"; const ni = deep ? i + 2 : i + 1;
      for (let k = j; k <= s.length; k++) { if (globAt(p, ni, s, k)) return true; if (!deep && s.charAt(k) === "/") return false; }
      return false;
    }
    if (j >= s.length || (c !== "?" && c !== s.charAt(j)) || (c === "?" && s.charAt(j) === "/")) return false;
    i++; j++;
  }
  return j === s.length;
}
// one clause → Val predicate
function matcher(a: Attr, c: Clause, vals: string[]): (v: Val) => boolean {
  const op = c.op;
  if (vals.length === 1 && vals[0] === "unknown" && (op === "is" || op === "is_not") && a.type !== "enum") { const want = op === "is"; return (v: Val) => v.unk === want; }
  if (isNumeric(a.type) && a.type !== "date") {
    const x = numOf(a.type, vals[0] ?? "");
    const cmp = (v: Val): boolean => {
      if (v.unk) return false;
      const n = v.n;
      if (op === ">") return n > x; if (op === ">=") return n >= x; if (op === "<") return n < x; if (op === "<=") return n <= x;
      if (op === "is") return Math.abs(n - x) < 1e-9; if (op === "is_not") return Math.abs(n - x) >= 1e-9;
      return false;
    };
    return c.neg ? (v: Val) => !cmp(v) : cmp;
  }
  if (a.type === "date") { // day keys compare as strings
    const dk = vals[0] ?? "";
    const cmp = (v: Val): boolean => {
      const s = v.ss[0] ?? ""; if (!s) return false;
      if (op === ">") return s > dk; if (op === ">=") return s >= dk; if (op === "<") return s < dk; if (op === "<=") return s <= dk;
      if (op === "is") return s === dk; if (op === "is_not") return s !== dk;
      return false;
    };
    return c.neg ? (v: Val) => !cmp(v) : cmp;
  }
  const path = a.type === "path";
  const ws: string[] = []; for (const w of vals) ws.push(path ? home(w).toLowerCase() : w.toLowerCase());
  const one = (s: string): boolean => {
    for (const w of ws) {
      if (op === "~" || op === "!~") { if (s.indexOf(w) >= 0) return true; }
      else if (path && w.indexOf("*") >= 0) { if (glob(w, s)) return true; }
      else if (s === w) return true;
    }
    return false;
  };
  const any = (v: Val): boolean => { for (const s of v.ss) if (one(s)) return true; return false; };
  return op === "is_not" || op === "is_not_one_of" || op === "!~" ? (v: Val) => !any(v) : any;
}

// ── compile ──
const WATCH_CALL = ["tool", "server", "program", "command", "file", "ext"];
const PROCS_KEYS = ["harness", "repo", "cwd", "live"];
// the values of a clause, canonicalized for evaluation (relative dates resolved, extensions' resolve applied)
function resolveVals(a: Attr, c: Clause): { vals: string[]; err: string } {
  const out: string[] = [];
  const x = EXT.get(a.key); const rs = x ? x.resolve : null;
  for (const v of c.vals) {
    if (rs) { const r = rs(v); if (r.err) return { vals: [], err: r.err }; out.push(r.v); continue; }
    if (a.type === "date" && v !== "unknown") { out.push(dateOf(v)); continue; }
    if (a.type === "enum") { const e = canonEnum(a, v); if (!e && v !== "unknown") return { vals: [], err: a.key + ": invalid value \"" + v + "\"" }; out.push(e || v); continue; }
    out.push(v);
  }
  return { vals: out, err: "" };
}
function knownDays(): string[] {
  const set = new Set<string>([todayKey()]);
  for (const a of ledger.values()) for (const k of a.days.keys()) set.add(k);
  return [...set];
}
export function compile(cs: Clause[], ctx: Ctx): { f: Compiled | null; err: QErr | null } {
  const f: Compiled = { key: "", cs, sess: [], day: [], call: [], event: [], content: [], dayKeys: null, rowx: [], needsCalls: false, dimmed: [] };
  const parts: string[] = []; const dateCs: ((dk: string) => boolean)[] = [];
  for (const c of cs) {
    const a = attrOf(c.key);
    if (!a) { const sg = suggest(c.key); return { f: null, err: { msg: "unknown key \"" + c.key + "\"" + (sg ? " — did you mean " + sg + "?" : ""), col: 0 } }; }
    if (ctx === "procs" && PROCS_KEYS.indexOf(a.key) < 0) { f.dimmed.push(c); continue; }
    if (ctx === "watch" && (a.key === "status" || a.key === "duration" || a.key === "out")) {
      return { f: null, err: { msg: "--watch: " + a.key + " is known only after the call's result; filter result events with event is result instead", col: 0 } };
    }
    if (ctx === "watch" && a.ent === "call" && WATCH_CALL.indexOf(a.key) < 0) return { f: null, err: { msg: "--watch: " + a.key + " is not known per event; use it with --json", col: 0 } };
    if (ctx !== "watch" && a.ent === "event") return { f: null, err: { msg: "event applies to --watch only", col: 0 } };
    const r = resolveVals(a, c); if (r.err) return { f: null, err: { msg: r.err, col: 0 } };
    parts.push(printClause({ key: c.key, op: c.op, vals: r.vals, neg: c.neg, pinned: false }));
    if (a.key === "content") { f.content.push(c); continue; }
    const m = matcher(a, c, r.vals); const key = a.key;
    if (a.ent === "event") { f.event.push((s: Sess, kind: string, tool: string, args: string) => m(V([kind]))); continue; }
    // tool events, and result events with their call's name and arguments
    if (ctx === "watch" && a.ent === "call") { f.event.push((s: Sess, kind: string, tool: string, args: string) => (kind === "tool" || kind === "result") && m(eventVal(key, tool, args))); continue; }
    if (a.ent === "call") { f.call.push((s: Sess, cl: Call) => m(callVal(key, s, cl))); f.needsCalls = true; continue; }
    // model is per session (its models) and per call (the issuing message's): the session test lifts, rows test their own
    if (key === "model") { f.sess.push((s: Sess) => m(sessVal(key, s))); f.rowx.push((s: Sess, cl: Call) => m(callVal(key, s, cl))); f.needsCalls = true; continue; }
    if (a.ent === "day") {
      f.day.push((s: Sess, dk: string, d: Day) => m(dayVal(key, s, dk, d)));
      if (key === "day" || key === "weekday") dateCs.push((dk: string) => key === "day" ? m(V([dk])) : m(V([WD[weekdayOf(dk)] ?? ""])));
      continue;
    }
    f.sess.push((s: Sess) => m(sessVal(key, s)));
  }
  if (dateCs.length) { const ks: string[] = []; for (const dk of knownDays()) { let ok = true; for (const p of dateCs) if (!p(dk)) { ok = false; break; } if (ok) ks.push(dk); } f.dayKeys = ks.sort(); }
  f.key = parts.join(" and ");
  return { f, err: null };
}
// a call attribute of a --watch tool event (name + argument text)
function eventVal(key: string, tool: string, args: string): Val {
  if (key === "tool") return V([tool.toLowerCase()]);
  if (key === "server") return V([mcpServer(tool).toLowerCase()]);
  if (key === "program") { const n = norm(args); return V(n ? [program(n).toLowerCase()] : []); }
  if (key === "command") { const n = norm(args); return V(n ? [n.toLowerCase()] : []); }
  const p = args.trim().split(/\s/)[0] ?? "";
  if (key === "file") return V(p ? [home(p).toLowerCase()] : []);
  if (key === "ext") return V([extOf(p)]);
  return V([]);
}

// ── evaluation with lifting ──
function all1(ps: ((s: Sess) => boolean)[], s: Sess): boolean { for (const p of ps) if (!p(s)) return false; return true; }
export function sessMatches(f: Compiled, s: Sess): boolean { return all1(f.sess, s); }
export function dayMatches(f: Compiled, s: Sess, dk: string, d: Day): boolean { for (const p of f.day) if (!p(s, dk, d)) return false; return true; }
function callOk(f: Compiled, s: Sess, c: Call): boolean { for (const p of f.call) if (!p(s, c)) return false; for (const p of f.rowx) if (!p(s, c)) return false; return true; }
export function callMatches(f: Compiled, s: Sess, c: Call): boolean {
  if (!all1(f.sess, s)) return false;
  if (f.day.length) { const dk = localOf(c.t).day; const d = accOf(s).days.get(dk); if (!d || !dayMatches(f, s, dk, d)) return false; }
  return callOk(f, s, c);
}
// a row on a selected day (days null = any), within retention, whose day bucket passes the day clauses and that passes the call clauses
// (scriptc: no Set | null values — anyDay says "days not restricted")
function rowOk(f: Compiled, s: Sess, ds: Map<string, Day>, c: Call, cut: number, days: Set<string>, anyDay: boolean): boolean {
  if (c.t < cut) return false;
  const dk = localOf(c.t).day;
  if (!anyDay && !days.has(dk)) return false;
  if (f.day.length) { const d = ds.get(dk); if (!d || !dayMatches(f, s, dk, d)) return false; }
  return callOk(f, s, c);
}
export function matchSession(f: Compiled, s: Sess, days: string[] | null): boolean {
  if (!all1(f.sess, s)) return false;
  if (!f.call.length && !f.day.length) return true;
  const a = accOf(s); const any = days === null; const ds = new Set<string>(days ?? []);
  if (f.call.length) {
    const cut = callCutoff();
    for (let i = a.calls.length - 1; i >= 0; i--) if (rowOk(f, s, a.days, a.calls[i], cut, ds, any)) return true;
    return false;
  }
  for (const [dk, d] of a.days) { if (!any && !ds.has(dk)) continue; if (dayMatches(f, s, dk, d)) return true; }
  return false;
}
export function eachCall(f: Compiled, days: string[], fn: (s: Sess, c: Call) => void): void {
  const cut = callCutoff(); const ds = new Set<string>(days);
  for (const s of sessions.values()) callsIn(f, s, ds, cut, (c: Call) => fn(s, c));
}
// one session's rows of eachCall (resumable aggregation steps a session at a time)
export function callsIn(f: Compiled, s: Sess, days: Set<string>, cut: number, fn: (c: Call) => void): void {
  if (!all1(f.sess, s)) return;
  const a = ledger.get(s.path); if (!a) return;
  for (const c of a.calls) if (rowOk(f, s, a.days, c, cut, days, false)) fn(c);
}
