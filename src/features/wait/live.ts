// agentglass — agent-wait live: the heavy commands running on this host now, with their RSS, plus host load and memory
// SPDX-License-Identifier: Apache-2.0
// Collected on the watchdog's alarm tick (H.onWatch, 1.5 s while agents are live) from data the tick already has: each
// watched session's outermost tool shells (detect.ts toolShells) and the children map (spec agent-wait §4). The command
// comes from the shell's argv (Claude Code: … && eval <word>, else the text after -c), reduced to its family; nothing is
// stored. Sessions whose shells cannot be seen (a shared daemon, no tree) count their open shell calls, without RSS.
import { readWhole } from "../../util/fs.ts";
import type { Proc, Sess } from "../../model/types.ts";
import { rootOf, allProcs } from "../../model/procs.ts";
import { ledger } from "../usage/ledger.ts";
import { normFull } from "../usage/calls.ts";
import { etimeSec, toolShells } from "../detect.ts";
import { familyOf, callFamily, waitCfg } from "./family.ts";

export interface Run { path: string; h: string; family: string; kind: string; heavy: boolean; ageSec: number; rssKb: number /* -1 unknown */; pid: number /* 0: an open call */; bg: boolean /* no open shell call: a background run */ }
export interface LiveWait { at: number; load1: number /* -1 unknown */; cpus: number /* -1 unknown */; memAvailPct: number /* -1 unknown */; running: Run[] }
export function emptyLive(): LiveWait { return { at: 0, load1: -1, cpus: -1, memAvailPct: -1, running: [] }; }
// cur: the last tick's look; want: host figures (load, memory) are read until this time (the Wait tab, --watch and the
// contention rules set it: no file reads otherwise); ver: bumped per collection
export const LIVE = { cur: emptyLive(), want: 0, ver: 0 };
// the last look while it is fresh (the tick stops when no agent is live: an old look is no look)
export function liveNow(now: number): LiveWait { return now - LIVE.cur.at < 5000 ? LIVE.cur : emptyLive(); }

// ── argv ──
// one shell word from i on, quotes removed: '…' literal, "…" with \ escapes, bare characters with \ escapes, joined until
// an unquoted blank or operator (; & | < > ( )). Claude Code quotes the eval word with '"'"' for a quote inside (older
// builds '\''): both are a word of concatenated parts here.
function word(a: string, i: number): string {
  let o = ""; const L = a.length;
  while (i < L) {
    const c = a.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || ";&|<>()".indexOf(a.charAt(i)) >= 0) break;
    if (c === 39) { const e = a.indexOf("'", i + 1); if (e < 0) return o + a.slice(i + 1); o += a.slice(i + 1, e); i = e + 1; continue; }
    if (c === 34) {
      let j = i + 1;
      while (j < L) {
        const d = a.charCodeAt(j);
        if (d === 34) break;
        if (d === 92 && j + 1 < L && "\"\\$`\n".indexOf(a.charAt(j + 1)) >= 0) { o += a.charAt(j + 1); j += 2; continue; }
        o += a.charAt(j); j++;
      }
      i = j + 1; continue;
    }
    if (c === 92 && i + 1 < L) { o += a.charAt(i + 1); i += 2; continue; }
    o += a.charAt(i); i++;
  }
  return o;
}
// the command a tool shell runs, from its argv as one string: Claude Code's `… && eval <word> … && pwd -P …` (the same
// on Linux and macOS: only the shell differs), else the text after -c (combined flags too; an eval in another
// harness's -c text is part of its command)
export function shellCmd(args: string): string {
  let ev = args.indexOf(" && eval "); if (ev >= 0 && args.indexOf(" && pwd -P", ev) > 0) return word(args, ev + 9);
  ev = args.indexOf(" eval "); if (ev >= 0 && ev + 6 < args.length && "'\"".indexOf(args.charAt(ev + 6)) >= 0) return word(args, ev + 6);
  const ws = args.split(" "); let off = (ws[0] ?? "").length + 1;
  for (let k = 1; k < ws.length; k++) {
    const w = ws[k] ?? "";
    if (!w.startsWith("-") || w.startsWith("--")) { if (w.startsWith("--")) { off += w.length + 1; continue; } return ""; }
    if (w.endsWith("c")) return args.slice(off + w.length + 1).trim();
    off += w.length + 1;
  }
  return "";
}

