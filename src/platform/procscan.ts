// agentglass — the incremental process scanner for any process source (procfs.ts: Linux /proc; darwin.ts: macOS
// libproc): new, young and tracked pids every pass, every pid on a full pass; no ps child
// SPDX-License-Identifier: Apache-2.0
import { own } from "../util/own.ts";
import type { ProcRow } from "./types.ts";

// one read of a process: startMs since the source's epoch (bootMs; pid reuse shows as another value), cpuMs user +
// system time (-1 = unknown: cpu reads 0), rss bytes (the cheap value, -1 = only via rss()), tty as ps prints it
export interface PStat { pid: number; comm: string; zombie: boolean; ppid: number; tty: string; cpuMs: number; startMs: number; rss: number }
export interface ProcSource {
  id: string; // the scanner's state resets when it changes
  pids(): number[]; // every pid now
  comm(pid: number): string; // the cheapest name read, "" = gone
  stat(pid: number): PStat | null; // null = gone
  rss(pid: number, st: PStat): number; // the precise resident size (bytes)
  args(pid: number, st: PStat): string; // the command line as ps args shows it, own()ed
  bootMs(now: number): number; // epoch ms of startMs 0 (procfs: boot; libproc: 0, its startMs is epoch ms)
}
// a pid younger than this re-reads its command line every pass: exec chains (sh -c → node → agent) settle within it
export const YOUNG_MS = 10000;
// launchers that exec into what they start (sh -c, env, npx…): only these are re-read while young; an interpreter or a
// binary keeps its command line, its children are new pids
const EXECS = ["sh", "bash", "zsh", "dash", "fish", "env", "npx", "npm", "pnpm", "yarn", "bunx", "uv", "uvx", "sudo", "nohup", "timeout", "script", "exec"];
export const SCAN_STATS = { comm: 0, stat: 0, args: 0, rss: 0 }; // reads, for checks
// per pid: the row handed out (kept across passes) and the last stat sample for the CPU delta
// comm = the name from the last stat
interface Ent { row: ProcRow; start: number; startMs: number; tty: string; t: number; at: number; seen: number; comm: string; rssAt: number }
// wait: new pids whose name is not an agent's or an interpreter's, seen once (by their name only): read on the next pass
// if still there (most of a busy host's new processes live less than a pass: a shell command, git)
const PF = { id: "", pass: 0, bootMs: 0, ents: new Map<number, Ent>(), out: [] as ProcRow[], wait: new Map<number, number>() };
const RSS_EVERY = 4; // a tracked pid's resident size every 4th pass (~6 s): its cpu needs the stat every pass, not this

// ps etime: [[dd-]hh:]mm:ss
function two(n: number): string { return (n < 10 ? "0" : "") + String(n); }
export function etimeText(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const d = Math.floor(t / 86400); const h = Math.floor(t / 3600) % 24;
  return (d ? String(d) + "-" : "") + (d || h ? two(h) + ":" : "") + two(Math.floor(t / 60) % 60) + ":" + two(t % 60);
}
function reset(src: ProcSource): void { if (PF.id !== src.id) { PF.id = src.id; PF.ents.clear(); PF.wait.clear(); PF.bootMs = 0; } }
function stat(src: ProcSource, pid: number): PStat | null { SCAN_STATS.stat++; return src.stat(pid); }
function rssOf(src: ProcSource, pid: number, st: PStat): number { SCAN_STATS.rss++; return src.rss(pid, st); }
function argsOf(src: ProcSource, pid: number, st: PStat): string { SCAN_STATS.args++; return src.args(pid, st); }
// recent cpu % from the cpu-time delta since the last sample; a pass right after another keeps the last value (a 10 ms
// tick over a few ms would read as 1000 %+)
function sample(e: Ent, st: PStat, now: number): void {
  if (now - e.at < 500) return;
  e.row.cpu = st.cpuMs < 0 || e.t < 0 ? 0 : Math.max(0, (st.cpuMs - e.t) / (now - e.at) * 100);
  e.t = st.cpuMs; e.at = now;
}

