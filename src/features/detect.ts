// agentglass — watchdog detectors: pure helpers over one observation of a live session (no globals, checked in isolation);
// the rule metrics (rules/metrics.ts) are built on them, watchdog.ts re-exports them
// SPDX-License-Identifier: Apache-2.0
import { base } from "../util/json.ts";
import { ago } from "../util/text.ts";
import type { Ev, Proc } from "../model/types.ts";

// ── pure detection helpers (no globals, so they can be checked in isolation) ──
// ps etime: [[dd-]hh:]mm:ss → seconds
export function etimeSec(e: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(e.trim());
  if (!m) return 0;
  return Number(m[1] ?? "0") * 86400 + Number(m[2] ?? "0") * 3600 + Number(m[3] ?? "0") * 60 + Number(m[4] ?? "0");
}
// identical tool calls (name + args) in a row at the end; results/thinking between them don't break the run
export function loopRun(evs: Ev[]): number {
  let n = 0; let key = "";
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.kind === "result" || e.kind === "thinking") continue;
    if (e.kind !== "tool") break;
    const k = e.text + "\u0001" + e.full;
    if (n > 0 && k !== key) break;
    key = k; n++;
  }
  return n;
}
export interface Run { tool: string; arg: string; n: number; ts: string }
// every run of ≥ min identical tool calls anywhere (same key and same gaps as loopRun), in order; ts = its first call
export function loopRuns(evs: Ev[], min: number): Run[] {
  const out: Run[] = [];
  let n = 0; let key = ""; let at = -1;
  const close = (): void => {
    if (at >= 0 && n >= min) { const f = evs[at]; const i = f.text.indexOf("\u0000"); out.push({ tool: i >= 0 ? f.text.slice(0, i) : f.text, arg: i >= 0 ? f.text.slice(i + 1) : "", n, ts: f.ts }); }
    n = 0; key = ""; at = -1;
  };
  for (let j = 0; j < evs.length; j++) {
    const e = evs[j];
    if (e.kind === "result" || e.kind === "thinking") continue;
    if (e.kind !== "tool") { close(); continue; }
    const k = e.text + "\u0001" + e.full;
    if (n > 0 && k !== key) close();
    if (n === 0) at = j;
    key = k; n++;
  }
  close();
  return out;
}
export function toolName(e: Ev): string { const i = e.text.indexOf("\u0000"); return i >= 0 ? e.text.slice(0, i) : e.text; }
// the last event is a tool call with no result yet → its name, else ""
export function pendingTool(evs: Ev[]): string {
  if (!evs.length) return "";
  const e = evs[evs.length - 1];
  return e.kind === "tool" ? toolName(e) || "tool" : "";
}
export function avgTail(a: number[], n: number): number {
  const t = a.slice(-n);
  let x = 0; for (const v of t) x += v;
  return t.length ? x / t.length : 0;
}
const SHELLS = ["sh", "bash", "zsh", "fish", "dash"];
function isShell(p: Proc): boolean { return SHELLS.indexOf(base(p.args.split(" ")[0] ?? "").replace(/^-/, "")) >= 0; }
export interface Cmd { age: number; name: string }
// tool commands run by the agent = its outermost descendant shells (MCP servers & co are spawned directly, not via a shell)
export function toolCmds(root: number, kids: Map<number, Proc[]>): Cmd[] {
  const out: Cmd[] = [];
  const stack: number[] = [root];
  while (stack.length) {
    const pid = stack.pop() as number;
    for (const c of kids.get(pid) ?? []) {
      if (isShell(c)) out.push({ age: etimeSec(c.etime), name: cmdName(c, kids) });
      else stack.push(c.pid);
    }
  }
  return out;
}
function cmdName(sh: Proc, kids: Map<number, Proc[]>): string {
  const q: Proc[] = [sh];
  while (q.length) {
    const p = q.shift() as Proc;
    if (!isShell(p)) return base(p.args.split(" ")[0] ?? "");
    for (const c of kids.get(p.pid) ?? []) q.push(c);
  }
  const i = sh.args.indexOf(" -c ");
  return i >= 0 ? sh.args.slice(i + 4, i + 34) : base(sh.args.split(" ")[0] ?? "");
}
export interface Obs { now: number; mtime: number; busy: boolean; evs: Ev[]; cpu: number[]; cmds: Cmd[]; subsActive: boolean; asks?: boolean; noAsk?: boolean; mayGuess?: boolean; guess?: boolean } // asks: the agent's terminal title says it waits for approval; noAsk: the harness never asks (pi); mayGuess: no title to read for a harness that hides its approval dialog (Gemini outside tmux); guess: approvalGuess holds
function dur(sec: number): string { return ago(Date.now() - sec * 1000); }
// a metric's value for a rule: v -1 = absent (its preconditions do not hold, the rule cannot fire); lv: the level the agent
// itself asserts (1: Gemini's approval title), whatever the threshold; at: recorded time of the newest record behind v;
// hint: a guess appended to the alert's message ("approval?": approvalGuess)
export interface MVal { v: number; tool: string; cmd: string; cpu: string; at: number; lv: number; hint: string }
export function absent(): MVal { return { v: -1, tool: "", cmd: "", cpu: "", at: 0, lv: 0, hint: "" }; }
function mv(v: number, tool: string, cmd: string, cpu: string, at: number): MVal { return { v, tool, cmd, cpu, at, lv: 0, hint: "" }; }
// seconds a tool call has been open while the tree is quiet (avg over samples < cpuBelow) and no tool command started
// within graceSec after it; the agent's own approval title (Gemini logs the call only once it ran) asserts it at once
export function approvalWait(o: Obs, cpuBelow: number, samples: number, graceSec: number): MVal {
  if (o.noAsk) return absent(); // a quiet long call there is just a long call (pi execs `sleep` & co. without a shell)
  const pend = (o.now - o.mtime) / 1000;
  if (o.asks) { const m = mv(pend, pendingTool(o.evs) || "approval dialog", "", avgTail(o.cpu, samples).toFixed(0), o.mtime); m.lv = 1; return m; }
  const t = pendingTool(o.evs);
  if (!o.busy || !t || o.cpu.length < samples || o.subsActive) return absent();
  const cpu = avgTail(o.cpu, samples);
  if (cpu >= cpuBelow) return absent();
  for (const c of o.cmds) if (c.age < pend + graceSec) return absent();
  return mv(pend, t, "", cpu.toFixed(0), o.mtime);
}
// age of the oldest tool shell command while a tool call is pending
export function commandAge(o: Obs): MVal {
  if (!pendingTool(o.evs)) return absent();
  let old: Cmd | null = null; for (const c of o.cmds) if (!old || c.age > old.age) old = c;
  return old ? mv(old.age, "", old.name, "", o.now - old.age * 1000) : absent();
}
// log-silent seconds while busy, the tree idle (avg < cpuBelow) and no tool command running
export function stalledFor(o: Obs, cpuBelow: number, samples: number): MVal {
  if (!o.busy || o.cpu.length < samples || o.cmds.length) return absent();
  const cpu = avgTail(o.cpu, samples);
  return cpu < cpuBelow ? mv((o.now - o.mtime) / 1000, "", "", cpu.toFixed(1), o.mtime) : absent();
}
// log-silent seconds while every one of the last samples is above cpuAbove
export function spinningFor(o: Obs, cpuAbove: number, samples: number): MVal {
  if (o.cpu.length < samples) return absent();
  let lo = 1e9; for (const v of o.cpu.slice(-samples)) if (v < lo) lo = v;
  return lo > cpuAbove ? mv((o.now - o.mtime) / 1000, "", "", lo.toFixed(0), o.mtime) : absent();
}
function lastTool(evs: Ev[]): string { for (let i = evs.length - 1; i >= 0; i--) { const e = evs[i]; if (e.kind === "tool") return toolName(e); } return "tool"; }
// identical consecutive tool calls at the end
export function repeatRun(o: Obs): MVal { const n = loopRun(o.evs); return n > 0 ? mv(n, lastTool(o.evs), "", "", o.mtime) : absent(); }
// waiting on a tool approval: tool call open > 20s, tree quiet (10s avg < 2%), no tool command started since the call
export function approvalNote(o: Obs): string {
  const a = approvalWait(o, 2, 7, 5);
  if (a.lv > 0) return "approval dialog open"; // the agent says so itself (Gemini logs the call only once it ran)
  return a.v > 20 ? a.tool + " pending " + dur(a.v) + ", cpu " + a.cpu + "%" : "";
}
// heuristic (no title to read: not in tmux): a harness that logs a call only once it ran (Gemini, may: the caller says so)
// shows its approval dialog as a finished turn when the reply has text (idle, ending in it), as thinking when it has none
// (busy, ending in thoughts); either way the tree is quiet (< 2 % CPU) for ≥ 3 s (2 samples at the 1.5 s alarm cadence).
// A real finished turn (or a slow model reply) looks the same: the alert that fires only gets an "approval?" hint
export function approvalGuess(o: Obs, may: boolean): boolean {
  if (!may || o.asks || o.cpu.length < 2) return false;
  const e = o.evs.length ? o.evs[o.evs.length - 1] : null;
  if (!e || e.kind !== (o.busy ? "thinking" : "assistant")) return false;
  for (const c of o.cpu.slice(-2)) if (c >= 2) return false;
  return true;
}
// which alarm a look raises: approval first (a Gemini approval dialog looks like a finished turn in its log), then busy →
// idle or a whole turn between two looks (fresh: a new prompt in the tail); "" = none
export function alarmOf(wasBusy: boolean, busy: boolean, fresh: boolean, appr: boolean): string {
  if (appr) return "approval?";
  return !busy && (wasBusy || fresh) ? "turn finished" : "";
}
// [reason, detail] — "" reason = fine; the first of loop, long cmd, stalled, spinning
export function stuckOf(o: Obs): string[] {
  const l = repeatRun(o);
  if (l.v >= 3) return ["loop", l.tool + " called " + l.v + "× in a row with the same arguments"];
  const c = commandAge(o);
  if (c.v > 600) return ["long cmd", c.cmd + " running " + dur(c.v)];
  const s = stalledFor(o, 1, 7);
  if (s.v > 480) return ["stalled", "no log activity " + dur(s.v) + ", cpu " + s.cpu + "%"];
  const p = spinningFor(o, 80, 120); // 120 samples × 1.5s = 3 min
  if (p.v > 180) return ["spinning", "cpu > " + p.cpu + "% for 3m while the log is silent " + dur(p.v)];
  return ["", ""];
}
