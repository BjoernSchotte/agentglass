// agentglass — watchdog: runs the alert rules (rules/, built-ins = waiting ◆, approval? ◆, stuck ⚠) on live sessions
// SPDX-License-Identifier: Apache-2.0
import { ago } from "../util/text.ts";
import type { Ev, Proc, Sess } from "../model/types.ts";
import { S, say } from "../state.ts";
import { H } from "../hooks.ts";
import { sessions, loadTail, working, current, sessAt, titleOf } from "../model/sessions.ts";
import { allProcs, hist, rootOf, refreshProcs, paneTitles, ttyOf } from "../model/procs.ts";
import { harnessOf } from "../harness/index.ts";
import { C, CSI, RST, fg } from "../ui/theme.ts";
import { type Obs, type MVal, type Cmd, etimeSec, loopRun, toolName, pendingTool, avgTail, toolCmds, absent, approvalWait, commandAge, stalledFor, spinningFor, repeatRun, approvalNote, approvalGuess, alarmOf, stuckOf } from "./detect.ts";
import { accOf, complete as ledgerComplete } from "./usage/ledger.ts";
import type { Call } from "./usage/facts.ts";
import { sessMatches } from "./query/eval.ts";
import { type Rule, type RuleSet, CALL_METRICS, thrText, unitOf } from "./rules/config.ts";
import { metricOf } from "./rules/metrics.ts";
import { type Trans, type Alert, LOG, stepSession, unwatch, prune, ackLook, flags, firing, stateOf, watching, snapshot, render, severityOf } from "./rules/engine.ts";
import { onTrans, forget } from "./rules/notify.ts";
import { R, rules } from "./rules/state.ts";
export { type Obs, type MVal, type Cmd, etimeSec, loopRun, toolName, pendingTool, avgTail, toolCmds, absent, approvalWait, commandAge, stalledFor, spinningFor, repeatRun, approvalNote, approvalGuess, alarmOf, stuckOf };

// ── live state ────────────────────────────────────────────────────────────────
// busy/prompt: last look; turnAt: when this run saw the last turn finish (0 = none, or busy since); looks: looks since then
interface St { busy: boolean; prompt: string; turnAt: number; looks: number }
// a finished turn of a harness whose approval dialog may hide behind it (o.mayGuess) is held this many more looks (≈ 3 s at
// the 1.5 s cadence: the quiet window of approvalGuess) unless the guess holds sooner, so the alert that fires (bell,
// notification, command, --watch line) already says "approval?"; other harnesses fire on the first idle look
const GUESS_LOOKS = 2;
const st = new Map<string, St>();
let selPath = ""; let selSince = 0;

