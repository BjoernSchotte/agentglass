// agentglass — watchdog rules: ~/.agentglass/rules.json parsing, validation with line:col, built-in merge (rules-config spec §1, §3, §7)
// SPDX-License-Identifier: Apache-2.0
// Pure: text in, RuleSet out (state.ts reads the file and hot-reloads it). A bad rule disables that rule only.
import { type Obj, obj, arr } from "../../util/json.ts";
import { parse } from "../query/parse.ts";
import { attrOf } from "../query/attrs.ts";
import { type Compiled, compile } from "../query/eval.ts";
import { RULES_FILE } from "./file.ts";

export interface Diag { line: number; col: number; rule: string; msg: string; err: boolean /* false = warning */ }
export interface Rule {
  id: string; metric: string; where: string; wf: Compiled | null /* session scope + call clauses */; ef: Compiled | null /* repeat_run: call clauses on the repeated call's event */;
  op: string /* > >= < <= */; deg: number; crit: number; hasDeg: boolean; hasCrit: boolean; forSec: number; minCalls: number; window: number;
  params: Map<string, number>; ack: string /* look | none */; notify: boolean; message: string;
  labels: Map<string, string>; enabled: boolean; builtin: boolean; reason: string /* s.stuck value */; prefix: string /* notification body prefix */;
}
export interface NotifyCfg { bell: boolean; desktop: boolean; throttleSec: number; command: string[]; on: string[] }
export interface RuleSet { rules: Rule[]; notify: NotifyCfg; diags: Diag[]; syntax: string /* "" or the JSON error */ }

// ── metric catalog (spec §2) ──
export const METRICS: string[] = ["turn_done", "approval_wait", "repeat_run", "command_age", "stalled", "spinning", "session_cost", "session_tokens", "tool_calls", "tool_errors", "tool_error_rate"];
const UNITS = ["duration", "duration", "count", "duration", "duration", "duration", "usd", "count", "count", "count", "ratio"];
export const CALL_METRICS = ["repeat_run", "tool_calls", "tool_errors", "tool_error_rate"];
export function unitOf(metric: string): string { for (let i = 0; i < METRICS.length && i < UNITS.length; i++) if (METRICS[i] === metric) return UNITS[i]; return ""; }
// metric → [param, default, lo, hi] (hi -1 = no upper bound); grace is a duration
const PARAMS: Record<string, string[][]> = {
  approval_wait: [["cpu_below", "2", "0", "100"], ["samples", "7", "1", "400"], ["grace", "5", "0", "-1"]],
  stalled: [["cpu_below", "1", "0", "100"], ["samples", "7", "1", "400"]],
  spinning: [["cpu_above", "80", "0", "100"], ["samples", "120", "1", "400"]],
};
export function paramDefault(metric: string, p: string): number { for (const d of PARAMS[metric] ?? []) if (d[0] === p) return Number(d[1]); return 0; }
// the event keys a repeated call can be filtered by (its name and argument text are all there is)
const EVENT_KEYS = ["tool", "server", "program", "command", "file", "ext"];
const DEFMSG: Record<string, string> = {
  turn_done: "turn finished", approval_wait: "{tool} pending {value}, cpu {cpu}%",
  repeat_run: "{tool} called {value}× in a row with the same arguments", command_age: "{cmd} running {value}",
  stalled: "no log activity {value}, cpu {cpu}%", spinning: "cpu > {cpu}% while the log is silent {value}",
  session_cost: "cost {value} (threshold {threshold})", session_tokens: "{value} tokens (threshold {threshold})",
  tool_calls: "{value} calls (threshold {threshold})", tool_errors: "{value} failed calls (threshold {threshold})",
  tool_error_rate: "error rate {value} (threshold {threshold})",
};
export const STATES = ["fire", "escalate", "deescalate", "resolve"];
const OPS = [">", ">=", "<", "<="];
const RULE_FIELDS = ["id", "metric", "where", "op", "degraded", "critical", "for", "min_calls", "window", "params", "ack", "notify", "message", "labels", "enabled"];
const TOP_FIELDS = ["version", "builtins", "notify", "rules", "$schema"];
const NOTIFY_FIELDS = ["bell", "desktop", "throttle", "command", "on"];