// ── host ──
// /proc/loadavg and /proc/meminfo texts → 1-minute load and MemAvailable / MemTotal in percent (-1 unknown)
export function parseLoad(loadavg: string, meminfo: string): { load1: number; memAvailPct: number } {
  const l = Number(loadavg.trim().split(" ")[0] ?? ""); let tot = -1; let av = -1;
  for (const line of meminfo.split("\n")) {
    const w = line.split(" ").filter((x: string) => x.length > 0);
    if (w[0] === "MemTotal:") tot = Number(w[1] ?? ""); else if (w[0] === "MemAvailable:") av = Number(w[1] ?? "");
  }
  return { load1: loadavg.trim() && l >= 0 ? l : -1, memAvailPct: tot > 0 && av >= 0 ? Math.round((av * 100) / tot) : -1 };
}
const LINUX = process.platform === "linux";
export function hostLoad(): { load1: number; memAvailPct: number } {
  if (!LINUX) return { load1: -1, memAvailPct: -1 }; // macOS: scriptc has no os.loadavg(); no figure rather than a spawn per tick
  return parseLoad(readWhole("/proc/loadavg", 4096).text, readWhole("/proc/meminfo", 65536).text);
}
let ncpu = 0;
export function cpuCount(): number {
  if (ncpu) return ncpu;
  let n = 0; if (LINUX) for (const l of readWhole("/proc/stat", 1048576).text.split("\n")) if (l.startsWith("cpu") && l.charCodeAt(3) >= 48 && l.charCodeAt(3) <= 57) n++;
  ncpu = n > 0 ? n : -1; return ncpu;
}

