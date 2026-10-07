// agentglass — agent-wait live: the heavy commands running on this host now, with their RSS, plus host load and memory
// SPDX-License-Identifier: Apache-2.0
// Collected on the watchdog's alarm tick (H.onWatch, 1.5 s while agents are live) from data the tick already has: each
// watched session's outermost tool shells (detect.ts toolShells) and the children map (spec agent-wait §4). The command
// comes from the shell's argv (Claude Code: eval '<cmd>', else the text after -c), reduced to its family; nothing is
// stored. Sessions whose shells cannot be seen (a shared daemon, no tree) count their open shell calls, without RSS.
import { readWhole } from "../../util/fs.ts";
import type { Proc, Sess } from "../../model/types.ts";
import { rootOf } from "../../model/procs.ts";
import { ledger } from "../usage/ledger.ts";
import { norm } from "../usage/calls.ts";
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
// '…' with '\'' escapes, from i (just after the opening quote) → [text, index after the closing quote]
function sq(a: string, i: number): string {
  let o = "";
  for (;;) {
    const e = a.indexOf("'", i); if (e < 0) return o + a.slice(i);
    o += a.slice(i, e);
    if (a.startsWith("'\\''", e)) { o += "'"; i = e + 4; continue; }
    return o;
  }
}
export function shellCmd(args: string): string {
  const ev = args.indexOf(" eval '"); if (ev >= 0) return sq(args, ev + 7);
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
  const cmd = norm(shellCmd(args)); if (!cmd) return null;
  const f = familyOf(cmd, waitCfg()); const m: FamMemo = { family: f.name, kind: f.kind, heavy: f.heavy };
  if (memo.size >= 512) memo.clear();
  memo.set(args, m); return m;
}
function treeRss(p: Proc, kids: Map<number, Proc[]>): number {
  let n = 0; const st: Proc[] = [p];
  while (st.length) { const q = st.pop() as Proc; n += q.rss; for (const c of kids.get(q.pid) ?? []) st.push(c); }
  return n;
}
// the session's open calls with a shell command (age < 24 h): [time, commands]
function openShell(s: Sess, now: number): { t: number; cmds: string[] }[] {
  const o: { t: number; cmds: string[] }[] = []; const a = ledger.get(s.path); if (!a) return o;
  for (const p of a.pend.values()) if (p.cmd && p.t > 0 && now - p.t < 86400000) o.push({ t: p.t, cmds: p.cmd.split("\n") });
  return o;
}
// ss: the watched sessions (top-level, live)
export function collectLive(ss: Sess[], kids: Map<number, Proc[]>, now: number): LiveWait {
  const lw: LiveWait = { at: now, load1: -1, cpus: cpuCount(), memAvailPct: -1, running: [] };
  if (LIVE.want > now) { const h = hostLoad(); lw.load1 = h.load1; lw.memAvailPct = h.memAvailPct; }
  const roots = new Map<number, number>(); const rp: number[] = [];
  for (const s of ss) { const r = rootOf(s.pid); const p = r ? r.pid : s.pid; rp.push(p); roots.set(p, (roots.get(p) ?? 0) + 1); }
  for (let k = 0; k < ss.length; k++) {
    const s = ss[k]; if (!s) continue; const p = (rp[k] ?? 0) + 0;
    const open = openShell(s, now);
    const shells = (roots.get(p) ?? 0) > 1 ? [] : toolShells(p, kids); // a root shared by sessions: whose shell is whose is unknown
    let seen = false;
    for (const sh of shells) {
      const f = famOfArgs(sh.args); if (!f) continue;
      seen = true;
      lw.running.push({ path: s.path, h: s.h, family: f.family, kind: f.kind, heavy: f.heavy, ageSec: etimeSec(sh.etime), rssKb: treeRss(sh, kids), pid: sh.pid, bg: open.length === 0 });
    }
    if (seen || shells.length) continue;
    for (const c of open) { const f = callFamily(c.cmds.map((x: string): string => norm(x)), waitCfg()); lw.running.push({ path: s.path, h: s.h, family: f.name, kind: f.kind, heavy: f.heavy, ageSec: Math.floor((now - c.t) / 1000), rssKb: -1, pid: 0, bg: false }); }
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
