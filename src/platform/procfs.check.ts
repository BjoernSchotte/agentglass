// agentglass — self-check for the /proc process table and the ps parser: scriptc build src/platform/procfs.check.ts -o pf && ./pf
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProcFs, parseStat, ttyName, cmdlineText, etimeText, scanProcs, procfsUsable, btimeOf, PROCFS_STATS } from "./procfs.ts";
import { parsePs } from "./posix.ts";
import type { ProcRow } from "./types.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": got " + got); } }
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }

// ── parsers ──
function statLine(pid: number, comm: string, state: string, ppid: number, tty: number, ticks: number, start: number, rss: number): string {
  return String(pid) + " (" + comm + ") " + state + " " + String(ppid) + " " + String(pid) + " " + String(pid) + " " + String(tty) + " -1 4194560 100 0 0 0 " +
    String(ticks) + " 0 0 0 20 0 1 0 " + String(start) + " 123456789 " + String(rss) + " 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0\n";
}
const st = parseStat(statLine(42, "a b) (c", "S", 7, 34816, 150, 900, 25));
ok("comm with ') (' parses", st !== null, "null");
if (st) {
  eq("comm", st.comm, "a b) (c"); eq("ppid", String(st.ppid), "7"); eq("tty_nr", String(st.ttyNr), "34816");
  eq("ticks", String(st.ticks), "150"); eq("start", String(st.start), "900"); eq("rss pages", String(st.rssPages), "25");
}
ok("garbage → null", parseStat("not a stat line") === null, "row");
ok("truncated → null", parseStat("1 (x) S 0 1") === null, "row");
eq("tty 136:0", ttyName(34816), "pts/0"); eq("tty 136:1", ttyName(34817), "pts/1");
eq("tty 137:2 (minor + 256)", ttyName(35074), "pts/258"); eq("tty 4:1", ttyName(1025), "tty1");
eq("tty 4:64", ttyName(1088), "ttyS0"); eq("no tty", ttyName(0), "?");
eq("pts minor over 255 (extended minor bits)", ttyName((136 << 8) | (1 << 20) | 4), "pts/260");
eq("kernel thread", cmdlineText(new Uint8Array(0), "kthreadd"), "[kthreadd]");
eq("trailing space of an arg kept, control chars as spaces", cmdlineText(new TextEncoder().encode("grep\0^### \0sh\nx\t\0\0"), "grep"), "grep ^###  sh x ");
eq("argv", cmdlineText(new TextEncoder().encode("node\0/x/claude\0--resume\0"), "node"), "node /x/claude --resume");
eq("etime m:s", etimeText(65), "01:05"); eq("etime h", etimeText(3661), "01:01:01"); eq("etime d", etimeText(90061), "1-01:01:01");