// ── collection ──
interface FamMemo { family: string; kind: string; heavy: boolean }
const memo = new Map<string, FamMemo>();
function famOfArgs(args: string): FamMemo | null {
  const hit = memo.get(args); if (hit) return hit;
  const cmd = normFull(shellCmd(args).split("\n").join(" ; ")); if (!cmd) return null; // a script's lines are its steps (Gemini's wrapper)
  const f = familyOf(cmd, waitCfg()); const m: FamMemo = { family: f.name, kind: f.kind, heavy: f.heavy };
  if (memo.size >= 512) memo.clear();
  memo.set(args, m); return m;
}
// the process that runs the tool command a shell belongs to: its topmost ancestor below the agent (a process with a
// harness, or the root). A harness that runs commands without a shell (OpenCode: `npm test` straight under the agent)
// has the shell further down (npm's own `sh -c`): that ancestor's argv is the command
function cmdProc(sh: Proc, root: number): Proc {
  let c = sh;
  for (let i = 0; i < 16; i++) { const par = allProcs.get(c.ppid); if (!par || par.pid === root || par.h) break; c = par; }
  return c;
}
function famOfProc(p: Proc): FamMemo | null {
  if (SHELL_RE.test(p.args)) return famOfArgs(p.args);
  const hit = memo.get(p.args); if (hit) return hit;
  const cmd = normFull(p.args); if (!cmd) return null;
  const f = familyOf(cmd, waitCfg()); const m: FamMemo = { family: f.name, kind: f.kind, heavy: f.heavy };
  if (memo.size >= 512) memo.clear();
  memo.set(p.args, m); return m;
}
const SHELL_RE = /^(\S*\/)?-?(sh|bash|zsh|fish|dash)( |$)/;
function ageOf(p: Proc, now: number): number { return p.start > 0 ? Math.max(0, Math.floor((now - p.start) / 1000)) : etimeSec(p.etime); }
// bytes resident in a process and its descendants (Proc.rss is bytes)
function treeRss(p: Proc, kids: Map<number, Proc[]>): number {
  let n = 0; const st: Proc[] = [p];
  while (st.length) { const q = st.pop() as Proc; n += q.rss; for (const c of kids.get(q.pid) ?? []) st.push(c); }
  return n;
}
// the session has an open call with a shell command (age < 24 h); calls: those calls ([time, commands]) when asked
function openShell(s: Sess, now: number, calls: { t: number; cmds: string[] }[] | null): boolean {
  const a = ledger.get(s.path); if (!a) return false; let any = false;
  for (const p of a.pend.values()) if (p.cmd && p.t > 0 && now - p.t < 86400000) { any = true; if (!calls) return true; calls.push({ t: p.t, cmds: p.cmd.split("\n") }); }
  return any;
}
// ss: the watched sessions (top-level, live)
export function collectLive(ss: Sess[], kids: Map<number, Proc[]>, now: number): LiveWait {
  const lw: LiveWait = { at: now, load1: -1, cpus: cpuCount(), memAvailPct: -1, running: [] };
  if (LIVE.want > now) { const h = hostLoad(); lw.load1 = h.load1; lw.memAvailPct = h.memAvailPct; }
  const roots = new Map<number, number>(); const rp: number[] = [];
  for (const s of ss) { const r = rootOf(s.pid); const p = r ? r.pid : s.pid; rp.push(p); roots.set(p, (roots.get(p) ?? 0) + 1); }
  for (let k = 0; k < ss.length; k++) {
    const s = ss[k]; if (!s) continue; const p = (rp[k] ?? 0) + 0;
    const shells: Proc[] = []; // a root shared by sessions (a daemon): whose shell is whose is unknown
    if ((roots.get(p) ?? 0) <= 1) for (const sh of toolShells(p, kids)) {
      const c = cmdProc(sh, p); if (ageOf(c, now) >= 86400) continue; // a day-old process is a server the agent started
      let dup = false; for (const x of shells) if (x === c) dup = true;
      if (!dup) shells.push(c);
    }
    const open: { t: number; cmds: string[] }[] = []; openShell(s, now, open);
    if (open.length) { // the open calls name what runs (the transcript's command, not a harness's wrapper script); the tree adds memory
      const runs: Run[] = [];
      for (const c of open) { const f = callFamily(c.cmds.map((x: string): string => normFull(x)), waitCfg()); runs.push({ path: s.path, h: s.h, family: f.name, kind: f.kind, heavy: f.heavy, ageSec: Math.floor((now - c.t) / 1000), rssKb: -1, pid: 0, bg: false }); }
      runs.sort((x: Run, y: Run) => y.ageSec - x.ageSec);
      for (const sh of shells) {
        const f = famOfProc(sh); let to: Run | null = null;
        for (const r of runs) if (f && r.family === f.family) { to = r; break; }
        if (!to) to = runs[0] ?? null; // a wrapper the call runs in: the oldest call's
        if (to) { to.rssKb = (to.rssKb < 0 ? 0 : to.rssKb) + Math.round(treeRss(sh, kids) / 1024); if (!to.pid) to.pid = sh.pid; }
      }
      for (const r of runs) lw.running.push(r);
      continue;
    }
    for (const sh of shells) { // no open call: background runs, from the shells' argv
      const f = famOfProc(sh); if (!f) continue;
      lw.running.push({ path: s.path, h: s.h, family: f.family, kind: f.kind, heavy: f.heavy, ageSec: ageOf(sh, now), rssKb: Math.round(treeRss(sh, kids) / 1024), pid: sh.pid, bg: true });
    }
  }
  return lw;
}
// heavy commands now, optionally of one family / kind ("" = any)
export function heavyNow(lw: LiveWait, family: string, kind: string): Run[] {
  const o: Run[] = []; for (const r of lw.running) if (r.heavy && (!family || r.family === family) && (!kind || r.kind === kind)) o.push(r);
  return o;
}
// "pnpm test ×2, tsc": families by count, then name, ≤ 60 characters
export function famCounts(rs: Run[]): string {
  const m = new Map<string, number>(); for (const r of rs) m.set(r.family, (m.get(r.family) ?? 0) + 1);
  const xs = [...m.entries()]; xs.sort((a: [string, number], b: [string, number]) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let o = "";
  for (const [f, n] of xs) {
    const part = (o ? ", " : "") + f + (n > 1 ? " ×" + String(n) : "");
    if (o.length + part.length > 59) return (o + part).slice(0, 59) + "…";
    o += part;
  }
  return o;
}
