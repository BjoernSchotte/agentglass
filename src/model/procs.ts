// agentglass — harness processes (via the platform adapter, tmux) and their link to sessions
// SPDX-License-Identifier: Apache-2.0
import { base } from "../util/json.ts";
import { run, WAKE_ALL, WAKE_H, WAKE_DIRS } from "../util/fs.ts";
import { OS } from "../platform/index.ts";
import { HARNESSES, harnessOfProc } from "../harness/index.ts";
import type { Live } from "../harness/types.ts";
import type { Proc, Sess } from "./types.ts";
import type { ProcRow } from "../platform/types.ts";
import { etimeSec } from "../features/detect.ts";
import { sessions, SG } from "./sessions.ts";
import { S } from "../state.ts";
import { linkByCwd, daemonWarn, type CwdProc } from "./link.ts";
import { H, applyMeta, realCwd } from "../hooks.ts";

// agents without an adapter yet: shown in the process view under their own name
const OTHER = ["aider", "cursor-agent", "amp", "qwen", "crush", "goose", "copilot"];
// per process tree CPU history length: max(120, the largest `samples` of an enabled rule) (rules/state.ts sets it)
export const HIST = { cap: 120 };
export let procs: Proc[] = [];
export let procView: Proc[] = []; // the rows the Processes tab shows: procs passing H.procFilter (liveness code keeps reading procs)
export const allProcs = new Map<number, Proc>();
export const hist = new Map<number, number[]>();
export const cpuHist: number[] = [];
const tmuxByTty = new Map<string, string>();
const cwdByPid = new Map<number, string>();
const filePid = new Map<string, number>(); // open transcript → pid (HarnessAdapter.liveFile)
const registry = new Map<string, Live>(); // "<harness>:<session id>" → entry (HarnessAdapter.liveRegistry)
const daemonLive = new Map<string, Live[]>(); // harness id → its registry, for harnesses whose registry is a shared daemon

