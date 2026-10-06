// agentglass — the SSH feed (fleet spec 5): one detached `ssh … agentglass fleet pull` per refresh into the spool, over a
// shared connection; the tick only stats the .rc file and reads the report a window of lines at a time
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { openSync, writeSync, closeSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../util/sha256.ts";
import { readText } from "../../util/fs.ts";
import { OS } from "../../platform/index.ts";
import { RUN_DIR, secureDir, myUid } from "../palette/rundir.ts";
import type { HostCfg, FleetCfg } from "./config.ts";
import { type HostFeed, type FeedState, newFeedState } from "./model.ts";
import { type Reader, ensureDir, fleetDir, keyOf, spoolPath, spoolOf, mtimeOf, newReader, readStep } from "./store.ts";

// the probe result is cached per configured command (a changed $AGENTGLASS_SSH is probed again)
let binFor = "\u0000"; let bin = "";
export function sshBin(): string {
  const env = process.env["AGENTGLASS_SSH"];
  const want = env !== undefined && env.trim() ? env.trim() : "ssh";
  if (want === binFor) return bin;
  binFor = want;
  try { execFileSync(want, ["-V"], { stdio: ["ignore", "ignore", "pipe"], timeout: 3000 }); bin = want; } catch (e) { bin = ""; }
  return bin;
}
// one remote word for the remote shell: single-quoted; a leading ~/ stays outside so the remote shell expands it
export function q(w: string): string {
  if (w.startsWith("~/")) return "~/" + q(w.slice(2));
  return "'" + w.split("'").join("'\\''") + "'";
}
// ssh refuses a ControlPath of 108+ bytes and adds a 17-character temp suffix while it creates the socket (measured)
const CP_MAX = 107; const CP_SUFFIX = 17;
// <run dir>/f-<12 hex of the destination>; "" = sharing off (the path would be too long)
export function controlPath(runDir: string, target: string): string {
  const p = join(runDir, "f-" + sha256Hex(target).slice(0, 12));
  return new TextEncoder().encode(p).length + CP_SUFFIX > CP_MAX ? "" : p;
}
// the run directory is ours and owner-only (checked once): else no shared connections (a socket there would be exposed)
const RUN = { checked: false, ok: false };
export function sharingDir(): string {
  if (!RUN.checked) { RUN.checked = true; RUN.ok = secureDir(RUN_DIR, myUid(), OS.fileInfo, true) === ""; }
  return RUN.ok ? RUN_DIR : "";
}
export function hostControlPath(h: HostCfg): string { const d = sharingDir(); return d ? controlPath(d, h.ssh) : ""; }
export function sshOpts(cp: string): string[] {
  const o = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "Compression=yes"];
  return cp ? o.concat(["-o", "ControlMaster=auto", "-o", "ControlPath=" + cp, "-o", "ControlPersist=600"]) : o;
}
// options, then the destination (never starting with "-": config.ts), then the remote words, each quoted
export function sshArgs(h: HostCfg, days: number, redact: boolean, cp: string): string[] {
  const a = sshOpts(cp).concat([h.ssh, q(h.agentglass), q("fleet"), q("pull"), q("--days"), q(String(days))]);
  if (redact) a.push(q("--redact"));
  return a;
}
// the fixed snippet a pull runs in (paths and argv as positional parameters: nothing from config is ever parsed by sh).
// A report without its end line (a cut connection that still exited 0) is not moved over the last good one: rc 86
export const RC_CUT = 86;
export const SNIPPET = [
  "umask 077",
  "d=$1; k=$2; shift 2",
  "\"$@\" > \"$d/$k.tmp\" 2> \"$d/$k.err\"; rc=$?",
  "[ \"$rc\" = 0 ] && { tail -n 1 \"$d/$k.tmp\" | grep -q '^{\"end\"' || rc=" + String(RC_CUT) + "; }",
  "[ \"$rc\" = 0 ] && mv -f \"$d/$k.tmp\" \"$d/$k.jsonl\"",
  "echo \"$rc\" > \"$d/$k.rc.tmp\" && mv -f \"$d/$k.rc.tmp\" \"$d/$k.rc\"",
].join("\n");
export const RC_TIMEOUT = -1;
// an exit code and the first stderr line → a status code and the message fleet status and the TUI show
export function statusOf(rc: number, err: string, h: HostCfg, timeoutS: number): { code: string; msg: string } {
  if (rc === 0) return { code: "ok", msg: "ok" };
  if (rc === RC_TIMEOUT) return { code: "timeout", msg: "timed out after " + String(timeoutS) + " s (the first pull indexes the host's history; try again)" };
  if (rc === 255) {
    const e = err || "ssh failed (exit 255)";
    return { code: "ssh", msg: /Permission denied|passphrase|password/i.test(e) ? e + " — ssh needs a key without a prompt, or ssh-agent" : e };
  }
  if (rc === 127) return { code: "missing", msg: "agentglass not found on " + h.name + ": set fleet.hosts[].agentglass" + (err ? " (" + err + ")" : "") };
  if (rc === 126) return { code: "refused", msg: "refused by fleet serve on " + h.name + (err ? ": " + err : "") };
  if ((rc === 2 && /unknown (fleet )?command/.test(err)) || (rc === 1 && /needs an interactive terminal/.test(err)))
    return { code: "old", msg: "agentglass on " + h.name + " is older than fleet: update it there" };
  if (rc === RC_CUT) return { code: "cut", msg: "incomplete report (connection cut)" };
  return { code: "other", msg: "exit " + String(rc) + (err ? ": " + err : "") };
}
// a report parse error → status (a newer format is the viewer's problem)
export function parseStatus(err: string, h: HostCfg): { code: string; msg: string } {
  if (err.startsWith("newer format")) return { code: "newer", msg: h.name + " runs a newer agentglass (" + err.slice(13) + "): update this one" };
  if (err === "no report") return { code: "none", msg: "no report yet" };
  return { code: "cut", msg: err === "incomplete report" ? "incomplete report (connection cut)" : err };
}
export const FEEDTEST = { timeoutMs: 0 }; // checks: a short timeout
function writeFileAtomic(path: string, text: string): void {
  try { const tmp = path + ".w"; const fd = openSync(tmp, "w"); writeSync(fd, text); closeSync(fd); renameSync(tmp, path); } catch (e) { /* the pid file is a courtesy */ }
}
function alive(pid: number): boolean { if (pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return String(e).indexOf("EPERM") >= 0; } }
// a pull another agentglass started (a CLI run next to the TUI): still running → wait for its .rc instead of a second one
function foreignRun(k: string, now: number, limitMs: number): number {
  const t = readText(spoolPath(k, "pid"), 0, 64).trim().split(" ");
  const pid = Number(t[0] ?? ""); const at = Number(t[1] ?? "");
  return pid > 0 && at > 0 && now - at < limitMs && alive(pid) ? at : 0;
}
export interface SshFeed extends HostFeed { key: string; cp: string }
// one host's feed; spawn = detachedPid in production, a stub in checks
export function sshFeed(h: HostCfg, f: FleetCfg, redact: boolean, now: () => number, spawn: (cmd: string, args: string[]) => number): SshFeed {
  const k = keyOf(h.name, redact);
  const st: FeedState = newFeedState();
  const run = { pid: 0, at: 0, foreign: 0 };
  let rd: Reader | null = null; let cached = false; let rcAt = 0; let loaded = false;
  const limit = (): number => FEEDTEST.timeoutMs > 0 ? FEEDTEST.timeoutMs : f.timeoutS * 1000;
  const setErr = (s: { code: string; msg: string }): void => { st.code = s.code; st.err = s.code === "ok" ? "" : s.msg; };
  const feed: SshFeed = {
    kind: "ssh", key: k, cp: hostControlPath(h),
    start(t: number): boolean {
      if (run.pid || run.foreign) return false;
      const why = ensureDir(); if (why) { st.code = "dir"; st.err = why; st.tryAt = t; return false; }
      const fa = foreignRun(k, t, limit() + 30000); if (fa) { run.foreign = fa; st.busy = true; return false; }
      const b = sshBin(); if (!b) { st.code = "nossh"; st.err = "fleet needs ssh (AGENTGLASS_SSH)"; st.tryAt = t; return false; }
      try { unlinkSync(spoolPath(k, "rc")); } catch (e) { /* none */ }
      rcAt = 0;
      const pid = spawn("sh", ["-c", SNIPPET, "sh", fleetDir(), k, b].concat(sshArgs(h, f.days, redact, feed.cp)));
      st.tryAt = t;
      if (pid <= 0) { st.code = "other"; st.err = "could not start sh"; return false; }
      run.pid = pid; run.at = t; st.busy = true;
      writeFileAtomic(spoolPath(k, "pid"), String(pid) + " " + String(t) + "\n");
      return true;
    },
    poll(t: number): FeedState {
      if (!loaded) { loaded = true; const sp = spoolOf(k); if (sp) { rcAt = sp.rcAt; if (sp.rc !== 0) setErr(statusOf(sp.rc, sp.err, h, f.timeoutS)); } if (mtimeOf(spoolPath(k, "jsonl"))) { rd = newReader(k); cached = true; } } // the cached report first (its status stays the last run's)
      if (run.pid && t - run.at > limit()) {
        try { process.kill(-run.pid, "SIGTERM"); } catch (e) { try { process.kill(run.pid, "SIGTERM"); } catch (e2) { /* gone */ } } // its group: sh and ssh together
        run.pid = 0; st.busy = false; setErr(statusOf(RC_TIMEOUT, "", h, f.timeoutS));
        try { unlinkSync(spoolPath(k, "pid")); } catch (e) { /* gone */ }
      }
      if (run.foreign && t - run.foreign > limit() + 30000) { run.foreign = 0; st.busy = false; }
      const at = mtimeOf(spoolPath(k, "rc"));
      if (at && at !== rcAt) {
        rcAt = at;
        const sp = spoolOf(k);
        if (run.pid) { try { unlinkSync(spoolPath(k, "pid")); } catch (e) { /* gone */ } }
        run.pid = 0; run.foreign = 0; st.busy = false;
        if (sp && sp.rc === 0) { rd = newReader(k); cached = false; } else if (sp) setErr(statusOf(sp.rc, sp.err, h, f.timeoutS));
      }
      if (rd) {
        const r = readStep(rd, 256);
        if (r !== undefined) {
          const okAt = rd.at; const perr = rd.p.err; const fromCache = cached; rd = null; cached = false;
          if (r) { st.report = r; st.okAt = okAt; if (!fromCache || !st.code) setErr({ code: "ok", msg: "ok" }); }
          else if (perr !== "no report") setErr(parseStatus(perr, h));
        }
      }
      return st;
    },
    stop(): void {
      if (!run.pid) return;
      try { process.kill(-run.pid, "SIGTERM"); } catch (e) { try { process.kill(run.pid, "SIGTERM"); } catch (e2) { /* gone */ } }
      run.pid = 0; st.busy = false;
      try { unlinkSync(spoolPath(k, "pid")); } catch (e) { /* gone */ }
    },
  };
  return feed;
}
