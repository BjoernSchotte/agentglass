// agentglass — the herdr adapter over the herdr CLI (no Unix sockets in scriptc): agent panes ↔ processes and sessions,
// states for the approval signal and the row, send (agent prompt), jump (agent focus), resume in a new tab (agent start).
// No spawn while herdr is absent; the pane map is read on a new agent, every 30 s and before actions
// SPDX-License-Identifier: Apache-2.0
import { spawn, execFileSync } from "node:child_process";
import { existsSync, statSync, openSync, closeSync, mkdirSync, unlinkSync } from "node:fs";
import { join, delimiter } from "node:path";
import { HOME, listDir, readText } from "../util/fs.ts";
import { str } from "../util/json.ts";
import { section } from "../util/config.ts";
import { OS } from "../platform/index.ts";
import { say } from "../state.ts";
import { REDACT } from "../features/redact-on.ts";
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";
import { MUX_EVENTS } from "./events.ts";
import { type HWs, parseAgents, parseLabels, parseWorkspaces, parseProcInfo, parseVersion, parseCreated, parseError, versionAtLeast,
  sessRef, choosePid, placeLabel, sendOutcome, errOutcome, envHerdr, workspaceFor, workspaceByPanes, HARNESS_LABELS } from "./herdr-parse.ts";

