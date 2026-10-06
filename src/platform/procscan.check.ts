// agentglass — self-check for the source-agnostic process scanner: scriptc build src/platform/procscan.check.ts -o c && ./c
// SPDX-License-Identifier: Apache-2.0
import { type PStat, type ProcSource, scanSource, knownSource, etimeText } from "./procscan.ts";
import type { ProcRow } from "./types.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": got " + got); } }
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }

// a source in memory: pid → stat and args, every read counted
const ST = new Map<number, PStat>(); const ARGS = new Map<number, string>();
const N = { comm: 0, stat: 0, args: 0, rss: 0 };
function mk(id: string): ProcSource {
  return {
    id,
    pids: (): number[] => [...ST.keys()],
    comm: (pid: number): string => { N.comm++; const s = ST.get(pid); return s ? s.comm : ""; },
    stat: (pid: number): PStat | null => {
      N.stat++; const s = ST.get(pid); if (!s) return null;
      return { pid: s.pid, comm: s.comm, zombie: s.zombie, ppid: s.ppid, tty: s.tty, cpuMs: s.cpuMs, startMs: s.startMs, rss: s.rss };
    },
    rss: (pid: number, st: PStat): number => { N.rss++; return st.rss * 2; }, // the precise read: twice the cheap one here
    args: (pid: number, st: PStat): string => { N.args++; return ARGS.get(pid) ?? "(" + st.comm + ")"; },
    bootMs: (now: number): number => 0, // startMs is epoch ms already
  };
}
function proc(pid: number, comm: string, ppid: number, cpuMs: number, startMs: number, args: string): void {
  ST.set(pid, { pid, comm, zombie: false, ppid, tty: "??", cpuMs, startMs, rss: 1000 }); ARGS.set(pid, args);
}
function byPid(rows: ProcRow[], pid: number): ProcRow | null { for (const r of rows) if (r.pid === pid) return r; return null; }
function set(...p: number[]): Set<number> { const s = new Set<number>(); for (const x of p) s.add(x); return s; }
const want = (c: string): boolean => c === "claude" || c === "node";
const T = 1791265000000;
let src = mk("fake");

proc(1, "launchd", 0, 0, T - 86400000, "/sbin/launchd");
proc(500, "claude", 1, 1000, T - 500000, "claude --resume");
let rows = scanSource(src, T, set(), true, want);
eq("rows", String(rows.length), "2");
const c = byPid(rows, 500); eq("args", c ? c.args : "", "claude --resume"); eq("etime", c ? c.etime : "", "08:20"); eq("start", c ? String(c.start) : "", String(T - 500000));
eq("wanted: precise rss", c ? String(c.rss) : "", "2000"); eq("first cpu", c ? String(c.cpu) : "", "0");

// an unwanted new name waits a pass (its name only), then is read once
proc(600, "cron", 1, 0, T, "/usr/sbin/cron -f");
let s0 = N.stat; let c0 = N.comm;
rows = scanSource(src, T + 1500, set(), false, want);
ok("unwanted: not listed on first sight", byPid(rows, 600) === null, "listed");
eq("unwanted: name only", String(N.comm - c0) + "/" + String(N.stat - s0), "1/0");
rows = scanSource(src, T + 3000, set(), false, want);
const cr = byPid(rows, 600); eq("unwanted: read on the second pass", cr ? cr.args : "", "/usr/sbin/cron -f"); eq("unwanted: cheap rss", cr ? String(cr.rss) : "", "1000");

// a young launcher is re-read and sees its exec
proc(700, "sh", 500, 0, T + 2000, "sh -c node x");
rows = scanSource(src, T + 4500, set(), false, want); rows = scanSource(src, T + 6000, set(), false, want);
const y = byPid(rows, 700); eq("young sh", y ? y.args : "", "sh -c node x");
proc(700, "node", 500, 0, T + 2000, "node /x/gemini");
rows = scanSource(src, T + 7500, set(), false, want);
const y2 = byPid(rows, 700); eq("young exec", y2 ? y2.args : "", "node /x/gemini");

// tracked cpu: +300 ms of cpu over 1,000 ms = 30 %; a pass 200 ms later keeps it (guard)
const tr = set(500);
rows = scanSource(src, T + 9000, tr, false, want);
proc(500, "claude", 1, 1300, T - 500000, "claude --resume");
rows = scanSource(src, T + 10000, tr, false, want);
const c2 = byPid(rows, 500); eq("tracked cpu", c2 ? c2.cpu.toFixed(1) : "", "30.0");
proc(500, "claude", 1, 1400, T - 500000, "claude --resume");
rows = scanSource(src, T + 10200, tr, false, want);
const c3 = byPid(rows, 500); eq("guard: cpu kept", c3 ? c3.cpu.toFixed(1) : "", "30.0");
// unknown cpu (-1: another user's process) reads 0
ST.set(800, { pid: 800, comm: "node", zombie: false, ppid: 1, tty: "??", cpuMs: -1, startMs: T, rss: 0 }); ARGS.set(800, "(node)");
rows = scanSource(src, T + 11000, set(800), false, want); rows = scanSource(src, T + 12000, set(800), false, want);
const u = byPid(rows, 800); eq("unknown cpu", u ? String(u.cpu) : "", "0");

// pid reuse: another start → a new process with its own args and cpu
proc(500, "codex", 1, 5, T + 11000, "codex");
rows = scanSource(src, T + 13000, tr, false, want);
const r5 = byPid(rows, 500); eq("reused args", r5 ? r5.args : "", "codex"); eq("reused cpu", r5 ? String(r5.cpu) : "", "0");

// the precise rss every 4th pass of a tracked pid, the cheap one otherwise
let r0 = N.rss;
for (let i = 0; i < 4; i++) rows = scanSource(src, T + 14000 + i * 1500, tr, false, want);
eq("tracked rss: once in 4 passes", String(N.rss - r0), "1");

// knownSource reads only tracked pids and drops a gone one
s0 = N.stat;
rows = knownSource(src, T + 21000, tr);
eq("known: one stat", String(N.stat - s0), "1");
ok("known: lists the known pids", byPid(rows, 1) !== null && byPid(rows, 600) !== null, String(rows.length));
ST.delete(500);
rows = knownSource(src, T + 22500, tr);
ok("known: a gone tracked pid dropped", byPid(rows, 500) === null, "kept");

// a full pass re-reads every pid's stat
s0 = N.stat;
rows = scanSource(src, T + 24000, set(), true, want);
eq("full: every stat", String(N.stat - s0), String(ST.size));

// another source id: state starts over (every pid read as new)
src = mk("other"); let a0 = N.args;
rows = scanSource(src, T + 25500, set(), true, want);
eq("new source: args read again", String(N.args - a0), String(ST.size));

eq("etime d", etimeText(90061), "1-01:01:01");
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("procscan: all checks passed");