// the newest user prompt in the tail window (ts + text), "" when none is in it
function lastPrompt(evs: Ev[]): string { for (let i = evs.length - 1; i >= 0; i--) { const e = evs[i]; if (e.kind === "user") return e.ts + "\u0000" + e.text; } return ""; }
export function watched(s: Sess): boolean { return s.pid !== 0 && !s.parent; }
function kidsMap(): Map<number, Proc[]> {
  const k = new Map<number, Proc[]>();
  for (const p of allProcs.values()) { const a = k.get(p.ppid); if (a) a.push(p); else k.set(p.ppid, [p]); }
  return k;
}
function observe(s: Sess, kids: Map<number, Proc[]>, titles: () => Map<string, string>): Obs {
  const r = rootOf(s.pid); const rp = r ? r.pid : s.pid;
  let subs = false; for (const c of s.subs) if (Date.now() - c.mtime < 45000) subs = true;
  const h = harnessOf(s.h); const at = h.approvalTitle; const tty = at ? ttyOf(s.pid) : "";
  const title = at && tty !== "" ? titles().get(tty) : undefined; // undefined: not in a tmux pane
  const asks = !!at && title !== undefined && at(title);
  const o: Obs = { now: Date.now(), mtime: s.mtime, busy: working(s), evs: s.evs, cpu: hist.get(rp) ?? [], cmds: toolCmds(rp, kids), subsActive: subs, asks, noAsk: !!h.noApproval };
  o.mayGuess = !!h.hiddenApproval && title === undefined;
  const br = h.bareReply; o.bare = o.mayGuess && br ? br(s) : false;
  o.guess = approvalGuess(o, o.mayGuess);
  return o;
}
// one look at every live session per alarm tick: the process tree and (lazily) the tmux pane titles
export interface Looker { kids: Map<number, Proc[]>; titles: () => Map<string, string> }
export function looker(): Looker {
  const tt = new Map<string, string>(); let read = false; // tmux pane titles: one spawn per look, only when a live agent reports approval in its title
  return { kids: kidsMap(), titles: (): Map<string, string> => { if (!read) { read = true; for (const [k, v] of paneTitles()) tt.set(k, v); } return tt; } };
}
export function observeWith(s: Sess, lk: Looker): Obs { return observe(s, lk.kids, lk.titles); }
function rowMetric(r: Rule): boolean { return CALL_METRICS.indexOf(r.metric) >= 0 && r.metric !== "repeat_run"; }
// an enabled rule reads the ledger (cost, tokens, call rows)
export function ledgerRule(rs: RuleSet): boolean { for (const r of rs.rules) if (r.enabled && (rowMetric(r) || r.metric === "session_cost" || r.metric === "session_tokens")) return true; return false; }
// rule id → value for every enabled rule whose where-scope the session passes
export function ruleVals(rs: RuleSet, s: Sess, o: Obs, turnAt: (r: Rule) => number): Map<string, MVal> {
  const m = new Map<string, MVal>(); const memo = new Map<string, MVal>();
  let rows: Call[] = []; let haveRows = false;
  for (const r of rs.rules) {
    if (!r.enabled) continue;
    const f = r.wf; if (f && !sessMatches(f, s)) continue;
    if (rowMetric(r) && !haveRows) { rows = accOf(s).calls; haveRows = true; }
    m.set(r.id, metricOf(r, s, o, turnAt(r), rows, memo));
  }
  return m;
}
// one watched session: turn tracking (first sight records only; a turn between two looks counts), values, engine step
export function watchStep(s: Sess, o: Obs, rs: RuleSet, now: number): Trans[] {
  const pr = lastPrompt(s.evs);
  let x = st.get(s.path);
  if (!x) { x = { busy: o.busy, prompt: pr, turnAt: 0, looks: 0 }; st.set(s.path, x); }
  else if (o.busy) x.turnAt = 0;
  else if (alarmOf(x.busy, o.busy, pr !== "" && pr !== x.prompt, o.asks === true) === "turn finished") { x.turnAt = Math.max(now, x.turnAt + 1); x.looks = -1; } // strictly newer: the engine tells turns apart by it (Gemini's approval dialog looks like a finished turn: alarmOf)
  x.busy = o.busy; if (pr) x.prompt = pr;
  if (x.turnAt > 0 && x.looks < GUESS_LOOKS) x.looks++;
  const ta = x.turnAt > 0 && o.mayGuess === true && !o.guess && x.looks < GUESS_LOOKS ? 0 : x.turnAt; // held: absent for now
  return stepSession(rs, s.path, ruleVals(rs, s, o, (r: Rule) => ta), now);
}
export function forgetSession(path: string): void { st.delete(path); unwatch(path); forget(path); }
export function ruleOf(rs: RuleSet, id: string): Rule | null { for (const r of rs.rules) if (r.id === id) return r; return null; }

