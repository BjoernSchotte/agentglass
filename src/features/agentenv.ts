// agentglass — agent mode: is agentglass run by a coding agent (flags, env markers), and which session is "current"
// SPDX-License-Identifier: Apache-2.0
// Inside an agent the CLI never starts the TUI, never prompts, prints compact JSON and reports errors as one JSON line.
import { writeSync, realpathSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Proc, Sess } from "../model/types.ts";
import { type Obj, str } from "../util/json.ts";
import { section } from "../util/config.ts";
import { sessions, parentOf, loadHead } from "../model/sessions.ts";
import { allProcs } from "../model/procs.ts";
import { S, say } from "../state.ts";
import { realCwd } from "../hooks.ts";

// via: "flag", "env:<NAME>", "ancestor:pid N", "env:<NAME>+ancestor:pid N" or ""
export interface AgentHost { on: boolean; harness: string; session: string; via: string }
// harness-specific markers first: a nested agent inherits the outer one's generic AI_AGENT (codex run from Claude Code)
export const MARKERS: string[] = ["CLAUDECODE", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_CI", "CODEX_THREAD_ID", "GEMINI_CLI",
  "PI_CODING_AGENT", "OPENCODE", "OPENCODE_SESSION_ID", "KIRO_SESSION_ID", "AI_AGENT"];
// PI_SESSION_ID: seen in pi's shell tool env (2026-10-03), = its session file's id
export const SESSION_VARS: string[] = ["CLAUDE_CODE_SESSION_ID", "OPENCODE_SESSION_ID", "CODEX_THREAD_ID", "KIRO_SESSION_ID", "PI_SESSION_ID"];
const VAR_HARNESS = ["claude", "opencode", "codex", "kiro", "pi"]; // harness of SESSION_VARS[i]

function markerHarness(name: string, v: string): string {
  if (name === "CLAUDECODE") return "claude";
  if (name.startsWith("CODEX_")) return "codex";
  if (name === "GEMINI_CLI") return "gemini";
  if (name === "PI_CODING_AGENT") return "pi";
  if (name.startsWith("OPENCODE")) return "opencode";
  if (name === "KIRO_SESSION_ID") return "kiro";
  if (v.startsWith("claude-code")) return "claude"; // AI_AGENT
  return v === "pi" || v === "opencode" ? v : "";
}
// a missing key of a Record<string, string> traps in scriptc: read through the optional view
type Env = Record<string, string | undefined>;
function get(env: Env, k: string): string { return env[k] ?? ""; }
// pure: precedence --no-agent / AGENTGLASS_AGENT=0 > --agent / AGENTGLASS_AGENT=1 > the first env marker; a plain AGENT=1 never counts
export function detectHost(env0: Record<string, string>, args: string[]): AgentHost {
  const env: Env = env0;
  const off: AgentHost = { on: false, harness: "", session: "", via: "" };
  const forced = get(env, "AGENTGLASS_AGENT");
  if (args.indexOf("--no-agent") >= 0 || forced === "0") return off;
  let harness = ""; let via = "";
  for (const m of MARKERS) if (get(env, m)) { harness = markerHarness(m, get(env, m)); via = "env:" + m; break; }
  if (args.indexOf("--agent") >= 0 || forced === "1") via = "flag";
  if (!via) return off;
  let session = "";
  for (let i = 0; i < SESSION_VARS.length; i++) if ((VAR_HARNESS[i] ?? "") === harness && get(env, SESSION_VARS[i] ?? "")) session = get(env, SESSION_VARS[i] ?? "");
  if (!session) for (const k of SESSION_VARS) if (get(env, k)) { session = get(env, k); break; }
  return { on: true, harness, session, via };
}
// the variable a session id came from (for via / warnings)
export function sessionVar(env0: Record<string, string>, id: string): string { const env: Env = env0; for (const k of SESSION_VARS) if (id && get(env, k) === id) return k; return ""; }

export interface Anc { harness: string; session: string; pid: number; steps: number }
// walk ppid up from pid (≤ 64 steps, cycles stop): the first harness process names the harness, the first linked process
// of that agent's process group (wrapper → binary) the session; leaving the group stops the search, so an agent whose
// session is not written yet never borrows an outer agent's session
export function ancestry(pid: number, procs: Map<number, Proc>, sessOf: (p: Proc) => string): Anc {
  const r: Anc = { harness: "", session: "", pid: 0, steps: 0 };
  const seen = new Set<number>();
  let p = procs.get(pid);
  while (p && r.steps < 64 && !seen.has(p.pid)) {
    seen.add(p.pid); r.steps++;
    if (p.h) {
      if (!r.harness) { r.harness = p.h; r.pid = p.pid; }
      const s = sessOf(p);
      if (s) { r.session = s; r.pid = p.pid; return r; }
    } else if (r.harness) return r;
    p = procs.get(p.ppid);
  }
  return r;
}

function envMap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const k of Object.keys(process.env)) { const v = process.env[k]; if (v !== undefined) m[k] = v; }
  return m;
}
let host: AgentHost | null = null;
export function agentHost(): AgentHost { if (!host) setHost(detectHost(envMap(), process.argv.slice(2))); return host as AgentHost; }
export function setHost(h: AgentHost): void { host = h; S.cliJson = h.on; } // checks set it directly
// a human can answer a prompt: a terminal on stdin and no agent around
export function interactive(): boolean { return process.stdin.isTTY === true && !agentHost().on; }