// node flags whose value is the next argument (not the script); -e/-p/--eval/--print run inline code: no script
const VAL_FLAGS = ["-r", "--require", "--import", "--loader", "--experimental-loader", "--inspect-port", "--title", "--env-file", "-C", "--conditions", "--input-type"];
const INLINE = ["-e", "--eval", "-p", "--print"];
// the script after node/bun/deno names the agent; runtime flags come first (gemini relaunches itself with --max-old-space-size=…)
export function harnessOfArgs(args: string): string {
  const t = args.split(" ");
  let b = base(t[0]);
  if (b === "node" || b === "bun" || b === "deno") {
    let i = 1;
    while (i < t.length && t[i].startsWith("-")) { if (INLINE.indexOf(t[i]) >= 0) return ""; i += VAL_FLAGS.indexOf(t[i]) >= 0 ? 2 : 1; }
    if (i >= t.length) return "";
    b = base(t[i]).replace(/\.(m?js|ts)$/, "");
  }
  return harnessOfProc(b) || (OTHER.indexOf(b) >= 0 ? b : "");
}
// the process objects live across refreshes: one per pid, updated from its row (a full process table rebuilt every
// 1.5 s was ~2,200 objects and a children map per refresh); the children map is rebuilt only when a pid came, went or
// moved; a pid's harness only when its args changed
let tracked = new Set<number>(); // the harness trees' pids of the last refresh: the platform reads them fresh
let passNo = 0;
export const PG = { gen: 0 }; // bumps when a pid came, went or moved (caches of the process tree key on it)
let kids = new Map<number, number[]>();
// a new process is read at once (else a pass later, if still there) and its command line re-read on full passes when its
// name (comm, ≤ 15 bytes) may be an agent's: an agent's own name, an interpreter that runs one (node 24 names its main
// thread "MainThread": Gemini CLI shows so), or a launcher that execs into one
const LAUNCH = ["node", "MainThread", "bun", "deno", "npx", "npm", "pnpm", "env", "sh", "bash", "zsh", "dash", "fish", "python", "python3", "uv", "uvx"];
export function argsWorth(comm: string): boolean {
  return LAUNCH.indexOf(comm) >= 0 || harnessOfProc(comm) !== "" || OTHER.indexOf(comm) >= 0 || harnessOfArgs(comm) !== "";
}
// the platform's rows into the process objects; true = a pid came, went or moved. A new agent — a new pid, or a known
// one that exec'd into one (zsh -c pi, npx gemini) — that is no agent's child wakes the session scan: its log may land
// in a quiet dir
export function applyRows(rows: ProcRow[]): boolean {
  let moved = false; const fresh: Proc[] = [];
  for (const r of rows) {
    let p = allProcs.get(r.pid);
    if (!p) { p = { pid: r.pid, ppid: r.ppid, cpu: r.cpu, rss: r.rss, etime: r.etime, tty: r.tty, args: r.args, h: harnessOfArgs(r.args), cwd: "", tcpu: 0, trss: 0, kids: 0, sess: "" }; allProcs.set(r.pid, p); moved = true; if (p.h) fresh.push(p); continue; }
    if (p.ppid !== r.ppid) { p.ppid = r.ppid; moved = true; }
    if (p.args !== r.args) { const was = p.h; p.args = r.args; p.h = harnessOfArgs(r.args); if (p.h && !was) fresh.push(p); }
    p.cpu = r.cpu; p.rss = r.rss; p.etime = r.etime; p.tty = r.tty;
  }
  for (const p of fresh) { const par = allProcs.get(p.ppid); if (!par || !par.h) { WAKE_ALL.at = Date.now(); break; } }
  if (allProcs.size !== rows.length) { // pids went
    const live = new Set<number>(); for (const r of rows) live.add(r.pid);
    for (const k of [...allProcs.keys()]) if (!live.has(k)) allProcs.delete(k);
    moved = true;
  }
  return moved;
}
// discover: look for new pids too (an unfocused TUI does it every other pass; the agents' own cpu is read every pass)
export function refreshProcs(discover: boolean = true): void {
  passNo++;
  const rows = OS.listProcs(tracked, argsWorth, discover);
  const moved = applyRows(rows);
  if (moved) {
    PG.gen++;
    kids = new Map<number, number[]>();
    for (const p of allProcs.values()) { const k = kids.get(p.ppid); if (k) k.push(p.pid); else kids.set(p.ppid, [p.pid]); }
  }
  for (const p of procs) { p.tcpu = 0; p.trss = 0; p.kids = 0; } // last refresh's roots: their sums start again
  const out: Proc[] = [];
  let total = 0;
  const now = Date.now();
  const tr = new Set<number>();
  for (const p of allProcs.values()) {
    if (!p.h) continue;
    const parent = allProcs.get(p.ppid);
    if (parent && parent.h) continue; // wrapper→binary: count as child of the outer one
    const stack = [p.pid];
    while (stack.length) {
      const q = allProcs.get(stack.pop() as number);
      if (!q) continue;
      q.cpu = OS.cpuOf(q.pid, q.cpu, now);
      if (q === p || (q.pid + passNo) % 2 === 0) tr.add(q.pid); // the agent every pass, its children every other one (their cpu is the delta since their last read)
      p.tcpu += q.cpu; p.trss += q.rss; if (q !== p) p.kids++;
      for (const c of kids.get(q.pid) ?? []) stack.push(c);
    }
    const hh = hist.get(p.pid) ?? [];
    hh.push(p.tcpu); while (hh.length > HIST.cap) hh.shift();
    hist.set(p.pid, hh);
    p.cwd = cwdByPid.get(p.pid) ?? "";
    total += p.tcpu;
    out.push(p);
  }
  tracked = tr;
  if (hist.size > out.length) for (const k of [...hist.keys()]) if (!allProcs.has(k)) hist.delete(k);
  if (moved) OS.prune((pid: number) => allProcs.has(pid));
  cpuHist.push(total); if (cpuHist.length > 240) cpuHist.shift();
  out.sort((a, b) => b.tcpu - a.tcpu || a.pid - b.pid);
  procs = out;
  buildProcView();
  registry.clear(); daemonLive.clear();
  const alive = (pid: number): boolean => allProcs.has(pid);
  const hOf = (pid: number): string => { const p = allProcs.get(pid); return p ? p.h : ""; };
  for (const ad of HARNESSES) {
    const f = ad.liveRegistry; if (!f) continue;
    const ls = f(alive, hOf);
    for (const l of ls) registry.set(ad.id + ":" + l.id, l);
    if (ad.daemon) daemonLive.set(ad.id, ls);
  }
  const g = linkSig(); if (g !== lastLink) { lastLink = g; linkSessions(); }
  wakeScan(procs, Date.now());
}
// an agent process with no session yet may write a new log any moment (a first prompt), often in a dir quiet for long:
// its harness's dirs (or just its session dir, when the harness names it from the cwd) are looked at every scan
// PEND.young: such agents started within the last 10 min (main.ts scans every 2 s while there is one, in any level; an
// older one — a daemon never linked to a session — leaves the scan at its level's pace)
export const PEND = { young: 0 };
const YOUNG_S = 600;
export function wakeScan(roots: Proc[], now: number): void {
  WAKE_DIRS.clear(); PEND.young = 0;
  for (const p of roots) {
    if (!p.h || p.sess) continue;
    if (p.etime && etimeSec(p.etime) < YOUNG_S) PEND.young++;
    let wd: ((cwd: string) => string) | null = null; for (const ad of HARNESSES) if (ad.id === p.h) { const f = ad.wakeDir; if (f) wd = f; }
    if (wd && (p.cwd || p.h !== "claude")) WAKE_DIRS.add(wd(p.cwd)); else WAKE_H.set(p.h, now); // Claude names its dir from the cwd (known after the slow job)
  }
}
// what linkSessions reads besides the open files (refreshSlow links after reading those): the registries, the agent
// processes and their parents, the session set, and the newest session per cwd for harnesses linked by cwd
let lastLink = "";
function linkSig(): string {
  const o: string[] = [String(SG.gen), String(sessions.size)];
  for (const [k, l] of registry) o.push(k + "=" + String(l.pid) + l.status + l.name);
  for (const p of allProcs.values()) if (p.h) o.push(String(p.pid) + ":" + String(p.ppid) + p.h + p.cwd);
  for (const [f, pid] of filePid) if (allProcs.has(pid)) o.push(f);
  let mt = 0; for (const ad of HARNESSES) if (ad.liveCwd) for (const s of sessions.values()) if (s.h === ad.id) mt += s.mtime;
  o.push(String(mt));
  return o.join("\n");
}
export function refreshSlow(): void {
  // cwd + open rollout files of every harness proc — nested ones too (codex app-server under its daemon holds the rollouts), tmux panes
  // open files only of the harnesses that keep their transcript open (liveFile): a walk over every fd of every agent
  // process was most of this job
  const hp: number[] = []; const fp = new Set<number>(); const lf = new Set<string>();
  for (const ad of HARNESSES) if (ad.liveFile) lf.add(ad.id);
  for (const p of allProcs.values()) if (p.h) { hp.push(p.pid); if (lf.has(p.h)) fp.add(p.pid); }
  const f = OS.procFiles(hp, fp, (n: string) => { for (const ad of HARNESSES) { const lf = ad.liveFile; if (lf && lf(n)) return true; } return false; });
  let sig = ""; for (const [k, v] of f.cwd) sig += String(k) + "=" + v + "\n"; for (const [k, v] of f.open) sig += v + "<" + String(k) + "\n";
  cwdByPid.clear(); filePid.clear();
  for (const [k, v] of f.cwd) cwdByPid.set(k, v);
  for (const [k, v] of f.open) filePid.set(k, v);
  // tmux panes: listed when an agent sits on a tty no pane is known for (a new pane), else every 30 s (a moved one)
  const now = Date.now(); let paneDue = now - SLOW.tmuxAt >= 30000;
  if (!paneDue) for (const p of procs) { const d = OS.ttyDevice(p.tty); if (d && !tmuxByTty.has(d) && !SLOW.noPane.has(d)) { paneDue = true; break; } }
  if (paneDue) readPanes(now);
  for (const p of procs) p.cwd = cwdByPid.get(p.pid) ?? "";
  if (S.pins.length) buildProcView(); // cwd known now: repo and cwd pins apply
  if (sig !== SLOW.sig) { SLOW.sig = sig; linkSessions(); lastLink = linkSig(); } // cwds or open transcripts moved: link again
}
const SLOW = { sig: "", tmuxAt: 0, noPane: new Set<string>() };
function readPanes(now: number): void {
  SLOW.tmuxAt = now; tmuxByTty.clear(); SLOW.noPane.clear();
  for (const l of run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}"]).split("\n")) {
    const i = l.indexOf(" ");
    if (i > 0) tmuxByTty.set(l.slice(0, i), l.slice(i + 1));
  }
  for (const p of procs) { const d = OS.ttyDevice(p.tty); if (d && !tmuxByTty.has(d)) SLOW.noPane.add(d); } // outside tmux: not asked again till the 30 s
}
export function rootOf(pid: number): Proc | null {
  let q = allProcs.get(pid);
  while (q) { const par = allProcs.get(q.ppid); if (!par || !par.h) break; q = par; }
  return q ?? null;
}
// per session the registry name linkOne last set and the name H.meta turned it into: without --redact (no H.meta) the
// link's fields are set again only when its name changed or something else rewrote s.name since. true = applyMeta ran
const linked = new Map<string, { raw: string; out: string }>();
export function linkOne(s: Sess, pid: number, status: string, name: string): boolean {
  s.pid = pid; s.status = status;
  const m = linked.get(s.path);
  if (m && m.raw === name && m.out === s.name && !H.meta.length) return false; // --redact (H.meta): every link applies it, as before
  s.name = name; applyMeta(s);
  linked.set(s.path, { raw: name, out: s.name });
  return true;
}
function linkSessions(): void {
  for (const s of sessions.values()) {
    let pid = 0; let status = ""; let name = "";
    const l = registry.get(s.h + ":" + s.id);
    if (l) { pid = l.pid; status = l.status; name = l.name; }
    else { const fp = filePid.get(s.path); if (fp && allProcs.has(fp)) { const r = rootOf(fp); pid = r ? r.pid : fp; status = "open"; } }
    linkOne(s, pid, status, name);
  }
  if (linked.size > sessions.size) for (const k of [...linked.keys()]) if (!sessions.has(k)) linked.delete(k);
  // harnesses with neither registry nor open transcript: process cwd ↔ newest session in that cwd
  // (registry pids are daemons, not TUIs; subagents never own a TUI)
  const regPids = new Set<number>();
  for (const l of registry.values()) regPids.add(l.pid);
  for (const ad of HARNESSES) {
    if (!ad.liveCwd) continue;
    const cp: CwdProc[] = []; const st = ad.sessionStart; const ra = ad.resumeArgs ?? []; const now = Date.now();
    for (const p of procs) {
      if (p.h !== ad.id || !p.cwd || regPids.has(p.pid)) continue;
      const resumes = ra.some((a: string) => (" " + p.args + " ").indexOf(" " + a + " ") >= 0);
      // its start, with 10 s of slack (etime has whole seconds; the session header is written right after start)
      cp.push({ pid: p.pid, h: p.h, cwd: p.cwd, after: st && !resumes && p.etime ? now - etimeSec(p.etime) * 1000 - 10000 : 0 });
    }
    const ss: { path: string; h: string; cwd: string; mtime: number; pid: number; start: number }[] = [];
    for (const s of sessions.values()) if (s.h === ad.id && !s.parent) ss.push({ path: s.path, h: s.h, cwd: realCwd(s), mtime: s.mtime, pid: s.pid, start: st ? st(s) : 0 });
    for (const [path, pid] of linkByCwd(cp, ss)) {
      const s = sessions.get(path);
      if (s) { const r = rootOf(pid); s.pid = r ? r.pid : pid; s.status = "open"; }
    }
  }
  for (const p of procs) p.sess = "";
  for (const s of sessions.values()) if (s.pid) { const r = rootOf(s.pid); if (r) r.sess = s.path; }
}
// pid is a harness's shared daemon: the warning to show instead of signalling it ("" = fine to signal)
export function sharedDaemon(pid: number): string {
  for (const ad of HARNESSES) {
    const d = ad.daemon; const ls = daemonLive.get(ad.id);
    if (d && ls) { const w = daemonWarn(pid, ad.label, d, ls); if (w) return w; }
  }
  return "";
}
// tmux pane titles by pane tty, read now (an agent's title can change within a second); empty outside tmux
export function paneTitles(): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of run("tmux", ["list-panes", "-a", "-F", "#{pane_tty}\t#{pane_title}"]).split("\n")) {
    const i = l.indexOf("\t");
    if (i > 0) m.set(l.slice(0, i), l.slice(i + 1));
  }
  return m;
}
export function ttyOf(pid: number): string { const p = allProcs.get(pid); return p ? OS.ttyDevice(p.tty) : ""; }
// the target for an action (send keys, switch): the panes read now (the display's map may be up to 30 s old)
export function tmuxTargetNow(pid: number): string { readPanes(Date.now()); return tmuxTarget(pid); }
export function tmuxTarget(pid: number): string {
  const p = allProcs.get(pid);
  const dev = p ? OS.ttyDevice(p.tty) : "";
  return dev ? tmuxByTty.get(dev) ?? "" : "";
}
// bounds-checked (see sessAt)
export function procAt(i: number): Proc | null { return i >= 0 && i < procView.length ? procView[i] : null; }
export function buildProcView(): void {
  const sp = procAt(S.psel); const selPid = sp ? sp.pid : 0;
  const out: Proc[] = [];
  for (const p of procs) { let ok = true; for (const f of H.procFilter) if (!f(p)) { ok = false; break; } if (ok) out.push(p); }
  procView = out;
  for (let i = 0; i < procView.length; i++) if (procView[i].pid === selPid) S.psel = i; // selection follows the pid, not the row
}
export function procSess(p: Proc): Sess | null { return p.sess ? sessions.get(p.sess) ?? null : null; }
