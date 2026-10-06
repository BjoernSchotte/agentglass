// agentglass — self-check: the kernel process scan (Linux /proc, macOS libproc) against ps on this host
// check: ffi
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { run, readText } from "../util/fs.ts";
import { type ProcFs, scanProcs, btimeOf } from "./procfs.ts";
import { scanSource } from "./procscan.ts";
import { libprocSource } from "./darwin.ts";
import { nativeProcs, lpStat } from "./libproc.ts";
import { psProcs } from "./posix.ts";
import { etimeSec } from "../features/detect.ts";
import type { ProcRow } from "./types.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": got " + got); } }
const mac = process.platform === "darwin";
function sleepMs(ms: number): void { run("sleep", [String(ms / 1000)]); }
function byPid(rows: ProcRow[]): Map<number, ProcRow> { const m = new Map<number, ProcRow>(); for (const r of rows) m.set(r.pid, { pid: r.pid, ppid: r.ppid, cpu: r.cpu, rss: r.rss, etime: r.etime, tty: r.tty, args: r.args, start: r.start }); return m; }
const me = Number(run("id", ["-u"]).trim());
function uidOf(pid: number): number {
  if (mac) { const s = lpStat(pid); return s ? s.uid : -1; }
  const t = readText("/proc/" + String(pid) + "/status", 0, 4096); const i = t.indexOf("\nUid:");
  return i < 0 ? -1 : parseInt(t.slice(i + 5).trim(), 10);
}

// a known tree: sh forks a sleep, then execs into another (an exec chain)
const tree = spawn("sh", ["-c", "sleep 30 & exec sleep 31"], { stdio: "ignore" });
const top = tree.pid ?? 0;
sleepMs(300);
if (mac) ok("native libproc on macOS", nativeProcs(), "ps fallback (built without --ffi?)");
// ps before and after the scan: only pids whose ps row did not change in between are compared (a busy host execs and
// grows processes all the time); a command line ps cut at a column limit (≥ 200 characters) need only be a prefix
const t0 = Date.now(); const ps0 = byPid(psProcs());
let rows: ProcRow[] = [];
if (mac) rows = nativeProcs() ? scanSource(libprocSource(), Date.now(), new Set<number>(), true, (c: string): boolean => true) : [];
else {
  const fs: ProcFs = { root: "/proc", hz: Number(run("getconf", ["CLK_TCK"]).trim()) || 100, page: Number(run("getconf", ["PAGESIZE"]).trim()) || 4096, btime: btimeOf("/proc") };
  rows = scanProcs(fs, Date.now(), new Set<number>(), true);
}
const scan = byPid(rows);
const ps1 = byPid(psProcs());
for (const r of ps1.values()) if (r.ppid === top) run("kill", ["-KILL", String(r.pid)]); // the orphan-to-be
tree.kill("SIGKILL");
let stable = 0; let both = 0; let compared = 0; let off = 0;
for (const [pid, a] of ps0) {
  const b = ps1.get(pid);
  if (!b || a.args !== b.args || a.ppid !== b.ppid || a.tty !== b.tty) continue;
  stable++;
  const s = scan.get(pid); if (!s) continue;
  both++;
  if (uidOf(pid) !== me) continue;
  compared++;
  const what = "pid " + String(pid) + " (" + a.args.slice(0, 60) + ")";
  if (s.ppid !== a.ppid) { off++; console.log("FAIL " + what + " ppid: scan " + String(s.ppid) + " ps " + String(a.ppid)); }
  if (s.tty !== a.tty) { off++; console.log("FAIL " + what + " tty: scan " + s.tty + " ps " + a.tty); }
  if (s.args !== a.args && !(a.args.length >= 200 && s.args.startsWith(a.args))) { off++; console.log("FAIL " + what + " args: scan " + JSON.stringify(s.args) + " ps " + JSON.stringify(a.args)); }
  const psStart = t0 - etimeSec(a.etime) * 1000; // etime: whole seconds, rounded down
  if (Math.abs(s.start - psStart) > 1500) { off++; console.log("FAIL " + what + " start: scan " + String(s.start) + " ps ~" + String(psStart)); }
  const lo = Math.min(a.rss, b.rss); const hi = Math.max(a.rss, b.rss);
  if (hi <= lo * 1.05 && (s.rss < lo * 0.75 || s.rss > hi * 1.25)) { off++; console.log("FAIL " + what + " rss: scan " + String(s.rss) + " ps " + String(a.rss)); }
}
bad += off;
ok("pid sets overlap ≥ 98 %", stable > 0 && both / stable >= 0.98, String(both) + " of " + String(stable));
let extra = 0; for (const pid of scan.keys()) if (!ps0.has(pid) && !ps1.has(pid)) extra++;
ok("scan has ≤ 2 % pids ps never listed", extra <= scan.size * 0.02, String(extra) + " of " + String(scan.size));
ok("own pids compared", compared >= 3, String(compared));
// the spawned tree in both: sh exec'd into sleep 31, its child sleep 30
for (const [name, m] of [["ps", ps0], ["scan", scan]] as [string, Map<number, ProcRow>][]) {
  const t = m.get(top); ok(name + ": tree top exec'd", t !== undefined && t.args === "sleep 31", t ? t.args : "missing");
  let kid = false; for (const r of m.values()) if (r.ppid === top && r.args === "sleep 30") kid = true;
  ok(name + ": tree child", kid, "missing");
}
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("procs parity: all checks passed (" + String(compared) + " pids compared)");
