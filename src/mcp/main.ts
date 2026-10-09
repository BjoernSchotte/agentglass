// agentglass-mcp — agentglass as MCP tools for coding agents: a small stdio JSON-RPC server, one per agent session.
// It holds no ledger: each tools/call runs one `agentglass` CLI child in agent mode (src/mcp/run.ts) and shapes its
// contract-1 JSON (shape.ts). Idle it arms no timer and reads nothing (spec mcp-server §1).
// SPDX-License-Identifier: Apache-2.0
import { writeSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { BUILD } from "../build-info.ts";
import { type Obj, obj, str } from "../util/json.ts";
import { newFramer, push, parse, ok, fail, note, newConn, answer, structured, type Msg } from "./rpc.ts";
import { parseOpts, toolsList, plan, instructionsFor, type Call } from "./tools.ts";
import { shapeExit, errorShaped, type Shaped } from "./shape.ts";
import { SESSION_VARS, MAX_OUT, newRunner, submit, cancel, killAll, cliBin, childCwd, type Done } from "./run.ts";

const HELP = `agentglass-mcp — agentglass as MCP tools for coding agents (stdio; one server per agent session)

usage: agentglass-mcp [--all-projects] [--content] [--redact] [--max-bytes N] [--timeout S] [--log]

  --all-projects  every project's sessions (default: the project the agent runs in)
  --content       include transcript content: tool results, later prompts, assistant
                  text (default: off; output goes to the agent's model provider)
  --redact        privacy mode in every answer (also AGENTGLASS_REDACT=1)
  --max-bytes N   size cap of one answer, 4000-200000 (default 24000)
  --timeout S     seconds one call may take, 5-600 (default 50)
  --log           diagnostics on stderr (also AGENTGLASS_MCP_LOG=1)
  --version, --help

Tools: session sessions errors cost triage compare related events contention waits
fleet prices. Each call runs one agentglass CLI child (the agentglass beside this binary).
Register it with your agents: agentglass mcp install. Check it: agentglass mcp doctor.
`;

type Env = Record<string, string | undefined>;
function envMap(): Record<string, string> {
  const m: Record<string, string> = {};
  for (const k of Object.keys(process.env)) { const v = process.env[k]; if (v !== undefined) m[k] = v; }
  return m;
}
const env = envMap(); const ev: Env = env;
const po = parseOpts(process.argv.slice(2));
function errOut(s: string): void { try { writeSync(2, s); } catch (e) { /* stderr closed */ } }
if (po.err) { errOut("agentglass-mcp: " + po.err + " (agentglass-mcp --help)\n"); process.exit(2); }
if (po.help) { try { writeSync(1, HELP); } catch (e) { /* closed */ } process.exit(0); }
if (po.version) { try { writeSync(1, BUILD.version + "\n"); } catch (e) { /* closed */ } process.exit(0); }
const o = po.o;
const on = (v: string): boolean => v !== "" && v !== "0";
if (on(ev["AGENTGLASS_REDACT"] ?? "")) o.redact = true;
const logOn = o.log || on(ev["AGENTGLASS_MCP_LOG"] ?? "");
function log(m: string): void { if (logOn) errOut("agentglass-mcp: " + m + "\n"); }

// the scope the children will use: --all-projects, or the config's agent.scope "all" (read here as the CLI reads it)
function configScope(): string {
  const f = ev["AGENTGLASS_CONFIG"] || (ev["HOME"] ?? "") + "/.agentglass/config.json";
  try { const c = obj(JSON.parse(readFileSync(f, "utf8"))); const a = c ? obj(c["agent"]) : null; return a ? str(a["scope"]) : ""; } catch (e) { return ""; }
}
const allScope = o.allProjects || configScope() === "all";
const scope = allScope ? "all" : "project";
const conn = newConn(); conn.redact = o.redact; conn.scopeName = allScope ? "all projects" : "project";
const hadSessionVar = SESSION_VARS.some((k: string) => (ev[k] ?? "") !== "");
const bin = cliBin(process.execPath, env);
const startCwd = childCwd(process.cwd(), ev["HOME"] ?? "");
const R = newRunner({ bin, cwd: startCwd, env, max: 2, queueMax: 8, beatMs: 2000 });

// ── output: JSON-RPC only, one line each; a closed stdout ends the server ──
let closing = false;
function send(line: string): void {
  if (closing) return;
  const b = new TextEncoder().encode(line + "\n"); let at = 0;
  for (let tries = 0; at < b.length && tries < 100000; tries++) {
    try { at += writeSync(1, b.subarray(at)); } catch (e) {
      if (String(e).indexOf("EAGAIN") >= 0) continue; // a non-blocking pipe that is full: try again
      shutdown("stdout closed"); return;
    }
  }
}
function shutdown(why: string): void {
  if (closing) return;
  closing = true; log("exit: " + why);
  killAll(R);
  // the children get SIGTERM now and SIGKILL after 1 s (run.ts); exit when they are gone, at most ~1.2 s from now
  const t0 = Date.now();
  const w = setInterval(() => { if (R.running === 0 || Date.now() - t0 > 1200) { clearInterval(w); process.exit(0); } }, 25);
}

// ── the contract check: once per agentglass binary (path + mtime), re-run after an update replaced it ──
interface Gate { key: string; code: string; msg: string; hint: string }
const gate: Gate = { key: "", code: "", msg: "", hint: "" };
function checkCli(): Gate {
  let key = "";
  try { key = bin + "@" + String(statSync(bin).mtimeMs); } catch (e) { return { key: "", code: "no_cli", msg: "agentglass not found at " + bin, hint: "agentglass-mcp runs the agentglass beside it: ./build.sh builds both; install.sh and brew install both" }; }
  if (key === gate.key) return gate;
  const r = spawnSync(bin, ["--version", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }); // (spawnSync takes no env here: --version needs none)
  let contract = 0;
  try { const v = obj(JSON.parse(String(r.stdout ?? ""))); contract = v && typeof v["contract"] === "number" ? (v["contract"] as number) : 0; } catch (e) { contract = 0; }
  gate.key = key; gate.code = ""; gate.msg = ""; gate.hint = "";
  if (contract < 1) { gate.code = "contract"; gate.msg = bin + " does not speak CLI contract 1 (agentglass-mcp " + BUILD.version + ")"; gate.hint = "agentglass update"; }
  log("cli " + bin + " contract " + String(contract));
  return gate;
}

// ── the project directory when the server was started in $HOME or /: the calling session's cwd, once it resolves ──
interface Parked { id: string; c: Call; token: string }
const cwdState = { ok: startCwd !== "", busy: false, parked: [] as Parked[], why: "" };
function resolveCwd(keep: boolean): void {
  cwdState.busy = true;
  const accepted = submit(R, { id: "\u0000cwd", argv: ["session", "current", "--all-projects", "--fields", "cwd", "--format", "json"], keepSession: keep, timeoutMs: o.timeoutMs, progress: "", label: "" }, (t: string, s: number, l: string) => { /* none */ }, (d: Done) => {
    let cwd = "";
    try { const v = obj(JSON.parse(d.stdout)); cwd = v ? str(v["cwd"]) : ""; } catch (e) { cwd = ""; }
    if (!cwd && !keep && hadSessionVar && d.stderr.indexOf("no_current_session") >= 0) { resolveCwd(true); return; }
    cwdState.busy = false;
    const ps = cwdState.parked; cwdState.parked = [];
    if (cwd) { cwdState.ok = true; R.cfg.cwd = cwd; log("project from the session: " + cwd); for (const p of ps) start(p.id, p.c, p.token); return; }
    // not cached: the agent may simply not have written its session yet
    for (const p of ps) respond(p.id, errorShaped("no_project", "agentglass-mcp runs in " + process.cwd() + " and the calling session's project is not known", "start the server in the project or register it with --all-projects"));
  });
  if (!accepted) { cwdState.busy = false; const ps = cwdState.parked; cwdState.parked = []; for (const p of ps) respond(p.id, busy()); }
}

// ── tools/call ──
const inflight = new Set<string>(); // request ids (JSON text) with a response still due
function busy(): Shaped { return errorShaped("busy", "2 agentglass calls running and 8 waiting in this server", "retry in a few seconds"); }
function respond(id: string, s: Shaped): void {
  if (!inflight.has(id)) return; // cancelled
  inflight.delete(id);
  const r: Obj = { content: [{ type: "text", text: s.text }] };
  if (structured(conn.version)) r["structuredContent"] = s.obj;
  if (s.isError) r["isError"] = true;
  send(ok(id, r));
}
function beat(token: string, sec: number, label: string): void {
  let t: unknown = token; try { t = JSON.parse(token); } catch (e) { t = token; }
  send(note("notifications/progress", { progressToken: t, progress: sec, message: label }));
}
function run(id: string, c: Call, token: string, keep: boolean): void {
  const t0 = Date.now();
  const accepted = submit(R, { id, argv: c.argv, keepSession: keep, timeoutMs: o.timeoutMs, progress: token, label: c.heartbeat }, beat, (d: Done) => {
    log(c.tool + " exit " + String(d.code) + " " + String(Date.now() - t0) + " ms");
    if (d.tooBig) { respond(id, errorShaped("too_large", "agentglass printed more than " + String(MAX_OUT / 1048576) + " MiB for this call", "ask for fewer fields, a shorter since or an earlier page")); return; }
    if (d.timedOut) { respond(id, errorShaped("timeout", "agentglass took longer than " + String(o.timeoutMs / 1000) + " s", "the first call after an install indexes all history: run agentglass once, then retry (or raise --timeout)")); return; }
    if (d.code === -1 && d.stderr.startsWith("spawn")) { respond(id, errorShaped("no_cli", d.stderr.slice(0, 300), "agentglass-mcp runs the agentglass beside it")); return; }
    // the process tree named no session (a sandbox without ps): once more with the env's session id
    if (d.code === 3 && !keep && hadSessionVar && d.stderr.indexOf("\"no_current_session\"") >= 0) { run(id, c, token, true); return; }
    respond(id, shapeExit(c, d.code, d.stdout, d.stderr, scope, o));
  });
  if (!accepted) respond(id, busy());
}
function start(id: string, c: Call, token: string): void { if (inflight.has(id)) run(id, c, token, false); }
function onCall(m: Msg): void {
  const name = m.params["name"];
  if (typeof name !== "string") { send(fail(m.id, -32602, "Invalid params: tools/call needs a tool name")); return; }
  const a = m.params["arguments"]; const args = a === undefined || a === null ? {} : obj(a);
  if (!args) { send(fail(m.id, -32602, "Invalid params: arguments must be an object")); return; }
  const c = plan(name, args, o);
  if (c.err === "unknown tool") { send(fail(m.id, -32602, "Unknown tool: " + name.slice(0, 64))); return; }
  // an id still in flight cannot name a second call: its response and a cancel would be ambiguous
  if (inflight.has(m.id)) { send(fail(m.id, -32600, "Invalid Request: id " + m.id.slice(0, 64) + " is already in flight")); return; }
  inflight.add(m.id);
  if (c.err) { respond(m.id, errorShaped("invalid_arguments", c.err, "")); return; }
  const g = checkCli();
  if (g.code) { respond(m.id, errorShaped(g.code, g.msg, g.hint)); return; }
  const meta = obj(m.params["_meta"]); const pt = meta ? meta["progressToken"] : undefined;
  const token = typeof pt === "string" || typeof pt === "number" ? JSON.stringify(pt) : "";
  if (c.scoped && !allScope && !cwdState.ok) {
    if (cwdState.parked.length >= 8) { respond(m.id, busy()); return; } // the runner's queue bound, also while the project resolves
    cwdState.parked.push({ id: m.id, c, token });
    if (!cwdState.busy) resolveCwd(false);
    return;
  }
  run(m.id, c, token, false);
}
function onCancel(m: Msg): void {
  const rid = m.params["requestId"];
  if (typeof rid !== "string" && typeof rid !== "number") return;
  const id = JSON.stringify(rid);
  if (!inflight.has(id)) return; // unknown or finished: ignored
  inflight.delete(id);
  cancel(R, id);
  cwdState.parked = cwdState.parked.filter((p: Parked) => p.id !== id);
  log("cancelled " + id);
}

// ── stdin ──
const F = newFramer();
const toolsFor = (v: string): Obj => toolsList(v);
function onLine(line: string, oversize: boolean): void {
  if (oversize) { send(fail("", -32600, "Invalid Request: line over 4 MiB")); return; }
  for (const m of parse(line, conn.version)) {
    const r = answer(conn, m, toolsFor, (c) => instructionsFor(c.scopeName), BUILD.version);
    for (const l of r.lines) send(l);
    if (r.handled) continue;
    if (m.method === "tools/call") onCall(m); else if (m.method === "notifications/cancelled") onCancel(m);
  }
}
process.stdin.on("data", (d: Uint8Array) => { for (const f of push(F, d)) onLine(f.line, f.oversize); });
process.stdin.on("end", () => { shutdown("stdin closed"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });
process.on("SIGINT", () => { shutdown("SIGINT"); });
log("agentglass-mcp " + BUILD.version + " cli " + bin + " cwd " + (startCwd || "(the session's)") + " scope " + scope);
