// agentglass — `agentglass mcp`: register agentglass-mcp with each installed coding agent (`install` prints the
// commands; `--write` runs each harness's own `mcp add` after consent) and check it end to end (`doctor`).
// agentglass never edits a harness's config file itself (spec mcp-server Decision 8): their CLIs own those formats.
// SPDX-License-Identifier: Apache-2.0
import { writeSync, readSync, existsSync, statSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { H } from "../hooks.ts";
import { S } from "../state.ts";
import { type Obj, obj, str, arr } from "../util/json.ts";
import { argVal } from "../util/argv.ts";
import { agentHost, cliError } from "./agentenv.ts";
import { addCmd, opt, helpOf, wantsHelp, optTable, type OptRec, type CmdRec } from "./clihelp.ts";
import { fmtArgs } from "./format.ts";
import { newFramer, push } from "../mcp/rpc.ts"; // the server's framing: whole lines, split on byte 0x0A

// ── registrations (pure) ──
export const HARNESS_IDS = ["claude", "codex", "gemini", "pi", "kiro", "opencode"];
const NAMES = ["Claude Code", "Codex", "Gemini CLI", "pi", "Kiro CLI", "OpenCode"];
const CMDS = ["claude", "codex", "gemini", "pi", "kiro-cli", "opencode"];
// argv [] = print-only (OpenCode: its JSONC config has no `mcp add`)
export interface Reg { harness: string; found: boolean; print: string; argv: string[] }
function q(a: string): string { return /^[A-Za-z0-9_./:@=+,-]+$/.test(a) ? a : "'" + a.replace(/'/g, "'\\''") + "'"; }
function line(argv: string[]): string { return argv.map(q).join(" "); }
// bin: the server command (bare name or absolute path); opts: its options; scope: user | project; which: harness ids
// ("all" = every one; none = those onPath finds)
export function regs(bin: string, opts: string[], scope: string, which: string[], onPath: (cmd: string) => boolean): Reg[] {
  const out: Reg[] = [];
  const proj = scope === "project";
  for (let i = 0; i < HARNESS_IDS.length; i++) {
    const h = HARNESS_IDS[i] ?? ""; const c = CMDS[i] ?? "";
    const found = onPath(c);
    if (which.length ? which.indexOf(h) < 0 && which.indexOf("all") < 0 : !found) continue;
    let argv: string[] = []; let print = "";
    const srv = [bin].concat(opts);
    if (h === "claude") argv = ["claude", "mcp", "add", "--scope", proj ? "project" : "user", "agentglass", "--"].concat(srv);
    else if (h === "codex") { // Codex registers servers per user only: --scope project cannot narrow it
      argv = ["codex", "mcp", "add", "agentglass", "--"].concat(srv);
      print = line(argv) + (proj ? "  (Codex has no project scope: this is for every project)" : "") + "\nor in ~/.codex/config.toml:\n  [mcp_servers.agentglass]\n  command = " + JSON.stringify(bin) + "\n  args = [" + opts.map((o: string) => JSON.stringify(o)).join(", ") + "]";
    }
    // gemini's own flags end at "--": the server's options after it
    else if (h === "gemini") argv = ["gemini", "mcp", "add", "--scope", proj ? "project" : "user", "agentglass", bin].concat(opts.length ? ["--"].concat(opts) : []);
    else if (h === "pi") argv = ["pi", "mcp", "add"].concat(proj ? ["--local"] : [], ["agentglass", "--"], srv);
    else if (h === "kiro") { argv = ["kiro-cli", "mcp", "add", "--name", "agentglass", "--scope", proj ? "workspace" : "global", "--command", bin]; for (const o of opts) argv.push("--args=" + o); } // (attached: clap takes a value that starts with "-" only so)
    else print = "\"mcp\": {\"agentglass\": {\"type\": \"local\", \"command\": [" + srv.map((x: string) => JSON.stringify(x)).join(", ") + "], \"enabled\": true}}\nprint-only: add it to " + (proj ? "opencode.json in the project" : "~/.config/opencode/opencode.json");
    out.push({ harness: h, found, print: print || line(argv), argv });
  }
  return out;
}
// the bare name when PATH finds this agentglass's own sibling (a stable registration across updates), else its path
export function serverCmd(execPath: string, which: (c: string) => string): string {
  const i = execPath.lastIndexOf("/"); const sib = (i >= 0 ? execPath.slice(0, i + 1) : "") + "agentglass-mcp";
  const w = which("agentglass-mcp");
  return w && real(w) === real(sib) ? "agentglass-mcp" : sib;
}
function real(p: string): string { try { return realpathSync(p); } catch (e) { return p; } }
function onPath(c: string): string {
  for (const d of (process.env.PATH ?? "").split(":")) {
    if (!d) continue; const p = d + "/" + c;
    try { if (statSync(p).isFile()) return p; } catch (e) { /* not here */ } // (no mode bits in scriptc: a file is enough)
  }
  return "";
}
function sibling(): string { const e = process.execPath; const i = e.lastIndexOf("/"); return (i >= 0 ? e.slice(0, i + 1) : "") + "agentglass-mcp"; }

// ── CLI ──
function out(s: string): void { try { writeSync(1, s + "\n"); } catch (e) { process.exit(0); } }
const INSTALL_OPTS: OptRec[] = [
  opt("--harness", "h,…|all", HARNESS_IDS.join(" "), "on PATH", []),
  opt("--write", "", "run each agent's own `mcp add` (asks y/N per agent)", "", []),
  opt("--yes", "", "with --write: no questions (needed without a terminal)", "", []),
  opt("--scope", "user|project", "for the user, or for this project only", "user", ["user", "project"]),
  opt("--all-projects", "", "the server shows every project, not only the agent's", "", []),
  opt("--content", "", "the server includes tool results and prompts", "", []),
  opt("--redact", "", "the server answers in privacy mode", "", []),
  opt("--json", "", "{server, harnesses[{harness, found, command, argv}]}", "", [])];
const DOCTOR_OPTS: OptRec[] = [opt("--json", "", "{ok, agentglass, server, protocol, tools, toolsBytes, current, callMs, scope}", "", [])];
const HELP = `usage: agentglass mcp install [--harness h,…|all] [--scope user|project]
                [--write [--yes]] [--all-projects] [--content] [--redact]
       agentglass mcp doctor [--json]

  agentglass-mcp is a small MCP server (stdio) that gives coding agents
  agentglass as tools: their own session, sessions, errors, cost, triage,
  compare, related events, contention ("start my tests now?"), wait history,
  fleet hosts and unpriced models. Each agent session starts one; it costs
  ~0.3 MB when idle.

  install   prints the registration for each agent found on PATH (Claude Code,
            Codex, Gemini CLI, pi, Kiro CLI; OpenCode: a config snippet).
            --write runs the agent's own \`mcp add\`; agentglass edits no file.
  doctor    starts agentglass-mcp as an agent would and calls it: versions,
            protocol, tools, which session it sees as "current", time per call.

  Privacy: the server shows the agent's own project only, no transcript content
  unless --content, and its answers go to the agent's model provider.

` + optTable(INSTALL_OPTS);
function rec(c: string, usage: string, summary: string, options: OptRec[]): CmdRec { return { cmd: c, usage, summary, options, fields: [], group: "cmd" }; }
addCmd(rec("mcp", "agentglass mcp", "the MCP server agentglass-mcp: agents query agentglass as tools (install, doctor)", []), "--update-prices");
addCmd(rec("mcp install", "agentglass mcp install [--harness h] [--write [--yes]]", "print (or with --write run) each agent's command that registers agentglass-mcp", INSTALL_OPTS), "--update-prices");
addCmd(rec("mcp doctor", "agentglass mcp doctor [--json]", "start agentglass-mcp as an agent would: versions, protocol, tools, the current session, time per call", DOCTOR_OPTS), "--update-prices");

function wantJson(args: string[]): boolean { const f = fmtArgs(args).fmt; return args.indexOf("--json") >= 0 || f === "json" || (!f && agentHost().on); }
function ask(qs: string): boolean {
  out(qs);
  const b = new Uint8Array(64); let n = 0;
  try { n = readSync(0, b, 0, 64, null); } catch (e) { return false; }
  return new TextDecoder().decode(b.subarray(0, n)).trim().toLowerCase().startsWith("y");
}
function install(args: string[]): void {
  const which: string[] = []; let scope = "user"; const opts: string[] = [];
  let write = false; let yes = false;
  for (let i = 2; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--harness") { const v = argVal(args, i++); if (!v) cliError("usage", "--harness needs a value", "--harness " + HARNESS_IDS.join("|") + "|all", 2); for (const h of v.split(",")) { if (HARNESS_IDS.indexOf(h) < 0 && h !== "all") cliError("usage", "unknown harness " + h, "one of: " + HARNESS_IDS.join(", ") + ", all", 2); which.push(h); } }
    else if (a === "--scope") { const v = argVal(args, i++) ?? ""; if (v !== "user" && v !== "project") cliError("usage", "--scope must be user or project", "agentglass mcp install --scope project", 2); scope = v; }
    else if (a === "--write") write = true;
    else if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--all-projects" || a === "--content" || a === "--redact") { if (opts.indexOf(a) < 0) opts.push(a); }
    else if (a === "--json") { /* wantJson */ }
    else if (a === "--format") i++;
    else cliError("usage", "unknown option " + a + " for mcp install", "agentglass mcp install --help", 2);
  }
  if (process.argv.indexOf("--redact") >= 0 && opts.indexOf("--redact") < 0) opts.push("--redact"); // a global flag: main() took it from args
  const sib = sibling(); const have = existsSync(sib);
  const bin = serverCmd(process.execPath, onPath);
  const rs = regs(bin, opts, scope, which, (c: string): boolean => onPath(c) !== "");
  if (write) {
    if (!have) cliError("no_server", "agentglass-mcp is missing next to " + process.execPath, "./build.sh builds both; install.sh and brew install both", 1);
    if (!yes && (process.stdin.isTTY !== true || agentHost().on)) cliError("usage", "--write changes your agents' MCP configuration: confirm with --yes", "agentglass mcp install --write --yes" + (which.length ? " --harness " + which.join(",") : ""), 2);
  }
  if (wantJson(args) && !write) {
    out(JSON.stringify({ server: bin, serverFound: have, harnesses: rs.map((r: Reg): Obj => ({ harness: r.harness, name: NAMES[HARNESS_IDS.indexOf(r.harness)] ?? r.harness, found: r.found, command: r.print, argv: r.argv })) }));
    process.exit(0);
  }
  if (!rs.length) { out("no supported agent found on PATH (" + CMDS.join(", ") + ")\n  agentglass mcp install --harness all  prints every registration"); process.exit(0); }
  if (!have) out("warning: agentglass-mcp is missing next to " + process.execPath + " (./build.sh builds both; install.sh and brew install both)\n");
  else if (!write) out("server: " + (bin === "agentglass-mcp" ? "agentglass-mcp (on PATH)" : bin) + "\n");
  let failed = 0;
  for (const r of rs) {
    const name = NAMES[HARNESS_IDS.indexOf(r.harness)] ?? r.harness;
    out(name + (r.found || !r.argv.length ? "" : " (" + (CMDS[HARNESS_IDS.indexOf(r.harness)] ?? "") + " not on PATH)"));
    out("  " + r.print.split("\n").join("\n  "));
    if (!write) { out(""); continue; }
    if (!r.argv.length) { out("  (print-only: nothing run)\n"); continue; }
    if (!r.found) { out("  skipped: not on PATH\n"); continue; }
    if (!yes && !ask("  run it? [y/N] ")) { out("  skipped\n"); continue; }
    const p = spawnSync(r.argv[0] ?? "", r.argv.slice(1), { stdio: ["inherit", "inherit", "inherit"] });
    const code = typeof p.status === "number" ? p.status : -1;
    if (code !== 0) failed++;
    out("  → exit " + String(code) + "\n");
  }
  if (!write) out("--write runs these (asks per agent); check with: agentglass mcp doctor");
  else out(failed ? String(failed) + " registration(s) failed: see the output above" : "done; check with: agentglass mcp doctor (from an agent's shell)");
  process.exit(failed ? 1 : 0);
}

// ── doctor: initialize, tools/list, tools/call session {} against agentglass-mcp, as a host would ──
function version(bin: string): Obj {
  const r = spawnSync(bin, ["--version", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  return obj((((): unknown => { try { return JSON.parse(String(r.stdout ?? "")); } catch (e) { return null; } })())) ?? {};
}
function doctor(args: string[]): void {
  const json = wantJson(args);
  const srv = process.env.AGENTGLASS_MCP_SERVER || sibling();
  const ag = version(process.execPath); const sv = spawnSync(srv, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 });
  const rep: Obj = { ok: false, agentglass: { path: process.execPath, version: str(ag["version"]), contract: ag["contract"] ?? null }, server: { path: srv, version: String(sv.stdout ?? "").trim() },
    protocol: null, tools: 0, toolsBytes: 0, current: null, callMs: null, scope: null, problem: "" };
  const finish = (): void => {
    if (json) { out(JSON.stringify(rep)); process.exit(rep["ok"] ? 0 : 1); }
    const a = obj(rep["agentglass"]) ?? {}; const s = obj(rep["server"]) ?? {}; const cur = obj(rep["current"]);
    const L: string[] = ["agentglass mcp doctor",
      "  agentglass      " + str(a["version"]) + ", contract " + String(a["contract"]), "                  " + str(a["path"]),
      "  agentglass-mcp  " + (str(s["version"]) || "(did not start)"), "                  " + str(s["path"])];
    if (rep["protocol"]) L.push("  protocol        " + str(rep["protocol"]), "  tools           " + String(rep["tools"]) + " tools, tools/list " + String(rep["toolsBytes"]) + " bytes");
    if (cur) {
      if (cur["id"]) L.push("  current         " + str(cur["harness"]) + ":" + str(cur["id"]) + "  via " + str(cur["via"]));
      else L.push("  current         none (" + str(cur["code"]) + ")" + (str(cur["code"]) === "no_current_session" && !agentHost().on ? ": expected outside an agent;\n                  run doctor from an agent's shell to see its session" : ": " + str(cur["message"])));
      L.push("  call            session {} in " + String(rep["callMs"]) + " ms");
      if (rep["scope"]) L.push("  scope           " + str(rep["scope"]));
    }
    L.push(rep["ok"] ? "ok" : "FAILED: " + str(rep["problem"]));
    out(L.join("\n")); process.exit(rep["ok"] ? 0 : 1);
  };
  if (!existsSync(srv)) { rep["problem"] = "agentglass-mcp is missing next to " + process.execPath + " (./build.sh builds both; install.sh and brew install both)"; finish(); return; }
  let ch: ReturnType<typeof spawn> | null = null;
  try { ch = spawn(srv, [], { stdio: ["pipe", "pipe", "inherit"] }); } catch (e) { rep["problem"] = "cannot start " + srv + ": " + String(e); finish(); return; }
  const c = ch as ReturnType<typeof spawn>;
  const F = newFramer(); let t0 = 0; let stage = 0;
  const send = (m: Obj): void => { const w = c.stdin; if (w) w.write(JSON.stringify(m) + "\n"); };
  const stop = (problem: string): void => { if (stage >= 9) return; stage = 9; rep["problem"] = problem; clearTimeout(k); try { c.kill(); } catch (e) { /* gone */ } finish(); };
  const k = setTimeout(() => stop("no answer within 60 s"), 60000);
  c.on("error", (e: Error) => stop("cannot start " + srv + ": " + String(e)));
  c.on("close", (code: number | null) => stop("agentglass-mcp exited (" + String(code) + ")"));
  const so = c.stdout;
  // responses, one per line: id 1 initialize, 2 tools/list, 3 tools/call session {}
  if (so) so.on("data", (d: Uint8Array) => {
    for (const f of push(F, d)) {
      let r: Obj | null = null; try { r = obj(JSON.parse(f.line)); } catch (e) { r = null; }
      if (!r) continue;
      const res = obj(r["result"]); const id = r["id"];
      if (id === 1 && res) { rep["protocol"] = res["protocolVersion"] ?? null; send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list" }); stage = 1; }
      else if (id === 2 && res) { rep["tools"] = arr(res["tools"]).length; rep["toolsBytes"] = new TextEncoder().encode(JSON.stringify(res)).length; t0 = Date.now(); send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session", arguments: { fields: ["id", "harness", "title", "via"] } } }); stage = 2; }
      else if (id === 3 && res) {
        rep["callMs"] = Date.now() - t0;
        const sc = obj(res["structuredContent"]) ?? {};
        const e = obj(sc["error"]);
        rep["current"] = e ? { code: str(e["code"]), message: str(e["message"]) } : { id: str(sc["id"]), harness: str(sc["harness"]), via: str(sc["via"]) };
        rep["scope"] = str(sc["scope"]) || (e ? null : "project"); rep["ok"] = true; stage = 9; clearTimeout(k);
        const w = c.stdin; if (w) w.end(); // the server exits on stdin's end
        finish();
      } else if (r["error"]) stop("agentglass-mcp answered " + JSON.stringify(r["error"]));
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "agentglass-mcp-doctor", version: str(ag["version"]) } } });
}

H.cli.unshift((args: string[]): boolean => {
  if (args[0] !== "mcp") return false;
  S.cli = true;
  const sub = args[1] ?? "";
  if (wantsHelp(args)) { out(helpOf(sub === "install" || sub === "doctor" ? "mcp " + sub : "mcp", args, HELP)); process.exit(0); }
  if (sub === "install") { install(args); return true; }
  if (sub === "doctor") { doctor(args); return true; }
  if (sub) cliError("usage", "unknown mcp command " + sub, "agentglass mcp install | agentglass mcp doctor", 2);
  // bare: what the server is; a host misconfigured to run `agentglass mcp` as the server gets a clear error, not a hang
  if (agentHost().on) { out(JSON.stringify({ server: "agentglass-mcp", install: "agentglass mcp install", doctor: "agentglass mcp doctor", help: "agentglass mcp --help" })); process.exit(0); }
  if (process.stdin.isTTY !== true) { try { writeSync(2, "the MCP server is agentglass-mcp: run agentglass mcp install\n"); } catch (e) { /* closed */ } process.exit(2); }
  out(HELP); process.exit(0);
});