// ── units ──
// "500ms" | "20s" | "2m" | "1h" | "1d" → seconds; a bare number string is seconds; -1 invalid
export function durSec(s: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?\s*$/.exec(s);
  if (!m) return -1;
  const n = Number(m[1] ?? ""); const u = m[2] ?? "s";
  return u === "ms" ? n / 1000 : u === "s" ? n : u === "m" ? n * 60 : u === "h" ? n * 3600 : n * 86400;
}
// a threshold in the unit's base (seconds, USD, count, ratio 0–1); -1 = invalid for this unit
export function parseThr(v: unknown, unit: string): number {
  if (typeof v === "number") { const n = v as number; return isFinite(n) && n >= 0 && (unit !== "ratio" || n <= 1) ? n : -1; }
  if (typeof v !== "string") return -1;
  const s = (v as string).trim();
  if (unit === "duration") return durSec(s);
  if (unit === "ratio") { const m = /^(\d+(?:\.\d+)?)%$/.exec(s); if (!m) return -1; const n = Number(m[1] ?? "") / 100; return n <= 1 ? n : -1; }
  return -1;
}
function thrHint(v: unknown, metric: string, unit: string): string {
  const shown = typeof v === "string" ? "\"" + (v as string) + "\"" : JSON.stringify(v);
  const isDur = typeof v === "string" && durSec(v as string) >= 0 && /[a-z]$/.test(v as string);
  const want = unit === "duration" ? "a duration (\"20s\", \"2m\", \"1h\") or seconds" : unit === "usd" ? "a number in USD" : unit === "ratio" ? "a ratio (0.3) or a percentage (\"30%\")" : "a number";
  return "threshold " + shown + (isDur && unit !== "duration" ? " is a duration" : " is invalid") + "; " + metric + " needs " + want;
}