export interface Current { s: Sess | null; via: string; code: string; hint: string }
function byId(id: string): Sess | null { for (const s of sessions.values()) if (s.id === id) return s; return null; }
function top(s: Sess): Sess { let r = s; for (let i = 0; i < 8 && r.parent; i++) { const p = parentOf(r); if (!p) break; r = p; } return r; }
// "current" from an env session id and the process tree; procs empty = ps unavailable (sandboxed shells): env ids only
export function currentFrom(h: AgentHost, envVar: string, procs: Map<number, Proc>, pid: number, root: boolean, quiet = false): Current {
  const warn = (m: string): void => { if (!quiet) say("warn", m); };
  const fin = (s: Sess, via: string): Current => ({ s: root ? top(s) : s, via, code: "", hint: "" });
  const envS = h.session ? byId(h.session) : null;
  if (!procs.size) {
    if (envS) return fin(envS, "env:" + envVar);
    warn("process list unavailable: only the session id from the environment can name the current session");
  }
  if (h.session && !envS) warn("session id from " + envVar + " not found, using the process tree");
  const a = procs.size ? ancestry(pid, procs, (p: Proc): string => p.sess) : { harness: "", session: "", pid: 0, steps: 0 };
  const as = a.session ? sessions.get(a.session) ?? null : null;
  if (envS && (!a.harness || a.harness === envS.h)) return fin(envS, "env:" + envVar);
  if (as) return fin(as, (envS ? "env:" + envVar + "+" : "") + "ancestor:pid " + String(a.pid));
  if (a.harness) return { s: null, via: "ancestor:pid " + String(a.pid), code: "no_current_session", hint: "session not written yet (or not linked to this " + a.harness + " process: pass its id)" };
  return { s: null, via: "", code: "no_current_session", hint: "pass a session id or use 'last'" };
}
// needs discover() first (sessions scanned, processes listed and linked); quiet = no warnings (current is only a side note)
export function currentSession(root: boolean, quiet = false): Current {
  const h = agentHost();
  return currentFrom(h, sessionVar(envMap(), h.session), allProcs, process.pid, root, quiet);
}

// "30s", "2m", "1h", "500ms" → ms; anything else -1
export function parseDur(s: string): number {
  const m = /^(\d+)(ms|s|m|h)$/.exec(s);
  if (!m) return -1;
  const n = Number(m[1] ?? "0"); const u = m[2] ?? "";
  return u === "ms" ? n : u === "s" ? n * 1000 : u === "m" ? n * 60000 : n * 3600000;
}

// a CLI failure on stderr: inside an agent one JSON line {"error":{code,message,hint?}}, else "<who>: msg" (+ hint)
export function errLine(who: string, code: string, msg: string, hint: string): void {
  let line = "";
  if (agentHost().on) {
    const e: Obj = { code, message: msg };
    if (hint) e["hint"] = hint;
    line = JSON.stringify({ error: e }) + "\n";
  } else line = who + ": " + msg + (hint ? "\n  hint: " + hint : "") + "\n";
  try { writeSync(2, line); } catch (e) { /* stderr closed */ }
}
// …and exit (stdout stays empty)
export function cliError(code: string, msg: string, hint: string, exit: number): never { errLine("agentglass", code, msg, hint); process.exit(exit); }

// ── agent-mode scope: what an agent may see (its output goes to the agent's model provider) ──
export interface Scope { name: string; key: string; cwd: string; warn: string }
export function realDir(d: string): string { try { return realpathSync(d); } catch (e) { return d; } }
// TODO(filter-language): replace with projectOf() (repo-view's Ident later); until then the nearest directory holding .git, else the path
const keys = new Map<string, string>();
export function projectKey(dir: string): string {
  if (!dir) return "";
  const hit = keys.get(dir); if (hit !== undefined) return hit;
  const r = realDir(dir); let d = r; let k = "";
  for (let i = 0; i < 64 && !k; i++) { if (existsSync(d + "/.git")) k = "git:" + d; else { const up = dirname(d); if (up === d) break; d = up; } }
  if (!k) k = "path:" + r;
  keys.set(dir, k);
  return k;
}
// pure: agent mode off → everything; on → config agent.scope (project default | all), --all-projects / --project-only win
export function scopeOf(on: boolean, args: string[], cfg: string, cwd: string): Scope {
  const real = realDir(cwd);
  let name = on ? "project" : "all"; let warn = "";
  if (on && cfg === "all") name = "all";
  else if (on && cfg && cfg !== "project") warn = "config agent.scope must be \"project\" or \"all\" — using project";
  if (args.indexOf("--all-projects") >= 0) name = "all";
  else if (args.indexOf("--project-only") >= 0) name = "project";
  return { name, key: name === "project" ? projectKey(real) : "", cwd: real, warn };
}
let scope0: Scope | null = null;
export function agentScope(args: string[]): Scope {
  if (!scope0) { const c = section("agent")["scope"]; scope0 = scopeOf(agentHost().on, args, c === undefined ? "" : str(c) || String(c), process.cwd()); if (scope0.warn) say("warn", scope0.warn); }
  return scope0;
}
export function inScope(s: Sess, sc: Scope): boolean { return sc.name === "all" || projectKey(realCwd(s)) === sc.key; }
// inScope, reading the log's head first when the cwd is not known yet (it comes from the log)
export function visible(s: Sess, sc: Scope): boolean { if (sc.name === "all") return true; if (!s.headDone || !s.cwd) loadHead(s); return inScope(s, sc); }
// agentMode in the JSON help: full adds on + via
export function hostObj(full: boolean): Obj {
  const h = agentHost(); const sc = agentScope(process.argv.slice(2));
  return full ? { on: h.on, harness: h.harness, session: h.session, via: h.via, scope: sc.name } : { harness: h.harness, session: h.session, scope: sc.name };
}