const MIN_SEND = "0.8.2"; // the first herdr that refuses a prompt while the agent is at a dialog (agent_blocked)
const PI_CAP = 8; // pane process-info calls per non-forced refresh (≈ 6 ms each)
// one agent pane: mp is the pane handed out (updated in place, so a caller holding it sees new readings)
interface Rec { mp: MuxPane; wsId: string; tabId: string; label: string; key: string; path: string; pid: number; seen: boolean; cwd: string }
interface Srv { sock: string; skipUntil: number; at: number; labelsAt: number; look: number; recs: Map<string, Rec>; ws: Map<string, string>; tabs: Map<string, string>; wsList: HWs[]; ver: string; verAt: number }
const HS = {
  bin: "", binDone: false, cfgWarned: false, badOutWarned: false,
  learned: new Set<string>(), named: [] as string[], namedAt: 0, sockAt: -1, socks: [] as string[],
  dirty: false, lastAt: 0, seen: new Set<number>(),
  ps: new Map<number, MuxProc>(), byPid: new Map<number, Rec>(), sending: new Set<string>(), sendNo: 0,
};
const servers = new Map<string, Srv>();
// checks: forget the binary, sockets, maps, versions and skips
export function herdrReset(): void {
  HS.bin = ""; HS.binDone = false; HS.cfgWarned = false; HS.badOutWarned = false; HS.learned.clear(); HS.named = []; HS.namedAt = 0; HS.sockAt = -1; HS.socks = [];
  HS.dirty = false; HS.lastAt = 0; HS.seen.clear(); HS.ps.clear(); HS.byPid.clear(); HS.sending.clear(); servers.clear(); MUX_EVENTS.jumped = false;
}
function envOf(k: string): string { const v = process.env[k]; return v !== undefined ? v : ""; }
function onPath(name: string): string {
  for (const d of envOf("PATH").split(delimiter)) { if (!d) continue; const f = join(d, name); if (existsSync(f)) return f; }
  return "";
}
// AGENTGLASS_HERDR (off | a path), config mux.herdr ("off" | "auto"), our own pane's HERDR_BIN_PATH, herdr on PATH
function bin(): string {
  if (HS.binDone) return HS.bin;
  HS.binDone = true; HS.bin = "";
  const e = envOf("AGENTGLASS_HERDR");
  if (e === "off" || e === "0") return "";
  if (e) { HS.bin = e; return e; }
  const c = str(section("mux")["herdr"]);
  if (c === "off") return "";
  if (c && c !== "auto" && !HS.cfgWarned) { HS.cfgWarned = true; say("warn", "config mux.herdr must be auto or off — using auto"); }
  const own = envOf("HERDR_BIN_PATH");
  HS.bin = own && existsSync(own) ? own : onPath("herdr");
  return HS.bin;
}
function configDir(): string { const x = envOf("XDG_CONFIG_HOME"); return join(x || join(HOME, ".config"), "herdr"); }
// the API sockets that exist: AGENTGLASS_HERDR_SOCKET alone, else ours, those agents' environments named, the default
// one and named sessions (listed every 30 s); recomputed at most once a second
function sockets(now: number): string[] {
  if (HS.sockAt >= 0 && now - HS.sockAt < 1000 && now >= HS.sockAt) return HS.socks;
  HS.sockAt = now;
  const pin = envOf("AGENTGLASS_HERDR_SOCKET");
  const c: string[] = [];
  if (pin) c.push(pin);
  else {
    const own = envOf("HERDR_SOCKET_PATH"); if (own) c.push(own);
    for (const s of HS.learned) c.push(s);
    const d = configDir(); c.push(join(d, "herdr.sock"));
    if (now - HS.namedAt >= 30000 || now < HS.namedAt) { HS.namedAt = now; HS.named = []; for (const n of listDir(join(d, "sessions"))) HS.named.push(join(d, "sessions", n, "herdr.sock")); }
    for (const s of HS.named) c.push(s);
  }
  const out: string[] = []; for (const s of c) if (out.indexOf(s) < 0 && existsSync(s)) out.push(s);
  HS.socks = out;
  return out;
}
function srvOf(sock: string): Srv {
  let s = servers.get(sock);
  if (!s) { s = { sock, skipUntil: 0, at: 0, labelsAt: 0, look: -1, recs: new Map<string, Rec>(), ws: new Map<string, string>(), tabs: new Map<string, string>(), wsList: [], ver: "", verAt: -1 }; servers.set(sock, s); }
  return s;
}
// the environment of a herdr child: ours, pointed at that server (never a named session's selector)
function childEnv(sock: string): { [k: string]: string } {
  const env: { [k: string]: string } = {};
  for (const k of Object.keys(process.env)) { const v = process.env[k]; if (v !== undefined && k !== "HERDR_SESSION" && k !== "HERDR_SOCKET_PATH") env[k] = v; }
  env["HERDR_SOCKET_PATH"] = sock;
  return env;
}
interface Res { ok: boolean; out: string; err: string }
// one synchronous herdr call (≤ 4 s); a failure carries herdr's stderr (its error JSON) in err. A server that fails it
// is skipped for 60 s by the caller
function call(sock: string, args: string[]): Res {
  const b = bin(); if (!b) return { ok: false, out: "", err: "" };
  try { return { ok: true, out: execFileSync(b, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 4000, env: childEnv(sock) }), err: "" }; }
  catch (e) { return { ok: false, out: "", err: e instanceof Error ? e.message : String(e) }; }
}
// a fresh file for a spawned herdr's stderr (read on exit, then deleted)
function errFile(what: string): string {
  const dir = join(HOME, ".agentglass", "tmp"); try { mkdirSync(dir, { recursive: true }); } catch (e) { /* exists */ }
  HS.sendNo++;
  return join(dir, "herdr-" + what + "-" + String(process.pid) + "-" + String(HS.sendNo) + ".err");
}
function skip(s: Srv, now: number): void { s.skipUntil = now + 60000; }
function place(p: MuxPane): string { return placeLabel(p.ws, p.tab, p.id, REDACT); }
// the agent root of a pane's foreground process and that root's harness ("" = not an agent process)
function rootOf(pid: number): number { const p = HS.ps.get(pid); return p ? p.root : 0; }
function harnessOfRoot(pid: number): string { const r = HS.ps.get(rootOf(pid)); return r ? r.h : ""; }
function labelsOf(s: Srv, r: Rec): void { r.mp.ws = s.ws.get(r.wsId) ?? ""; r.mp.wsId = r.wsId; r.mp.tab = s.tabs.get(r.tabId) ?? ""; }
function readLabels(s: Srv, now: number): void {
  const w = call(s.sock, ["workspace", "list"]); if (w.ok) { s.wsList = parseWorkspaces(w.out); s.ws = parseLabels(w.out, "workspaces", "workspace_id"); }
  const t = call(s.sock, ["tab", "list"]); if (t.ok) s.tabs = parseLabels(t.out, "tabs", "tab_id");
  s.labelsAt = now;
}
// `agent list` of one server into its records (pane ids, labels, states, session refs); false = the server is down or
// answered something else (skipped 60 s)
function readAgents(s: Srv, now: number): boolean {
  const r = call(s.sock, ["agent", "list"]);
  if (!r.ok) { skip(s, now); return false; }
  const l = parseAgents(r.out);
  if (!l.ok) { skip(s, now); if (!HS.badOutWarned) { HS.badOutWarned = true; say("warn", "herdr: unexpected output from agent list"); } return false; }
  for (const x of s.recs.values()) x.seen = false;
  for (const a of l.agents) {
    let x = s.recs.get(a.term);
    if (!x) { x = { mp: { kind: "herdr", id: a.pane, term: a.term, server: s.sock, ws: "", wsId: "", tab: "", status: "", at: 0 }, wsId: "", tabId: "", label: "", key: "", path: "", pid: 0, seen: true, cwd: "" }; s.recs.set(a.term, x); }
    const ref = sessRef(a.label, a.sKind, a.sVal);
    x.seen = true; x.mp.id = a.pane; x.mp.status = a.status; x.mp.at = now; x.wsId = a.ws; x.tabId = a.tab; x.label = a.label; x.cwd = a.cwd;
    if (x.key !== ref.key || x.path !== ref.path) { x.key = ref.key; x.path = ref.path; x.pid = 0; } // another session in the pane: resolve again
  }
  const gone: string[] = []; for (const [k, x] of s.recs) if (!x.seen) gone.push(k);
  for (const k of gone) s.recs.delete(k);
  return true;
}
function sigOf(): string {
  let o = "";
  for (const s of servers.values()) for (const x of s.recs.values()) o += x.mp.id + " " + x.mp.term + " " + String(x.pid) + " " + x.mp.ws + " " + x.mp.tab + " " + x.key + " " + x.path + "\n";
  return o;
}
function index(): void { HS.byPid.clear(); for (const s of servers.values()) for (const x of s.recs.values()) if (x.pid) HS.byPid.set(x.pid, x); }
function live(now: number): Srv[] { const out: Srv[] = []; for (const k of sockets(now)) { const s = srvOf(k); if (s.skipUntil <= now) out.push(s); } return out; }

