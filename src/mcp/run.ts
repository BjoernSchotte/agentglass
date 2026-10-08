// agentglass-mcp — the child runner: one `agentglass` CLI child per tool call, at most `max` at once and `queueMax`
// waiting (FIFO, then busy), with a timeout (SIGTERM, SIGKILL 1 s later), cancellation and progress heartbeats.
// No timer is armed while nothing runs: an idle server costs no CPU.
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

// a copy of agentenv.ts SESSION_VARS (src/mcp imports no feature module; agentenv.check.ts pins both lists)
export const SESSION_VARS: string[] = ["CLAUDE_CODE_SESSION_ID", "OPENCODE_SESSION_ID", "CODEX_THREAD_ID", "KIRO_SESSION_ID", "PI_SESSION_ID"];
// progress: the progressToken as JSON text ("" = none); label: the heartbeat's message ("agentglass <cmd>")
export interface Job { id: string; argv: string[]; keepSession: boolean; timeoutMs: number; progress: string; label: string }
// code -1: no exit code (killed by a signal, or the binary could not be started: stderr says "spawn …"); tooBig: the
// child printed more than MAX_OUT and was killed (a wide page: many fields × a deep cursor)
export interface Done { code: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; tooBig: boolean; ms: number }
// what one child may print before it is killed: the server holds its output until the child ends (stderr: the tail)
export const MAX_OUT = 32 * 1024 * 1024;
const MAX_ERR = 64 * 1024;
export interface RunCfg { bin: string; cwd: string; env: Record<string, string>; max: number; queueMax: number; beatMs: number }
type Beat = (token: string, sec: number, label: string) => void;
type Fin = (d: Done) => void;
interface Wait { j: Job; beat: Beat; done: Fin }
// one running child: its kill and its timers (handles kept to clear them; armed counts them in Runner.timers)
interface Act { j: Job; kill: (sig: string) => void; pid: number; cancelled: boolean; timedOut: boolean; tooBig: boolean; tmo: ReturnType<typeof setTimeout> | null; esc: ReturnType<typeof setTimeout> | null; beat: ReturnType<typeof setInterval> | null }
// timers: armed timers (timeouts, beats, kill escalations), so a check can assert 0 when idle
export interface Runner { cfg: RunCfg; running: number; queued: number; timers: number; q: Wait[]; act: Act[] }
export function newRunner(cfg: RunCfg): Runner { return { cfg, running: 0, queued: 0, timers: 0, q: [], act: [] }; }

type Env = Record<string, string | undefined>;
// the child's env: agent mode forced (hosts may filter the env down to no harness marker), no colors, and without the
// session id variables unless asked: a nested host passes on the outer agent's id, and a long-lived server's env goes
// stale after /clear — the child's process ancestry names the caller instead
export function childEnv(env: Record<string, string>, keepSession: boolean): Record<string, string> {
  const o: Record<string, string> = {}; const src: Env = env;
  for (const k of Object.keys(env)) { if (!keepSession && SESSION_VARS.indexOf(k) >= 0) continue; const v = src[k]; if (v !== undefined) o[k] = v; }
  o["AGENTGLASS_AGENT"] = "1"; o["NO_COLOR"] = "1";
  return o;
}
// AGENTGLASS_MCP_BIN (tests), else the agentglass beside this binary
export function cliBin(execPath: string, env: Record<string, string>): string {
  const e: Env = env; const b = e["AGENTGLASS_MCP_BIN"] ?? "";
  if (b) return b;
  const i = execPath.lastIndexOf("/");
  return (i >= 0 ? execPath.slice(0, i + 1) : "") + "agentglass";
}
// "" when the server was started in $HOME or / (no project there: main.ts resolves the calling session's cwd once).
// Both compared as real paths: process.cwd() is one, $HOME may not be (macOS: /var/… is /private/var/…)
export function childCwd(cwd: string, home: string): string {
  const t = (p: string): string => { let r = p; try { r = p ? realpathSync(p) : p; } catch (e) { r = p; } return r.length > 1 && r.endsWith("/") ? r.slice(0, -1) : r; };
  const c = t(cwd);
  return c === "/" || c === "" || c === t(home) ? "" : c;
}