// ── scanProcs over a fixture tree ──
const root = join(tmpdir(), "agentglass-procfs-" + String(process.pid));
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
writeFileSync(join(root, "stat"), "cpu  1 2 3\nintr 5\nbtime 1700000000\nprocesses 9\n");
writeFileSync(join(root, "self"), ""); // non-numeric entries are skipped
function proc(pid: number, comm: string, ppid: number, tty: number, ticks: number, start: number, args: string): void {
  const d = join(root, String(pid)); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "stat"), statLine(pid, comm, "S", ppid, tty, ticks, start, 10));
  writeFileSync(join(d, "cmdline"), args);
  writeFileSync(join(d, "statm"), "5000 7 2 1 0 3 0\n"); // resident 7 pages: what ps shows, not stat's rss (10)
}
const fs: ProcFs = { root, hz: 100, page: 4096, btime: btimeOf(root) };
eq("btime", String(fs.btime), "1700000000");
const T0 = (1700000000 + 1000) * 1000; // boot + 1000 s
proc(1, "init", 0, 0, 10, 100, "/sbin/init\0");
proc(2, "kthreadd", 0, 0, 0, 100, "");
proc(500, "claude", 1, 34816, 1000, 50000, "claude\0--resume\0"); // started at boot + 500 s
ok("usable", procfsUsable(fs), "false");
function byPid(rows: ProcRow[], pid: number): ProcRow | null { for (const r of rows) if (r.pid === pid) return r; return null; }
function none(): Set<number> { return new Set<number>(); }
let rows = scanProcs(fs, T0, none(), false);
eq("rows", String(rows.length), "3");
const k = byPid(rows, 2); eq("kernel thread args", k ? k.args : "", "[kthreadd]");
const c = byPid(rows, 500);
eq("claude args", c ? c.args : "", "claude --resume"); eq("claude tty", c ? c.tty : "", "pts/0");
eq("claude rss (statm)", c ? String(c.rss) : "", "28672"); eq("claude etime", c ? c.etime : "", "08:20"); eq("first sample cpu", c ? String(c.cpu) : "", "0");
let n0 = PROCFS_STATS.cmdline; let s0 = PROCFS_STATS.stat;
rows = scanProcs(fs, T0 + 1500, none(), false);
eq("no change: no cmdline read", String(PROCFS_STATS.cmdline - n0), "0");
eq("no change: no stat read", String(PROCFS_STATS.stat - s0), "0");
// a tracked pid: stat again, cpu from the tick delta since its last sample (150 ticks over 3 s at 100 Hz = 50 %)
proc(500, "claude", 1, 34816, 1150, 50000, "claude\0--resume\0");
const tr = new Set<number>(); tr.add(500);
s0 = PROCFS_STATS.stat; n0 = PROCFS_STATS.cmdline;
rows = scanProcs(fs, T0 + 3000, tr, false);
eq("tracked: one stat", String(PROCFS_STATS.stat - s0), "1"); eq("tracked: no cmdline", String(PROCFS_STATS.cmdline - n0), "0");
const c2 = byPid(rows, 500); eq("tracked cpu", c2 ? c2.cpu.toFixed(1) : "", "50.0");
// a pass right after another keeps the last cpu (a few ms would read as 1000 %+)
proc(500, "claude", 1, 34816, 1160, 50000, "claude\0--resume\0");
rows = scanProcs(fs, T0 + 3100, tr, false);
const c3 = byPid(rows, 500); eq("pass < 500 ms: cpu kept", c3 ? c3.cpu.toFixed(1) : "", "50.0");
// a young pid (started 2 s ago) re-reads its cmdline: sh -c → node → agent
proc(600, "sh", 500, 34816, 0, (1000 + 2) * 100 + 300, "sh\0-c\0node x\0");
rows = scanProcs(fs, T0 + 5000, none(), false);
const y = byPid(rows, 600); eq("young first", y ? y.args : "", "sh -c node x");
proc(600, "node", 500, 34816, 0, (1000 + 2) * 100 + 300, "node\0/x/gemini\0");
rows = scanProcs(fs, T0 + 6500, none(), false);
const y2 = byPid(rows, 600); eq("young exec seen", y2 ? y2.args : "", "node /x/gemini");
// an old untracked pid's exec waits for the full pass
proc(1, "init", 0, 0, 10, 100, "/sbin/init\0splash\0");
rows = scanProcs(fs, T0 + 8000, none(), false);
const i1 = byPid(rows, 1); eq("old pid, no full pass: cached", i1 ? i1.args : "", "/sbin/init");
rows = scanProcs(fs, T0 + 9500, none(), true);
const i2 = byPid(rows, 1); eq("full pass: re-read", i2 ? i2.args : "", "/sbin/init splash");
// vanished pid → gone
rmSync(join(root, "2"), { recursive: true, force: true });
rows = scanProcs(fs, T0 + 11000, none(), false);
ok("vanished pid dropped", byPid(rows, 2) === null, "still listed");
// a listed pid whose stat vanished before the read is skipped
mkdirSync(join(root, "700"), { recursive: true });
rows = scanProcs(fs, T0 + 12500, none(), false);
ok("no stat → skipped", byPid(rows, 700) === null, "listed");
// pid reused (same number, other start) → a new process with its own cmdline and cpu reset
proc(500, "codex", 1, 0, 5, 101000, "codex\0");
rows = scanProcs(fs, T0 + 14000, tr, false);
const r5 = byPid(rows, 500);
eq("reused pid args", r5 ? r5.args : "", "codex"); eq("reused pid tty", r5 ? r5.tty : "", "?"); eq("reused pid cpu", r5 ? String(r5.cpu) : "", "0");
// a command line over the first 4 KB read is read whole
const long = "x".repeat(5000);
proc(900, "node", 1, 0, 0, 100, "node\0" + long + "\0");
rows = scanProcs(fs, T0 + 15000, none(), false);
const lg = byPid(rows, 900); eq("long cmdline", lg ? String(lg.args.length) : "", String(5 + 5000));
// zombie: [comm] <defunct>, as ps prints it
const zd = join(root, "800"); mkdirSync(zd, { recursive: true });
writeFileSync(join(zd, "stat"), statLine(800, "dead", "Z", 1, 0, 0, 100, 0)); writeFileSync(join(zd, "cmdline"), "");
rows = scanProcs(fs, T0 + 15500, none(), false);
const z = byPid(rows, 800); eq("zombie", z ? z.args : "", "[dead] <defunct>");

