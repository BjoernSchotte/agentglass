// agentglass — harness processes (via the platform adapter, their multiplexer panes via src/mux/) and their link to sessions
// SPDX-License-Identifier: Apache-2.0
import { realpathSync } from "node:fs";
import { base } from "../util/json.ts";
import { WAKE_ALL, WAKE_H, WAKE_DIRS } from "../util/fs.ts";
import { OS } from "../platform/index.ts";
import { HARNESSES, harnessOfProc } from "../harness/index.ts";
import type { Live } from "../harness/types.ts";
import type { Proc, Sess } from "./types.ts";
import type { ProcRow } from "../platform/types.ts";
import { etimeSec } from "../features/detect.ts";
import { sessions, SG, SCANNED } from "./sessions.ts";
import { S } from "../state.ts";
import { linkByCwd, daemonWarn, type CwdProc, type CwdSess } from "./link.ts";
import { H, applyMeta, realCwd } from "../hooks.ts";
import { muxRefresh, muxLinks, muxSig, paneOfPid } from "../mux/index.ts";
import type { MuxProc } from "../mux/types.ts";

// agents without an adapter yet: shown in the process view under their own name
const OTHER = ["aider", "cursor-agent", "amp", "qwen", "crush", "goose", "copilot"];
// per process tree CPU history length: max(120, the largest `samples` of an enabled rule) (rules/state.ts sets it)
export const HIST = { cap: 120 };
export let procs: Proc[] = [];
export let procView: Proc[] = []; // the rows the Processes tab shows: procs passing H.procFilter (liveness code keeps reading procs)
export const allProcs = new Map<number, Proc>();
export const hist = new Map<number, number[]>();
export const cpuHist: number[] = [];
const cwdByPid = new Map<number, string>();
const filePid = new Map<string, number>(); // open transcript → pid (HarnessAdapter.liveFile)
const registry = new Map<string, Live>(); // "<harness>:<session id>" → entry (HarnessAdapter.liveRegistry)
const daemonLive = new Map<string, Live[]>(); // harness id → its registry, for harnesses whose registry is a shared daemon