// ── JSON positions: a small scanner, because scriptc's JSON.parse errors carry no position ──
interface Scan { pos: Map<string, number>; err: number; msg: string }
let SRC = ""; let POS = 0; // scanner cursor (module state: the scanner is not re-entrant)
function ws(): void { while (POS < SRC.length) { const c = SRC.charCodeAt(POS); if (c === 32 || c === 9 || c === 10 || c === 13) POS++; else break; } }
// POS on the opening quote → the decoded string (POS after the closing quote), null on error
function readStr(sc: Scan): string | null {
  const a = POS; POS++;
  while (POS < SRC.length) {
    const c = SRC.charCodeAt(POS);
    if (c === 92) { POS += 2; continue; }
    if (c === 34) { POS++; try { return String(JSON.parse(SRC.slice(a, POS))); } catch (e) { fail(sc, "invalid string escape", a); return null; } }
    if (c < 32) { fail(sc, "control character in a string", POS); return null; }
    POS++;
  }
  fail(sc, "unterminated string", a); return null;
}
function fail(sc: Scan, msg: string, at: number): boolean { if (sc.err < 0) { sc.err = at; sc.msg = msg; } return false; }
function child(path: string, k: string): string { return path ? path + "." + k : k; }
function val(sc: Scan, path: string): boolean {
  ws();
  if (POS >= SRC.length) return fail(sc, "unexpected end of input", POS);
  sc.pos.set(path, POS);
  const c = SRC.charAt(POS);
  if (c === "{") {
    POS++; ws();
    if (SRC.charAt(POS) === "}") { POS++; return true; }
    for (;;) {
      ws();
      if (SRC.charAt(POS) !== "\"") return fail(sc, POS >= SRC.length ? "unexpected end of input" : "expected a quoted key", POS);
      const ka = POS; const k = readStr(sc); if (k === null) return false;
      sc.pos.set(child(path, k) + ":k", ka);
      ws(); if (SRC.charAt(POS) !== ":") return fail(sc, "expected \":\" after the key", POS);
      POS++;
      if (!val(sc, child(path, k))) return false;
      ws(); const d = SRC.charAt(POS);
      if (d === ",") { POS++; continue; }
      if (d === "}") { POS++; return true; }
      return fail(sc, POS >= SRC.length ? "unexpected end of input" : "expected \",\" or \"}\"", POS);
    }
  }
  if (c === "[") {
    POS++; ws();
    if (SRC.charAt(POS) === "]") { POS++; return true; }
    for (let n = 0; ; n++) {
      if (!val(sc, child(path, String(n)))) return false;
      ws(); const d = SRC.charAt(POS);
      if (d === ",") { POS++; ws(); if (SRC.charAt(POS) === "]") return fail(sc, "trailing comma", POS); continue; }
      if (d === "]") { POS++; return true; }
      return fail(sc, POS >= SRC.length ? "unexpected end of input" : "expected \",\" or \"]\"", POS);
    }
  }
  if (c === "\"") return readStr(sc) !== null;
  const rest = SRC.slice(POS, POS + 64);
  const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
  if (m && m[0]) { POS += m[0].length; return true; }
  for (const w of ["true", "false", "null"]) if (rest.startsWith(w)) { POS += w.length; return true; }
  return fail(sc, "unexpected \"" + c + "\"", POS);
}
function scan(text: string): Scan {
  const sc: Scan = { pos: new Map<string, number>(), err: -1, msg: "" };
  SRC = text; POS = 0;
  if (val(sc, "")) { ws(); if (POS < text.length) fail(sc, "unexpected text after the JSON value", POS); }
  SRC = "";
  return sc;
}
// JSON path ("rules.2.where") → offset of its value; "<path>:k" → offset of the key's quote
export function jsonPos(text: string): Map<string, number> { return scan(text).pos; }
// [line, col], 1-based
export function lineCol(text: string, off: number): number[] {
  let line = 1; let col = 1;
  for (let i = 0; i < off && i < text.length; i++) { if (text.charCodeAt(i) === 10) { line++; col = 1; } else col++; }
  return [line, col];
}
// offset in the raw text of decoded character k of the JSON string starting (at its quote) at q
function rawIn(text: string, q: number, k: number): number {
  let i = q + 1;
  for (let n = 0; n < k && i < text.length; n++) { if (text.charCodeAt(i) === 92) i += text.charAt(i + 1) === "u" ? 6 : 2; else i++; }
  return i;
}

// ── built-ins (spec §3: exactly today's detectors) ──
function mk(id: string, metric: string, op: string, deg: number, crit: number, ack: string, notify: boolean, message: string, reason: string, prefix: string): Rule {
  return { id, metric, where: "", wf: null, ef: null, op, deg: deg < 0 ? 0 : deg, crit: crit < 0 ? 0 : crit, hasDeg: deg >= 0, hasCrit: crit >= 0, forSec: 0, minCalls: 1, window: 0,
    params: new Map<string, number>(), ack, notify, message, labels: new Map<string, string>(), enabled: true, builtin: true, reason, prefix };
}
export function builtins(): Rule[] {
  return [
    mk("waiting", "turn_done", ">=", 0, -1, "look", true, "turn finished", "waiting", ""),
    mk("approval", "approval_wait", ">", 20, -1, "look", true, "{tool} pending {value}, cpu {cpu}%", "approval", "approval? "),
    mk("loop", "repeat_run", ">=", -1, 3, "none", false, "{tool} called {value}× in a row with the same arguments", "loop", "[loop] "),
    mk("long-cmd", "command_age", ">", -1, 600, "none", false, "{cmd} running {value}", "long cmd", "[long-cmd] "),
    mk("stalled", "stalled", ">", -1, 480, "none", false, "no log activity {value}, cpu {cpu}%", "stalled", "[stalled] "),
    mk("spinning", "spinning", ">", -1, 180, "none", false, "cpu > {cpu}% for 3m while the log is silent {value}", "spinning", "[spinning] "),
  ];
}
export function defaultNotify(): NotifyCfg { return { bell: true, desktop: true, throttleSec: 30, command: [], on: ["fire", "escalate"] }; }
export function rulesFile(): string { return RULES_FILE; }