function clear(r: Runner, a: Act): void {
  if (a.tmo !== null) { clearTimeout(a.tmo); a.tmo = null; r.timers--; }
  if (a.esc !== null) { clearTimeout(a.esc); a.esc = null; r.timers--; }
  if (a.beat !== null) { clearInterval(a.beat); a.beat = null; r.timers--; }
}
// SIGTERM now, SIGKILL in 1 s if it is still there (cleared on close)
function stop(r: Runner, a: Act): void {
  a.kill("SIGTERM");
  if (a.esc === null) { r.timers++; a.esc = setTimeout(() => { a.esc = null; r.timers--; a.kill("SIGKILL"); }, 1000); }
}
function start(r: Runner, w: Wait): void {
  const j = w.j; const t0 = Date.now();
  const out: Uint8Array[] = []; const err: Uint8Array[] = []; let outN = 0; let errN = 0;
  let ended = false;
  const a: Act = { j, kill: (sig: string): void => { /* replaced below */ }, pid: 0, cancelled: false, timedOut: false, tooBig: false, tmo: null, esc: null, beat: null };
  r.running++; r.act.push(a);
  const end = (code: number, spawnErr: string): void => {
    if (ended) return; ended = true;
    clear(r, a); r.running--;
    const i = r.act.indexOf(a); if (i >= 0) r.act.splice(i, 1);
    if (!a.cancelled) w.done({ code, stdout: text(out), stderr: spawnErr || text(err), timedOut: a.timedOut, cancelled: false, tooBig: a.tooBig, ms: Date.now() - t0 });
    pump(r);
  };
  try {
    const env = childEnv(r.cfg.env, j.keepSession);
    const ch = r.cfg.cwd ? spawn(r.cfg.bin, j.argv, { stdio: ["ignore", "pipe", "pipe"], env, cwd: r.cfg.cwd, detached: true }) : spawn(r.cfg.bin, j.argv, { stdio: ["ignore", "pipe", "pipe"], env, detached: true });
    a.pid = ch.pid ?? 0;
    // detached: the child leads its own process group, so a kill reaches what it started too (a grandchild holding the
    // pipes open would otherwise delay "close" past the kill)
    a.kill = (sig: string): void => { try { process.kill(-a.pid, sig); } catch (e) { try { ch.kill(sig); } catch (e2) { /* already gone */ } } };
    const so = ch.stdout; const se = ch.stderr;
    if (so) so.on("data", (d: Uint8Array) => {
      if (a.tooBig) return;
      outN += d.length; if (outN <= MAX_OUT) { out.push(d); return; }
      a.tooBig = true; out.length = 0; stop(r, a); // kept nothing: the answer is the too_large error
    });
    if (se) se.on("data", (d: Uint8Array) => { err.push(d); errN += d.length; while (errN > MAX_ERR && err.length > 1) errN -= (err.shift() as Uint8Array).length; });
    // "close" comes after all output (the probe saw "exit" first)
    ch.on("close", (code: number | null) => { end(code === null ? -1 : code, ""); });
    ch.on("error", (e: Error) => { end(-1, "spawn " + r.cfg.bin + ": " + String(e)); });
  } catch (e) { end(-1, "spawn " + r.cfg.bin + ": " + String(e)); return; }
  if (ended) return;
  r.timers++; a.tmo = setTimeout(() => { a.tmo = null; r.timers--; a.timedOut = true; stop(r, a); }, j.timeoutMs);
  if (j.progress) {
    let sec = 0; const step = Math.max(1, Math.round(r.cfg.beatMs / 1000));
    r.timers++; a.beat = setInterval(() => { sec += step; w.beat(j.progress, sec, j.label); }, r.cfg.beatMs);
  }
}
function text(parts: Uint8Array[]): string {
  let n = 0; for (let i = 0; i < parts.length; i++) n += (parts[i] as Uint8Array).length;
  const b = new Uint8Array(n); let at = 0;
  for (let i = 0; i < parts.length; i++) { const p = parts[i] as Uint8Array; b.set(p, at); at += p.length; }
  return new TextDecoder("utf-8").decode(b);
}
function pump(r: Runner): void {
  while (r.running < r.cfg.max && r.q.length) { const w = r.q.shift() as Wait; r.queued--; start(r, w); }
}
// false = busy: max running and queueMax waiting
export function submit(r: Runner, j: Job, onProgress: (token: string, sec: number, label: string) => void, done: (d: Done) => void): boolean {
  const w: Wait = { j, beat: onProgress, done };
  if (r.running < r.cfg.max) { start(r, w); return true; }
  if (r.queued >= r.cfg.queueMax) return false;
  r.q.push(w); r.queued++;
  return true;
}
// a queued job is dropped, a running one killed; done is never called for either (no response for a cancelled request)
export function cancel(r: Runner, id: string): boolean {
  for (let i = 0; i < r.q.length; i++) if ((r.q[i] as Wait).j.id === id) { r.q.splice(i, 1); r.queued--; return true; }
  for (const a of r.act) if (a.j.id === id && !a.cancelled) { a.cancelled = true; stop(r, a); return true; }
  return false;
}
// shutdown: the queue dropped, every child SIGTERM, SIGKILL 1 s later
export function killAll(r: Runner): void {
  r.q = []; r.queued = 0;
  for (const a of r.act) { a.cancelled = true; stop(r, a); }
}
