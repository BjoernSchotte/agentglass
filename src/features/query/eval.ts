// agentglass — filter language: attribute values, compile clauses to predicates, lifting (spec §2, §3)
// SPDX-License-Identifier: Apache-2.0
// A view has a row entity; a clause on another entity is lifted: on a session row, call clauses mean "has a call that
// matches all of them" (the same call), day clauses "has a day bucket that matches all of them" (the same day).
import { HOME } from "../../util/fs.ts";
import type { Sess } from "../../model/types.ts";
import { sessions, titleFrom, working, parentOf, isLive } from "../../model/sessions.ts";
import { type RealMeta, realMeta, display } from "../../hooks.ts";
import { type Day, L, todayKey, dayKey, startOfDay, heavy } from "../usage/record.ts";
import { DICT, nameOf, extOf, localOf } from "../usage/facts.ts";
import { type Rows, rowIds, KIND_PROG, KIND_CMD, KIND_FILE } from "../usage/rows.ts";
import { mcpServer, program, norm } from "../usage/calls.ts";
import { accOf, accsOf, ledger, callsOf, unread, LGEN } from "../usage/ledger.ts";
import { type Acc, skOf, hasSk } from "../usage/record.ts";
import { callCutoff } from "../usage/callcache.ts";
import { type Attr, type Clause, type QErr, type Val, EXACT } from "./types.ts";
import { attrOf, canonEnum, isNumeric, weekdayIndex } from "./attrs.ts";
import { printClause, suggest } from "./parse.ts";
import { repoVals } from "./project.ts";
import { rowFam, rowKind, famName, famLabel, toolFamily, famKind } from "../wait/family.ts";
import { kindMatch, toolKinds, evKindList, shellFam, serverOf, LEGACY_EVENT } from "../../model/kinds.ts";
import { marksOf } from "../../model/marks.ts";
import { toolName, toolArg } from "../callgraph/model.ts";
import type { Ev } from "../../model/types.ts";
import { type LoadRow, skillLoads } from "../skills/model.ts";
import { skillVis, VIS } from "../skills/vis.ts";
import { LISTING } from "../usage/skillrec.ts";
export { callCutoff };

