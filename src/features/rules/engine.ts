// agentglass — rule engine (rules-config spec §4): per (session, rule) level 0/1/2 with `for`, transitions, ack, alert log
// SPDX-License-Identifier: Apache-2.0
// No I/O: the watchdog (TUI), the --watch loop and the --json snapshot feed it values and act on what it returns.
import type { Sess } from "../../model/types.ts";
import { titleOf } from "../../model/sessions.ts";
import { base } from "../../util/json.ts";
import { ago } from "../../util/text.ts";
import { type MVal, absent } from "../detect.ts";
import { type Rule, type RuleSet, unitOf } from "./config.ts";

// since: [pending since for level 1, for level 2] (0 = its threshold does not hold); lvAt: when the current level began
export interface AState { level: number; since: number[]; firedAt: number; lvAt: number; acked: boolean; v: MVal }
export interface Trans { at: number; path: string; rule: string; from: number; to: number; state: string /* fire | escalate | deescalate | resolve */; v: number; thr: number }
export interface Alert { rule: string; severity: string; level: number; value: number; unit: string; threshold: number; since: number; message: string; labels: Map<string, string>; acked: boolean }

interface Box { m: Map<string, AState> } // scriptc: no Map-valued Maps
const ST = new Map<string, Box>(); // path → rule id → state
export const LOG: Trans[] = []; // the newest 500 transitions (help popup, related-events)
const LOG_MAX = 500;

export function holds(op: string, v: number, thr: number): boolean { return op === ">" ? v > thr : op === ">=" ? v >= thr : op === "<" ? v < thr : op === "<=" ? v <= thr : false; }
export function thrOf(r: Rule, level: number): number { return level === 2 ? r.crit : r.deg; }
export function severityOf(level: number): string { return level === 2 ? "critical" : level === 1 ? "degraded" : "ok"; }
// does level k's condition hold for value v (the agent's own assertion lv counts for the degraded level)
function lvHolds(r: Rule, k: number, v: MVal): boolean {
  if (v.v < 0) return false;
  if (k === 1) return r.hasDeg && (v.lv >= 1 || holds(r.op, v.v, r.deg));
  return r.hasCrit && holds(r.op, v.v, r.crit);
}
function newState(): AState { return { level: 0, since: [0, 0], firedAt: 0, lvAt: 0, acked: false, v: absent() }; }
// one tick of one (session, rule): the highest level that holds and has held ≥ for fires; absent → level 0, timers reset
export function evalRule(r: Rule, st: AState, v: MVal, now: number): Trans | null {
  let to = 0;
  for (let k = 1; k <= 2; k++) {
    const i = k - 1;
    if (!lvHolds(r, k, v)) { st.since[i] = 0; continue; }
    if (!st.since[i]) st.since[i] = now;
    if (now - st.since[i] >= r.forSec * 1000) to = k;
  }
  if (v.v >= 0) st.v = v; // the last present value: a resolve still says what it was
  const from = st.level;
  if (to === from) return null;
  const state = from === 0 ? "fire" : to === 0 ? "resolve" : to > from ? "escalate" : "deescalate";
  st.level = to; st.lvAt = now;
  if (state === "fire") { st.firedAt = now; st.acked = false; }
  else if (state === "resolve") { st.firedAt = 0; st.acked = false; } // an ack lasts until the alert resolves (spec §3)
  return { at: now, path: "", rule: r.id, from, to, state, v: st.v.v, thr: thrOf(r, to || from) };
}
function log(t: Trans): void { LOG.push(t); if (LOG.length > LOG_MAX) LOG.splice(0, LOG.length - LOG_MAX); }
function statesOf(path: string): Map<string, AState> { const b = ST.get(path); if (b) return b.m; const m = new Map<string, AState>(); ST.set(path, { m }); return m; }
const NONE = new Map<string, AState>(); // read-only stand-in (scriptc: no Map | null)
function mapOf(path: string): Map<string, AState> { const b = ST.get(path); return b ? b.m : NONE; }
// vals: rule id → value for every enabled rule in scope (a rule without an entry is absent: out of scope)
export function stepSession(rs: RuleSet, path: string, vals: Map<string, MVal>, now: number): Trans[] {
  const out: Trans[] = [];
  const m = statesOf(path);
  for (const r of rs.rules) {
    if (!r.enabled) { m.delete(r.id); continue; }
    let st = m.get(r.id); if (!st) { st = newState(); m.set(r.id, st); }
    const v = vals.get(r.id) ?? absent();
    // turn_done: a new finished turn while the last one still fires is a new alert (resolve, then fire again)
    if (r.metric === "turn_done" && st.level > 0 && v.v >= 0 && v.at !== st.v.at) { const t0 = evalRule(r, st, absent(), now); if (t0) { t0.path = path; out.push(t0); log(t0); } }
    const t = evalRule(r, st, v, now);
    if (t) { t.path = path; out.push(t); log(t); }
  }
  return out;
}
export function stateOf(path: string, id: string): AState | null { return mapOf(path).get(id) ?? null; }
export function watching(path: string): boolean { return ST.has(path); }
// a session no longer watched: its alerts end silently (no transitions)
export function unwatch(path: string): void { ST.delete(path); }
export function prune(alive: (path: string) => boolean): void { for (const p of [...ST.keys()]) if (!alive(p)) ST.delete(p); }
// hot reload: states of rule ids no longer enabled go silently
export function retain(ids: Set<string>): void { for (const b of ST.values()) for (const k of [...b.m.keys()]) if (!ids.has(k)) b.m.delete(k); }
// the user looked: firing ack-look alerts are acknowledged until they resolve
export function ackLook(rs: RuleSet, path: string): void {
  const m = mapOf(path);
  for (const r of rs.rules) { if (r.ack !== "look") continue; const st = m.get(r.id); if (st && st.level > 0) st.acked = true; }
}
// [attention "1" | "", stuck reason | ""] — attention: an unacked degraded alert; stuck: the first unacked critical in rule order
export function flags(rs: RuleSet, path: string): string[] {
  const m = mapOf(path);
  let att = ""; let stuck = "";
  for (const r of rs.rules) {
    const st = m.get(r.id); if (!r.enabled || !st || st.acked) continue;
    if (st.level === 1) att = "1";
    if (st.level === 2 && !stuck) stuck = r.reason;
  }
  return [att, stuck];
}

