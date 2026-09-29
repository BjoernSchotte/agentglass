// agentglass — watchdog: flags live sessions waiting for you (◆, bell + desktop notification) and stuck ones (⚠)
// SPDX-License-Identifier: Apache-2.0
import { OS } from "../platform/index.ts";
import { base } from "../util/json.ts";
import { ago } from "../util/text.ts";
import type { Ev, Proc, Sess } from "../model/types.ts";
import { S, say } from "../state.ts";
import { H } from "../hooks.ts";
import { sessions, loadTail, working, titleOf, current, sessAt } from "../model/sessions.ts";
import { allProcs, hist, rootOf, refreshProcs } from "../model/procs.ts";
import { C, CSI, RST, fg } from "../ui/theme.ts";

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
export interface Obs { now: number; mtime: number; busy: boolean; evs: Ev[]; cpu: number[]; cmds: Cmd[]; subsActive: boolean }
function dur(sec: number): string { return ago(Date.now() - sec * 1000); }
// waiting on a tool approval: tool call open > 20s, tree quiet (10s avg < 2%), no tool command started since the call
export function approvalNote(o: Obs): string {
  const t = pendingTool(o.evs);
  const pend = (o.now - o.mtime) / 1000;
  if (!o.busy || !t || pend <= 20 || o.cpu.length < 7 || o.subsActive) return "";
  const cpu = avgTail(o.cpu, 7);
  if (cpu >= 2) return "";
  for (const c of o.cmds) if (c.age < pend + 5) return "";
  return t + " pending " + dur(pend) + ", cpu " + cpu.toFixed(0) + "%";
}
// [reason, detail] — "" reason = fine
export function stuckOf(o: Obs): string[] {
  const n = loopRun(o.evs);
  if (n >= 3) {
    let t = "tool"; for (let i = o.evs.length - 1; i >= 0; i--) { const e = o.evs[i]; if (e.kind === "tool") { t = toolName(e); break; } }
    return ["loop", t + " called " + n + "× in a row with the same arguments"];
  }
  const silent = (o.now - o.mtime) / 1000;
  if (pendingTool(o.evs)) { let old: Cmd | null = null; for (const c of o.cmds) if (c.age > 600 && (!old || c.age > old.age)) old = c; if (old) return ["long cmd", old.name + " running " + dur(old.age)]; }
  if (o.cpu.length >= 7) {
    const cpu = avgTail(o.cpu, 7);
    if (o.busy && silent > 480 && cpu < 1 && !o.cmds.length) return ["stalled", "no log activity " + dur(silent) + ", cpu " + cpu.toFixed(1) + "%"];
  }
  if (o.cpu.length >= 120 && silent > 180) { // 120 samples × 1.5s = 3 min
    let lo = 1e9; for (const v of o.cpu.slice(-120)) if (v < lo) lo = v;
    if (lo > 80) return ["spinning", "cpu > " + lo.toFixed(0) + "% for 3m while the log is silent " + dur(silent)];
  }
  return ["", ""];
}

// ── live state ────────────────────────────────────────────────────────────────
interface St { busy: boolean; att: string; attAt: number; note: string; appr: boolean; bell: number; stuckNote: string }
const st = new Map<string, St>();
let selPath = ""; let selSince = 0;

function watched(s: Sess): boolean { return s.pid !== 0 && !s.parent; }
function isBusy(s: Sess): boolean { return working(s); }
function kidsMap(): Map<number, Proc[]> {
  const k = new Map<number, Proc[]>();
  for (const p of allProcs.values()) { const a = k.get(p.ppid); if (a) a.push(p); else k.set(p.ppid, [p]); }
  return k;
}
function observe(s: Sess, kids: Map<number, Proc[]>): Obs {
  const r = rootOf(s.pid); const rp = r ? r.pid : s.pid;
  let subs = false; for (const c of s.subs) if (Date.now() - c.mtime < 45000) subs = true;
  return { now: Date.now(), mtime: s.mtime, busy: isBusy(s), evs: s.evs, cpu: hist.get(rp) ?? [], cmds: toolCmds(rp, kids), subsActive: subs };
}
function stateOf(s: Sess): St | null { return st.get(s.path) ?? null; }
function raise(s: Sess, x: St, why: string, note: string): void {
  s.attention = true; x.att = why; x.attAt = Date.now(); x.note = note;
  if (Date.now() - x.bell < 30000) return;
  x.bell = Date.now();
  process.stdout.write("\x07");
  if (process.env.AGENTGLASS_NOTIFY === "0") return;
  OS.notify("agentglass", s.h + " · " + (base(s.cwd) || "?"), (why === "approval?" ? "approval? " : "") + titleOf(s).slice(0, 120));
}
function clear(s: Sess, x: St): void { s.attention = false; x.att = ""; x.note = ""; }