// node flags whose value is the next argument (not the script); -e/-p/--eval/--print run inline code: no script
const VAL_FLAGS = ["-r", "--require", "--import", "--loader", "--experimental-loader", "--inspect-port", "--title", "--env-file", "-C", "--conditions", "--input-type"];
const INLINE = ["-e", "--eval", "-p", "--print"];
// the script after node/bun/deno names the agent; runtime flags come first (gemini relaunches itself with --max-old-space-size=…)
export function harnessOfArgs(args: string): string {
  const t = args.split(" "); const i = scriptAt(t); if (i < 0) return "";
  const b = i > 0 ? base(t[i]).replace(/\.(m?js|ts)$/, "") : base(t[0]);
  return harnessOfProc(b) || (OTHER.indexOf(b) >= 0 ? b : "");
}
// the index of the token naming the program: 0, or the script after node/bun/deno and their flags; -1 = inline code or none
function scriptAt(t: string[]): number {
  const b = base(t[0]);
  if (b !== "node" && b !== "bun" && b !== "deno") return 0;
  let i = 1;
  while (i < t.length && t[i].startsWith("-")) { if (INLINE.indexOf(t[i]) >= 0) return -1; i += VAL_FLAGS.indexOf(t[i]) >= 0 ? 2 : 1; }
  return i < t.length ? i : -1;
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
// start: the row's, else from etime as a lower bound (whole seconds), estimated once (a later one only jitters)
export function applyRows(rows: ProcRow[], now: number = Date.now()): boolean {
  let moved = false; const fresh: Proc[] = [];
  for (const r of rows) {
    let p = allProcs.get(r.pid);
    const st = r.start > 0 ? r.start : r.etime ? now - (etimeSec(r.etime) + 1) * 1000 : 0;
    if (!p) { p = { pid: r.pid, ppid: r.ppid, cpu: r.cpu, rss: r.rss, etime: r.etime, tty: r.tty, args: r.args, h: harnessOfArgs(r.args), start: st, cwd: "", tcpu: 0, trss: 0, kids: 0, sess: "" }; allProcs.set(r.pid, p); moved = true; if (p.h) fresh.push(p); continue; }
    if (p.ppid !== r.ppid) { p.ppid = r.ppid; moved = true; }
    if (r.start > 0) p.start = r.start;
    if (p.args !== r.args) { const was = p.h; p.args = r.args; p.h = harnessOfArgs(r.args); if (r.start <= 0) p.start = st; if (p.h && !was) fresh.push(p); }
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
  relink();
  wakeScan(procs, Date.now());
}
function relink(): void { const g = linkSig(); if (g !== lastLink) { lastLink = g; linkSessions(); } }
// a scan brought new sessions: link them now, from this pass's processes and registry (until the next process pass a new
// OpenCode/pi/Gemini session showed with no process: ○/· before its spinner). Not before the first process pass: a
// run's first scan (every one-shot CLI command) has no processes to link yet, and its refreshProcs links anyway
SCANNED.push((): void => { if (passNo > 0) relink(); });
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
  for (const [k, l] of registry) o.push(k + "=" + String(l.pid) + l.status + l.name + "@" + l.cwd);
  for (const p of allProcs.values()) if (p.h) o.push(String(p.pid) + ":" + String(p.ppid) + p.h + p.cwd);
  for (const [f, pid] of filePid) if (allProcs.has(pid)) o.push(f);
  let mt = 0; for (const ad of HARNESSES) if (ad.liveCwd) for (const s of sessions.values()) if (s.h === ad.id) mt += s.mtime;
  o.push(String(mt));
  o.push(muxSig()); // a multiplexer's exact links (herdr agent_session) moved
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
  const lr = logicalRoots();
  for (const [k, v] of f.open) filePid.set(logicalPath(k, lr), v);
  // multiplexer panes (tmux, herdr): each adapter decides when to read them again (a new agent, 30 s, forced by actions)
  // (a one-shot command's only pass reads everything at once)
  muxRefresh(muxProcs(), Date.now(), S.cli && !SLOW.ran, knownPid); SLOW.ran = true;
  for (const p of procs) p.cwd = cwdByPid.get(p.pid) ?? "";
  if (S.pins.length) buildProcView(); // cwd known now: repo and cwd pins apply
  if (sig !== SLOW.sig) { SLOW.sig = sig; linkSessions(); lastLink = linkSig(); } // cwds or open transcripts moved: link again
}
const SLOW = { sig: "", ran: false };
// the kernel names an open file by its real path, sessions are keyed by the path under their harness's root as configured
// (HOME, CODEX_HOME): a root reached through a symlink (macOS /var → /private/var, a moved home) is mapped back. Pairs
// [real + "/", root + "/"] of the open-file harnesses' roots whose real path differs (a few realpath calls per slow job)
function logicalRoots(): [string, string][] {
  const o: [string, string][] = [];
  for (const ad of HARNESSES) if (ad.liveFile) for (const r of ad.roots()) {
    let real = ""; try { real = realpathSync(r); } catch (e) { real = ""; }
    if (real && real !== r) o.push([real + "/", r + "/"]);
  }
  return o;
}
function logicalPath(p: string, roots: [string, string][]): string {
  for (const [real, root] of roots) if (p.startsWith(real)) return root + p.slice(real.length);
  return p;
}
// every agent process (nested ones too: a pane's foreground process may be a wrapper's child) with its tty and root
export function muxProcs(): MuxProc[] {
  const out: MuxProc[] = [];
  for (const p of allProcs.values()) if (p.h) { const r = rootOf(p.pid); out.push({ pid: p.pid, h: p.h, tty: OS.ttyDevice(p.tty), root: r ? r.pid : p.pid }); }
  return out;
}
// the exact pid agentglass already has for a session (registry, open transcript): a multiplexer's session id then needs no
// process lookup
export function knownPid(key: string, path: string): number {
  const l = key ? registry.get(key) : undefined; if (l && allProcs.has(l.pid)) return l.pid;
  const fp = path ? filePid.get(path) ?? 0 : 0; if (fp && allProcs.has(fp)) { const r = rootOf(fp); return r ? r.pid : fp; }
  if (key) for (const s of sessions.values()) if (s.h + ":" + s.id === key) { const f = filePid.get(s.path) ?? 0; if (f && allProcs.has(f)) { const r = rootOf(f); return r ? r.pid : f; } }
  return 0;
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
// the one copy a registry entry links when its session id has several (Claude: one session under two project dirs): the
// one its process writes — in the project dir of the process's cwd (HarnessAdapter.wakeDir) — else the newest. One live
// row per process: a pane's cost and a workspace's sum count it once. "<harness>:<id>" → path, only keys with copies
function regCopies(): Map<string, string> {
  const by = new Map<string, Sess[]>();
  for (const s of sessions.values()) { if (s.parent) continue; const k = s.h + ":" + s.id; if (!registry.has(k)) continue; const v = by.get(k); if (v) v.push(s); else by.set(k, [s]); }
  const out = new Map<string, string>();
  for (const [k, ss] of by) {
    if (ss.length < 2) continue;
    const l = registry.get(k); let d = "";
    const h = k.slice(0, k.indexOf(":"));
    if (l && l.cwd) for (const ad of HARNESSES) { const f = ad.wakeDir; if (ad.id === h && f) d = f(l.cwd); }
    let pick: Sess | null = null;
    if (d) for (const s of ss) if (s.path.slice(0, s.path.lastIndexOf("/")) === d) pick = s;
    if (!pick) for (const s of ss) if (!pick || s.mtime > pick.mtime) pick = s;
    if (pick) out.set(k, pick.path);
  }
  return out;
}
function linkSessions(): void {
  const cp = regCopies();
  for (const s of sessions.values()) {
    let pid = 0; let status = ""; let name = "";
    const k = s.h + ":" + s.id; const l = registry.get(k); const c = cp.get(k);
    if (l && (c === undefined || c === s.path)) { pid = l.pid; status = l.status; name = l.name; }
    else { const fp = filePid.get(s.path); if (fp && allProcs.has(fp)) { const r = rootOf(fp); pid = r ? r.pid : fp; status = "open"; } }
    linkOne(s, pid, status, name);
  }
  if (linked.size > sessions.size) for (const k of [...linked.keys()]) if (!sessions.has(k)) linked.delete(k);
  // a multiplexer's exact pairs (herdr: the agent_session its integrations report) for sessions still unlinked; before
  // the cwd guess, never over a registry or open-transcript link. A pid tmux claims is tmux's (the innermost owns it)
  const muxPids = linkMux();
  // harnesses with neither registry nor open transcript: process cwd ↔ newest session in that cwd
  // (registry pids are daemons, not TUIs; subagents never own a TUI)
  const regPids = new Set<number>(); for (const p of muxPids) regPids.add(p);
  for (const l of registry.values()) regPids.add(l.pid);
  for (const ad of HARNESSES) {
    if (!ad.liveCwd) continue;
    const cp: CwdProc[] = []; const st = ad.sessionStart; const ra = ad.resumeArgs ?? [];
    for (const p of procs) if (p.h === ad.id && p.cwd && !regPids.has(p.pid)) cp.push({ pid: p.pid, h: p.h, cwd: p.cwd, start: st ? p.start : 0, resume: resumeOf(p.args, ra) });
    const ss: CwdSess[] = [];
    for (const s of sessions.values()) if (s.h === ad.id && !s.parent) ss.push({ path: s.path, id: s.id, h: s.h, cwd: realCwd(s), mtime: s.mtime, pid: s.pid, start: st ? st(s) : 0 });
    const lm = ad.lastMessage; const lastMsg = (path: string): number => { const s = sessions.get(path); return lm && s ? lm(s) : 0; };
    const held = (path: string, pid: number, since: number): boolean => { const h = heldBy.get(path); return !!h && h.pid !== pid && h.at >= since; };
    for (const [path, pid] of linkByCwd(cp, ss, lastMsg, held)) {
      const s = sessions.get(path);
      if (s) { const r = rootOf(pid); s.pid = r ? r.pid : pid; s.status = "open"; }
    }
  }
  for (const p of procs) p.sess = "";
  const now = Date.now();
  for (const s of sessions.values()) if (s.pid) { const r = rootOf(s.pid); if (r) r.sess = s.path; heldBy.set(s.path, { pid: s.pid, at: now }); }
  if (heldBy.size > sessions.size) for (const k of [...heldBy.keys()]) if (!sessions.has(k)) heldBy.delete(k);
}
// checks: link with these agent roots (their cwds) as the process pass would
export function linkForCheck(roots: Proc[]): void { procs = roots; linkSessions(); }
export function linkSigForCheck(): string { return linkSig(); }
export function openForCheck(path: string, pid: number): void { if (pid) filePid.set(path, pid); else filePid.delete(path); }
export function liveForCheck(key: string, l: Live | null): void { if (l) registry.set(key, l); else registry.delete(key); }
// a pid the registry or an open transcript already gives another session keeps that link: a disagreement is not acted on
// (herdr may still report the session a TUI had before /new or /clear)
function linkMux(): Set<number> {
  const pids = new Set<number>(); const ls = muxLinks(); if (!ls.length) return pids;
  const owned = new Map<number, string>(); for (const s of sessions.values()) if (s.pid) owned.set(s.pid, s.path);
  const byKey = new Map<string, Sess>(); // a resumed session copied into a second project dir: the copy written last
  for (const s of sessions.values()) { if (s.parent) continue; const k = s.h + ":" + s.id; const o = byKey.get(k); if (!o || s.mtime > o.mtime) byKey.set(k, s); }
  for (const l of ls) {
    if (!allProcs.has(l.pid) || paneOfPid(l.pid).kind === "tmux") continue;
    const s = l.key ? byKey.get(l.key) : sessions.get(l.path);
    const r = rootOf(l.pid); const pid = r ? r.pid : l.pid;
    pids.add(pid);
    const o = owned.get(pid);
    if (s && !s.pid && (o === undefined || o === s.path)) { linkOne(s, pid, "open", ""); owned.set(pid, s.path); }
  }
  return pids;
}
// session → the last pid linked to it and when (linkByCwd: an older session a headless --resume run wrote to is not
// taken by a lone TUI in that project for an in-TUI resume once the run ended)
const heldBy = new Map<string, { pid: number; at: number }>();
// the session a command line resumes: "" none, "latest" (the flag without a value), else the value (an id or an index).
// Only arguments after the agent's script count (node's own -r is --require)
export function resumeOf(args: string, flags: string[]): string {
  if (!flags.length) return "";
  const t = args.split(" "); let i = scriptAt(t); if (i < 0) return "";
  for (i++; i < t.length; i++) {
    const a = t[i] ?? "";
    for (const f of flags) {
      if (a.startsWith(f + "=")) return a.slice(f.length + 1) || "latest";
      if (a === f) { const v = t[i + 1] ?? ""; return v && !v.startsWith("-") ? v : "latest"; }
    }
  }
  return "";
}
// pid is a harness's shared daemon: the warning to show instead of signalling it ("" = fine to signal)
export function sharedDaemon(pid: number): string {
  for (const ad of HARNESSES) {
    const d = ad.daemon; const ls = daemonLive.get(ad.id);
    if (d && ls) { const w = daemonWarn(pid, ad.label, d, ls); if (w) return w; }
  }
  return "";
}
export function ttyOf(pid: number): string { const p = allProcs.get(pid); return p ? OS.ttyDevice(p.tty) : ""; }
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
