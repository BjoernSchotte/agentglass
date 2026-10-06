// agentglass — self-check for the macOS libproc bindings: the parsers everywhere, the native reads on macOS (FFI build)
// check: ffi
// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { parseAgStat, nulSplit, nativeProcs, lpPids, lpStat, lpArgs, lpCwd, lpFiles } from "./libproc.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": got " + got); } }
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }

// ── parsers ──
const a = parseAgStat("1 501 0 1791265126127 1234 933888 ttys003\tnode MainThread x");
ok("stat line parses", a !== null, "null");
if (a) {
  eq("ppid", String(a.ppid), "1"); eq("uid", String(a.uid), "501"); eq("zombie", String(a.zombie), "false");
  eq("start", String(a.startMs), "1791265126127"); eq("cpu", String(a.cpuMs), "1234"); eq("rss", String(a.rss), "933888");
  eq("tty", a.tty, "ttys003"); eq("comm with spaces", a.comm, "node MainThread x");
}
const r = parseAgStat("0 0 0 1791265000000 -1 0 ??\tlaunchd");
eq("refused cpu", r ? String(r.cpuMs) : "", "-1"); eq("no tty", r ? r.tty : "", "??");
const z = parseAgStat("7 501 1 1791265000000 5 0 ??\tsh");
eq("zombie", z ? String(z.zombie) : "", "true");
ok("5 fields → null", parseAgStat("1 501 0 17 12\tx") === null, "row");
ok("no tab → null", parseAgStat("1 501 0 17 12 0 ??") === null, "row");
ok("non-numeric → null", parseAgStat("1 x 0 17 12 0 ??\tx") === null, "row");
ok("zombie flag 2 → null", parseAgStat("1 501 2 17 12 0 ??\tx") === null, "row");
eq("nulSplit", JSON.stringify(nulSplit(new TextEncoder().encode("a\0b\0\0"), 5)), "[\"a\",\"b\"]");
eq("nulSplit stops at n", JSON.stringify(nulSplit(new TextEncoder().encode("/x/y\0/z\0"), 5)), "[\"/x/y\"]");
eq("nulSplit empty", JSON.stringify(nulSplit(new Uint8Array(4), 4)), "[]");

// ── native reads (macOS, a --ffi build) ──
function sleepMs(ms: number): void { spawnSync("sleep", [String(ms / 1000)]); }
if (process.platform !== "darwin" || !nativeProcs()) {
  ok("native on macOS", process.platform !== "darwin", "no binding (built without --ffi?)");
  console.log("native: skipped (not darwin or no ffi)");
} else {
  const me = lpStat(process.pid);
  ok("own stat", me !== null, "null");
  if (me) {
    ok("own start within 60 s", Math.abs(Date.now() - me.startMs) < 60000, String(me.startMs));
    ok("own rss", me.rss > 1000000, String(me.rss));
    ok("own cpu read", me.cpuMs >= 0, String(me.cpuMs));
    ok("own args", lpArgs(process.pid, me.comm).indexOf(basename(process.argv[0] ?? "c")) >= 0, lpArgs(process.pid, me.comm));
  }
  // cpu time in ms on any timebase (arm64 counts mach units): a spinning child reads ~100 % of a core
  const busy = spawn("sh", ["-c", "while :; do :; done"], { stdio: "ignore" });
  const bp = busy.pid ?? 0;
  sleepMs(200);
  const bs = lpStat(bp); eq("child's ppid", bs ? String(bs.ppid) : "", String(process.pid)); eq("child's comm", bs ? bs.comm : "", "sh");
  eq("child's args", lpArgs(bp, "sh"), "sh -c while :; do :; done");
  const b0 = lpStat(bp); const t0 = Date.now();
  sleepMs(1000);
  const b1 = lpStat(bp); const t1 = Date.now();
  const pt = spawnSync("ps", ["-o", "time=", "-p", String(bp)]); // [[dd-]hh:]mm:ss.cc
  busy.kill("SIGKILL");
  let psMs = 0; let m = 1; const parts = String(pt.stdout).trim().split(/[-:]/);
  for (let i = parts.length - 1; i >= 0; i--) { psMs += Number(parts[i]) * m * 1000; m = m === 1 ? 60 : m === 60 ? 3600 : 86400; }
  if (b0 && b1) {
    // a loaded runner may give the spinner less than a core: the share is loose, ps's own cpu time is the yardstick
    const pct = (b1.cpuMs - b0.cpuMs) / (t1 - t0) * 100; ok("busy child 30–130 %", pct >= 30 && pct <= 130, pct.toFixed(1));
    ok("busy child cpu time = ps time", psMs >= 200 && Math.abs(b1.cpuMs - psMs) <= Math.max(60, psMs * 0.2), String(b1.cpuMs) + " vs ps " + String(psMs));
  } else ok("busy child stat", false, "null");
  eq("cwd", lpCwd(process.pid), realpathSync(process.cwd()));
  const f = join(tmpdir(), "agentglass-libproc-" + String(process.pid)); writeFileSync(f, "x");
  const fd = openSync(f, "r");
  const files = lpFiles(process.pid);
  ok("open file listed", files.indexOf(realpathSync(f)) >= 0, JSON.stringify(files));
  closeSync(fd); rmSync(f, { force: true });
  const l = lpStat(1);
  eq("launchd uid", l ? String(l.uid) : "", "0");
  const la = lpArgs(1, "launchd"); ok("launchd args", la === "(launchd)" || la.startsWith("/sbin/launchd"), la);
  const gone = Number(String(spawnSync("sh", ["-c", "echo $$"]).stdout).trim()); // exited and waited for
  ok("gone pid → null", gone > 0 && lpStat(gone) === null, String(gone));
  const ps = lpPids();
  ok("pid list has self", ps.indexOf(process.pid) >= 0, String(ps.length));
  ok("pid list ≥ 50", ps.length >= 50, String(ps.length));
}
if (bad === 0) console.log("libproc: all checks passed");
else { console.log(String(bad) + " failures"); process.exit(1); }