// events: an event view's own filter (ui/evfilter.ts) and `agentglass events`: every clause per event
export type Ctx = "list" | "stats" | "json" | "watch" | "procs" | "events";
// one event as the event clauses see it: raw = the Ev kind (user, tool, result …), kinds = its event kinds (kinds.ts),
// tool / args = the call's name and argument text (a result: its call's), server / fam = mcp.server / shell.family ("" none),
// err = 1 failed, 0 ok, -1 unknown (a call before its result)
export interface EvX { raw: string; kinds: string[]; tool: string; args: string; server: string; fam: string; err: number }
// an event (and its paired call for a result, null otherwise / unknown) as EvX; kinds = its kinds when the caller holds them
// (need: bits of what to fill beyond kinds — 2 the MCP server, 4 the shell family; 7 = everything)
export function evxOf(e: Ev, call: Ev | null, kinds: string[] | null, need: number = 7): EvX {
  const c = e.kind === "tool" ? e : call;
  const tool = c ? toolName(c) : ""; const args = c ? toolArg(c) : "";
  const ks = kinds ?? evKindList(e, call);
  return { raw: e.kind, kinds: ks, tool, args, server: c && (need & 2) ? serverOf(tool, args).toLowerCase() : "", fam: c && (need & 4) ? shellFam(tool, args).toLowerCase() : "", err: ks.indexOf("error") >= 0 ? 1 : e.kind === "result" ? 0 : -1 };
}
// what the old (s, kind, tool, args) event predicates know: no result text, so no error flag
function evxRaw(kind: string, tool: string, args: string): EvX {
  const ks = kind === "tool" || kind === "result" ? toolKinds(tool, args) : evKindList({ kind, text: "", ts: "", id: "", full: "" }, null);
  return { raw: kind, kinds: ks, tool, args, server: tool ? serverOf(tool, args).toLowerCase() : "", fam: tool ? shellFam(tool, args).toLowerCase() : "", err: -1 };
}
export interface Compiled {
  key: string;            // canonical text + resolved relative dates: cache key
  cs: Clause[];           // the clauses compiled (pinned flags kept)
  sess: ((s: Sess) => boolean)[];
  day: ((s: Sess, dk: string, d: Day) => boolean)[];
  call: ((s: Sess, r: Rows, i: number) => boolean)[]; // call row i of the session's rows r
  event: ((s: Sess, kind: string, tool: string, args: string) => boolean)[];
  ev: ((s: Sess, x: EvX) => boolean)[]; // event and (watch, events) call clauses over one event with its kinds
  evLift: boolean;        // list / json: the ev clauses lift ("has such an event": call rows, marks, prompts and replies)
  content: Clause[];      // content ~ / !~ clauses (the full-text search runs elsewhere)
  dayKeys: string[] | null; // known day keys passing the day/weekday clauses, sorted; null = no day clause (scriptc: no Set | null members)
  rowx: ((s: Sess, r: Rows, i: number) => boolean)[]; // per-row tests of session attributes a call refines (model): rows only, never lifted alone
  needsCalls: boolean;    // any call clause or row refinement: totals and aggregates must read call rows
  dimmed: Clause[];       // clauses that do not apply in this ctx (procs: all but harness/repo/cwd/live)
  skill: ((r: SkQ) => boolean)[]; // skill clauses, all on one session × skill row (also folded into sess: "has such a skill")
}
export const EMPTY: Compiled = { key: "", cs: [], sess: [], day: [], call: [], event: [], ev: [], evLift: false, content: [], dayKeys: null, rowx: [], needsCalls: false, dimmed: [], skill: [] };

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
// fleet: this machine's name in the host attribute (fleet.localName; features/fleet/hosts.ts sets it)
export const HOSTQ = { local: "local" };
function stateOf(s: Sess): string {
  if (s.host) return !isLive(s) ? "ended" : s.stuck ? "stuck" : s.attention ? "attention" : s.status === "busy" ? "busy" : "idle"; // a stale remote row is not live
  if (s.stuck) return "stuck";
  if (s.attention) return "attention";
  const pid = livePid(s);
  if (pid && working(s)) return "busy";
  return pid ? "idle" : "ended";
}
function errorsOf(s: Sess): number { const a = ledger.get(s.path); let n = 0; if (a) for (const d of a.days.values()) for (const st of heavy(d).tt.values()) n += st.err; return n; }
// session model ∪ the models of its call rows, per (path, L.ver)
// keyed on the session's ledger entry (object, offset) and its own model: rows only change when the entry moves
const models = new Map<string, { a: Acc | null; off: number; m: string; ss: string[] }>();
function modelsOf(s: Sess): Val {
  const a = ledger.get(s.path) ?? null; const hit = models.get(s.path);
  if (hit && a && hit.a === a && hit.off === a.off && hit.m === s.model && !unread.has(s.path)) return hit.ss.length ? V(hit.ss) : UNK;
  const set = new Set<string>(); if (s.model) set.add(s.model.toLowerCase());
  const seen = new Set<number>(); const r = callsOf(s);
  for (let i = 0; i < r.n; i++) { const m = r.model[i] + 0; if (m >= 0 && !seen.has(m)) { seen.add(m); set.add(nameOf(DICT.model, m).toLowerCase()); } }
  const ss = [...set]; const b = ledger.get(s.path) ?? null; models.set(s.path, { a: b, off: b ? b.off : -1, m: s.model, ss });
  return ss.length ? V(ss) : UNK;
}
// --redact: the real values (realMeta) — the screen shows fakes, filters (and pins saved without --redact) mean the real
// ones; cwd, branch and agent also take the session's own shown fake for exact matches (EXACT), so a value picked off the
// redacted screen still selects it
function haystack(s: Sess, m: RealMeta): string { return (titleFrom(s, m.title, m.prompt) + " " + m.cwd + " " + s.id + " " + s.h + " " + m.name + " " + m.branch + " " + m.kind).toLowerCase(); }
function both(real: string, shown: string): Val { const a = real.toLowerCase(); const b = shown.toLowerCase(); return V(a === b ? [a] : [a, EXACT + b]); }
export function sessVal(key: string, s: Sess): Val {
  const x = EXT.get(key); if (x && x.sess) { const f = x.sess; return f(s); }
  switch (key) {
    case "harness": return V([s.h]);
    case "repo": return V(repoVals(s));
    case "cwd": return both(home(realMeta(s).cwd), home(s.cwd));
    case "branch": return both(realMeta(s).branch, s.branch);
    case "model": return modelsOf(s);
    case "title": { const m = realMeta(s); return V([titleFrom(s, m.title, m.prompt).toLowerCase()]); }
    case "id": return V([s.id.toLowerCase()]);
    case "agent": return both(realMeta(s).kind, s.kind);
    case "subagent": return V([s.parent !== "" ? "true" : "false"]);
    case "live": return V([livePid(s) > 0 || isLive(s) ? "true" : "false"]);
    case "host": return V([(s.host || HOSTQ.local).toLowerCase()]);
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
    case "text": return V([haystack(s, realMeta(s))]);
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
// program names, plus (--redact) each one's shown fake for exact matches: the completion offers only those
function progVals(xs: number[]): string[] {
  const o: string[] = [];
  for (const x of xs) { const n = nameOf(DICT.prog, x); o.push(n.toLowerCase()); const sh = display("prog", n, null); if (sh !== n) o.push(EXACT + sh.toLowerCase()); }
  return o;
}
export function callVal(key: string, s: Sess, r: Rows, i: number): Val {
  switch (key) {
    case "tool": return V([nameOf(DICT.tool, r.tool[i] + 0).toLowerCase()]);
    case "server": return V([mcpServer(nameOf(DICT.tool, r.tool[i] + 0)).toLowerCase()]);
    case "program": return V(progVals(rowIds(r, i, KIND_PROG)));
    case "command": return V(names(DICT.cmd, rowIds(r, i, KIND_CMD)));
    case "family": { const f = rowFam(r, i); if (f < 0) return V([toolFamily(nameOf(DICT.tool, r.tool[i] + 0)).toLowerCase()]); const n = famName(f).toLowerCase(); const sh = famLabel(f).toLowerCase(); return V(sh === n ? [n] : [n, EXACT + sh]); }
    case "kind": return V([rowKind(r, i)]);
    case "file": return V(names(DICT.file, rowIds(r, i, KIND_FILE)));
    case "ext": { const o: string[] = []; for (const f of rowIds(r, i, KIND_FILE)) { const e = extOf(nameOf(DICT.file, f)); if (o.indexOf(e) < 0) o.push(e); } return V(o); }
    case "status": { const e = r.err[i] + 0; return V([e === 1 ? "error" : e === 0 ? "ok" : "unknown"]); }
    case "duration": return r.ms[i] < 0 ? UNK : N(r.ms[i] + 0);
    case "out": return r.err[i] < 0 ? UNK : N(r.out[i] + 0);
    case "hour": return N(localOf(r.t[i] + 0).hour);
    case "model": return r.model[i] < 0 ? UNK : V([nameOf(DICT.model, r.model[i] + 0).toLowerCase()]);
    case "day": return V([localOf(r.t[i] + 0).day]);
    case "weekday": return V([WD[localOf(r.t[i] + 0).wd] ?? ""]);
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
  const one = (s0: string): boolean => {
    const ex = s0.startsWith(EXACT); const s = ex ? s0.slice(EXACT.length) : s0;
    for (const w of ws) {
      if (op === "~" || op === "!~") { if (!ex && s.indexOf(w) >= 0) return true; }
      else if (path && w.indexOf("*") >= 0) { if (!ex && glob(w, s)) return true; }
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
// does the counted period reach before cutoff (the oldest local day that keeps call rows)? dayKeys: the clauses' days
// (null = no day clause), period: the view's days oldest first ([] = all history), oldest: the oldest known day
export function beyondRetention(dayKeys: string[] | null, period: string[], oldest: string, cutoff: string): boolean {
  let first: string = period.length ? period[0] : oldest;
  if (dayKeys) {
    first = "";
    if (!period.length) { if (dayKeys.length) first = dayKeys[0]; }
    else { const ks = new Set<string>(dayKeys); for (const d of period) if (ks.has(d)) { first = d; break; } }
  }
  const c: string = String(cutoff); const f0: string = String(first); // scriptc 0.1.7 lost these types across modules (SC1043)
  return f0 !== "" && f0 < c;
}
// the oldest day a listed session that passes f's session clauses has a bucket for, "" = none: the earliest day an
// all-history view (the Sessions list) counts for f; per ledger version, filter and session count
const oldMemo = { ver: -1, key: "", n: -1, day: "" };
export function oldestDay(f: Compiled): string {
  if (oldMemo.ver === L.ver && oldMemo.key === f.key && oldMemo.n === sessions.size) return oldMemo.day;
  let o = "";
  for (const s of sessions.values()) {
    const a = ledger.get(s.path); if (!a || !all1(f.sess, s)) continue;
    for (const k of a.days.keys()) if (o === "" || k < o) o = k;
  }
  oldMemo.ver = L.ver; oldMemo.key = f.key; oldMemo.n = sessions.size; oldMemo.day = o; return o;
}
function knownDays(): string[] {
  const set = new Set<string>([todayKey()]);
  for (const a of ledger.values()) for (const k of a.days.keys()) set.add(k);
  return [...set];
}
export function compile(cs: Clause[], ctx: Ctx): { f: Compiled | null; err: QErr | null } {
  const f: Compiled = { key: "", cs, sess: [], day: [], call: [], event: [], ev: [], evLift: false, content: [], dayKeys: null, rowx: [], needsCalls: false, dimmed: [], skill: [] };
  const parts: string[] = []; const dateCs: ((dk: string) => boolean)[] = [];
  for (const c of cs) {
    const a = attrOf(c.key);
    if (!a) { const sg = suggest(c.key); return { f: null, err: { msg: "unknown key \"" + c.key + "\"" + (sg ? " — did you mean " + sg + "?" : ""), col: 0 } }; }
    if (ctx === "procs" && PROCS_KEYS.indexOf(a.key) < 0) { f.dimmed.push(c); continue; }
    if (ctx === "watch" && (a.key === "status" || a.key === "duration" || a.key === "out")) {
      return { f: null, err: { msg: "--watch: " + a.key + " is known only after the call's result; filter result events with event is result instead", col: 0 } };
    }
    if (ctx === "watch" && a.ent === "call" && WATCH_CALL.indexOf(a.key) < 0) return { f: null, err: { msg: "--watch: " + a.key + " is not known per event; use it with --json", col: 0 } };
    if (ctx === "events" && a.ent === "call" && WATCH_CALL.indexOf(a.key) < 0 && a.key !== "status") return { f: null, err: { msg: a.key + " is not known per event in an event view; use it on the session list or with --json", col: 0 } };
    if (ctx === "events" && a.ent === "day") return { f: null, err: { msg: a.key + " applies to the session list and Stats, not to an event view", col: 0 } };
    if (ctx === "stats" && a.ent === "event") return { f: null, err: { msg: a.key + " selects events: use it on the session list, in an event view (transcript, call graph: K or /), --watch or agentglass events", col: 0 } };
    if (a.ent === "skill" && ctx === "watch" && a.key !== "skill" && a.key !== "skill.trigger") return { f: null, err: { msg: "--watch: " + a.key + " is known only after the session's requests (load + carry); --watch matches skill and skill.trigger on load lines — use " + a.key + " with --json", col: 0 } };
    if (a.ent === "skill" && ctx === "events") return { f: null, err: { msg: a.key + " selects sessions by their skills: use it on the session list, Stats or --json; in an event view event.kind is skill shows the loads", col: 0 } };
    const r = resolveVals(a, c); if (r.err) return { f: null, err: { msg: r.err, col: 0 } };
    parts.push(printClause({ key: c.key, op: c.op, vals: r.vals, neg: c.neg, pinned: false }));
    if (a.key === "content") { f.content.push(c); continue; }
    const key = a.key;
    // the legacy values of event / event.kind name raw event kinds: marked so they never meet a kind of the same name
    const legacy = key === "event";
    const m = matcher(a, c, key === "event.kind" || legacy ? r.vals.map((v: string): string => rawValue(legacy, v.toLowerCase()) ? RAWP + v.toLowerCase() : v) : r.vals);
    if (a.ent === "skill") {
      if (ctx === "watch") { f.ev.push((s: Sess, x: EvX) => x.tool.startsWith(SKILL_EV) && m(key === "skill" ? skillNames(x.tool.slice(SKILL_EV.length)) : V([x.args]))); continue; }
      f.skill.push((q: SkQ) => m(skillVal(key, q)));
      continue;
    }
    if (a.ent === "event") {
      const p = evPred(key, m);
      f.ev.push(p); f.event.push((s: Sess, kind: string, tool: string, args: string) => p(s, evxRaw(kind, tool, args)));
      if (ctx === "list" || ctx === "json") { f.evLift = true; f.needsCalls = true; }
      continue;
    }
    // tool events, and result events with their call's name and arguments (status: known on the result, and on its call
    // once the result is in)
    if ((ctx === "watch" || ctx === "events") && a.ent === "call") {
      if (key === "status") { f.ev.push((s: Sess, x: EvX) => x.err >= 0 && m(V([x.err === 1 ? "error" : "ok"]))); continue; }
      f.event.push((s: Sess, kind: string, tool: string, args: string) => (kind === "tool" || kind === "result") && m(eventVal(key, tool, args)));
      f.ev.push((s: Sess, x: EvX) => (x.raw === "tool" || x.raw === "result") && m(eventVal(key, x.tool, x.args)));
      continue;
    }
    if (a.ent === "call") { f.call.push((s: Sess, r: Rows, i: number) => m(callVal(key, s, r, i))); f.needsCalls = true; continue; }
    // model is per session (its models) and per call (the issuing message's): the session test lifts, rows test their own
    if (key === "model") { f.sess.push((s: Sess) => m(sessVal(key, s))); f.rowx.push((s: Sess, r: Rows, i: number) => m(callVal(key, s, r, i))); f.needsCalls = true; continue; }
    if (a.ent === "day") {
      f.day.push((s: Sess, dk: string, d: Day) => m(dayVal(key, s, dk, d)));
      if (key === "day" || key === "weekday") dateCs.push((dk: string) => key === "day" ? m(V([dk])) : m(V([WD[weekdayOf(dk)] ?? ""])));
      continue;
    }
    f.sess.push((s: Sess) => m(sessVal(key, s)));
  }
  if (f.skill.length) { const ps = f.skill; f.sess.push((s: Sess) => { for (const q of skillRows(s)) if (skillOk(ps, q)) return true; return false; }); }
  if (dateCs.length) { const ks: string[] = []; for (const dk of knownDays()) { let ok = true; for (const p of dateCs) if (!p(dk)) { ok = false; break; } if (ok) ks.push(dk); } f.dayKeys = ks.sort(); }
  f.key = parts.join(" and ");
  return { f, err: null };
}
// an event clause → its predicate. event.kind / event: the event's kinds (a family matches all of its kinds); the old values
// of `event` (user, assistant, thinking, tool, result, live, exit, alert; meta under the old key) match the raw kind
function evPred(key: string, m: (v: Val) => boolean): (s: Sess, x: EvX) => boolean {
  if (key === "mcp.server") return (s: Sess, x: EvX) => m(V(x.server ? [x.server] : []));
  if (key === "shell.family") return (s: Sess, x: EvX) => m(V(x.fam ? [x.fam] : []));
  return (s: Sess, x: EvX) => m(V(evVals(x)));
}
// the values an event offers the kind matcher: the raw kind under its legacy name (kept apart from the kinds by a prefix
// only the legacy values carry), every kind, and every family of a kind ("shell" for shell:test)
function evVals(x: EvX): string[] {
  const o: string[] = [];
  for (const k of x.kinds) { o.push(k); const i = k.indexOf(":"); if (i > 0 && o.indexOf(k.slice(0, i)) < 0) o.push(k.slice(0, i)); }
  o.push(RAWP + x.raw);
  return o;
}
const RAWP = "\u0002";
// a legacy value names a raw event kind: matched against the raw kind only (event is meta: under event.kind the family)
export function rawValue(legacy: boolean, v: string): boolean { return LEGACY_EVENT.has(v) && (v !== "meta" || legacy); }
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

// ── skill rows (spec §6.11): one per session × skill name, from the session's load timeline (its copies, not its subagents) ──
// trigs = the triggers of its loads; cost/carry/tail = $ (-1 unknown: a load without a size or a price); size = S of the
// newest load (-1 unknown); omitted skills (skills.hide omit) have no row
export interface SkQ { name: string; shown: string; trigs: string[]; loads: number; cost: number; carry: number; tail: number; size: number; scope: string }
// a --watch skill line as an event (cli.ts): tool = SKILL_EV + the real name, args = the trigger
export const SKILL_EV = "\u0003skill:";
function skillNames(name: string): Val { const v = skillVis(name); const a = name.toLowerCase(); const b = v.shown.toLowerCase(); return V(a === b ? [a] : [a, EXACT + b]); }
export function skillVal(key: string, q: SkQ): Val {
  switch (key) {
    case "skill": { const a = q.name.toLowerCase(); const b = q.shown.toLowerCase(); return V(a === b ? [a] : [a, EXACT + b]); }
    case "skill.trigger": return V(q.trigs);
    case "skill.loads": return N(q.loads);
    case "skill.cost": return q.cost < 0 ? UNK : N(q.cost);
    case "skill.carry": return q.carry < 0 ? UNK : N(q.carry);
    case "skill.tail": return q.tail < 0 ? UNK : N(q.tail);
    case "skill.size": return q.size < 0 ? UNK : N(q.size);
    case "skill.scope": return V([q.scope || "?"]);
  }
  return V([]);
}
export function skillOk(ps: ((r: SkQ) => boolean)[], q: SkQ): boolean { for (const p of ps) if (!p(q)) return false; return true; }
// the rows of loads (any sessions' LoadRows): grouped by name in first-load order, hidden ones left out
export function skillRowsFrom(ls: LoadRow[]): SkQ[] {
  const out: SkQ[] = []; const at = new Map<string, number>(); const newest = new Map<string, number>();
  for (const l of ls) {
    const v = skillVis(l.name); if (v.mode === "omit") continue;
    let i = at.get(l.name) ?? -1;
    if (i < 0) { i = out.length; at.set(l.name, i); out.push({ name: l.name, shown: v.shown, trigs: [], loads: 0, cost: 0, carry: 0, tail: 0, size: -1, scope: "" }); }
    const q = out[i];
    if (q.trigs.indexOf(l.trig) < 0) q.trigs.push(l.trig);
    q.loads += Math.max(1, l.n);
    const unk = l.unpriced || l.tier === "?";
    if (unk || q.cost < 0) { q.cost = -1; q.carry = -1; q.tail = -1; } else { q.cost += l.usd; q.carry += l.carryUsd; q.tail += l.tailUsd; }
    if (l.t >= (newest.get(l.name) ?? -1)) { newest.set(l.name, l.t); q.size = l.size; q.scope = l.scope; }
  }
  return out;
}
// per session path, kept while its ledger entries (objects, offsets) and the price generation stay
interface SkMemo { as: Acc[]; offs: number[]; gen: number; vis: number; rows: SkQ[] }
const skMemo = new Map<string, SkMemo>();
export function skillRows(s: Sess): SkQ[] {
  if (s.host) return [];
  const as = accsOf(s); const m = skMemo.get(s.path);
  if (m && m.gen === LGEN.reapply && m.vis === VIS.gen && m.as.length === as.length) {
    let same = true; for (let i = 0; i < as.length; i++) if (m.as[i] !== as[i] || numAt0(m.offs, i) !== as[i].off) { same = false; break; }
    if (same) return m.rows;
  }
  let any = false; for (const a of as) if (hasSk(a)) { any = true; break; }
  const ids: string[] = []; for (let i = 0; i < as.length; i++) ids.push("");
  const rows = any ? skillRowsFrom(skillLoads(as, ids)) : [];
  const offs: number[] = []; for (const a of as) offs.push(a.off);
  if (skMemo.size > 20000) skMemo.clear();
  skMemo.set(s.path, { as, offs, gen: LGEN.reapply, vis: VIS.gen, rows });
  return rows;
}
function numAt0(a: number[], i: number): number { return i >= 0 && i < a.length ? a[i] + 0 : -1; }
// triage's skill dimension: the shown names of the session's skills (at < 0), or of those in context at time at (a call's
// start: loaded at or before it and not yet unloaded); the listing is in nearly every context and says nothing here
export function skillsAt(s: Sess, at: number): string[] {
  const o: string[] = []; if (s.host) return o;
  for (const a of accsOf(s)) for (const l of skOf(a)) {
    if (l.name === LISTING || (at >= 0 && (l.t > at || (l.end > 0 && l.end <= at)))) continue;
    const v = skillVis(l.name); if (v.mode !== "omit" && o.indexOf(v.shown) < 0) o.push(v.shown);
  }
  return o;
}
// the rows of a filter's skill clauses a surface shows (the Stats skills panel: only matching names); all without such clauses
export function skillRowMatches(f: Compiled, q: SkQ): boolean { return skillOk(f.skill, q); }

// ── evaluation with lifting ──
function all1(ps: ((s: Sess) => boolean)[], s: Sess): boolean { for (const p of ps) if (!p(s)) return false; return true; }
export function sessMatches(f: Compiled, s: Sess): boolean { return all1(f.sess, s); }
export function dayMatches(f: Compiled, s: Sess, dk: string, d: Day): boolean { for (const p of f.day) if (!p(s, dk, d)) return false; return true; }
function callOk(f: Compiled, s: Sess, r: Rows, i: number): boolean { for (const p of f.call) if (!p(s, r, i)) return false; for (const p of f.rowx) if (!p(s, r, i)) return false; return true; }
export function callMatches(f: Compiled, s: Sess, r: Rows, i: number): boolean {
  if (!all1(f.sess, s)) return false;
  if (f.day.length) { const dk = localOf(r.t[i] + 0).day; const d = accOf(s).days.get(dk); if (!d || !dayMatches(f, s, dk, d)) return false; }
  return callOk(f, s, r, i);
}
// a row on a selected day (days null = any), within retention, whose day bucket passes the day clauses and that passes the call clauses
// (scriptc: no Set | null values — anyDay says "days not restricted")
function rowOk(f: Compiled, s: Sess, ds: Map<string, Day>, r: Rows, i: number, cut: number, days: Set<string>, anyDay: boolean): boolean {
  const t = r.t[i] + 0;
  if (t < cut) return false;
  const dk = localOf(t).day;
  if (!anyDay && !days.has(dk)) return false;
  if (f.day.length) { const d = ds.get(dk); if (!d || !dayMatches(f, s, dk, d)) return false; }
  return callOk(f, s, r, i);
}
// rows fall on the session's day buckets: a session without a bucket in the window and within retention has no row there,
// and its calls file is not read (call rows are read lazily, ledger.ts callsOf)
const cutDay = { cut: -1, key: "" };
function rowsMayMatch(ds: Map<string, Day>, cut: number, days: Set<string>, anyDay: boolean): boolean {
  if (cut !== cutDay.cut) { cutDay.cut = cut; cutDay.key = localOf(cut).day; }
  for (const k of ds.keys()) if (k >= cutDay.key && (anyDay || days.has(k))) return true;
  return false;
}
// matchSession with the session's row/day verdict kept: it stands while the session's ledger entry (object, offset), the
// retention cut and the price generation (day.cost clauses) are unchanged; the session clauses are tested every time
// (live, age, title… change without the ledger). A pinned call filter while agents stream re-reads only what moved.
export interface RowMemo { a: Acc | null; off: number; cut: number; gen: number; hit: boolean }
export const MEMO_STATS = { evals: 0 };
export function matchSessionMemo(f: Compiled, s: Sess, memo: Map<string, RowMemo>): boolean {
  if (!all1(f.sess, s)) return false;
  if (!f.call.length && !f.day.length && !f.evLift) return true;
  const a = ledger.get(s.path) ?? null; const cut = callCutoff(); const m = memo.get(s.path);
  if (a && m && m.a === a && m.off === a.off && m.cut === cut && m.gen === LGEN.reapply && !unread.has(s.path)) return m.hit;
  MEMO_STATS.evals++;
  const hit = matchSession(f, s, null);
  const b = ledger.get(s.path) ?? null; // reading rows may have replaced a stale entry
  memo.set(s.path, { a: b, off: b ? b.off : -1, cut, gen: LGEN.reapply, hit });
  return hit;
}
// matchSession would read this session's calls file first (not read in this run yet, rows possibly in the window)
const NO_DAYS = new Set<string>();
export function rowsPending(f: Compiled, s: Sess): boolean {
  if (!f.call.length && !f.rowx.length && !f.evLift) return false;
  if (!unread.has(s.path)) return false;
  const a = ledger.get(s.path); return !!a && rowsMayMatch(a.days, callCutoff(), NO_DAYS, true);
}
// list / json: the session has an event that passes every event clause — a call row (its tool, shell family and
// status), a mark (skill loads, debug episodes) or a prompt / reply (any turn) — the logs are not read for it. Like a
// call clause, the event must lie on a day the selection and the day clauses keep (ds / any: matchSession's days)
function evLifted(f: Compiled, s: Sess, a: Acc, ds: Set<string>, any: boolean): boolean {
  const ok = (x: EvX): boolean => { for (const p of f.ev) if (!p(s, x)) return false; return true; };
  const free = any && !f.day.length; // no day restriction: undated events count too
  const dayOk = (dk: string): boolean => { if (!any && !ds.has(dk)) return false; if (!f.day.length) return true; const d = a.days.get(dk); return !!d && dayMatches(f, s, dk, d); };
  const atOk = (t: number): boolean => t > 0 ? dayOk(localOf(t).day) : free;
  let turns = 0; for (const [dk, d] of a.days) if (dayOk(dk)) turns += d.turns;
  if (turns > 0 || (free && s.outTok > 0)) {
    if (ok({ raw: "user", kinds: ["prompt"], tool: "", args: "", server: "", fam: "", err: -1 })) return true;
    if (ok({ raw: "assistant", kinds: ["reply"], tool: "", args: "", server: "", fam: "", err: -1 })) return true;
  }
  for (const m of marksOf(s, null)) if (atOk(m.t0) && ok({ raw: "meta", kinds: [m.kind], tool: "", args: "", server: "", fam: "", err: -1 })) return true;
  const r = callsOf(s); const cut = callCutoff();
  for (let i = r.n - 1; i >= 0; i--) {
    const t = r.t[i] + 0; if (t < cut || !atOk(t)) continue;
    const tool = nameOf(DICT.tool, r.tool[i] + 0); const fi = rowFam(r, i);
    const ks = fi >= 0 ? ["shell:" + famKind(fi)] : toolKinds(tool, "");
    const e = r.err[i] + 0; if (e === 1) ks.push("error");
    if (ok({ raw: "tool", kinds: ks, tool, args: "", server: serverOf(tool, "").toLowerCase(), fam: fi >= 0 ? famName(fi).toLowerCase() : "", err: e })) return true;
  }
  return false;
}
export function matchSession(f: Compiled, s: Sess, days: string[] | null): boolean {
  if (!all1(f.sess, s)) return false;
  if (!f.call.length && !f.day.length && !f.evLift) return true;
  if (s.host) return false; // a remote row (fleet): its calls and days are not here (and it never gets a ledger entry)
  const a = accOf(s); const any = days === null; const ds = new Set<string>(days ?? []);
  if (f.evLift && !evLifted(f, s, a, ds, any)) return false;
  if (!f.call.length && !f.day.length) return true;
  if (f.call.length) {
    const cut = callCutoff(); if (!rowsMayMatch(a.days, cut, ds, any)) return false;
    const r = callsOf(s); const b = ledger.get(s.path) ?? a; // a stale calls file re-indexed the session: its new entry
    for (let i = r.n - 1; i >= 0; i--) if (rowOk(f, s, b.days, r, i, cut, ds, any)) return true;
    return false;
  }
  for (const [dk, d] of a.days) { if (!any && !ds.has(dk)) continue; if (dayMatches(f, s, dk, d)) return true; }
  return false;
}
// every matching row as (s, r, i): r and i are valid only inside fn (rows are compacted between passes). later: the TUI's
// deferral (query/ui.ts rowsLater) — a session whose calls file this run has not read is put there instead of read
export function eachCall(f: Compiled, days: string[], fn: (s: Sess, r: Rows, i: number) => void, later: Sess[] | null = null): void {
  const cut = callCutoff(); const ds = new Set<string>(days);
  for (const s of sessions.values()) callsIn(f, s, ds, cut, (r: Rows, i: number) => fn(s, r, i), later);
}
// one session's rows of eachCall (resumable aggregation steps a session at a time)
export function callsIn(f: Compiled, s: Sess, days: Set<string>, cut: number, fn: (r: Rows, i: number) => void, later: Sess[] | null = null): void {
  const a = ledger.get(s.path); if (!a) return;
  // a model clause reads rows already in the session test: defer before it (as matchingPaths does); other session clauses
  // are cheap and keep sessions nobody asks for out of the queue
  if (later && unread.has(s.path) && rowsMayMatch(a.days, cut, days, false) && (f.rowx.length > 0 || all1(f.sess, s))) { later.push(s); return; }
  if (!all1(f.sess, s) || !rowsMayMatch(a.days, cut, days, false)) return;
  const r = callsOf(s); const b = ledger.get(s.path) ?? a;
  for (let i = 0; i < r.n; i++) if (rowOk(f, s, b.days, r, i, cut, days, false)) fn(r, i);
}