// ── text ──
export function fmtVal(unit: string, v: number): string {
  if (unit === "duration") return ago(Date.now() - v * 1000);
  if (unit === "usd") return "$" + v.toFixed(2);
  if (unit === "ratio") return (v * 100).toFixed(0) + "%";
  return String(Math.round(v));
}
// placeholder values of an alert: {value} {threshold} {severity} {rule} {tool} {title} {project} {harness} {cpu} {cmd}
export function placeholders(r: Rule, v: MVal, level: number, s: Sess): Map<string, string> {
  const u = unitOf(r.metric); const m = new Map<string, string>();
  m.set("value", v.v < 0 ? "" : fmtVal(u, v.v)); m.set("threshold", fmtVal(u, thrOf(r, level || 1))); m.set("severity", severityOf(level));
  m.set("rule", r.id); m.set("tool", v.tool); m.set("cmd", v.cmd); m.set("cpu", v.cpu);
  m.set("title", titleOf(s)); m.set("project", base(s.cwd)); m.set("harness", s.h);
  return m;
}
// {name} → its value; unknown names stay as written (scriptc: no function replacements)
export function fill(t: string, m: Map<string, string>): string {
  let out = ""; let i = 0;
  while (i < t.length) {
    const a = t.indexOf("{", i); if (a < 0) break;
    const b = t.indexOf("}", a); if (b < 0) break;
    const x = m.get(t.slice(a + 1, b));
    out += t.slice(i, a) + (x !== undefined ? x : t.slice(a, b + 1)); i = b + 1;
  }
  return out + t.slice(i);
}
export function render(r: Rule, v: MVal, level: number, s: Sess): string { return fill(r.message, placeholders(r, v, level, s)); }
function alertOf(r: Rule, st: AState, s: Sess): Alert {
  return { rule: r.id, severity: severityOf(st.level), level: st.level, value: st.v.v, unit: unitOf(r.metric), threshold: thrOf(r, st.level), since: st.lvAt,
    message: render(r, st.v, st.level, s), labels: r.labels, acked: st.acked };
}
// every firing alert of a session in rule order (acknowledged ones included, flagged)
export function firing(rs: RuleSet, s: Sess): Alert[] {
  const m = mapOf(s.path); const out: Alert[] = [];
  for (const r of rs.rules) { const st = m.get(r.id); if (r.enabled && st && st.level > 0) out.push(alertOf(r, st, s)); }
  return out;
}

// ── one-shot (--json): no tick history; `for` is judged from recorded time ──
// the highest level whose threshold holds and has held ≥ for: a duration has held its threshold for v − thr seconds,
// anything else since the recorded time of the newest record behind it (a lower bound: never earlier than the TUI)
export function snapLevel(r: Rule, unit: string, v: MVal, now: number): number {
  let lv = 0;
  for (let k = 1; k <= 2; k++) {
    if (!lvHolds(r, k, v)) continue;
    const held = unit === "duration" ? (v.lv >= 1 && k === 1 ? v.v : v.v - thrOf(r, k)) : (now - v.at) / 1000;
    if (r.forSec <= 0 || held >= r.forSec) lv = k;
  }
  return lv;
}
// snapshot alerts + flags for a session from one set of values (vals as for stepSession)
export function snapshot(rs: RuleSet, s: Sess, vals: Map<string, MVal>, now: number): { alerts: Alert[]; att: boolean; stuck: string } {
  const alerts: Alert[] = []; let att = false; let stuck = "";
  for (const r of rs.rules) {
    if (!r.enabled) continue;
    const v = vals.get(r.id); if (!v || v.v < 0) continue;
    const u = unitOf(r.metric);
    const lv = snapLevel(r, u, v, now); if (!lv) continue;
    const since = u === "duration" ? now - Math.max(0, v.v - (v.lv >= 1 && lv === 1 ? 0 : thrOf(r, lv))) * 1000 : v.at;
    const st: AState = { level: lv, since: [0, 0], firedAt: since, lvAt: since, acked: false, v };
    alerts.push(alertOf(r, st, s));
    if (lv === 1) att = true;
    if (lv === 2 && !stuck) stuck = r.reason;
  }
  return { alerts, att, stuck };
}
