// agentglass — self-check for the MCP child runner (queue, timeout, cancel, progress, env, paths) with sh stub children:
//   scriptc build src/mcp/run.check.ts -o rn && ./rn
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, unlinkSync, mkdtempSync, symlinkSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { SESSION_VARS, newRunner, submit, cancel, killAll, childEnv, cliBin, childCwd, type Job, type Done, type Runner } from "./run.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
type Env = Record<string, string | undefined>;
const T0 = Date.now();
const now = (): number => Date.now() - T0;
function rn(max: number, beatMs: number): Runner { return newRunner({ bin: "/bin/sh", cwd: "", env: { PATH: "/usr/bin:/bin" }, max, queueMax: 8, beatMs }); }
function job(id: string, script: string, timeoutMs: number, progress: string): Job { return { id, argv: ["-c", script], keepSession: false, timeoutMs, progress, label: "agentglass x" }; }
const noBeat = (token: string, sec: number, label: string): void => { /* no progress expected */ };
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return false; } }
const runners: Runner[] = [];
let pending = 0; // cases still running
function fin(): void { pending--; if (pending === 0) summary(); }

// ── pure ──
{
  const e = childEnv({ CLAUDE_CODE_SESSION_ID: "x", PI_SESSION_ID: "y", PATH: "/bin", AGENTGLASS_AGENT: "0" }, false); const ev: Env = e;
  ok("env drops session vars", ev["CLAUDE_CODE_SESSION_ID"] === undefined && ev["PI_SESSION_ID"] === undefined, JSON.stringify(e));
  ok("env forces agent mode", ev["AGENTGLASS_AGENT"] === "1" && ev["NO_COLOR"] === "1" && ev["PATH"] === "/bin", JSON.stringify(e));
  const k: Env = childEnv({ CLAUDE_CODE_SESSION_ID: "x" }, true);
  ok("env keeps session vars on retry", k["CLAUDE_CODE_SESSION_ID"] === "x" && k["AGENTGLASS_AGENT"] === "1", JSON.stringify(k));
  ok("session vars", JSON.stringify(SESSION_VARS) === JSON.stringify(["CLAUDE_CODE_SESSION_ID", "OPENCODE_SESSION_ID", "CODEX_THREAD_ID", "KIRO_SESSION_ID", "PI_SESSION_ID"]), JSON.stringify(SESSION_VARS));
  ok("cwd home", childCwd("/home/u", "/home/u") === "", childCwd("/home/u", "/home/u"));
  ok("cwd home/", childCwd("/home/u/", "/home/u") === "", childCwd("/home/u/", "/home/u"));
  ok("cwd root", childCwd("/", "/home/u") === "", childCwd("/", "/home/u"));
  ok("cwd project", childCwd("/w/p", "/home/u") === "/w/p", childCwd("/w/p", "/home/u"));
  // $HOME through a symlink (macOS: mktemp's /var/… is /private/var/…, and process.cwd() reports the real path)
  const d = mkdtempSync(tmpdir() + "/agmcp-"); const l = d + "-link"; symlinkSync(d, l);
  ok("cwd home via symlink", childCwd(realpathSync(d), l) === "" && childCwd(l, realpathSync(d)) === "", childCwd(realpathSync(d), l));
  ok("cwd project real", childCwd(l, "/home/u") === realpathSync(d), childCwd(l, "/home/u"));
  unlinkSync(l); rmdirSync(d);
  ok("bin sibling", cliBin("/opt/x/agentglass-mcp", {}) === "/opt/x/agentglass", cliBin("/opt/x/agentglass-mcp", {}));
  ok("bin env", cliBin("/opt/x/agentglass-mcp", { AGENTGLASS_MCP_BIN: "/t/stub" }) === "/t/stub", cliBin("/opt/x/agentglass-mcp", { AGENTGLASS_MCP_BIN: "/t/stub" }));
}