function tick(): void {
  const kids = kidsMap();
  const now = Date.now();
  const cur = S.mode === "list" && S.tab === 0 ? current() : null;
  const cp = cur ? cur.path : "";
  if (cp !== selPath) { selPath = cp; selSince = now; }
  for (const s of sessions.values()) {
    if (!watched(s)) { if (s.attention || s.stuck) { s.attention = false; s.stuck = ""; } st.delete(s.path); continue; }
    loadTail(s);
    const o = observe(s, kids);
    const r = stuckOf(o);
    s.stuck = r[0] ?? "";
    let x = stateOf(s);
    if (!x) { x = { busy: o.busy, att: "", attAt: 0, note: "", appr: false, bell: 0, stuckNote: "" }; st.set(s.path, x); } // first sight: record only
    x.stuckNote = r[1] ?? "";
    if (x.busy && !o.busy) raise(s, x, "turn finished", "");
    else if (!x.busy && o.busy && x.att) clear(s, x);
    x.busy = o.busy;
    const a = approvalNote(o);
    if (a && !x.appr) raise(s, x, "approval?", a);
    else if (a && x.att === "approval?") x.note = a;
    else if (!a && x.att === "approval?") clear(s, x);
    x.appr = a !== "";
    // the user looked: selected > 1s, or its transcript is open
    if (x.att && ((cp === s.path && now - selSince > 1000) || (S.tv !== null && S.tv.s === s))) clear(s, x);
  }
}
H.onTick.push(tick);

H.complete.push((s: Sess) => {
  if (!watched(s)) { s.attention = false; s.stuck = ""; return; }
  if (!allProcs.size) refreshProcs();
  loadTail(s);
  const o = observe(s, kidsMap());
  const r = stuckOf(o);
  s.stuck = r[0] ?? "";
  const x = stateOf(s);
  s.attention = (x !== null && x.att !== "") || approvalNote(o) !== "";
});

// ── UI ────────────────────────────────────────────────────────────────────────
const B = CSI + "1m";
H.rowBadges.push((s: Sess) => s.stuck ? fg(C.red) + B + "⚠" + RST : s.attention ? fg(C.yellow) + B + "◆" + RST : "");
H.previewSections.push((s: Sess, w: number) => {
  const out: string[] = [];
  const x = stateOf(s);
  if (s.attention && x) {
    const d = x.att === "approval?" ? "approval? · " + x.note : "waiting for you · " + (x.att || "turn finished") + " " + ago(x.attAt) + " ago";
    out.push(fg(C.yellow) + B + "◆ " + RST + fg(C.yellow) + d + RST);
  }
  if (s.stuck) out.push(fg(C.red) + B + "⚠ " + RST + fg(C.red) + s.stuck + (x && x.stuckNote ? fg(C.sub) + " · " + x.stuckNote : "") + RST);
  return out;
});
H.headerWidgets.push((w: number) => {
  let a = 0; let k = 0;
  for (const s of sessions.values()) { if (s.stuck) k++; else if (s.attention) a++; }
  return (a ? fg(C.yellow) + B + "◆ " + a + RST : "") + (a && k ? "  " : "") + (k ? fg(C.red) + B + "⚠ " + k + RST : "");
});
// ! → next row needing attention, then stuck ones (wraps)
H.keys.push((mode: string, k: string) => {
  if (k !== "!" || mode !== "list" || S.tab !== 0) return false;
  const n = S.view.length;
  for (const pass of [0, 1]) for (let d = 1; d <= n; d++) {
    const i = (S.sel + d) % n; const s = sessAt(i);
    if (s && (pass === 0 ? s.attention && !s.stuck : s.stuck !== "")) { S.sel = i; return true; }
  }
  say("info", "no session needs attention");
  return true;
});
H.helpSections.push({ name: "watchdog", ctx: "sessions", keys: [
  ["!", "jump to next ◆ waiting, then ⚠ stuck"],
  ["◆", "waiting for you: turn done / approval?"], ["", "bell + notification (AGENTGLASS_NOTIFY=0)"],
  ["⚠", "stuck: loop · stalled · long cmd · spin"] ] });