function tick(): void {
  const rs = rules();
  const lk = looker();
  const now = Date.now();
  const cur = S.mode === "list" && S.tab === 0 ? current() : null;
  const cp = cur ? cur.path : "";
  if (cp !== selPath) { selPath = cp; selSince = now; }
  let changed = false;
  for (const s of sessions.values()) {
    if (!watched(s)) { if (s.attention || s.stuck) { s.attention = false; s.stuck = ""; } if (st.has(s.path) || watching(s.path)) forgetSession(s.path); continue; }
    loadTail(s);
    const o = observe(s, lk.kids, lk.titles);
    for (const t of watchStep(s, o, rs, now)) {
      const r = ruleOf(rs, t.rule); const a = stateOf(s.path, t.rule); if (!r || !a) continue;
      onTrans(s, r, t, a.acked, false, true, rs.notify, a.v, render(r, a.v, t.to || t.from, s), a.lvAt);
      changed = true;
    }
    // the user looked: selected > 1s, or its transcript is open
    if ((cp === s.path && now - selSince > 1000) || (S.tv !== null && S.tv.s === s)) ackLook(rs, s.path);
    const f = flags(rs, s.path);
    s.attention = f[0] === "1"; s.stuck = f[1] ?? "";
  }
  prune((p: string) => sessions.has(p));
  for (const p of [...st.keys()]) if (!sessions.has(p)) st.delete(p);
  if (changed || helpVer !== R.ver) helpRules(rs);
}
H.onWatch.push(tick);
// one session's approval estimate outside the TUI (the OTLP live sink): "" = no approval wait seen; CPU history comes from refreshProcs
export function approvalOf(s: Sess): string { if (!watched(s)) return ""; loadTail(s); return approvalNote(observe(s, kidsMap(), paneTitles)); }

// --json: one-shot evaluation on the current state (no tick history, no bell/desktop/command, no ack); live TUI state wins
const SNAP = new Map<string, Alert[]>();
H.complete.push((s: Sess) => {
  if (!watched(s)) { s.attention = false; s.stuck = ""; return; }
  if (watching(s.path)) return; // the TUI's engine has the history
  const rs = rules();
  if (!allProcs.size) refreshProcs();
  loadTail(s);
  if (ledgerRule(rs)) ledgerComplete(s);
  const o = observe(s, kidsMap(), paneTitles);
  // turn_done: threshold 0 needs a transition (absent); a threshold > 0 counts from the last recorded activity when idle
  const vals = ruleVals(rs, s, o, (r: Rule) => (r.hasDeg ? r.deg : r.crit) > 0 ? s.mtime : 0);
  const sn = snapshot(rs, s, vals, Date.now());
  s.attention = sn.att; s.stuck = sn.stuck;
  SNAP.set(s.path, sn.alerts);
});
// the firing alerts of a session: the live engine's in the TUI / --watch, else the --json snapshot's
export function alertsOf(s: Sess): Alert[] { return watching(s.path) ? firing(R.set, s) : SNAP.get(s.path) ?? []; }