// 1, 2: output and exit codes
{
  const r = rn(2, 1000); runners.push(r); pending += 2;
  submit(r, job("1", "echo '{\"a\":1}'", 5000, ""), noBeat, (d: Done) => { ok("stdout", d.code === 0 && d.stdout === "{\"a\":1}\n" && !d.timedOut, JSON.stringify(d)); fin(); });
  submit(r, job("2", "echo '{\"error\":{\"code\":\"x\"}}' >&2; exit 3", 5000, ""), noBeat, (d: Done) => { ok("stderr + exit 3", d.code === 3 && d.stderr.indexOf("{\"error\":{\"code\":\"x\"}}") === 0, JSON.stringify(d)); fin(); });
}
// 3: concurrency 2, queue 8, then busy
{
  const r = rn(2, 1000); runners.push(r); let peak = 0; let n = 0;
  for (let i = 0; i < 11; i++) {
    const id = "c" + String(i);
    const acc = submit(r, job(id, "sleep 0.3", 5000, ""), noBeat, (d: Done) => { n++; if (n === 10) { ok("peak running 2", peak === 2, String(peak)); fin(); } });
    if (r.running > peak) peak = r.running;
    if (i < 10) ok("accepted " + id, acc, String(acc)); else ok("11th is busy", !acc, String(acc));
  }
  ok("queued 8", r.queued === 8 && r.running === 2, String(r.queued) + "/" + String(r.running));
  pending++;
  const watch = setInterval(() => { if (r.running > peak) peak = r.running; if (r.running === 0 && r.queued === 0) clearInterval(watch); }, 20);
}
// FIFO: one at a time, the queue runs in submission order
{
  const r = rn(1, 1000); runners.push(r); const order: string[] = []; pending++;
  for (const id of ["f0", "f1", "f2", "f3", "f4"]) submit(r, job(id, "sleep 0.05", 5000, ""), noBeat, (d: Done) => { order.push(id); if (order.length === 5) { ok("fifo", order.join() === "f0,f1,f2,f3,f4", order.join()); fin(); } });
}
// 4: timeout: SIGTERM ignored → SIGKILL after 1 s
{
  const r = rn(2, 1000); runners.push(r); pending++; const t = now();
  submit(r, job("t", "trap '' TERM; sleep 5", 200, ""), noBeat, (d: Done) => { const el = now() - t; ok("timeout", d.timedOut && !d.cancelled && el < 1700 && el >= 1100, JSON.stringify(d) + " " + String(el) + " ms"); fin(); });
}
// 5: cancel while running (pid gone, done never called) and while queued (never spawned)
{
  const r = rn(1, 1000); runners.push(r); pending++;
  const pidFile = "/tmp/agentglass-run-check-" + String(process.pid);
  let calledRun = false; let calledQ = false;
  submit(r, job("run", "echo $$ > " + pidFile + "; exec sleep 5", 10000, ""), noBeat, (d: Done) => { calledRun = true; });
  submit(r, job("q", "echo spawned > " + pidFile + ".q", 10000, ""), noBeat, (d: Done) => { calledQ = true; });
  setTimeout(() => {
    let pid = 0; try { pid = Number(readFileSync(pidFile, "utf8").trim()); } catch (e) { pid = 0; }
    ok("cancel queued", cancel(r, "q") && r.queued === 0, String(r.queued));
    ok("cancel running", cancel(r, "run"), "");
    ok("cancel unknown", !cancel(r, "nope"), "");
    setTimeout(() => {
      ok("cancelled pid gone", pid > 0 && !alive(pid), String(pid));
      let spawned = true; try { readFileSync(pidFile + ".q", "utf8"); } catch (e) { spawned = false; }
      ok("queued never spawned", !spawned, "");
      ok("done not called", !calledRun && !calledQ, String(calledRun) + String(calledQ));
      try { unlinkSync(pidFile); } catch (e) { /* gone */ }
      fin();
    }, 1200);
  }, 300);
}
// 6: progress beats only with a token
{
  const r = rn(2, 1000); runners.push(r); pending += 2; const beats: string[] = []; let none = 0;
  submit(r, job("p", "sleep 2.3", 10000, "\"7\""), (token: string, sec: number, label: string) => { beats.push(token + ":" + String(sec) + ":" + label); }, (d: Done) => { ok("2 beats", beats.join() === "\"7\":1:agentglass x,\"7\":2:agentglass x", beats.join()); fin(); });
  submit(r, job("np", "sleep 2.3", 10000, ""), (token: string, sec: number, label: string) => { none++; }, (d: Done) => { ok("no token, no beats", none === 0, String(none)); fin(); });
}
// a missing binary: done with code -1 and the spawn error
{
  const r = newRunner({ bin: "/nonexistent/agentglass", cwd: "", env: {}, max: 2, queueMax: 8, beatMs: 1000 }); runners.push(r); pending++;
  submit(r, job("m", "", 5000, ""), noBeat, (d: Done) => { ok("missing binary", d.code === -1 && d.stderr.indexOf("spawn") >= 0, JSON.stringify(d)); fin(); });
}
// killAll: every child ends
{
  const r = rn(2, 1000); runners.push(r); pending++; let called = 0;
  submit(r, job("k1", "trap '' TERM; sleep 5", 10000, ""), noBeat, (d: Done) => { called++; });
  submit(r, job("k2", "sleep 5", 10000, ""), noBeat, (d: Done) => { called++; });
  submit(r, job("k3", "sleep 5", 10000, ""), noBeat, (d: Done) => { called++; });
  setTimeout(() => { killAll(r); setTimeout(() => { ok("killAll: none running or queued", r.running === 0 && r.queued === 0 && called === 0, String(r.running) + "/" + String(r.queued) + "/" + String(called)); fin(); }, 1300); }, 200);
}

function summary(): void {
  // 9: idle: no armed timer, nothing running
  for (const r of runners) ok("idle runner", r.timers === 0 && r.running === 0 && r.queued === 0, String(r.timers) + "/" + String(r.running) + "/" + String(r.queued));
  console.log(bad ? String(bad) + " failed" : "run: all checks passed");
  process.exit(bad ? 1 : 0);
}
setTimeout(() => { console.log("FAIL: cases still pending after 10 s: " + String(pending)); process.exit(1); }, 10000);