// boot time from /proc/uptime (as ps): 1000.5 s up, pid 1 started 1 s after boot → 999.5 s → 16:39 (btime would say 16:40 here)
writeFileSync(join(root, "uptime"), "1000.50 31000.00\n");
rows = scanProcs(fs, (1700000000 + 1001) * 1000, none(), true);
const u1 = byPid(rows, 1); eq("etime from uptime", u1 ? u1.etime : "", "16:39");

// only processes whose name may be an agent's or a launcher's get their command line read (want); a tracked one and a
// tracked pid's new child always; an exec (another comm) re-reads it
const want = (c: string): boolean => c === "node" || c === "claude";
proc(1100, "cron", 1, 0, 0, 100, "/usr/sbin/cron\0-f\0");
proc(1101, "node", 1, 0, 0, 100, "node\0/x/claude\0");
n0 = PROCFS_STATS.cmdline;
rows = scanProcs(fs, T0 + 20000, none(), false, want);
const cr = byPid(rows, 1100); const nd = byPid(rows, 1101);
eq("not an agent's name: no cmdline", cr ? cr.args : "x", ""); eq("node: cmdline", nd ? nd.args : "", "node /x/claude"); eq("one cmdline read", String(PROCFS_STATS.cmdline - n0), "1");
const t11 = new Set<number>(); t11.add(1100);
proc(1102, "sh", 1100, 0, 0, 100, "sh\0-c\0ls\0");
rows = scanProcs(fs, T0 + 21500, t11, false, want);
const cr2 = byPid(rows, 1100); const ch = byPid(rows, 1102);
eq("tracked: cmdline read", cr2 ? cr2.args : "", "/usr/sbin/cron -f"); eq("a tracked pid's new child: cmdline", ch ? ch.args : "", "sh -c ls");
// a tracked pid's resident size every 4th pass, its cpu every pass
writeFileSync(join(root, "1100", "statm"), "5000 9 2 1 0 3 0\n");
rows = scanProcs(fs, T0 + 23000, t11, false, want); const r1 = byPid(rows, 1100);
eq("rss not re-read on the next pass", r1 ? String(r1.rss) : "", String(7 * 4096));
for (let i = 0; i < 4; i++) rows = scanProcs(fs, T0 + 24500 + i * 1500, t11, false, want);
const r2 = byPid(rows, 1100); eq("rss after 4 passes", r2 ? String(r2.rss) : "", String(9 * 4096));
// an old untracked process that execs into an agent: its new name shows on the full pass, then its command line
const gone = join(root, "1100"); writeFileSync(join(gone, "stat"), statLine(1100, "node", "S", 1, 0, 10, 100, 10)); writeFileSync(join(gone, "cmdline"), "node\0/x/claude\0--resume\0");
rows = scanProcs(fs, T0 + 32000, none(), false, want); const x1 = byPid(rows, 1100);
eq("exec not seen between full passes", x1 ? x1.args : "", "/usr/sbin/cron -f");
rows = scanProcs(fs, T0 + 33500, none(), true, want); const x2 = byPid(rows, 1100);
eq("full pass: exec seen", x2 ? x2.args : "", "node /x/claude --resume");

// ── fallback to ps: /proc missing or without a boot time ──
ok("missing root → not usable", !procfsUsable({ root: join(root, "nope"), hz: 100, page: 4096, btime: 1 }), "usable");
ok("no btime → not usable", !procfsUsable({ root, hz: 100, page: 4096, btime: btimeOf(join(root, "500")) }), "usable");
rmSync(root, { recursive: true, force: true });

// ── ps output (macOS, and Linux without /proc) ──
const ps = parsePs("    1     0   0.0  13520 2-03:04:05 ??       /sbin/launchd\n  812     1  12.5 204800      05:12 ttys003  node /usr/local/bin/claude --resume x\nbogus line\n");
eq("ps rows", String(ps.length), "2");
const p2 = ps.length > 1 ? ps[1] : null;
if (p2) { eq("ps pid", String(p2.pid), "812"); eq("ps cpu", String(p2.cpu), "12.5"); eq("ps rss bytes", String(p2.rss), String(204800 * 1024)); eq("ps etime", p2.etime, "05:12"); eq("ps tty", p2.tty, "ttys003"); eq("ps args", p2.args, "node /usr/local/bin/claude --resume x"); }

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("procfs: all checks passed");