// ── UI ────────────────────────────────────────────────────────────────────────
const B = CSI + "1m";
H.rowBadges.push((s: Sess) => s.stuck ? fg(C.red) + B + "⚠" + RST : s.attention ? fg(C.yellow) + B + "◆" + RST : "");
function labelText(a: Alert): string { let o = ""; for (const [k, v] of a.labels) o += " " + k + "=" + v; return o ? fg(C.sub) + o + RST : ""; }
const LIKELY = " · likely"; // render's hint suffix of a likely approval
// one line per unacknowledged firing alert; built-ins keep their wording
H.previewSections.push((s: Sess, w: number) => {
  const out: string[] = [];
  for (const a of firing(R.set, s)) {
    if (a.acked) continue;
    const r = ruleOf(R.set, a.rule); if (!r) continue;
    if (a.level === 1) {
      const lk = r.builtin && r.id === "approval" && a.message.endsWith(LIKELY); // Gemini outside tmux, a reply without text or calls (detect.ts unlogged)
      const d = r.builtin && r.id === "approval" ? (lk ? "approval? (likely) · " + a.message.slice(0, a.message.length - LIKELY.length) : "approval? · " + a.message)
        : r.builtin && r.id === "waiting" ? "waiting for you · " + a.message + " " + ago(a.since) + " ago" : r.id + " · " + a.message;
      out.push(fg(C.yellow) + B + "◆ " + RST + fg(C.yellow) + d + RST + labelText(a));
    } else out.push(fg(C.red) + B + "⚠ " + RST + fg(C.red) + r.reason + fg(C.sub) + " · " + a.message + RST + labelText(a));
  }
  return out;
});
H.headerWidgets.push((w: number) => {
  let a = 0; let k = 0;
  for (const s of sessions.values()) { if (s.stuck) k++; else if (s.attention) a++; }
  return (a ? fg(C.yellow) + B + "◆ " + a + RST : "") + (a && k ? "  " : "") + (k ? fg(C.red) + B + "⚠ " + k + RST : "");
});
// ! cycle: every row with an unacked alert, critical (⚠) first, view order within a severity. sev[i]: 2 ⚠, 1 ◆, 0 none;
// selSev: where the cursor stands in that order (0 = on no item: start at the first) → the next row, wrapping; -1 = none
export function nextAlarm(sev: number[], sel: number, selSev: number): number {
  let first = -1; let next = -1; let best = 0; // keys (3 − severity) · n + row: smaller = earlier in the cycle
  const n = sev.length; const cur = selSev > 0 ? (3 - selSev) * n + sel : -1;
  for (let i = 0; i < n; i++) {
    const v = sev[i]; if (v <= 0) continue;
    const key = (3 - v) * n + i;
    if (first < 0 || key < (3 - (sev[first] ?? 0)) * n + first) first = i;
    if (cur >= 0 && key > cur && (next < 0 || key < best)) { next = i; best = key; }
  }
  return next >= 0 ? next : first;
}
function sevOf(s: Sess | null): number { return !s ? 0 : s.stuck ? 2 : s.attention ? 1 : 0; }
// the row ! last jumped to, and its severity then: on it the cycle goes on after it (looking at it may have acked it);
// from anywhere else (the cursor moved) ! starts over at the most severe row
let jumpPath = ""; let jumpSev = 0;
H.keys.push((mode: string, k: string) => {
  if (k !== "!" || mode !== "list" || S.tab !== 0) return false;
  const sev: number[] = []; for (let i = 0; i < S.view.length; i++) sev.push(sevOf(sessAt(i)));
  const cur = sessAt(S.sel);
  const cs = cur && cur.path === jumpPath ? Math.max(jumpSev, sevOf(cur)) : 0;
  let i = nextAlarm(sev, S.sel, cs);
  if (i === S.sel && cs === 0) i = nextAlarm(sev, S.sel, sev[i] ?? 0); // already on the first: the next one
  if (i < 0) { say("info", "no session needs attention"); return true; }
  const s = sessAt(i);
  S.sel = i; jumpPath = s ? s.path : ""; jumpSev = sev[i] ?? 0;
  return true;
});
H.helpSections.push({ name: "watchdog", ctx: "sessions", keys: [
  ["!", "cycle ⚠ stuck, then ◆ waiting (unacked)"],
  ["◆", "waiting for you: turn done / approval?"], ["", "bell + notification (AGENTGLASS_NOTIFY=0)"],
  ["⚠", "stuck: loop · stalled · long cmd · spin"],
  ["rules", "~/.agentglass/rules.json: agentglass rules check"] ] });
// the rules in force with their firing count, then the newest transitions (rebuilt on reload and on transitions)
const RULES_HELP: string[][] = [];
let helpVer = -1;
function helpRules(rs: RuleSet): void {
  helpVer = R.ver;
  RULES_HELP.length = 0;
  for (const r of rs.rules) {
    let n = 0; for (const s of sessions.values()) { const a = stateOf(s.path, r.id); if (a && a.level > 0) n++; }
    const u = unitOf(r.metric);
    const thr = (r.hasDeg ? "◆" + r.op + thrText(u, r.deg) : "") + (r.hasDeg && r.hasCrit ? " " : "") + (r.hasCrit ? "⚠" + r.op + thrText(u, r.crit) : "");
    RULES_HELP.push([r.id, (r.enabled ? "" : "off · ") + r.metric + " " + thr + (n ? " · " + String(n) + " firing" : "")]);
  }
  for (let i = LOG.length - 1; i >= 0 && i >= LOG.length - 5; i--) {
    const t = LOG[i]; const s = sessions.get(t.path);
    const d = new Date(t.at); const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    RULES_HELP.push([hm, t.rule + " " + t.state + " " + severityOf(t.to || t.from) + (s ? " · " + titleOf(s).slice(0, 24) : "")]);
  }
}
H.helpSections.push({ name: "rules", ctx: "sessions", keys: RULES_HELP });
