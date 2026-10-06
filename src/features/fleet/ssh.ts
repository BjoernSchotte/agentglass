// agentglass — the SSH feed (fleet spec 5): one detached `ssh … agentglass fleet pull` per refresh into the spool, over a
// shared connection; the tick only stats the .rc file and reads the report a window of lines at a time
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { openSync, writeSync, closeSync, unlinkSync, renameSync, chmodSync, statSync, appendFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../../util/sha256.ts";
import { readText } from "../../util/fs.ts";
import { OS } from "../../platform/index.ts";
import { RUN_DIR, secureDir, myUid } from "../palette/rundir.ts";
import type { HostCfg, FleetCfg } from "./config.ts";
import { type HostFeed, type HostReport, type FeedState, newFeedState } from "./model.ts";
import { type Reader, type SnapReader, ensureDir, fleetDir, keyOf, spoolPath, spoolOf, mtimeOf, newReader, readStep, newSnapReader, readSnapStep, kindOf } from "./store.ts";
import { type Snap, snapLines, applySnap, fullOf } from "./snap.ts";

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
// options, "--", the destination (never starting with "-": config.ts), then the remote words, each quoted. OpenSSH parses
// options again after the destination unless "--" ended them: nothing after it is ever an option
export function sshArgs(h: HostCfg, days: number, redact: boolean, cp: string): string[] {
  const a = sshOpts(cp).concat(["--", h.ssh, q(h.agentglass), q("fleet"), q("pull"), q("--days"), q(String(days))]);
  if (redact) a.push(q("--redact"));
  return a;
}
// a snapshot request (spec 12): this viewer's id and the generation it applied last ("" = none yet: a full one)
export function snapArgs(h: HostCfg, days: number, redact: boolean, cp: string, peer: string, ack: string): string[] {
  const a = sshOpts(cp).concat(["--", h.ssh, q(h.agentglass), q("fleet"), q("snapshot"), q("--peer"), q(peer)]);
  if (ack) { a.push(q("--ack")); a.push(q(ack)); }
  a.push(q("--days")); a.push(q(String(days)));
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
  try { const tmp = path + ".w"; const fd = openSync(tmp, "w"); chmodSync(tmp, 0o600); writeSync(fd, text); closeSync(fd); renameSync(tmp, path); } catch (e) { /* the pid file is a courtesy */ }
}
function alive(pid: number): boolean { if (pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return String(e).indexOf("EPERM") >= 0; } }
// a pull another agentglass started (a CLI run next to the TUI): still running → wait for its .rc instead of a second one
function foreignRun(k: string, now: number, limitMs: number): number {
  const t = readText(spoolPath(k, "pid"), 0, 64).trim().split(" ");
  const pid = Number(t[0] ?? ""); const at = Number(t[1] ?? "");
  return pid > 0 && at > 0 && now - at < limitMs && alive(pid) ? at : 0;
}
export interface SshFeed extends HostFeed { key: string; cp: string; mode(): string }
// a host this viewer does not pull (disabled, another transport): a feed that never starts
export function idleFeed(kind: string): HostFeed { const st = newFeedState(); return { kind, start: (t: number): boolean => false, poll: (t: number): FeedState => st, stop: (): void => {} }; }
// the exact state of a snapshot host on the viewer (spec 12, T12): k.snap = one full snapshot (the state at its gen),
// k.j = the deltas applied since, appended in order. A delta is acknowledged by its gen only once it is in the journal:
// a crash before that re-asks from the older gen; a delta whose base is not the state's gen never applies (no double
// rows). The journal folds into k.snap when it passes half of it
export const JOURNAL_MIN = 1048576;
export interface SnapState { rep: HostReport | null; gen: string }
export function saveFull(k: string, rep: HostReport, gen: string): boolean {
  try {
    const tmp = spoolPath(k, "snap.tmp"); const fd = openSync(tmp, "w"); chmodSync(tmp, 0o600);
    for (const l of snapLines(fullOf(rep, gen))) writeSync(fd, l + "\n");
    closeSync(fd); renameSync(tmp, spoolPath(k, "snap"));
    try { unlinkSync(spoolPath(k, "j")); } catch (e) { /* none */ }
    return true;
  } catch (e) { return false; }
}
// a finished snapshot read from the spool: applied when full or on the state's gen; then made durable (the spool file
// becomes k.snap when full, else it is appended to the journal). false = not applied (another base: ask for a full one).
// src/len: the spool file and the bytes of it the snapshot took (a full one is copied whole, never held as a string: up
// to 17 MB; a reader of k.snap stops at its end line)
export function applyDurable(k: string, ss: SnapState, x: Snap, src: string, len: number): boolean {
  if (!x.full && x.base !== ss.gen) return false;
  ss.rep = applySnap(ss.rep, x); ss.gen = x.gen;
  try {
    if (x.full) { copyFileSync(src, spoolPath(k, "snap.tmp")); chmodSync(spoolPath(k, "snap.tmp"), 0o600); renameSync(spoolPath(k, "snap.tmp"), spoolPath(k, "snap")); try { unlinkSync(spoolPath(k, "j")); } catch (e) { /* none */ } }
    else {
      appendFileSync(spoolPath(k, "j"), readText(src, 0, len)); chmodSync(spoolPath(k, "j"), 0o600);
      const js = sizeOf(spoolPath(k, "j")); if (js > Math.max(JOURNAL_MIN, sizeOf(spoolPath(k, "snap")) / 2) && ss.rep) saveFull(k, ss.rep, ss.gen);
    }
  } catch (e) { ss.gen = ""; } // not durable: the next request asks for a full snapshot
  return true;
}
function sizeOf(p: string): number { try { return statSync(p).size; } catch (e) { return 0; } }
// one host's feed; spawn = detachedPid in production, a stub in checks; lines = how much of a new report one poll parses
// (the TUI: 256 lines, a frame's worth; 0 = all of it: a CLI run reads a report whole). peer: this machine's host id
// (snapshot hosts keep this viewer's generations under it)
export function sshFeed(h: HostCfg, f: FleetCfg, redact: boolean, now: () => number, spawn: (cmd: string, args: string[]) => number, lines: number, peer = ""): SshFeed {
  const k = keyOf(h.name, redact);
  const st: FeedState = newFeedState();
  const run = { pid: 0, at: 0, foreign: 0 };
  let rd: Reader | null = null; let cached = false; let rcAt = 0; let loaded = false;
  let mode = h.snapshot && /^[0-9a-f]{16}$/.test(peer) ? "snapshot" : "pull";
  const ss: SnapState = { rep: null, gen: "" };
  let sr: SnapReader | null = null; let srFile = ""; let boot: string[] = []; // the state's files still to load (k.snap, k.j)
  const limit = (): number => FEEDTEST.timeoutMs > 0 ? FEEDTEST.timeoutMs : f.timeoutS * 1000;
  const setErr = (s: { code: string; msg: string }): void => { st.code = s.code; st.err = s.code === "ok" ? "" : s.msg; };
  const step = (): number => lines > 0 ? lines : 1000000;
  const feed: SshFeed = {
    kind: "ssh", key: k, cp: hostControlPath(h), mode: (): string => mode,
    start(t: number): boolean {
      if (run.pid || run.foreign) return false;
      if (boot.length || (sr && srFile !== "run")) return false; // the state is still loading: its gen is the ack
      const why = ensureDir(); if (why) { st.code = "dir"; st.err = why; st.tryAt = t; return false; }
      const fa = foreignRun(k, t, limit() + 30000); if (fa) { run.foreign = fa; st.busy = true; return false; }
      const b = sshBin(); if (!b) { st.code = "nossh"; st.err = "fleet needs ssh (AGENTGLASS_SSH)"; st.tryAt = t; return false; }
      try { unlinkSync(spoolPath(k, "rc")); } catch (e) { /* none */ }
      rcAt = 0;
      const args = mode === "snapshot" ? snapArgs(h, f.days, redact, feed.cp, peer, ss.gen) : sshArgs(h, f.days, redact, feed.cp);
      const pid = spawn("sh", ["-c", SNIPPET, "sh", fleetDir(), k, b].concat(args));
      st.tryAt = t;
      if (pid <= 0) { st.code = "other"; st.err = "could not start sh"; return false; }
      run.pid = pid; run.at = t; st.busy = true;
      writeFileAtomic(spoolPath(k, "pid"), String(pid) + " " + String(t) + "\n");
      return true;
    },
    poll(t: number): FeedState {
      if (!loaded) { // the cached state first (its status stays the last run's): a snapshot host's k.snap + k.j, else the last pull report
        loaded = true; const sp = spoolOf(k); if (sp) { rcAt = sp.rcAt; if (sp.rc !== 0) setErr(statusOf(sp.rc, sp.err, h, f.timeoutS)); }
        if (mode === "snapshot" && mtimeOf(spoolPath(k, "snap"))) boot = [spoolPath(k, "snap"), spoolPath(k, "j")];
        else if (kindOf(spoolPath(k, "jsonl")) === "pull") { rd = newReader(k); cached = true; }
      }
      if (run.pid && t - run.at > limit()) {
        try { process.kill(-run.pid, "SIGTERM"); } catch (e) { try { process.kill(run.pid, "SIGTERM"); } catch (e2) { /* gone */ } } // its group: sh and ssh together
        run.pid = 0; st.busy = false; setErr(statusOf(RC_TIMEOUT, "", h, f.timeoutS));
        try { unlinkSync(spoolPath(k, "pid")); } catch (e) { /* gone */ }
        writeFileAtomic(spoolPath(k, "rc"), String(RC_TIMEOUT) + "\n"); rcAt = mtimeOf(spoolPath(k, "rc")); // fleet status reads it later
      }
      if (run.foreign && t - run.foreign > limit() + 30000) { run.foreign = 0; st.busy = false; }
      const at = boot.length ? 0 : mtimeOf(spoolPath(k, "rc"));
      if (at && at !== rcAt) {
        rcAt = at;
        const sp = spoolOf(k);
        if (run.pid) { try { unlinkSync(spoolPath(k, "pid")); } catch (e) { /* gone */ } }
        run.pid = 0; run.foreign = 0; st.busy = false;
        if (sp && sp.rc === 0) {
          const kd = kindOf(spoolPath(k, "jsonl"));
          if (kd === "snap") { sr = newSnapReader(spoolPath(k, "jsonl")); srFile = "run"; rd = null; }
          else { rd = newReader(k); cached = false; sr = null; }
        } else if (sp) {
          const s = statusOf(sp.rc, sp.err, h, f.timeoutS);
          // an agentglass without fleet snapshot (or a serve that allows only pull): the pull for the rest of this run
          if (mode === "snapshot" && (s.code === "old" || (s.code === "refused" && /only fleet pull and --version/.test(sp.err)))) {
            mode = "pull"; setErr({ code: "old", msg: "agentglass on " + h.name + " has no fleet snapshot: update it there for an exact merge (pulling meanwhile)" });
            feed.start(t); // the pull right away, as part of this refresh
          }
          else setErr(s);
        }
      }
      // the state's files at start, then a run's snapshot: one snapshot per step, a window of lines each
      if (!sr && boot.length) { const p = boot.shift() ?? ""; sr = newSnapReader(p); srFile = p.endsWith(".snap") ? "snap" : "j"; }
      if (sr) {
        const r = readSnapStep(sr, step());
        if (r) {
          if (srFile === "run") {
            if (applyDurable(k, ss, r, sr.path, sr.off)) { st.report = ss.rep; st.okAt = sr.at; setErr({ code: "ok", msg: "ok" }); }
            else { ss.gen = ""; setErr({ code: "cut", msg: "snapshot on another generation: asking for a full one" }); }
            sr = null;
          } else if (srFile === "snap") { ss.rep = applySnap(null, r); ss.gen = r.gen; st.report = ss.rep; st.okAt = sr.at; if (!st.code) setErr({ code: "ok", msg: "ok" }); } // the cached state; its status stays the last run's
          else if (!r.full && r.base === ss.gen) { ss.rep = applySnap(ss.rep, r); ss.gen = r.gen; st.report = ss.rep; st.okAt = mtimeOf(spoolPath(k, "j")); }
        } else if (r === null) {
          if (srFile === "run" && sr.p.err && sr.p.err !== "") { const e = sr.p.err; setErr(e.startsWith("newer format") ? parseStatus(e, h) : { code: "cut", msg: "incomplete snapshot (connection cut)" }); }
          sr = null;
        }
        if (lines <= 0 && (sr || boot.length)) return feed.poll(t); // a CLI run reads it whole
      }
      if (rd) {
        let r = readStep(rd, step());
        while (lines <= 0 && r === undefined) r = readStep(rd, 1000000);
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