export const herdr: Mux = {
  id: "herdr", label: "herdr",
  present: (now: number): boolean => bin() !== "" && sockets(now).length > 0,
  refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean => {
    HS.ps.clear(); for (const p of ps) HS.ps.set(p.pid, p);
    // a new agent process: in a herdr pane when its environment says so (Linux; only two values are kept), on macOS
    // (no environment) any new one
    const mac = process.platform === "darwin"; const pin = envOf("AGENTGLASS_HERDR_SOCKET") !== "";
    for (const p of ps) {
      if (p.root !== p.pid || HS.seen.has(p.pid)) continue;
      HS.seen.add(p.pid);
      if (mac) { HS.dirty = true; continue; }
      const e = envHerdr(OS.envOf(p.pid));
      if (e.pane) HS.dirty = true;
      if (e.sock && !pin && !HS.learned.has(e.sock)) { HS.learned.add(e.sock); HS.sockAt = -1; }
    }
    if (HS.seen.size > ps.length * 2 + 64) for (const k of [...HS.seen]) if (!HS.ps.has(k)) HS.seen.delete(k);
    if (!force && !HS.dirty && now - HS.lastAt < 30000 && now >= HS.lastAt) return false;
    HS.dirty = false; HS.lastAt = now;
    const was = sigOf(); let pi = 0;
    for (const s of live(now)) {
      if (!readAgents(s, now)) continue;
      let unknown = false; for (const x of s.recs.values()) if ((x.wsId && !s.ws.has(x.wsId)) || (x.tabId && !s.tabs.has(x.tabId))) unknown = true;
      if (unknown || now - s.labelsAt >= 30000 || force) readLabels(s, now);
      for (const x of s.recs.values()) {
        labelsOf(s, x);
        if (x.pid && HS.ps.has(x.pid)) continue; // cached by terminal id (survives moves); gone = the agent restarted
        x.pid = 0;
        const k = x.key || x.path ? known(x.key, x.path) : 0;
        if (k) { x.pid = rootOf(k) || k; continue; }
        if (!force && pi >= PI_CAP) continue; // the rest next pass
        pi++;
        const r = call(s.sock, ["pane", "process-info", "--pane", x.mp.id]);
        const fg = r.ok ? parseProcInfo(r.out) : [];
        const c = choosePid(fg, harnessOfRoot, x.label);
        if (c) x.pid = rootOf(c) || c;
        else if (pi >= PI_CAP && !force) HS.dirty = true;
      }
      // panes left unresolved by the cap: the next slow pass goes on
      for (const x of s.recs.values()) if (!x.pid && !force && pi >= PI_CAP) HS.dirty = true;
    }
    index();
    return sigOf() !== was;
  },
  paneOf: (pid: number): MuxPane | null => { const x = HS.byPid.get(pid); return x ? x.mp : null; },
  paneOfSession: (key: string, path: string): MuxPane | null => {
    for (const s of servers.values()) for (const x of s.recs.values()) if ((key && x.key === key) || (path && x.path === path)) return x.mp;
    return null;
  },
  links: (): MuxLink[] => {
    const out: MuxLink[] = [];
    for (const s of servers.values()) for (const x of s.recs.values()) if (x.pid && (x.key || x.path)) out.push({ pid: x.pid, key: x.key, path: x.path });
    return out;
  },
  title: (p: MuxPane, look: number): string => "",
  // one `agent list` per server per look, only when a caller says it is due; the last reading otherwise
  status: (p: MuxPane, due: boolean, look: number, now: number): string => {
    const s = servers.get(p.server);
    if (s && due && s.look !== look && s.skipUntil <= now) { s.look = look; if (readAgents(s, now)) { for (const x of s.recs.values()) labelsOf(s, x); index(); } }
    return p.status;
  },
  send: (p: MuxPane, msg: string): void => {
    const s = srvOf(p.server); const b = bin();
    // the server's version, read again when its socket changed (a restarted server)
    let mt = 0; try { mt = statSync(p.server).mtimeMs; } catch (e) { mt = 0; }
    if (s.verAt !== mt || !s.ver) { const r = call(p.server, ["status", "server"]); s.ver = r.ok ? parseVersion(r.out) : ""; s.verAt = mt; }
    if (!versionAtLeast(s.ver, MIN_SEND)) { say("warn", "herdr " + (s.ver || "of unknown version") + " is too old to send safely (needs ≥ " + MIN_SEND + ")"); return; }
    if (HS.sending.has(p.term)) { say("warn", "still sending…"); return; }
    const where = place(p);
    const ef = errFile("send");
    let fd = -1; try { fd = openSync(ef, "w"); } catch (e) { say("err", "herdr: cannot write " + ef); return; }
    HS.sending.add(p.term);
    let done = false;
    const end = (code: number, timedOut: boolean): void => {
      if (done) return; done = true; HS.sending.delete(p.term);
      const err = readText(ef, 0, 4096); try { unlinkSync(ef); } catch (e) { /* gone */ }
      if (timedOut) { say("err", "herdr send timed out"); return; }
      const o = sendOutcome(code, err, where); say(o.kind, o.text);
    };
    try {
      const ch = spawn(b, ["agent", "prompt", p.id, msg], { stdio: ["ignore", "ignore", fd], env: childEnv(p.server) });
      closeSync(fd);
      const k = setTimeout(() => { if (!done) { ch.kill("SIGKILL"); end(-1, true); } }, 10000); // herdr itself takes ≈ 0.3 s
      ch.on("exit", (c: number | null) => { clearTimeout(k); end(c === null ? -1 : c, false); });
      ch.on("error", (e: Error) => { clearTimeout(k); end(-1, false); });
    } catch (e) { try { closeSync(fd); } catch (x) { /* closed */ } end(-1, false); }
  },
  focus: (p: MuxPane): void => {
    const r = call(p.server, ["agent", "focus", p.id]);
    if (r.ok) { MUX_EVENTS.jumped = true; say("ok", "focused in herdr: " + place(p)); return; }
    const o = errOutcome(parseError(r.err), "herdr focus failed"); say(o.kind, o.text);
  },
  // resume inside herdr (agentglass runs in a herdr pane): a new tab in the workspace owning the directory (else a new
  // workspace), the agent started there with its resume arguments, then focused; a failed start closes the tab
  start: (h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean => {
    const own = envOf("HERDR_SOCKET_PATH");
    if (envOf("HERDR_ENV") !== "1" || !own || HARNESS_LABELS.indexOf(h) < 0 || sockets(Date.now()).indexOf(own) < 0) return false;
    const s = srvOf(own); const now = Date.now();
    readLabels(s, now); if (readAgents(s, now)) index();
    // the workspace: its worktree holds the directory, else its repo's, else one of its agents works in the directory
    const wi = workspaceFor(cwd, top, s.wsList); const w = wi >= 0 ? s.wsList[wi] : undefined;
    const pairs: string[][] = []; for (const x of s.recs.values()) pairs.push([x.cwd, x.wsId]);
    const wid = w ? w.id : workspaceByPanes(cwd, pairs);
    let pane = ""; let tab = ""; let wsLabel = "";
    if (wid) {
      wsLabel = s.ws.get(wid) ?? "";
      const r = call(own, ["tab", "create", "--workspace", wid, "--cwd", cwd, "--label", label, "--no-focus"]);
      if (!r.ok) { const o = errOutcome(parseError(r.err), "herdr: could not create a tab"); say(o.kind, o.text); return true; }
      const c = parseCreated(r.out); pane = c.pane; tab = c.tab;
    } else { // a new workspace: its first tab takes the agent
      const parts = (top || cwd).split("/"); wsLabel = parts[parts.length - 1] || "agent";
      const r = call(own, ["workspace", "create", "--cwd", cwd, "--label", wsLabel, "--no-focus"]);
      if (!r.ok) { const o = errOutcome(parseError(r.err), "herdr: could not create a workspace"); say(o.kind, o.text); return true; }
      const c = parseCreated(r.out); pane = c.pane; tab = c.tab;
    }
    if (!pane) { say("err", "herdr: no pane in the reply"); return true; }
    const where = placeLabel(wsLabel, label, pane, REDACT);
    const name = h + "-" + Array.from(id).filter((c: string) => /[A-Za-z0-9]/.test(c)).slice(0, 8).join("");
    const ef = errFile("start");
    let fd = -1; try { fd = openSync(ef, "w"); } catch (e) { say("err", "herdr: cannot write " + ef); return true; }
    say("info", "starting " + h + " in herdr " + where + "…");
    let done = false;
    const end = (code: number): void => {
      if (done) return; done = true;
      const err = readText(ef, 0, 4096); try { unlinkSync(ef); } catch (e) { /* gone */ }
      if (code === 0) {
        call(own, ["agent", "focus", pane]); HS.dirty = true; MUX_EVENTS.jumped = true;
        say("ok", "resumed in herdr: " + where); return;
      }
      const o = errOutcome(parseError(err), h + " did not start in herdr (exit " + String(code) + ")"); say(o.kind, o.text);
      if (tab) call(own, ["tab", "close", tab]);
    };
    try {
      const ch = spawn(bin(), ["agent", "start", name, "--kind", h, "--pane", pane, "--"].concat(args), { stdio: ["ignore", "ignore", fd], env: childEnv(own) });
      closeSync(fd);
      const k = setTimeout(() => { if (!done) { ch.kill("SIGKILL"); end(-1); } }, 40000); // herdr waits ≤ 30 s for readiness
      ch.on("exit", (c: number | null) => { clearTimeout(k); end(c === null ? -1 : c); });
      ch.on("error", (e: Error) => { clearTimeout(k); end(-1); });
    } catch (e) { try { closeSync(fd); } catch (x) { /* closed */ } end(-1); }
    return true;
  },
};
// the last workspace list of every present server (workspace attribution of sessions)
export function herdrWorkspaces(): HWs[] { const out: HWs[] = []; for (const s of servers.values()) for (const w of s.wsList) out.push(w); return out; }