// one pass: rows of every pid of src. A pid is read when it is new, tracked (a harness tree: cpu, resident size),
// young (< 10 s) while its name is a launcher's (exec chains: EXECS), or on a full pass; a reused pid shows
// in its start time. A new pid's name is read first: one that may be an agent's or a launcher's (want) is read at once,
// any other on the next pass if still there. The command line is read on a pid's first read, again when its name
// changed (an exec), and on young and full passes where want(comm) or it is tracked or a tracked pid's child. cpu is the recent % from
// the cpu-time delta since the last sample (0 on the first). The array is reused: callers read it before the next pass.
export function scanSource(src: ProcSource, now: number, tracked: Set<number>, full: boolean, want: (comm: string) => boolean = (c: string): boolean => true): ProcRow[] {
  reset(src);
  if (full || !PF.bootMs) PF.bootMs = src.bootMs(now); // again on full passes: the wall clock may have been stepped
  PF.pass++; const pass = PF.pass; const out = PF.out; out.length = 0;
  for (const pid of src.pids()) {
    let e = PF.ents.get(pid);
    const tr = tracked.has(pid);
    const young = e !== undefined && now - e.startMs < YOUNG_MS && EXECS.indexOf(e.comm) >= 0;
    if (!e && !full && !PF.wait.has(pid)) { // first sight: only its name; an agent or an interpreter is read at once
      SCAN_STATS.comm++;
      const c = src.comm(pid);
      if (!c) continue;
      if (!want(c) || EXECS.indexOf(c) >= 0) { PF.wait.set(pid, pass); continue; }
    }
    if (!e || full || young || tr) {
      PF.wait.delete(pid);
      const st = stat(src, pid);
      if (!st) { if (e) PF.ents.delete(pid); continue; } // gone between the listing and the read
      if (e && e.start !== st.startMs) e = undefined; // pid reused
      const startMs = PF.bootMs + st.startMs;
      const args = tr || want(st.comm) || tracked.has(st.ppid);
      if (!e) {
        // its command line once, whatever its name: an agent may run under any (node 24 names itself "MainThread", a
        // wrapper sets a title); the wait above already dropped the processes that live less than a pass
        const rss = args || st.rss < 0 ? rssOf(src, pid, st) : st.rss;
        const row: ProcRow = { pid, ppid: st.ppid, cpu: 0, rss, etime: own(etimeText((now - startMs) / 1000)), tty: own(st.tty), args: argsOf(src, pid, st), start: startMs };
        e = { row, start: st.startMs, startMs, tty: row.tty, t: st.cpuMs, at: now, seen: pass, comm: st.comm, rssAt: args ? pass : -1 }; // -1: the cheap rss, the precise one once tracked
        PF.ents.set(pid, e);
      } else {
        const r = e.row;
        r.ppid = st.ppid; r.etime = own(etimeText((now - startMs) / 1000));
        if (tr && (pass - e.rssAt >= RSS_EVERY || e.rssAt < 0)) { r.rss = rssOf(src, pid, st); e.rssAt = pass; }
        if (st.tty !== e.tty) { e.tty = own(st.tty); r.tty = e.tty; }
        const exec = st.comm !== e.comm; if (exec) e.comm = own(st.comm);
        if (exec || (args && (young || full))) r.args = argsOf(src, pid, st);
        sample(e, st, now);
      }
    }
    e.seen = pass;
    out.push(e.row);
  }
  for (const [pid, e] of PF.ents) if (e.seen !== pass) PF.ents.delete(pid);
  for (const [pid, p] of PF.wait) if (p !== pass) PF.wait.delete(pid); // gone before its second pass (or read now)
  return out;
}
// a pass without the listing: the pids seen last time, the tracked ones read fresh (cpu, a gone one dropped); new pids
// wait for the next listing pass
export function knownSource(src: ProcSource, now: number, tracked: Set<number>): ProcRow[] {
  reset(src);
  const out = PF.out; out.length = 0;
  for (const [pid, e] of PF.ents) {
    if (tracked.has(pid)) {
      const st = stat(src, pid);
      if (!st || st.startMs !== e.start) { PF.ents.delete(pid); continue; } // gone (or reused: the next listing reads it as new)
      e.row.ppid = st.ppid;
      sample(e, st, now);
    }
    out.push(e.row);
  }
  return out;
}