// ── loading ──
interface Ctx { text: string; pos: Map<string, number>; diags: Diag[] }
function at(cx: Ctx, path: string): number[] {
  let p = cx.pos.get(path); let q = path;
  while (p === undefined && q.indexOf(".") >= 0) { q = q.slice(0, q.lastIndexOf(".")); p = cx.pos.get(q); } // the nearest enclosing value
  return lineCol(cx.text, p ?? 0);
}
function diag(cx: Ctx, path: string, rule: string, msg: string, err: boolean): void { const lc = at(cx, path); cx.diags.push({ line: lc[0] ?? 1, col: lc[1] ?? 1, rule, msg, err }); }
function diagAt(cx: Ctx, off: number, rule: string, msg: string): void { const lc = lineCol(cx.text, off); cx.diags.push({ line: lc[0] ?? 1, col: lc[1] ?? 1, rule, msg, err: true }); }
function isNum(v: unknown): boolean { return typeof v === "number" && isFinite(v as number); }
function intIn(v: unknown, lo: number): boolean { return isNum(v) && Number.isInteger(v as number) && (v as number) >= lo; }

function copyRule(r: Rule): Rule {
  const p = new Map<string, number>(); for (const [k, v] of r.params) p.set(k, v);
  const l = new Map<string, string>(); for (const [k, v] of r.labels) l.set(k, v);
  return { id: r.id, metric: r.metric, where: r.where, wf: r.wf, ef: r.ef, op: r.op, deg: r.deg, crit: r.crit, hasDeg: r.hasDeg, hasCrit: r.hasCrit, forSec: r.forSec, minCalls: r.minCalls, window: r.window,
    params: p, ack: r.ack, notify: r.notify, message: r.message, labels: l, enabled: r.enabled, builtin: r.builtin, reason: r.reason, prefix: r.prefix };
}
function blank(id: string): Rule {
  return { id, metric: "", where: "", wf: null, ef: null, op: ">", deg: 0, crit: 0, hasDeg: false, hasCrit: false, forSec: 0, minCalls: 1, window: 0,
    params: new Map<string, number>(), ack: "none", notify: true, message: "", labels: new Map<string, string>(), enabled: true, builtin: false, reason: id, prefix: "[" + id + "] " };
}
// the column of key k inside a where string (the clause a semantic error is about), 0 when not found
function keyCol(where: string, k: string): number {
  const l = where.toLowerCase();
  for (let i = l.indexOf(k); i >= 0; i = l.indexOf(k, i + 1)) { const b = i === 0 ? " " : l.charAt(i - 1); const e = l.charAt(i + k.length); if (" ,(-".indexOf(b) >= 0 && (e === " " || e === "")) return i; }
  return 0;
}
// compile where for rule r (metric known); false = an error was reported
function compileWhere(cx: Ctx, path: string, r: Rule): boolean {
  r.wf = null; r.ef = null;
  if (!r.where.trim()) return true;
  const q = cx.pos.get(path + ".where") ?? -1;
  const bad = (col: number, msg: string): boolean => { if (q >= 0 && cx.text.charAt(q) === "\"") diagAt(cx, rawIn(cx.text, q, col), r.id, "where: " + msg); else diag(cx, path + ".where", r.id, "where: " + msg, true); return false; };
  const p = parse(r.where);
  if (p.err) return bad(p.err.col, p.err.msg);
  const call = CALL_METRICS.indexOf(r.metric) >= 0;
  for (const c of p.cs) {
    const a = attrOf(c.key); if (!a) continue; // compile reports it
    const col = keyCol(r.where, c.key);
    if (a.key === "content") return bad(col, "content searches transcripts; rules cannot use it");
    if (a.ent === "day") return bad(col, a.key + " is a day attribute; rules apply to live sessions, not days");
    if (a.ent === "call" && !call) return bad(col, a.key + " is a call attribute; " + r.metric + " is a session metric (call attributes work with " + CALL_METRICS.join(", ") + ")");
    if (a.ent === "call" && r.metric === "repeat_run" && EVENT_KEYS.indexOf(a.key) < 0) return bad(col, a.key + " is not known for a repeated call; use " + EVENT_KEYS.join(", "));
  }
  const cf = compile(p.cs, "list");
  if (cf.err || !cf.f) return bad(cf.err ? cf.err.col : 0, cf.err ? cf.err.msg : "does not compile");
  r.wf = cf.f;
  if (r.metric === "repeat_run") { const ce = compile(p.cs, "watch"); if (ce.err || !ce.f) return bad(0, ce.err ? ce.err.msg : "does not compile"); r.ef = ce.f; }
  return true;
}
// one rule object onto r (a copy of the built-in, or blank); false = the rule has an error (disabled)
function applyRule(cx: Ctx, path: string, o: Obj, r: Rule, isNew: boolean): boolean {
  let ok = true;
  const err = (sub: string, msg: string): void => { diag(cx, sub ? path + "." + sub : path, r.id, msg, true); ok = false; };
  for (const k of Object.keys(o)) if (RULE_FIELDS.indexOf(k) < 0) diag(cx, path + "." + k + ":k", r.id, "unknown field \"" + k + "\" (ignored)", false);
  const v = (k: string): unknown => o[k];
  if (v("metric") !== undefined) {
    if (typeof v("metric") !== "string" || METRICS.indexOf(v("metric") as string) < 0) { err("metric", "unknown metric " + JSON.stringify(v("metric")) + "; one of " + METRICS.join(", ")); return false; }
    if ((v("metric") as string) !== r.metric && !isNew && r.builtin) { r.params = new Map<string, number>(); r.message = ""; }
    r.metric = v("metric") as string;
  } else if (isNew) { err("", "rule \"" + r.id + "\" needs a metric (one of " + METRICS.join(", ") + ")"); return false; }
  if (!r.message) r.message = DEFMSG[r.metric] ?? "{value}";
  const unit = unitOf(r.metric);
  if (v("where") !== undefined) { if (typeof v("where") !== "string") err("where", "where must be a string"); else r.where = v("where") as string; }
  if (v("op") !== undefined) { if (typeof v("op") !== "string" || OPS.indexOf(v("op") as string) < 0) err("op", "op must be one of " + OPS.join(" ")); else r.op = v("op") as string; }
  for (const k of ["degraded", "critical"]) {
    const x = v(k); if (x === undefined) continue;
    if (x === null) { if (k === "degraded") r.hasDeg = false; else r.hasCrit = false; continue; } // null removes a built-in level
    const n = parseThr(x, unit);
    if (n < 0) { err(k, thrHint(x, r.metric, unit)); continue; }
    if (k === "degraded") { r.deg = n; r.hasDeg = true; } else { r.crit = n; r.hasCrit = true; }
  }
  if (v("for") !== undefined) { const n = typeof v("for") === "string" ? durSec(v("for") as string) : isNum(v("for")) ? (v("for") as number) : -1; if (n < 0) err("for", "for must be a duration (\"30s\", \"2m\")"); else r.forSec = n; }
  if (v("min_calls") !== undefined) { if (!intIn(v("min_calls"), 0)) err("min_calls", "min_calls must be an integer ≥ 0"); else r.minCalls = v("min_calls") as number; }
  if (v("window") !== undefined) { if (!intIn(v("window"), 0)) err("window", "window must be an integer ≥ 0 (0 = the whole session)"); else r.window = v("window") as number; }
  if (v("ack") !== undefined) { if (v("ack") !== "look" && v("ack") !== "none") err("ack", "ack must be \"look\" or \"none\""); else r.ack = v("ack") as string; }
  if (v("notify") !== undefined) { if (typeof v("notify") !== "boolean") err("notify", "notify must be true or false"); else r.notify = v("notify") as boolean; }
  if (v("enabled") !== undefined) { if (typeof v("enabled") !== "boolean") err("enabled", "enabled must be true or false"); else r.enabled = v("enabled") as boolean; }
  if (v("message") !== undefined) { if (typeof v("message") !== "string") err("message", "message must be a string"); else r.message = v("message") as string; }
  if (v("labels") !== undefined) {
    const lo = obj(v("labels"));
    if (!lo) err("labels", "labels must be an object of strings");
    else {
      const ks = Object.keys(lo);
      if (ks.length > 16) err("labels", "at most 16 labels (" + String(ks.length) + " given)");
      else { r.labels = new Map<string, string>(); for (const k of ks) { const x = lo[k]; if (typeof x !== "string") err("labels." + k, "label " + k + " must be a string"); else r.labels.set(k, x as string); } }
    }
  }
  if (v("params") !== undefined) {
    const po = obj(v("params"));
    if (!po) err("params", "params must be an object");
    else for (const k of Object.keys(po)) {
      let d: string[] | null = null; for (const x of PARAMS[r.metric] ?? []) if (x[0] === k) d = x;
      if (!d) { diag(cx, path + ".params." + k + ":k", r.id, "unknown param \"" + k + "\" for " + r.metric + " (ignored)", false); continue; }
      const raw = po[k];
      const n = k === "grace" && typeof raw === "string" ? durSec(raw as string) : isNum(raw) ? (raw as number) : NaN;
      const lo = Number(d[2]); const hi = Number(d[3]);
      if (!(n >= lo) || (hi >= 0 && n > hi) || (k === "samples" && !Number.isInteger(n))) err("params." + k, k + " must be " + (k === "samples" ? "an integer " : "") + "between " + d[2] + " and " + (hi >= 0 ? d[3] : "∞") + (k === "grace" ? " seconds" : ""));
      else r.params.set(k, n);
    }
  }
  if (!r.hasDeg && !r.hasCrit) err("", "rule \"" + r.id + "\" needs a degraded or critical threshold");
  if (r.hasDeg && r.hasCrit) {
    const up = r.op === ">" || r.op === ">=";
    if (up ? !(r.deg < r.crit) : !(r.deg > r.crit)) err(v("critical") !== undefined ? "critical" : "degraded", "degraded must be " + (up ? "below" : "above") + " critical for op " + r.op);
  }
  if (ok && !compileWhere(cx, path, r)) ok = false;
  return ok;
}
function loadNotify(cx: Ctx, o: Obj, n: NotifyCfg): void {
  for (const k of Object.keys(o)) if (NOTIFY_FIELDS.indexOf(k) < 0) diag(cx, "notify." + k + ":k", "", "unknown field \"notify." + k + "\" (ignored)", false);
  const e = (k: string, msg: string): void => diag(cx, "notify." + k, "", msg, true);
  if (o["bell"] !== undefined) { if (typeof o["bell"] !== "boolean") e("bell", "notify.bell must be true or false"); else n.bell = o["bell"] as boolean; }
  if (o["desktop"] !== undefined) { if (typeof o["desktop"] !== "boolean") e("desktop", "notify.desktop must be true or false"); else n.desktop = o["desktop"] as boolean; }
  const th = o["throttle"];
  if (th !== undefined) { const s = typeof th === "string" ? durSec(th as string) : isNum(th) ? (th as number) : -1; if (s < 0) e("throttle", "notify.throttle must be a duration (\"30s\")"); else n.throttleSec = s; }
  const c = o["command"];
  if (c !== undefined && c !== null) {
    const a = arr(c); let good = Array.isArray(c) && a.length > 0;
    for (const x of a) if (typeof x !== "string" || !x) good = false;
    if (!good) e("command", "notify.command must be a non-empty array of strings (argv, no shell), e.g. [\"/usr/bin/logger\", \"-t\", \"agentglass\", \"{rule} {severity}\"]");
    else { n.command = []; for (const x of a) n.command.push(x as string); }
  }
  if (o["on"] !== undefined) {
    const a = arr(o["on"]); let good = Array.isArray(o["on"]);
    for (const x of a) if (typeof x !== "string" || STATES.indexOf(x as string) < 0) good = false;
    if (!good) e("on", "notify.on must be an array of " + STATES.join(", "));
    else { n.on = []; for (const x of a) n.on.push(x as string); }
  }
}
// text of rules.json (exists = the file is there); never throws
export function loadRules(text: string, exists: boolean): RuleSet {
  const rs: RuleSet = { rules: builtins(), notify: defaultNotify(), diags: [], syntax: "" };
  if (!exists) return rs;
  const sc = scan(text);
  const cx: Ctx = { text, pos: sc.pos, diags: rs.diags };
  if (sc.err >= 0) { const lc = lineCol(text, sc.err); rs.syntax = sc.msg + " at " + String(lc[0]) + ":" + String(lc[1]); rs.diags.push({ line: lc[0] ?? 1, col: lc[1] ?? 1, rule: "", msg: "syntax error: " + sc.msg + " — using built-in rules", err: true }); return rs; }
  let root: Obj | null = null;
  try { root = obj(JSON.parse(text)); } catch (e) { rs.syntax = String(e); rs.diags.push({ line: 1, col: 1, rule: "", msg: "syntax error: " + String(e) + " — using built-in rules", err: true }); return rs; }
  if (!root) { rs.syntax = "not a JSON object"; rs.diags.push({ line: 1, col: 1, rule: "", msg: "rules.json must be a JSON object ({\"rules\": [...]}) — using built-in rules", err: true }); return rs; }
  for (const k of Object.keys(root)) if (TOP_FIELDS.indexOf(k) < 0) diag(cx, k + ":k", "", "unknown field \"" + k + "\" (ignored)", false);
  if (root["version"] !== undefined && root["version"] !== 1) diag(cx, "version", "", "version must be 1", false);
  if (root["builtins"] !== undefined && typeof root["builtins"] !== "boolean") diag(cx, "builtins", "", "builtins must be true or false", true);
  if (root["builtins"] === false) rs.rules = [];
  const no = root["notify"];
  if (no !== undefined) { const o = obj(no); if (!o) diag(cx, "notify", "", "notify must be an object", true); else loadNotify(cx, o, rs.notify); }
  const rr = root["rules"];
  if (rr !== undefined && !Array.isArray(rr)) { diag(cx, "rules", "", "rules must be an array", true); return rs; }
  const seen = new Set<string>();
  const list = arr(rr);
  for (let i = 0; i < list.length; i++) {
    const path = "rules." + String(i);
    const o = obj(list[i]);
    if (!o) { diag(cx, path, "", "a rule must be an object", true); continue; }
    const id = o["id"];
    if (typeof id !== "string" || !/^[a-z0-9-]{1,40}$/.test(id as string)) { diag(cx, typeof id === "string" ? path + ".id" : path, typeof id === "string" ? (id as string) : "", id === undefined ? "rule needs an \"id\" ([a-z0-9-], 1–40 characters)" : "id " + JSON.stringify(id) + " must match [a-z0-9-]{1,40}", true); continue; }
    const sid = id as string;
    if (seen.has(sid)) { diag(cx, path + ".id", sid, "duplicate id \"" + sid + "\" (the first one is used)", true); continue; }
    seen.add(sid);
    let idx = -1; for (let j = 0; j < rs.rules.length; j++) if (rs.rules[j].id === sid) idx = j;
    const r = idx >= 0 ? copyRule(rs.rules[idx]) : blank(sid);
    const good = applyRule(cx, path, o, r, idx < 0);
    if (!good) r.enabled = false;
    if (!r.message) r.message = DEFMSG[r.metric] ?? "{value}";
    if (idx >= 0) rs.rules[idx] = r; else rs.rules.push(r);
  }
  return rs;
}
// the rule set has errors (diags with err) — a broken rule is disabled, the rest runs
export function errCount(rs: RuleSet): number { let n = 0; for (const d of rs.diags) if (d.err) n++; return n; }
