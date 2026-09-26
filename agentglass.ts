// agentglass — a tiny TUI to browse, watch and steer coding-agent sessions
// (Claude Code ~/.claude, Codex ~/.codex). Built as a native binary with scriptc.
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync, renameSync, writeSync, mkdirSync } from "node:fs";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";

type Obj = Record<string, unknown>;
type Harness = "claude" | "codex" | "fx";
interface Ev { kind: string; text: string; ts: string; id: string; full: string } // id pairs tool call ↔ result; full = untruncated detail ("@file:" = load lazily)
interface Sess {
  h: Harness; id: string; path: string; cwd: string; title: string; prompt: string; branch: string; model: string;
  mtime: number; size: number; headDone: boolean; tailSize: number; evs: Ev[]; pid: number; status: string; name: string; archived: boolean;
  parent: string; kind: string; // subagents: parent session id + agent type/role ("" for top-level sessions)
  subs: Sess[]; last: number; depth: number; // derived per buildView: children, newest mtime across self + children, tree depth
}
interface Proc {
  pid: number; ppid: number; cpu: number; rss: number; etime: string; tty: string; args: string; h: string;
  cwd: string; tcpu: number; trss: number; kids: number; sess: string;
}

const HOME = homedir();
const CLAUDE = join(HOME, ".claude");
const CODEX = join(HOME, ".codex");
const FX = join(HOME, ".fx");
const TOTALMEM = totalmem();
const HARN = ["claude", "codex", "fx", "gemini", "opencode", "aider", "cursor-agent", "amp", "qwen", "crush", "goose", "copilot"];

// ── json helpers ────────────────────────────────────────────────────────────
function obj(v: unknown): Obj | null {
  if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as Obj;
  return null;
}
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function arr(v: unknown): unknown[] { return Array.isArray(v) ? (v as unknown[]) : []; }
function parse(l: string): Obj | null {
  if (l.length < 2 || l.charCodeAt(0) !== 123) return null;
  try { return obj(JSON.parse(l)); } catch (e) { return null; }
}
function base(p: string): string { const i = p.lastIndexOf("/"); return i >= 0 ? p.slice(i + 1) : p; }

// ── file reading ────────────────────────────────────────────────────────────
function readBytes(path: string, start: number, len: number): Uint8Array {
  const b = new Uint8Array(len);
  let n = 0;
  try { const fd = openSync(path, "r"); n = readSync(fd, b, 0, len, start); closeSync(fd); } catch (e) { n = 0; }
  return b.subarray(0, n);
}
function readText(path: string, start: number, len: number): string {
  const b = readBytes(path, start, len);
  return new TextDecoder("utf-8").decode(b);
}
// Complete lines in [start,end). align: skip the partial first line. Returns next unread offset.
function readLines(path: string, start: number, end: number, align: boolean): { lines: string[]; next: number } {
  const b = readBytes(path, start, end - start);
  let a = 0;
  if (align) { while (a < b.length && b[a] !== 10) a++; a++; }
  let z = b.length - 1;
  while (z >= a && b[z] !== 10) z--;
  if (z < a) return { lines: [], next: align ? start : start };
  const text = new TextDecoder("utf-8").decode(b.subarray(a, z + 1));
  return { lines: text.split("\n"), next: start + z + 1 };
}

// ── event parsing (shared by preview + transcript) ─────────────────────────
function firstLine(s: string, n: number): string {
  const t = s.trim(); const i = t.indexOf("\n");
  const f = i >= 0 ? t.slice(0, i) : t;
  return f.length > n ? f.slice(0, n) + "…" : f;
}
function toolArg(name: string, inp: Obj | null, raw: string): string {
  if (inp) {
    const keys = ["command", "cmd", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill", "task", "location"];
    for (const k of keys) { const v = str(inp[k]); if (v) return v; }
    const req = obj(inp["request"]);
    if (req) return toolArg(name, req, "");
    return JSON.stringify(inp);
  }
  const j = parse(raw);
  if (j) return toolArg(name, j, "");
  return raw;
}
function blockText(v: unknown): string {
  if (typeof v === "string") return v;
  const parts: string[] = [];
  for (const b of arr(v)) { const o = obj(b); if (o) { const t = str(o["text"]); if (t) parts.push(t); } }
  return parts.join("\n");
}
function isNoise(t: string): boolean {
  const s = t.trimStart();
  return s.length === 0 || s.startsWith("<") || s.startsWith("# AGENTS.md") || s.startsWith("Caveat:");
}
// fx events.jsonl: {seq, timestamp_ms, event: {<kind>: {...}}} — one kind per line
function fxResult(preview: string): string {
  const p = parse(preview);
  if (!p) return preview;
  const t = str(p["output_delta"]) || str(p["result"]) || str(p["output"]) || str(p["error"]) || str(p["error_code"]);
  return t || preview;
}
function parseFx(o: Obj, out: Ev[], logPath: string): void {
  const e = obj(o["event"]);
  if (!e) return;
  const ms = typeof o["timestamp_ms"] === "number" ? (o["timestamp_ms"] as number) : 0;
  const ts = ms ? new Date(ms).toISOString() : "";
  const u = obj(e["user"]);
  if (u) { const t = str(u["text"]); if (t) out.push({ kind: "user", text: t, ts, id: "", full: "" }); return; }
  const a = obj(e["assistant"]);
  if (a) { const t = str(a["text"]); if (t) out.push({ kind: "assistant", text: t, ts, id: "", full: "" }); return; }
  const r = obj(e["reasoning"]) ?? obj(e["thinking"]);
  if (r) { const t = str(r["text"]) || str(r["summary"]); if (t) out.push({ kind: "thinking", text: t, ts, id: "", full: "" }); return; }
  const c = obj(e["tool_call"]);
  if (c) { const n = str(c["tool_name"]) || "tool"; const aj = str(c["arguments_json"]); out.push({ kind: "tool", text: n + "\u0000" + toolArg(n, null, aj), ts, id: str(c["call_id"]), full: aj }); return; }
  const res = obj(e["tool_result"]);
  if (res) {
    const t = fxResult(str(res["preview"]));
    const art = str(res["artifact_ref"]);
    const dir = logPath.slice(0, logPath.lastIndexOf("/") + 1);
    out.push({ kind: "result", text: (str(res["status"]) === "success" ? "" : "[" + str(res["status"]) + "] ") + t, ts, id: str(res["call_id"]), full: art && dir ? "@file:" + dir + "tool-results/" + art : "" });
    return;
  }
  const done = obj(e["turn_completed"]);
  if (done) {
    const sum = obj(done["turn_summary"]);
    const dur = sum && typeof sum["turn_duration_ms"] === "number" ? " · " + ((sum["turn_duration_ms"] as number) / 1000).toFixed(1) + "s" : "";
    out.push({ kind: "meta", text: "turn complete" + dur, ts, id: "", full: "" });
    return;
  }
  const keys = Object.keys(e);
  if (keys.length && keys[0] !== "turn_started") out.push({ kind: "meta", text: keys[0].replace(/_/g, " "), ts, id: "", full: "" });
}
function parseEvents(h: Harness, line: string, out: Ev[], s: Sess | null): void {
  const o = parse(line);
  if (!o) return;
  const ts = str(o["timestamp"]);
  const type = str(o["type"]);
  if (h === "fx") { parseFx(o, out, s ? s.path : ""); return; }
  if (h === "claude") {
    if (type === "ai-title") { if (s) s.title = str(o["aiTitle"]); return; }
    if (type === "summary") { out.push({ kind: "meta", text: "summary: " + str(o["summary"]), ts, id: "", full: "" }); return; }
    if (type !== "user" && type !== "assistant") return;
    if (o["isMeta"] === true) return;
    if (s) { const c = str(o["cwd"]); if (c) s.cwd = c; const g = str(o["gitBranch"]); if (g) s.branch = g; }
    const m = obj(o["message"]);
    if (!m) return;
    if (s && type === "assistant") { const md = str(m["model"]); if (md) s.model = md; }
    const c = m["content"];
    if (typeof c === "string") {
      const cmd = /<command-name>([^<]*)<\/command-name>/.exec(c);
      const cargs = /<command-args>([^<]*)/.exec(c);
      if (cmd) out.push({ kind: cargs && cargs[1].trim() ? "user" : "meta", text: cmd[1] + (cargs && cargs[1].trim() ? " " + cargs[1].trim() : ""), ts, id: "", full: "" });
      else if (!isNoise(c)) out.push({ kind: "user", text: c, ts, id: "", full: "" });
      return;
    }
    for (const b of arr(c)) {
      const bo = obj(b);
      if (!bo) continue;
      const bt = str(bo["type"]);
      if (bt === "text") { const t = str(bo["text"]); if (type === "assistant") out.push({ kind: "assistant", text: t, ts, id: "", full: "" }); else if (!isNoise(t)) out.push({ kind: "user", text: t, ts, id: "", full: "" }); }
      else if (bt === "thinking") { const t = str(bo["thinking"]); if (t) out.push({ kind: "thinking", text: t, ts, id: "", full: "" }); }
      else if (bt === "tool_use") { const n = str(bo["name"]); const inp = obj(bo["input"]); out.push({ kind: "tool", text: n + "\u0000" + toolArg(n, inp, ""), ts, id: str(bo["id"]), full: inp ? JSON.stringify(inp) : "" }); }
      else if (bt === "tool_result") { const tur = obj(o["toolUseResult"]); out.push({ kind: "result", text: blockText(bo["content"]), ts, id: str(bo["tool_use_id"]), full: tur ? JSON.stringify(tur) : "" }); }
    }
    return;
  }
  // codex
  const p = obj(o["payload"]);
  if (!p) return;
  const pt = str(p["type"]);
  if (type === "session_meta" || type === "turn_context") {
    if (s) { const c = str(p["cwd"]); if (c) s.cwd = c; const md = str(p["model"]); if (md) s.model = md; const g = obj(p["git"]); if (g) { const br = str(g["branch"]); if (br) s.branch = br; } }
    return;
  }
  if (type === "compacted") { out.push({ kind: "meta", text: "context compacted", ts, id: "", full: "" }); return; }
  if (type === "event_msg") {
    if (pt === "task_started") out.push({ kind: "meta", text: "turn started", ts, id: "", full: "" });
    else if (pt === "task_complete") out.push({ kind: "meta", text: "turn complete", ts, id: "", full: "" });
    else if (pt === "turn_aborted") out.push({ kind: "meta", text: "turn aborted", ts, id: "", full: "" });
    return;
  }
  if (type !== "response_item") return;
  if (pt === "message") {
    const role = str(p["role"]);
    const t = blockText(p["content"]);
    if (role === "assistant") out.push({ kind: "assistant", text: t, ts, id: "", full: "" });
    else if (role === "user" && !isNoise(t)) out.push({ kind: "user", text: t, ts, id: "", full: "" });
  } else if (pt === "reasoning") {
    const t = blockText(p["summary"]);
    if (t) out.push({ kind: "thinking", text: t, ts, id: "", full: "" });
  } else if (pt === "function_call" || pt === "custom_tool_call" || pt === "local_shell_call") {
    const n = str(p["name"]) || "shell";
    const act = obj(p["action"]);
    const raw = str(p["arguments"]) || str(p["input"]);
    out.push({ kind: "tool", text: n + "\u0000" + toolArg(n, act, raw), ts, id: str(p["call_id"]), full: act ? JSON.stringify(act) : raw });
  } else if (pt === "function_call_output" || pt === "custom_tool_call_output") {
    out.push({ kind: "result", text: blockText(p["output"]), ts, id: str(p["call_id"]), full: "" });
  }
}

// ── session discovery ───────────────────────────────────────────────────────
const sessions = new Map<string, Sess>();
const codexTitles = new Map<string, string>();
let codexIndexM = 0;

function newSess(h: Harness, id: string, path: string, archived: boolean): Sess {
  return { h, id, path, cwd: "", title: "", prompt: "", branch: "", model: "", mtime: 0, size: 0, headDone: false, tailSize: -1, evs: [], pid: 0, status: "", name: "", archived, parent: "", kind: "", subs: [], last: 0, depth: 0 };
}
function addFile(h: Harness, path: string, id: string, archived: boolean, seen: Set<string>, parent: string): void {
  let mt = 0; let sz = 0;
  try { const st = statSync(path); mt = st.mtimeMs; sz = st.size; } catch (e) { return; }
  let s = sessions.get(path);
  if (!s) {
    s = newSess(h, id, path, archived);
    sessions.set(path, s);
    if (parent) claudeSub(s, parent);
    else if (h === "codex") codexSub(s);
    else if (h === "fx") fxMeta(s);
  }
  s.mtime = mt; s.size = sz;
  seen.add(path);
}
// Claude: <project>/<session>/subagents/agent-<id>.jsonl + agent-<id>.meta.json {agentType, description, model}
function claudeSub(s: Sess, parent: string): void {
  s.parent = parent;
  s.kind = "agent";
  const o = parse(readText(s.path.slice(0, -6) + ".meta.json", 0, 4096).trim());
  if (!o) return;
  s.kind = str(o["agentType"]) || "agent";
  s.title = str(o["description"]);
  s.model = str(o["model"]);
}
// fx: ~/.fx/sessions/<id>/{session.json, events.jsonl, subagent/owner.json {parent_id}}
function fxMeta(s: Sess): void {
  const dir = s.path.slice(0, -"events.jsonl".length);
  const o = parse(readText(dir + "session.json", 0, 65536).trim());
  if (o) {
    s.cwd = str(o["workspace_root"]) || str(o["origin_workspace_root"]);
    s.title = str(o["title"]);
    s.model = str(o["model"]);
    if (o["subagent_child"] === true) s.kind = "subagent";
  }
  const own = parse(readText(dir + "subagent/owner.json", 0, 4096).trim());
  if (own) { s.parent = str(own["parent_id"]); if (!s.kind) s.kind = "subagent"; }
}
// Codex: first line (session_meta) names parent_thread_id + source.subagent {thread_spawn{agent_role,agent_nickname} | other:"guardian"}
function codexSub(s: Sess): void {
  const head = readText(s.path, 0, 8192);
  const par = /"parent_thread_id":"([^"]+)"/.exec(head);
  if (!par || head.indexOf('"subagent"') < 0) return;
  s.parent = par[1];
  const role = /"agent_role":"([^"]*)"/.exec(head);
  const other = /"subagent":\{"other":"([^"]*)"/.exec(head);
  const nick = /"agent_nickname":"([^"]*)"/.exec(head);
  s.kind = role ? role[1] : other ? other[1] : "subagent";
  if (nick) s.name = nick[1];
}
function listDir(p: string): string[] { try { return readdirSync(p); } catch (e) { return []; } }
function scan(): void {
  const seen = new Set<string>();
  const pdir = join(CLAUDE, "projects");
  for (const proj of listDir(pdir)) {
    for (const f of listDir(join(pdir, proj))) {
      if (f.endsWith(".jsonl")) { addFile("claude", join(pdir, proj, f), f.slice(0, -6), false, seen, ""); continue; }
      if (f.length !== 36) continue; // <session-uuid>/ dirs hold subagent transcripts
      const sd = join(pdir, proj, f, "subagents");
      for (const a of listDir(sd)) if (a.endsWith(".jsonl")) addFile("claude", join(sd, a), a.slice(6, -6), false, seen, f);
    }
  }
  const walk = (dir: string, archived: boolean, depth: number): void => {
    for (const f of listDir(dir)) {
      const p = join(dir, f);
      if (f.endsWith(".jsonl")) addFile("codex", p, f.length > 42 ? f.slice(-42, -6) : f, archived, seen, "");
      else if (depth < 3 && /^\d+$/.test(f)) walk(p, archived, depth + 1);
    }
  };
  walk(join(CODEX, "sessions"), false, 0);
  const fxd = join(FX, "sessions");
  for (const id of listDir(fxd)) addFile("fx", join(fxd, id, "events.jsonl"), id, false, seen, "");
  walk(join(CODEX, "archived_sessions"), true, 3);
  for (const k of [...sessions.keys()]) if (!seen.has(k)) sessions.delete(k);
  // codex thread names
  const idx = join(CODEX, "session_index.jsonl");
  try {
    const st = statSync(idx);
    if (st.mtimeMs !== codexIndexM) {
      codexIndexM = st.mtimeMs;
      for (const l of readText(idx, 0, st.size).split("\n")) { const o = parse(l); if (o) codexTitles.set(str(o["id"]), str(o["thread_name"])); }
    }
  } catch (e) { /* no codex */ }
}
function loadHead(s: Sess): void {
  s.headDone = true;
  const evs: Ev[] = [];
  for (const l of readText(s.path, 0, s.h === "claude" ? 131072 : 524288).split("\n")) {
    parseEvents(s.h, l, evs, s);
    if (!s.prompt) for (const e of evs) if (e.kind === "user") { s.prompt = firstLine(e.text, 200); break; }
  }
}
function loadTail(s: Sess): void {
  if (s.tailSize === s.size) return;
  s.tailSize = s.size;
  if (s.h === "fx") fxMeta(s);
  const start = Math.max(0, s.size - 98304);
  const r = readLines(s.path, start, s.size, start > 0);
  const evs: Ev[] = [];
  for (const l of r.lines) parseEvents(s.h, l, evs, s);
  s.evs = evs.slice(-60);
  if (!s.prompt) for (const e of evs) if (e.kind === "user") { s.prompt = firstLine(e.text, 200); break; } // head was read before the first prompt
}
function titleOf(s: Sess): string {
  if (s.h === "codex") { const t = codexTitles.get(s.id); if (t) return t; }
  return s.title || s.prompt || "(no prompt yet)";
}

// ── processes ───────────────────────────────────────────────────────────────
let procs: Proc[] = [];
const allProcs = new Map<number, Proc>();
const hist = new Map<number, number[]>();
const cpuHist: number[] = [];
const tmuxByTty = new Map<string, string>();
const cwdByPid = new Map<number, string>();
const codexPidByPath = new Map<string, number>();
const claudeLive = new Map<string, { pid: number; status: string; name: string }>();

function harnessOf(args: string): string {
  const t = args.split(" ");
  let b = base(t[0]);
  if ((b === "node" || b === "bun" || b === "deno") && t.length > 1) b = base(t[1]).replace(/\.(m?js|ts)$/, "");
  return HARN.indexOf(b) >= 0 ? b : "";
}
function run(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }); } catch (e) { return ""; }
}
function refreshProcs(): void {
  allProcs.clear();
  const kids = new Map<number, number[]>();
  for (const l of run("ps", ["-axo", "pid=,ppid=,pcpu=,rss=,etime=,tty=,args="]).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(l);
    if (!m) continue;
    const p: Proc = { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rss: Number(m[4]) * 1024, etime: m[5], tty: m[6], args: m[7], h: "", cwd: "", tcpu: 0, trss: 0, kids: 0, sess: "" };
    p.h = harnessOf(p.args);
    allProcs.set(p.pid, p);
    const k = kids.get(p.ppid);
    if (k) k.push(p.pid); else kids.set(p.ppid, [p.pid]);
  }
  const out: Proc[] = [];
  let total = 0;
  for (const p of allProcs.values()) {
    if (!p.h) continue;
    const parent = allProcs.get(p.ppid);
    if (parent && parent.h) continue; // wrapper→binary: count as child of the outer one
    const stack = [p.pid];
    while (stack.length) {
      const q = allProcs.get(stack.pop() as number);
      if (!q) continue;
      p.tcpu += q.cpu; p.trss += q.rss; if (q !== p) p.kids++;
      for (const c of kids.get(q.pid) ?? []) stack.push(c);
    }
    const hh = hist.get(p.pid) ?? [];
    hh.push(p.tcpu); if (hh.length > 120) hh.shift();
    hist.set(p.pid, hh);
    p.cwd = cwdByPid.get(p.pid) ?? "";
    total += p.tcpu;
    out.push(p);
  }
  for (const k of [...hist.keys()]) if (!allProcs.has(k)) hist.delete(k);
  cpuHist.push(total); if (cpuHist.length > 240) cpuHist.shift();
  out.sort((a, b) => b.tcpu - a.tcpu || a.pid - b.pid);
  const sp = procAt(psel); const selPid = sp ? sp.pid : 0;
  procs = out;
  for (let i = 0; i < procs.length; i++) if (procs[i].pid === selPid) psel = i; // selection follows the pid, not the row
  // claude live registry
  claudeLive.clear();
  const sd = join(CLAUDE, "sessions");
  for (const f of listDir(sd)) {
    if (!f.endsWith(".json")) continue;
    const o = parse(readText(join(sd, f), 0, 8192).trim());
    if (!o) continue;
    const pid = typeof o["pid"] === "number" ? (o["pid"] as number) : 0;
    if (pid && allProcs.has(pid)) claudeLive.set(str(o["sessionId"]), { pid, status: str(o["status"]), name: str(o["name"]) });
  }
  linkSessions();
}
function refreshSlow(): void {
  // cwd + open rollout files of harness procs (lsof), tmux panes
  cwdByPid.clear(); codexPidByPath.clear();
  const pids = procs.map((p) => String(p.pid));
  if (pids.length) {
    let pid = 0; let fd = "";
    for (const l of run("lsof", ["-a", "-p", pids.join(","), "-Fpfn"]).split("\n")) {
      if (l.startsWith("p")) pid = Number(l.slice(1));
      else if (l.startsWith("f")) fd = l.slice(1);
      else if (l.startsWith("n")) {
        const n = l.slice(1);
        if (fd === "cwd") cwdByPid.set(pid, n);
        else if (n.endsWith(".jsonl") && (n.indexOf("/rollout-") >= 0 || n.indexOf("/.fx/sessions/") >= 0)) codexPidByPath.set(n, pid);
      }
    }
  }
  tmuxByTty.clear();
  for (const l of run("tmux", ["list-panes", "-a", "-F", "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}"]).split("\n")) {
    const i = l.indexOf(" ");
    if (i > 0) tmuxByTty.set(l.slice(0, i), l.slice(i + 1));
  }
  for (const p of procs) p.cwd = cwdByPid.get(p.pid) ?? "";
  linkSessions();
}
function rootOf(pid: number): Proc | null {
  let q = allProcs.get(pid);
  while (q) { const par = allProcs.get(q.ppid); if (!par || !par.h) break; q = par; }
  return q ?? null;
}
function linkSessions(): void {
  for (const s of sessions.values()) {
    s.pid = 0; s.status = ""; s.name = "";
    if (s.h === "claude") { const l = claudeLive.get(s.id); if (l) { s.pid = l.pid; s.status = l.status; s.name = l.name; } }
    else { const pid = codexPidByPath.get(s.path); if (pid && allProcs.has(pid)) { const r = rootOf(pid); s.pid = r ? r.pid : pid; s.status = "open"; } }
  }
  for (const p of procs) p.sess = "";
  for (const s of sessions.values()) if (s.pid) { const r = rootOf(s.pid); if (r) r.sess = s.path; }
}
function tmuxTarget(pid: number): string {
  const p = allProcs.get(pid);
  if (!p || p.tty === "??") return "";
  return tmuxByTty.get("/dev/" + p.tty) ?? "";
}

// ── text width / ansi ───────────────────────────────────────────────────────
const CSI = "\x1b[";
const RST = CSI + "0m";
function fg(c: string): string { return CSI + "38;2;" + c + "m"; }
function bg(c: string): string { return CSI + "48;2;" + c + "m"; }
const C = {
  text: "220;223;228", sub: "150;156;168", dim: "96;101;112", line: "58;62;72", sel: "40;44;54", panel: "22;24;30",
  accent: "122;162;247", claude: "217;119;87", codex: "110;180;255", fx: "94;234;212", green: "126;211;135", yellow: "229;192;123",
  red: "240;113;120", cyan: "125;207;255", purple: "187;154;247",
};
function cpOf(ch: string): number {
  const a = ch.charCodeAt(0);
  if (a >= 0xd800 && a <= 0xdbff && ch.length > 1) return (a - 0xd800) * 0x400 + (ch.charCodeAt(1) - 0xdc00) + 0x10000;
  return a;
}
function cw(c: number): number {
  if (c < 32 || (c >= 0x7f && c < 0xa0) || (c >= 0x300 && c < 0x370) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) return 0;
  if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)) return 2;
  return 1;
}
function width(s: string): number { let w = 0; for (const ch of s) w += cw(cpOf(ch)); return w; }
function clean(s: string): string { return s.replace(/\t/g, "  ").replace(/[\u0000-\u001f\u007f]/g, " "); }
// truncate to w columns (with …) and pad with spaces to exactly w
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  let out = ""; let n = 0;
  const full = width(s) <= w;
  for (const ch of s) {
    const c = cw(cpOf(ch));
    if (!full && n + c > w - 1) { out += "…"; n += 1; break; }
    out += ch; n += c;
  }
  return n < w ? out + " ".repeat(w - n) : out;
}
function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  for (const raw of s.split("\n")) {
    const l = clean(raw);
    if (l.length === 0) { out.push(""); continue; }
    let cur = ""; let n = 0;
    for (const ch of l) {
      const c = cw(cpOf(ch));
      if (n + c > w) { out.push(cur); cur = ""; n = 0; }
      cur += ch; n += c;
    }
    out.push(cur);
  }
  return out;
}
function localHM(iso: string): string {
  const d = new Date(iso);
  const h = d.getHours(); const m = d.getMinutes();
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}
function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
function bytes(n: number): string {
  if (n < 1024) return n + "B";
  if (n < 1048576) return (n / 1024).toFixed(0) + "K";
  if (n < 1073741824) return (n / 1048576).toFixed(n < 104857600 ? 1 : 0) + "M";
  return (n / 1073741824).toFixed(1) + "G";
}
function home(p: string): string { return p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p; }
function lerp(a: string, b: string, t: number): string {
  const x = a.split(";"); const y = b.split(";");
  const r: string[] = [];
  for (let i = 0; i < 3; i++) r.push(String(Math.round(Number(x[i]) + (Number(y[i]) - Number(x[i])) * t)));
  return r.join(";");
}
function heat(t: number): string { return t < 0.5 ? lerp(C.green, C.yellow, t * 2) : lerp(C.yellow, C.red, Math.min(1, (t - 0.5) * 2)); }

// ── screen buffer ───────────────────────────────────────────────────────────
let W = 80; let H = 24;
let buf: string[] = [];
function put(x: number, y: number, s: string): void { if (y >= 0 && y < H) buf.push(CSI + (y + 1) + ";" + (x + 1) + "H" + s); }
// styled segment helper: fixed-width text with style
function seg(style: string, text: string, w: number): string { return style + fit(clean(text), w) + RST; }
function box(x: number, y: number, w: number, h: number, title: string, info: string, focus: boolean): void {
  const bc = fg(focus ? C.accent : C.line);
  let t = title ? " " + clean(title) + " " : "";
  if (width(t) > w - 4) t = fit(t, w - 4);
  let i = info ? " " + clean(info) + " " : "";
  const room = w - 4 - width(t);
  if (width(i) > room) i = room > 2 ? "…" + Array.from(i).slice(-(room - 1)).join("") : "";
  const mid = Math.max(0, w - 3 - width(t) - width(i));
  put(x, y, bc + "╭─" + (focus ? CSI + "1m" + fg(C.text) : fg(C.sub)) + t + RST + bc + "─".repeat(mid) + fg(C.dim) + i + bc + "╮" + RST);
  for (let r = 1; r < h - 1; r++) { put(x, y + r, bc + "│" + RST); put(x + w - 1, y + r, bc + "│" + RST); }
  put(x, y + h - 1, bc + "╰" + "─".repeat(Math.max(0, w - 2)) + "╯" + RST);
}
// harness "logos": Claude's terracotta spark vs. Codex's terminal prompt — distinct in shape, color and name
const BADGE_W = 10;
function badge(h: string): string {
  if (h === "claude") return fg(C.claude) + CSI + "1m" + "✻" + RST + fg(C.claude) + " Claude  " + RST;
  if (h === "codex") return bg("236;236;240") + fg("16;16;20") + CSI + "1m" + ">_" + RST + fg("236;236;240") + " Codex  " + RST;
  if (h === "fx") return fg("255;255;255") + CSI + "1m" + "▲" + RST + fg(C.fx) + CSI + "1m" + " 𝒇x" + RST + fg(C.fx) + "      " + RST;
  return fg(C.purple) + CSI + "1m" + "◆" + RST + fg(C.purple) + " " + fit(h, BADGE_W - 2) + RST;
}
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let frame = 0;
function statusGlyph(s: Sess): string {
  if (s.pid) {
    const busy = s.status === "busy" || (s.h !== "claude" && working(s)) || Date.now() - s.mtime < 8000;
    return busy ? fg(C.green) + SPIN[frame % SPIN.length] + RST : fg(C.yellow) + "●" + RST;
  }
  if (Date.now() - s.mtime < 120000) return fg(C.green) + "○" + RST;
  return fg(C.dim) + "·" + RST;
}
function working(s: Sess): boolean {
  for (let i = s.evs.length - 1; i >= 0; i--) {
    const e = s.evs[i];
    if (e.kind === "meta" && e.text === "turn started") return true;
    if (e.kind === "meta" && (e.text.startsWith("turn complete") || e.text === "turn aborted")) return false;
    if (s.h === "fx" && e.kind === "user") return true; // fx logs no turn-start marker
  }
  return false;
}
function activity(s: Sess): string {
  const e = s.evs.length ? s.evs[s.evs.length - 1] : null;
  if (!e) return "";
  if (e.kind === "tool") { const i = e.text.indexOf("\u0000"); return "⚒ " + e.text.slice(0, i) + " " + firstLine(e.text.slice(i + 1), 80); }
  if (e.kind === "result") return "⎿ tool result";
  if (e.kind === "thinking") return "∴ thinking";
  if (e.kind === "user") return "❯ " + firstLine(e.text, 80);
  if (e.kind === "assistant") return "⏺ " + firstLine(e.text, 80);
  return e.text;
}
// braille area graph (btop style): values 0..max, each cell holds 2 samples × 4 levels
function braille(vals: number[], w: number, h: number, max: number): string[] {
  const rows: string[] = [];
  const need = w * 2;
  const v = vals.slice(-need);
  while (v.length < need) v.unshift(0);
  const levels = h * 4;
  const lv = v.map((x) => (x <= 0 ? 0 : Math.max(1, Math.round((Math.min(x, max) / max) * levels))));
  const L = [0x40, 0x04, 0x02, 0x01]; const R = [0x80, 0x20, 0x10, 0x08]; // bottom→top dots
  for (let r = 0; r < h; r++) {
    const floor = (h - 1 - r) * 4;
    let line = "";
    for (let c = 0; c < w; c++) {
      let bits = 0;
      const a = lv[c * 2] - floor; const b = lv[c * 2 + 1] - floor;
      for (let k = 0; k < 4; k++) { if (a > k) bits |= L[k]; if (b > k) bits |= R[k]; }
      line += String.fromCharCode(0x2800 + bits);
    }
    rows.push(line);
  }
  return rows;
}
function gauge(frac: number, w: number): string {
  let s = "";
  const filled = Math.round(Math.max(0, Math.min(1, frac)) * w);
  for (let i = 0; i < w; i++) s += i < filled ? fg(heat(i / Math.max(1, w - 1))) + "■" : fg(C.line) + "■";
  return s + RST;
}

// ── app state ───────────────────────────────────────────────────────────────
type Mode = "list" | "transcript" | "detail" | "input" | "confirm" | "help";
let tab = 0; // 0 sessions, 1 processes
let mode: Mode = "list";
let sel = 0; let top = 0;
let psel = 0; let ptop = 0;
let filter = "";
let hfilter = ""; // "", "claude", "codex", "fx"
let liveOnly = false;
let fulltext = new Set<string>(); let useFull = false; let fullq = "";
let view: Sess[] = [];
let toast = ""; let toastKind = "info"; let toastAt = 0;
let inputLabel = ""; let inputText = ""; let inputAction = "";
let confirmText = ""; let confirmAction = "";
let listY = 0; let listH = 0; let listX = 0; let listW = 0;
interface TV {
  s: Sess; evs: Ev[]; off: number; scroll: number; follow: boolean; expand: boolean; lines: string[]; lw: number; ln: number; lexp: boolean;
  cur: number; lineEv: number[]; lineStart: number[]; // event cursor + rendered-line ↔ event maps
  focusKind: string; focusTs: string; focusText: string; // jump target when opened from the preview
}
// detail layer: one event (tool call + its result) fully expanded
interface DV { idx: number; lines: string[]; plain: string; files: string[]; fileRow: number[]; fsel: number; scroll: number; title: string; lw: number }
let dv: DV | null = null;
// mouse hit maps, rebuilt every frame
const footX0: number[] = []; const footX1: number[] = []; const footKey: string[] = [];
const prevKind: number[] = []; const prevIdx: number[] = []; // per preview row: 0 none, 1 subagent (idx into prevKids), 2 event (idx into prevSess.evs)
const prevKids: Sess[] = [];
let prevSess: Sess | null = null; let prevY0 = 0; let prevX0 = 0; let prevX1 = 0;
let lastClickY = -1; let lastClickAt = 0;
let tv: TV | null = null;

function say(kind: string, msg: string): void { toast = msg; toastKind = kind; toastAt = Date.now(); }
// ── subagent tree ───────────────────────────────────────────────────────────
const expanded = new Set<string>(); const collapsed = new Set<string>();
const AUTO_KIDS = 8; // auto-expanded parents show this many children; an explicit expand shows all
function subActive(s: Sess): boolean { return Date.now() - s.mtime < 45000; }
function activeSubs(s: Sess): number { let n = 0; for (const c of s.subs) if (subActive(c)) n++; return n; }
function isOpen(s: Sess): boolean {
  if (collapsed.has(s.path)) return false;
  return expanded.has(s.path) || activeSubs(s) > 0; // auto-expand while subagents work
}
function matches(s: Sess, q: string): boolean {
  if (useFull && !fulltext.has(s.path)) return false;
  if (!q) return true;
  return (titleOf(s) + " " + s.cwd + " " + s.id + " " + s.h + " " + s.name + " " + s.branch + " " + s.kind).toLowerCase().indexOf(q) >= 0;
}
function parentOf(s: Sess): Sess | null {
  if (!s.parent) return null;
  for (const p of sessions.values()) if (!p.parent && p.h === s.h && p.id === s.parent) return p;
  return null;
}
function buildView(): void {
  const q = filter.toLowerCase();
  const filtering = q !== "" || useFull;
  const roots = new Map<string, Sess>();
  for (const s of sessions.values()) { s.subs = []; s.last = s.mtime; s.depth = 0; if (!s.parent) roots.set(s.h + ":" + s.id, s); }
  for (const s of sessions.values()) {
    if (!s.parent) continue;
    const p = roots.get(s.h + ":" + s.parent);
    if (!p) continue; // orphan subagent: listed as its own root
    p.subs.push(s); s.depth = 1;
    if (s.mtime > p.last) p.last = s.mtime;
  }
  const tops: Sess[] = [];
  for (const s of sessions.values()) {
    if (s.depth !== 0) continue;
    if (hfilter && s.h !== hfilter) continue;
    if (liveOnly && !s.pid && activeSubs(s) === 0) continue;
    if (!matches(s, q) && !(filtering && s.subs.some((c) => matches(c, q)))) continue;
    tops.push(s);
  }
  tops.sort((a, b) => (b.pid ? 1 : 0) - (a.pid ? 1 : 0) || b.last - a.last);
  const out: Sess[] = [];
  for (const t of tops) {
    out.push(t);
    if (!t.subs.length || collapsed.has(t.path) || !(filtering || isOpen(t))) continue;
    const kids = filtering ? t.subs.filter((c) => matches(c, q)) : t.subs.slice();
    kids.sort((a, b) => (subActive(b) ? 1 : 0) - (subActive(a) ? 1 : 0) || b.mtime - a.mtime);
    const n = filtering || expanded.has(t.path) ? kids.length : Math.max(AUTO_KIDS, activeSubs(t));
    for (const c of kids.slice(0, n)) out.push(c);
  }
  const cur = sessAt(sel);
  view = out;
  if (cur) { const i = view.indexOf(cur); if (i >= 0) sel = i; }
  sel = Math.max(0, Math.min(sel, view.length - 1));
}
// bounds-checked reads: in scriptc an out-of-range object read traps instead of yielding undefined
function sessAt(i: number): Sess | null { return i >= 0 && i < view.length ? view[i] : null; }
function procAt(i: number): Proc | null { return i >= 0 && i < procs.length ? procs[i] : null; }
function current(): Sess | null { return sessAt(sel); }
function procSess(p: Proc): Sess | null { return p.sess ? sessions.get(p.sess) ?? null : null; }

// ── rendering ───────────────────────────────────────────────────────────────
function renderHeader(): void {
  let live = 0; let busy = 0;
  for (const s of sessions.values()) if (s.pid) { live++; if (s.status === "busy" || working(s)) busy++; }
  const cpu = cpuHist.length ? cpuHist[cpuHist.length - 1] : 0;
  let mem = 0; for (const p of procs) mem += p.trss;
  const tabs = [" Sessions ", " Processes "];
  let x = 0;
  let s = bg(C.accent) + fg("20;20;24") + CSI + "1m" + " ◈ agentglass " + RST + " ";
  x = 16;
  for (let i = 0; i < 2; i++) {
    s += (i === tab ? bg(C.sel) + fg(C.text) + CSI + "1m" + CSI + "4m" : fg(C.sub)) + (i + 1) + tabs[i] + RST + " ";
    x += tabs[i].length + 2;
  }
  const spark = braille(cpuHist, 16, 1, Math.max(100, Math.max(...cpuHist.slice(-32))))[0];
  const right = fg(C.green) + "● " + live + " live" + RST + fg(C.dim) + " · " + RST + fg(C.yellow) + busy + " busy" + RST + fg(C.dim) + " · " + RST +
    fg(C.sub) + "cpu " + RST + fg(heat(cpu / 400)) + cpu.toFixed(1) + "% " + spark + RST + fg(C.dim) + " · " + RST +
    fg(C.sub) + "mem " + RST + fg(C.text) + bytes(mem) + RST + fg(C.dim) + "/" + bytes(TOTALMEM) + " · " + sessions.size + " sessions " + RST;
  const rw = width(right.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
  put(0, 0, s + " ".repeat(Math.max(0, W - x - rw)) + (W - x > rw ? right : ""));
}
function renderFooter(): void {
  const y = H - 1;
  if (mode === "input") {
    put(0, y, bg(C.sel) + fg(C.accent) + CSI + "1m" + " " + inputLabel + " ❯ " + RST + bg(C.sel) + fg(C.text) + fit(clean(inputText) + "▏", W - inputLabel.length - 4) + RST);
    return;
  }
  footX0.length = 0; footX1.length = 0; footKey.length = 0;
  let fx = 0;
  const k = (key: string, what: string): string => {
    const w = width(key) + 1 + width(what);
    // clickable: the hint's key, when it maps to one keystroke
    const act = key === "↵" ? "enter" : key === "␣" ? " " : key === "esc" ? "esc" : key === "tab" ? "tab" : width(key.split("/")[0]) === 1 && key.split("/")[0].length === 1 ? key.split("/")[0] : "";
    if (act) { footX0.push(fx); footX1.push(fx + w); footKey.push(act); }
    fx += w + 2;
    return fg(C.accent) + CSI + "1m" + key + RST + fg(C.sub) + " " + what + "  " + RST;
  };
  let hints = "";
  if (mode === "detail") hints = k("?", "keys") + k("↑↓/jk", "scroll") + k("[/]", "prev/next event") + k("1-9", "open file") + k("tab", "select file") + k("o", "pager") + k("e", "edit") + k("v", "all in pager") + k("y", "copy") + k("esc", "back");
  else if (mode === "transcript") hints = k("?", "keys") + k("↑↓/jk", "event") + k("↵", "details") + k("g/G", "top/end") + k("f", "follow") + k("t", "expand tools") + k("n/N", "subagents") + k("u", "parent") + k("s", "send") + k("R", "resume") + k("esc", "back");
  else if (tab === 0) hints = k("?", "keys") + k("↵", "open") + k("␣", "subagents") + k("/", "filter") + k("F", "full-text") + k("h", "harness") + k("l", "live") + k("s", "send") + k("R", "resume") + k("x", "kill") + k("D", "trash");
  else hints = k("?", "keys") + k("↵", "session") + k("s", "send") + k("x", "SIGTERM") + k("X", "SIGKILL") + k("a", "attach tmux") + k("q", "quit");
  put(0, y, fitStyled(hints, W - 1) + CSI + "K");
  if (toast && Date.now() - toastAt < 5000) {
    const icon = toastKind === "ok" ? "✔" : toastKind === "err" ? "✖" : toastKind === "warn" ? "⚠" : "ℹ";
    const col = toastKind === "ok" ? C.green : toastKind === "err" ? C.red : toastKind === "warn" ? C.yellow : C.cyan;
    const msg = " " + icon + " " + clean(toast) + " ";
    const w = Math.min(W - 4, width(msg) + 2);
    const x = W - w - 1;
    put(x, H - 4, fg(col) + "╭" + "─".repeat(w - 2) + "╮" + RST);
    put(x, H - 3, fg(col) + "│" + RST + bg(C.panel) + fg(col) + CSI + "1m" + fit(msg, w - 2) + RST + fg(col) + "│" + RST);
    put(x, H - 2, fg(col) + "╰" + "─".repeat(w - 2) + "╯" + RST);
  }
}
function evLines(e: Ev, w: number, expand: boolean, out: string[]): void {
  const tsx = e.ts.length >= 16 ? localHM(e.ts) : "";
  if (e.kind === "user") {
    out.push("");
    const ls = wrap(e.text, w - 2);
    for (let i = 0; i < ls.length; i++) out.push((i === 0 ? fg(C.cyan) + CSI + "1m" + "❯ " : "  ") + RST + bg(C.sel) + fg(C.text) + fit(ls[i], w - 8) + RST + (i === 0 ? fg(C.dim) + " " + fit(tsx, 5) + RST : ""));
  } else if (e.kind === "assistant") {
    const ls = wrap(e.text, w - 2);
    for (let i = 0; i < ls.length; i++) out.push((i === 0 ? fg(C.text) + "⏺ " : "  ") + RST + fg(C.text) + ls[i] + RST);
  } else if (e.kind === "thinking") {
    const ls = wrap(e.text, w - 2);
    const n = expand ? ls.length : Math.min(2, ls.length);
    for (let i = 0; i < n; i++) out.push(fg(C.dim) + CSI + "3m" + (i === 0 ? "∴ " : "  ") + ls[i] + RST);
    if (n < ls.length) out.push(fg(C.dim) + "  … " + (ls.length - n) + " more lines" + RST);
  } else if (e.kind === "tool") {
    const i = e.text.indexOf("\u0000");
    const name = e.text.slice(0, i);
    const ls = wrap(e.text.slice(i + 1), w - 4 - width(name));
    const n = expand ? ls.length : Math.min(3, ls.length);
    for (let j = 0; j < n; j++) out.push((j === 0 ? fg(C.yellow) + "⚒ " + CSI + "1m" + name + RST + fg(C.sub) + "(" : " ".repeat(width(name) + 3) + fg(C.sub)) + ls[j] + (j === n - 1 ? (n < ls.length ? " …" : ")") : "") + RST);
  } else if (e.kind === "result") {
    const ls = wrap(e.text.length > 20000 ? e.text.slice(0, 20000) : e.text, w - 4);
    const n = expand ? ls.length : Math.min(3, ls.length);
    for (let j = 0; j < n; j++) out.push(fg(C.line) + (j === 0 ? "  ⎿ " : "    ") + fg(C.dim) + ls[j] + RST);
    if (n < ls.length) out.push(fg(C.dim) + "    … +" + (ls.length - n) + " lines (t to expand)" + RST);
  } else {
    out.push(fg(C.line) + "── " + fg(C.purple) + clean(e.text) + fg(C.line) + " " + "─".repeat(Math.max(0, w - width(e.text) - 5)) + RST);
  }
}
function renderSessions(): void {
  const wide = W >= 110;
  const bodyH = H - 2;
  listW = wide ? Math.floor(W * 0.52) : W;
  const lh = wide ? bodyH : Math.max(6, Math.floor(bodyH * 0.55));
  listX = 0; listY = 2; listH = lh - 2;
  const chips = (hfilter ? hfilter + " · " : "") + (liveOnly ? "live · " : "") + (filter ? "/" + filter + " · " : "") + (fullq ? "F:" + fullq + " · " : "");
  box(0, 1, listW, lh, "sessions", chips + (view.length ? sel + 1 : 0) + "/" + view.length, mode === "list");
  if (sel < top) top = sel;
  if (sel >= top + listH) top = sel - listH + 1;
  const iw = listW - 2;
  let pending = 0;
  for (let r = 0; r < listH; r++) {
    const s = sessAt(top + r);
    if (!s) { put(1, 2 + r, " ".repeat(iw)); continue; }
    if (!s.headDone && pending < 40) { loadHead(s); pending++; }
    const on = top + r === sel;
    const b = on ? bg(C.sel) : "";
    const cursor = b + (on ? fg(C.accent) + "❯" : " ") + RST + b;
    const tstyle = on ? fg(C.text) + CSI + "1m" : fg(C.sub);
    if (s.depth === 1) {
      const nx = sessAt(top + r + 1);
      const branch = nx && nx.depth === 1 ? "├─" : "└─";
      const glyph = subActive(s) ? fg(C.cyan) + SPIN[frame % SPIN.length] : fg(C.dim) + "·";
      const who = s.name ? s.name + " · " : "";
      put(1, 2 + r, cursor + "   " + fg(C.line) + branch + " " + glyph + RST + b + " " + fg(C.purple) + fit(s.kind, 16) + fg(C.dim) + fit(ago(s.mtime), 5) + RST + b + tstyle + fit(clean(who + titleOf(s)), iw - 30) + RST);
      continue;
    }
    const proj = base(s.cwd) || "?";
    const chip = s.subs.length ? (isOpen(s) ? "▾" : "▸") + "⑂" + activeSubs(s) + "/" + s.subs.length : "";
    const cw2 = chip ? Math.min(12, width(chip) + 1) : 0;
    const tw = iw - 21 - BADGE_W - cw2;
    const row = cursor + statusGlyph(s) + b + " " + badge(s.h) + b + fg(C.dim) + fit(ago(s.last), 4) + RST + b + fg(C.purple) + fit(proj, 13) + RST + b + " " +
      tstyle + fit(clean(titleOf(s)), tw) + RST + b + (activeSubs(s) ? fg(C.cyan) : fg(C.dim)) + fit(chip, cw2) + RST;
    put(1, 2 + r, row);
  }
  const s = current();
  const px = wide ? listW : 0; const py = wide ? 1 : 1 + lh; const pw = wide ? W - listW : W; const ph = wide ? bodyH : bodyH - lh;
  box(px, py, pw, ph, "preview", s ? s.h + " · " + bytes(s.size) : "", false);
  const iw2 = pw - 4;
  const lines: string[] = [];
  prevKind.length = 0; prevIdx.length = 0; prevKids.length = 0; prevSess = s; prevY0 = py + 1; prevX0 = px; prevX1 = px + pw;
  const hit = (kind: number, idx: number): void => { while (prevKind.length < lines.length - 1) { prevKind.push(0); prevIdx.push(0); } prevKind.push(kind); prevIdx.push(idx); };
  if (s) {
    if (!s.headDone) loadHead(s);
    loadTail(s);
    lines.push(fg(C.text) + CSI + "1m" + fit(clean(titleOf(s)), iw2) + RST);
    const kv = (k: string, v: string, c: string): void => { lines.push(fg(C.dim) + fit(k, 9) + RST + fg(c) + fit(clean(v), iw2 - 9) + RST); };
    kv("id", s.id, C.sub);
    kv("cwd", home(s.cwd), C.purple);
    if (s.branch) kv("branch", s.branch, C.green);
    if (s.model) kv("model", s.model, C.cyan);
    kv("updated", ago(s.mtime) + " ago · " + new Date(s.mtime).toISOString().slice(0, 10) + " " + localHM(new Date(s.mtime).toISOString()), C.sub);
    if (s.pid) { const t = tmuxTarget(s.pid); kv("process", "pid " + s.pid + (s.status ? " · " + s.status : "") + (s.name ? " · " + s.name : "") + (t ? " · tmux " + t : ""), C.green); }
    else kv("process", s.archived ? "archived" : "not running", C.dim);
    if (s.depth === 1 || s.parent) { const par = parentOf(s); kv("subagent", s.kind + (s.name ? " · " + s.name : "") + (par ? "  ↰ " + titleOf(par) : ""), C.cyan); }
    if (s.subs.length) {
      lines.push(fg(C.line) + "─ " + fg(C.cyan) + "subagents " + fg(C.dim) + activeSubs(s) + " active / " + s.subs.length + RST);
      const kids = s.subs.slice().sort((a, b) => (subActive(b) ? 1 : 0) - (subActive(a) ? 1 : 0) || b.mtime - a.mtime).slice(0, 6);
      for (const c of kids) {
        loadTail(c);
        const g = subActive(c) ? fg(C.cyan) + SPIN[frame % SPIN.length] : fg(C.dim) + "·";
        prevKids.push(c);
        lines.push(g + " " + fg(C.purple) + fit(c.kind, 14) + fg(C.dim) + fit(ago(c.mtime), 5) + fg(C.sub) + fit(clean(titleOf(c)), Math.max(10, Math.floor((iw2 - 21) / 2))) + fg(C.dim) + " " + fit(clean(activity(c)), Math.max(0, iw2 - 22 - Math.max(10, Math.floor((iw2 - 21) / 2)))) + RST);
        hit(1, prevKids.length - 1);
      }
    }
    lines.push(fg(C.line) + "─".repeat(iw2) + RST);
    const act: string[] = []; const actEv: number[] = [];
    for (let i = Math.max(0, s.evs.length - 25); i < s.evs.length; i++) { evLines(s.evs[i], iw2, false, act); while (actEv.length < act.length) actEv.push(i); }
    const room = ph - 2 - lines.length;
    const from = Math.max(0, act.length - room);
    for (let i = from; i < act.length; i++) { lines.push(act[i]); hit(2, actEv[i]); }
  }
  for (let r = 0; r < ph - 2; r++) put(px + 1, py + 1 + r, " " + (lines[r] ?? "") + CSI + "0m" + " ".repeat(0) + fillTo(lines[r] ?? "", iw2) + " ");
}
// pad a styled line (already ≤ w visible) to width w using its visible width
function fillTo(styled: string, w: number): string {
  const vis = styled.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const n = width(vis);
  return n < w ? " ".repeat(w - n) : "";
}
function renderProcs(): void {
  const bodyH = H - 2;
  const th = Math.max(6, Math.floor(bodyH * 0.5));
  listX = 0; listY = 3; listH = th - 3; listW = W;
  box(0, 1, W, th, "harness processes", procs.length + " roots", mode === "list");
  const cols = fg(C.dim) + CSI + "1m" + fit("  PID", 8) + fit("AGENT", BADGE_W + 1) + fit("CPU%", 7) + fit("MEM", 7) + fit("KIDS", 5) + fit("UP", 12) + fit("CPU GRAPH", 17) + fit("SESSION / CWD", W - 69) + RST;
  put(1, 2, cols);
  if (psel >= procs.length) psel = Math.max(0, procs.length - 1);
  if (psel < ptop) ptop = psel;
  if (psel >= ptop + listH) ptop = psel - listH + 1;
  for (let r = 0; r < listH; r++) {
    const p = procAt(ptop + r);
    if (!p) { put(1, 3 + r, " ".repeat(W - 2)); continue; }
    const on = ptop + r === psel;
    const b = on ? bg(C.sel) : "";
    const s = procSess(p);
    const where = s ? clean(titleOf(s)) + "  " + home(s.cwd || p.cwd) : home(p.cwd) || p.args;
    const ph0 = hist.get(p.pid) ?? [];
    const g = braille(ph0, 16, 1, Math.max(20, Math.max(...ph0)))[0];
    put(1, 3 + r, b + (on ? fg(C.accent) + "❯" : " ") + fg(C.sub) + fit(String(p.pid), 7) + RST + badge(p.h) + b + " " + fg(heat(p.tcpu / 100)) + fit(p.tcpu.toFixed(1), 7) + fg(C.text) + fit(bytes(p.trss), 7) +
      fg(C.sub) + fit(String(p.kids), 5) + fit(p.etime, 12) + fg(heat(Math.min(1, p.tcpu / 100))) + g + " " + (s ? fg(C.text) : fg(C.dim)) + fit(where, W - 69) + RST);
  }
  // detail
  const p = procAt(psel);
  const dy = 1 + th; const dh = bodyH - th;
  box(0, dy, W, dh, p ? "pid " + p.pid + " · " + p.h : "detail", p ? "cpu " + p.tcpu.toFixed(1) + "% · " + bytes(p.trss) : "", false);
  const gw = Math.min(40, Math.floor(W * 0.35));
  const lines: string[] = [];
  if (p) {
    const hh = hist.get(p.pid) ?? [];
    const gh = Math.max(2, Math.min(8, dh - 6));
    const peak = Math.max(10, Math.max(...hh));
    const gl = braille(hh, gw, gh, peak);
    for (let i = 0; i < gh; i++) lines.push(fg(heat(1 - i / gh)) + gl[i] + RST);
    lines.push(fg(C.dim) + fit("cpu (" + (hh.length * 1.5).toFixed(0) + "s)  peak " + peak.toFixed(0) + "%", gw) + RST);
    lines.push(fg(C.dim) + "mem " + RST + gauge(p.trss / TOTALMEM, gw - 11) + fg(C.sub) + " " + fit((p.trss / TOTALMEM * 100).toFixed(1) + "%", 6) + RST);
    const tt = tmuxTarget(p.pid);
    lines.push(fg(C.dim) + "tty " + RST + fg(C.sub) + fit(p.tty + (tt ? "  tmux " + tt : ""), gw - 4) + RST);
  }
  // tree to the right
  const tree: string[] = [];
  if (p) {
    tree.push(fg(C.text) + CSI + "1m" + clean(p.args) + RST);
    tree.push(fg(C.purple) + home(p.cwd) + RST);
    const walk = (pid: number, depth: number): void => {
      for (const q of allProcs.values()) {
        if (q.ppid !== pid) continue;
        tree.push(fg(C.line) + "  ".repeat(depth) + "└─ " + fg(C.sub) + fit(String(q.pid), 7) + fg(heat(q.cpu / 100)) + fit(q.cpu.toFixed(1) + "%", 7) + fg(C.dim) + fit(bytes(q.rss), 7) + fg(q.h ? C.claude : C.text) + clean(q.args) + RST);
        if (depth < 6) walk(q.pid, depth + 1);
      }
    };
    walk(p.pid, 0);
  }
  const tw = W - gw - 8;
  for (let r = 0; r < dh - 2; r++) {
    const l = lines[r] ?? ""; const t = tree[r] ?? "";
    const tv2 = t ? fitStyled(t, tw) : "";
    put(1, dy + 1 + r, " " + l + fillTo(l, gw) + "  " + fg(C.line) + "│ " + RST + tv2 + fillTo(tv2, tw) + " ");
  }
}
// truncate a styled line to w visible columns (keeps escapes)
function fitStyled(s: string, w: number): string {
  let out = ""; let n = 0; let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 27) { const m = /^\x1b\[[0-9;]*[A-Za-z]/.exec(s.slice(i, i + 24)); if (m) { out += m[0]; i += m[0].length; continue; } }
    const a = s.charCodeAt(i);
    const ch = a >= 0xd800 && a <= 0xdbff ? s.slice(i, i + 2) : s.slice(i, i + 1);
    const c = cw(cpOf(ch));
    if (n + c > w) break;
    out += ch; n += c; i += ch.length;
  }
  return out + RST;
}
function renderTranscript(): void {
  if (!tv) return;
  const t = tv;
  const s = t.s;
  // incremental read
  try { const st = statSync(s.path); s.size = st.size; s.mtime = st.mtimeMs; } catch (e) { /* gone */ }
  if (s.size > t.off) {
    const r = readLines(s.path, t.off, Math.min(s.size, t.off + 16777216), false);
    for (const l of r.lines) parseEvents(s.h, l, t.evs, s);
    t.off = r.next;
  }
  const iw = W - 4;
  if (t.lw !== iw || t.ln !== t.evs.length || t.lexp !== t.expand) {
    const out: string[] = []; const le: number[] = []; const ls: number[] = [];
    for (let i = 0; i < t.evs.length; i++) { ls.push(out.length); evLines(t.evs[i], iw - 1, t.expand, out); while (le.length < out.length) le.push(i); }
    t.lines = out; t.lineEv = le; t.lineStart = ls; t.lw = iw; t.ln = t.evs.length; t.lexp = t.expand;
  }
  const vh = H - 4;
  const maxScroll = Math.max(0, t.lines.length - vh);
  if (t.focusTs || t.focusText) { // opened from a preview row: put the cursor on that event
    for (let i = t.evs.length - 1; i >= 0; i--) {
      const e = t.evs[i];
      if (e.kind === t.focusKind && e.ts === t.focusTs && e.text === t.focusText) { t.cur = i; t.follow = false; t.scroll = Math.max(0, numAt(t.lineStart, i, 0) - Math.floor(vh / 3)); break; }
    }
    t.focusTs = ""; t.focusText = "";
  }
  if (t.follow) { t.scroll = maxScroll; t.cur = t.evs.length - 1; }
  t.scroll = Math.max(0, Math.min(t.scroll, maxScroll));
  const live = s.pid || (s.depth === 1 && subActive(s)) ? " · " + SPIN[frame % SPIN.length] + " live" : "";
  const subs = s.subs.length ? " · ⑂ " + activeSubs(s) + "/" + s.subs.length + " (n)" : "";
  const name = s.depth === 1 ? "↳ " + s.kind + (s.name ? " " + s.name : "") + ": " + titleOf(s) : titleOf(s);
  box(0, 1, W, H - 2, name, (s.depth === 1 ? "u parent · n next · " : "") + home(s.cwd) + subs + live + " · " + (t.follow ? "follow" : Math.round((t.scroll / Math.max(1, maxScroll)) * 100) + "%"), true);
  for (let r = 0; r < vh; r++) {
    const li = t.scroll + r;
    const l = li < t.lines.length ? t.lines[li] : "";
    const on = li < t.lines.length && numAt(t.lineEv, li, -1) === t.cur;
    const f = fitStyled(l, iw - 1);
    put(1, 2 + r, (on ? fg(C.accent) + "▌" + RST : " ") + f + fillTo(f, iw - 1) + "  ");
  }
  // scrollbar
  if (t.lines.length > vh) {
    const th = Math.max(1, Math.floor((vh * vh) / t.lines.length));
    const ty = Math.floor((t.scroll / Math.max(1, maxScroll)) * (vh - th));
    for (let r = 0; r < vh; r++) put(W - 1, 2 + r, fg(r >= ty && r < ty + th ? C.accent : C.line) + (r >= ty && r < ty + th ? "┃" : "│") + RST);
  }
}
function renderModal(title: string, body: string[], col: string): void {
  const w = Math.min(W - 4, Math.max(40, Math.max(...body.map((b) => width(b) + 4))));
  const h = body.length + 2;
  const x = Math.floor((W - w) / 2); const y = Math.floor((H - h) / 2);
  const bc = fg(col);
  put(x, y, bc + "╭─ " + CSI + "1m" + title + " " + RST + bc + "─".repeat(Math.max(0, w - width(title) - 5)) + "╮" + RST);
  for (let i = 0; i < body.length; i++) put(x, y + 1 + i, bc + "│" + RST + bg(C.panel) + fg(C.text) + " " + fit(body[i], w - 3) + RST + bc + "│" + RST);
  put(x, y + h - 1, bc + "╰" + "─".repeat(w - 2) + "╯" + RST);
}
// ── help layer ──────────────────────────────────────────────────────────────
interface HelpSec { name: string; ctx: string; keys: string[][] }
const HELP: HelpSec[] = [
  { name: "global", ctx: "", keys: [
    ["?", "show / hide this help"], ["Tab  1  2", "switch Sessions / Processes"], ["q  ctrl-c", "quit"] ] },
  { name: "sessions", ctx: "sessions", keys: [
    ["↑↓  j k", "move"], ["PgUp PgDn", "page"], ["g G  Home End", "first / last"],
    ["↵  →", "open live transcript"], ["space", "fold / unfold subagents"],
    ["/", "filter (title, path, id, harness)"], ["F", "full-text search (ripgrep)"],
    ["h", "harness: all → claude → codex → fx"], ["l", "live sessions only"], ["esc", "clear filters"],
    ["s", "send prompt (tmux if live, else headless)"], ["R", "resume interactively"],
    ["x", "SIGTERM the session's agent"], ["D", "move session to ~/.Trash"], ["y", "copy session id"] ] },
  { name: "processes", ctx: "processes", keys: [
    ["↑↓  j k", "move"], ["g G  Home End", "first / last"], ["↵  →", "open linked session"],
    ["s", "send prompt to the agent's tmux pane"], ["a", "switch tmux client to the pane"],
    ["x", "SIGTERM (asks first)"], ["X", "SIGKILL (asks first)"] ] },
  { name: "transcript", ctx: "transcript", keys: [
    ["↑↓  j k", "previous / next event (cursor ▌)"], ["↵  →  click", "drill into event: full call, result, diff, files"],
    ["wheel", "scroll lines"], ["PgUp PgDn  b ␣", "scroll a page"], ["g  Home", "top"],
    ["G  End  f", "bottom + live follow"], ["t", "expand / collapse tool output"],
    ["n  N", "next / previous subagent"], ["u", "up to parent session"],
    ["s", "send prompt"], ["R", "resume interactively"], ["esc  q  ←", "back to list"] ] },
  { name: "event details", ctx: "detail", keys: [
    ["↑↓  j k  wheel", "scroll"], ["[  ]  p n", "previous / next event"], ["1-9  click file", "open referenced file in $PAGER"],
    ["tab  o  e", "select file · open in pager · open in $EDITOR"], ["v", "whole detail in $PAGER"], ["y", "copy detail to clipboard"],
    ["esc  q  ←  right-click", "back to transcript"] ] },
  { name: "prompt & dialogs", ctx: "", keys: [
    ["↵", "submit"], ["esc", "cancel"], ["ctrl-u  ctrl-w", "clear line / delete word"], ["y  n", "confirm / cancel dialog"] ] },
  { name: "mouse", ctx: "", keys: [
    ["wheel", "scroll list / transcript / details"], ["click", "select row · click again (or double-click) to open"],
    ["click preview row", "jump to that event / subagent"], ["click footer hint", "press that key"], ["right-click", "back"], ["click tab", "switch view"] ] },
];
let helpScroll = 0;
function helpContext(): string { return prevMode === "detail" ? "detail" : prevMode === "transcript" ? "transcript" : tab === 0 ? "sessions" : "processes"; }
function helpLines(sec: HelpSec, w: number, ctx: string): string[] {
  const on = sec.ctx !== "" && sec.ctx === ctx;
  const out: string[] = [];
  out.push((on ? fg(C.accent) + CSI + "1m" + "▍" : fg(C.sub) + CSI + "1m" + " ") + fit(sec.name.toUpperCase() + (on ? "  · current view" : ""), w - 1) + RST);
  const kw = Math.min(18, Math.floor(w * 0.4));
  for (const kd of sec.keys) {
    out.push("  " + bg(C.sel) + fg(on ? C.accent : C.text) + CSI + "1m" + " " + fit(kd[0], kw - 2) + " " + RST + " " + fg(C.sub) + fit(kd[1], w - kw - 3) + RST);
  }
  out.push("");
  return out;
}
function renderHelp(): void {
  const w = Math.min(W - 4, 120);
  const two = w >= 96;
  const cw1 = two ? Math.floor((w - 5) / 2) : w - 4;
  const ctx = helpContext();
  const blocks = HELP.map((sec) => helpLines(sec, cw1, ctx));
  let total = 0; for (const b of blocks) total += b.length;
  const left: string[] = []; const right: string[] = [];
  for (const b of blocks) { const tgt = two && left.length >= total / 2 ? right : left; for (const l of b) tgt.push(l); }
  const rows = Math.max(left.length, right.length);
  const h = Math.min(rows + 4, H - 3); // leave the footer row free for the drop shadow
  const view2 = h - 4;
  helpScroll = Math.max(0, Math.min(helpScroll, rows - view2));
  const x0 = Math.floor((W - w) / 2); const y0 = Math.max(1, Math.floor((H - h) / 2));
  const bc = fg(C.accent);
  const title = " ⌨ keyboard shortcuts ";
  put(x0, y0, bc + "╭─" + CSI + "1m" + fg(C.text) + title + RST + bc + "─".repeat(Math.max(0, w - 3 - width(title))) + "╮" + RST);
  put(x0, y0 + 1, bc + "│" + RST + bg(C.panel) + " ".repeat(w - 2) + RST + bc + "│" + RST);
  for (let r = 0; r < view2; r++) {
    const l = left[helpScroll + r] ?? ""; const rr = right[helpScroll + r] ?? "";
    const body = " " + l + fillTo(l, cw1) + (two ? " " + fg(C.line) + "│" + RST + bg(C.panel) + " " + rr + fillTo(rr, cw1) : "");
    put(x0, y0 + 2 + r, bc + "│" + RST + bg(C.panel) + body + RST + bg(C.panel) + fillTo(body, w - 2) + RST + bc + "│" + RST);
  }
  const more = rows > view2 ? "  j/k scroll " + (helpScroll + 1) + "–" + Math.min(rows, helpScroll + view2) + "/" + rows : "";
  const foot = " esc  ?  q  close" + more + " ";
  put(x0, y0 + h - 2, bc + "│" + RST + bg(C.panel) + fg(C.dim) + fit(foot, w - 2) + RST + bc + "│" + RST);
  put(x0, y0 + h - 1, bc + "╰" + "─".repeat(w - 2) + "╯" + RST);
  // drop shadow
  const sh = bg("8;8;10") + " " + RST;
  for (let r = 1; r < h; r++) put(x0 + w, y0 + r, sh);
  put(x0 + 1, y0 + h, bg("8;8;10") + " ".repeat(w) + RST);
}
function render(): void {
  buf = [];
  buf.push("\x1b[?2026h");
  renderHeader();
  if (mode === "detail" || (mode !== "list" && dv && prevMode === "detail")) { renderTranscript(); renderDetail(); }
  else if (mode === "transcript" || (mode !== "list" && tv && prevMode === "transcript")) renderTranscript();
  else if (tab === 0) renderSessions();
  else renderProcs();
  renderFooter();
  if (mode === "confirm") renderModal("confirm", [confirmText, "", "y  yes      n / esc  cancel"], C.yellow);
  if (mode === "help") renderHelp();
  buf.push("\x1b[?2026l");
  process.stdout.write(buf.join(""));
}

// ── actions ─────────────────────────────────────────────────────────────────
let prevMode: Mode = "list";
function ask(label: string, action: string, init: string): void { prevMode = mode === "input" ? prevMode : mode; mode = "input"; inputLabel = label; inputAction = action; inputText = init; }
function confirm(text: string, action: string): void { prevMode = mode; mode = "confirm"; confirmText = text; confirmAction = action; }
function target(): Sess | null {
  if (mode === "transcript" || prevMode === "transcript") return tv ? tv.s : null;
  if (tab === 1) { const p = procAt(psel); return p ? procSess(p) : null; }
  return current();
}
function targetPid(): number {
  if (tab === 1 && prevMode !== "transcript" && mode !== "transcript") { const p = procAt(psel); return p ? p.pid : 0; }
  const s = target(); if (!s || !s.pid) return 0;
  const r = rootOf(s.pid); return r ? r.pid : s.pid;
}
// ── event detail (drill-down) ───────────────────────────────────────────────
// ponytail: slice+for-of read — in scriptc a number read via a[i] (or a[i] ?? d) cannot index another array afterwards
function numAt(a: number[], i: number, d: number): number {
  let v = d;
  if (i >= 0 && i < a.length) for (const x of a.slice(i, i + 1)) v = x;
  return v;
}
function evIn(list: Ev[], i: number): Ev | null { return i >= 0 && i < list.length ? list[i] ?? null : null; }
function resolveFull(e: Ev): string {
  if (!e.full.startsWith("@file:")) return e.full;
  const p = e.full.slice(6);
  try { const st = statSync(p); return readText(p, 0, Math.min(st.size, 4194304)); } catch (err) { return ""; }
}
// tool call ↔ result, by id when the harness logs one, else the adjacent event
function pairOf(evs: Ev[], i: number): number {
  const e = evIn(evs, i);
  if (!e) return -1;
  if (e.kind === "tool") {
    for (let j = i + 1; j < evs.length && j < i + 500; j++) {
      const r = evs[j];
      if (r.kind === "result" && (!e.id || r.id === e.id)) return j;
      if (!e.id && r.kind === "tool") return -1;
    }
  } else if (e.kind === "result") {
    for (let j = i - 1; j >= 0 && j > i - 500; j--) {
      const c = evs[j];
      if (c.kind === "tool" && (!e.id || c.id === e.id)) return j;
    }
  }
  return -1;
}
function dHead(L: string[], P: string[], title: string, w: number, col: string): void {
  L.push("");
  const t = clean(title);
  L.push(fg(col) + CSI + "1m" + "━━ " + fit(t, Math.min(width(t), w - 4)) + " " + RST + fg(C.line) + "━".repeat(Math.max(0, w - width(t) - 4)) + RST);
  P.push("", "== " + title);
}
function dText(L: string[], P: string[], text: string, w: number, col: string): void {
  for (const l of wrap(text, w)) L.push(fg(col) + l + RST);
  P.push(text);
}
function dCode(L: string[], P: string[], text: string, w: number, numbered: boolean): void {
  const src = text.split("\n");
  if (src.length > 1 && src[src.length - 1] === "") src.pop();
  const nw = numbered ? String(src.length).length : 0;
  for (let i = 0; i < src.length; i++) {
    const segs = wrap(src[i], Math.max(10, w - (numbered ? nw + 3 : 2)));
    for (let j = 0; j < segs.length; j++) {
      const gut = numbered ? fg(C.dim) + (j === 0 ? String(i + 1).padStart(nw, " ") : " ".repeat(nw)) + " │ " : fg(C.line) + "│ ";
      L.push(gut + RST + fg(C.text) + segs[j] + RST);
    }
  }
  P.push(text);
}
function dDiff(L: string[], P: string[], text: string, w: number): void {
  for (const raw of text.split("\n")) {
    const c = raw.charAt(0);
    const col = c === "+" && !raw.startsWith("+++") ? C.green : c === "-" && !raw.startsWith("---") ? C.red : c === "@" ? C.cyan : C.sub;
    for (const seg of wrap(raw, w)) L.push(fg(col) + seg + RST);
  }
  P.push(text);
}
function pretty(o: Obj): string { return JSON.stringify(o, null, 2); }
function prefixLines(text: string, pre: string): string { return text.split("\n").map((l) => pre + l).join("\n"); }
function fmtCall(L: string[], P: string[], e: Ev, w: number): void {
  const i0 = e.text.indexOf("\u0000");
  const name = i0 >= 0 ? e.text.slice(0, i0) : e.text;
  const a = parse(e.full.trim());
  if (a) {
    const fp = str(a["file_path"]) || str(a["path"]) || str(a["notebook_path"]);
    const cmd = str(a["command"]) || str(a["cmd"]);
    const req = obj(a["request"]);
    if (typeof a["old_string"] === "string" || typeof a["new_string"] === "string") {
      dHead(L, P, "EDIT  " + home(fp), w, C.yellow);
      dDiff(L, P, prefixLines(str(a["old_string"]), "- ") + "\n" + prefixLines(str(a["new_string"]), "+ "), w);
    } else if (arr(a["edits"]).length) {
      dHead(L, P, "MULTI-EDIT  " + home(fp), w, C.yellow);
      for (const ed of arr(a["edits"])) { const eo = obj(ed); if (eo) dDiff(L, P, prefixLines(str(eo["old_string"]), "- ") + "\n" + prefixLines(str(eo["new_string"]), "+ ") + "\n", w); }
    } else if (typeof a["content"] === "string" && fp) {
      dHead(L, P, "WRITE  " + home(fp), w, C.yellow);
      dCode(L, P, str(a["content"]), w, true);
    } else if (cmd) {
      dHead(L, P, "COMMAND" + (str(a["workdir"]) || str(a["cwd"]) ? "  in " + home(str(a["workdir"]) || str(a["cwd"])) : ""), w, C.yellow);
      dCode(L, P, cmd, w, false);
    } else if (req && str(req["task"])) {
      dHead(L, P, "SUBAGENT TASK", w, C.yellow);
      dText(L, P, str(req["task"]), w, C.text);
    } else if (str(a["prompt"])) {
      dHead(L, P, "PROMPT" + (str(a["description"]) ? "  " + str(a["description"]) : ""), w, C.yellow);
      dText(L, P, str(a["prompt"]), w, C.text);
    }
    dHead(L, P, "ARGUMENTS  " + name, w, C.sub);
    dCode(L, P, pretty(a), w, false);
  } else if (e.full) {
    dHead(L, P, "INPUT  " + name, w, C.yellow);
    if (e.full.indexOf("*** Begin Patch") >= 0 || e.full.indexOf("\n+") >= 0) dDiff(L, P, e.full, w); else dCode(L, P, e.full, w, true);
  } else {
    dHead(L, P, "CALL  " + name, w, C.yellow);
    dText(L, P, i0 >= 0 ? e.text.slice(i0 + 1) : e.text, w, C.text);
  }
}
function fmtResult(L: string[], P: string[], e: Ev, w: number): void {
  const tur = e.full && !e.full.startsWith("@file:") ? parse(e.full.trim()) : null; // Claude toolUseResult
  if (tur) {
    let shown = false;
    const patch = arr(tur["structuredPatch"]);
    if (patch.length) {
      dHead(L, P, "PATCH  " + home(str(tur["filePath"])), w, C.green);
      for (const hk of patch) {
        const h = obj(hk);
        if (!h) continue;
        const ls: string[] = [];
        for (const x of arr(h["lines"])) ls.push(str(x));
        dDiff(L, P, "@@ -" + String(h["oldStart"]) + " +" + String(h["newStart"]) + " @@\n" + ls.join("\n"), w);
      }
      shown = true;
    }
    const file = obj(tur["file"]);
    if (file && str(file["content"])) {
      dHead(L, P, "FILE  " + home(str(file["filePath"])), w, C.green);
      dCode(L, P, str(file["content"]), w, true);
      shown = true;
    }
    const so = str(tur["stdout"]); const se = str(tur["stderr"]);
    if (so) { dHead(L, P, "STDOUT", w, C.green); dCode(L, P, so, w, false); shown = true; }
    if (se) { dHead(L, P, "STDERR", w, C.red); dCode(L, P, se, w, false); shown = true; }
    if (!shown) { dHead(L, P, "RESULT", w, C.green); dCode(L, P, e.text, w, false); dHead(L, P, "RESULT DATA", w, C.sub); dCode(L, P, pretty(tur), w, false); }
    return;
  }
  const full = resolveFull(e);
  dHead(L, P, "RESULT" + (e.full.startsWith("@file:") ? "  " + home(e.full.slice(6)) : ""), w, C.green);
  const body = full || e.text;
  if (body.indexOf("\n@@ ") >= 0 || body.startsWith("diff --git")) dDiff(L, P, body, w); else dCode(L, P, body, w, false);
}
function filesOf(texts: string[], cwd: string): string[] {
  const out: string[] = [];
  const add = (p0: string): void => {
    const p = p0.replace(/\\\//g, "/").trim();
    if (!p || p.length > 400 || p.indexOf("\n") >= 0) return;
    const abs = p.startsWith("/") ? p : p.startsWith("~/") ? HOME + p.slice(1) : cwd ? join(cwd, p) : p;
    if (out.indexOf(abs) < 0) out.push(abs);
  };
  for (const t of texts) {
    for (const m of t.matchAll(/"(?:file_path|filePath|path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) add(m[1]);
    for (const m of t.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n]+)/g)) add(m[1]);
  }
  return out;
}
function buildDetail(t: TV, idx: number, w: number): DV {
  const L: string[] = []; const P: string[] = [];
  const e = evIn(t.evs, idx);
  let title = "event";
  const texts: string[] = [];
  if (e) {
    const j = pairOf(t.evs, idx);
    const pe = evIn(t.evs, j);
    const call = e.kind === "tool" ? e : e.kind === "result" ? pe : null;
    const res = e.kind === "result" ? e : e.kind === "tool" ? pe : null;
    if (call || res) {
      const i0 = call ? call.text.indexOf("\u0000") : -1;
      title = "⚒ " + (call && i0 >= 0 ? call.text.slice(0, i0) : "tool result");
      if (call) { fmtCall(L, P, call, w); texts.push(call.full); }
      else { dHead(L, P, "CALL", w, C.dim); dText(L, P, "(call not in the loaded part of the log)", w, C.dim); }
      if (res) { fmtResult(L, P, res, w); texts.push(res.full.startsWith("@file:") ? "" : res.full); }
      else { dHead(L, P, "RESULT", w, C.dim); dText(L, P, "(no result yet — still running?)", w, C.dim); }
    } else {
      title = e.kind === "user" ? "❯ user" : e.kind === "assistant" ? "⏺ assistant" : e.kind === "thinking" ? "∴ thinking" : "── " + e.kind;
      dHead(L, P, e.kind.toUpperCase(), w, e.kind === "user" ? C.cyan : C.text);
      dText(L, P, e.text, w, e.kind === "thinking" ? C.sub : C.text);
      texts.push(e.text);
    }
    if (e.ts) title += "  ·  " + localHM(e.ts);
    if (e.id) title += "  ·  " + e.id;
  }
  const files = filesOf(texts, t.s.cwd);
  const head: string[] = []; const fileRow: number[] = [];
  if (files.length) {
    head.push(fg(C.purple) + CSI + "1m" + "FILES" + RST + fg(C.dim) + "   1-9 / click open in $PAGER · e edit · tab select" + RST);
    for (let i = 0; i < files.length; i++) {
      fileRow.push(head.length);
      const ok = existsSync(files[i]);
      head.push("  " + fg(C.accent) + CSI + "1m" + "[" + (i + 1) + "]" + RST + " " + fg(ok ? C.text : C.dim) + home(files[i]) + RST + (ok ? "" : fg(C.red) + "  (missing)" + RST));
    }
  }
  return { idx, lines: head.concat(L), plain: P.join("\n"), files, fileRow, fsel: 0, scroll: 0, title, lw: w };
}
function openDetail(i: number): void {
  if (!tv || i < 0 || i >= tv.evs.length) return;
  dv = buildDetail(tv, i, W - 4);
  mode = "detail";
}
function stepDetail(dir: number): void {
  if (!tv || !dv) return;
  let i = dv.idx + dir;
  // a result already shown with its call is skipped
  while (i >= 0 && i < tv.evs.length) {
    const e = tv.evs[i];
    if (e.kind === "result" && pairOf(tv.evs, i) >= 0) { i += dir; continue; }
    if (e.kind === "meta") { i += dir; continue; }
    break;
  }
  if (i < 0 || i >= tv.evs.length) return;
  tv.cur = i; tv.follow = false;
  openDetail(i);
}
function openExternal(cmd: string, path: string): void {
  if (!existsSync(path)) { say("warn", "not found: " + home(path)); return; }
  const c = cmd.split(" ").filter((x) => x.length > 0);
  leave();
  try { execFileSync(c[0], c.slice(1).concat([path]), { stdio: "inherit" }); } catch (err) { /* viewer exit code */ }
  enter();
}
function pagerCmd(): string { const p = process.env.PAGER; return p !== undefined && p.trim() ? p : "less -R"; }
function editorCmd(): string { const v = process.env.VISUAL; const e = process.env.EDITOR; return v !== undefined && v.trim() ? v : e !== undefined && e.trim() ? e : "vi"; }
function openFileN(n: number, edit: boolean): void {
  if (!dv || n < 0 || n >= dv.files.length) return;
  dv.fsel = n;
  openExternal(edit ? editorCmd() : pagerCmd(), dv.files[n]);
}
function pageDetail(): void {
  if (!dv) return;
  const dir = join(HOME, ".agentglass", "tmp");
  try { mkdirSync(dir, { recursive: true }); } catch (err) { /* exists */ }
  const f = join(dir, "detail.txt");
  try { const fd = openSync(f, "w"); writeSync(fd, dv.plain + "\n"); closeSync(fd); } catch (err) { say("err", "cannot write " + home(f)); return; }
  openExternal(pagerCmd(), f);
}
function renderDetail(): void {
  if (!dv || !tv) return;
  const d = dv;
  if (d.lw !== W - 4) { const keep = d.scroll; const fs = d.fsel; dv = buildDetail(tv, d.idx, W - 4); dv.scroll = keep; dv.fsel = fs; }
  const v = dv;
  const vh = H - 4; const iw = W - 4;
  const maxScroll = Math.max(0, v.lines.length - vh);
  v.scroll = Math.max(0, Math.min(v.scroll, maxScroll));
  box(0, 1, W, H - 2, v.title, "event " + (v.idx + 1) + "/" + tv.evs.length + " · " + clean(titleOf(tv.s)), true);
  for (let r = 0; r < vh; r++) {
    const li = v.scroll + r;
    const l = li < v.lines.length ? v.lines[li] : "";
    const fi = v.fileRow.indexOf(li);
    const mark = fi >= 0 && fi === v.fsel ? fg(C.accent) + "▌" + RST : " ";
    const f = fitStyled(l, iw);
    put(1, 2 + r, mark + f + fillTo(f, iw) + " ");
  }
  if (v.lines.length > vh) {
    const th = Math.max(1, Math.floor((vh * vh) / v.lines.length));
    const ty = Math.floor((v.scroll / Math.max(1, maxScroll)) * (vh - th));
    for (let r = 0; r < vh; r++) put(W - 1, 2 + r, fg(r >= ty && r < ty + th ? C.accent : C.line) + (r >= ty && r < ty + th ? "┃" : "│") + RST);
  }
}
function cycleSub(dir: number): void {
  if (!tv) return;
  const root = tv.s.depth === 1 ? parentOf(tv.s) : tv.s;
  if (!root || !root.subs.length) { say("info", "no subagents"); return; }
  const kids = root.subs.slice().sort((a, b) => (subActive(b) ? 1 : 0) - (subActive(a) ? 1 : 0) || b.mtime - a.mtime);
  const i = kids.indexOf(tv.s);
  openTranscript(kids[(((i + dir) % kids.length) + kids.length) % kids.length]);
}
function moveCur(t: TV, d: number, vh: number): void {
  if (!t.evs.length) return;
  t.cur = Math.max(0, Math.min(t.evs.length - 1, (t.cur < 0 ? t.evs.length - 1 : t.cur) + d));
  t.follow = false;
  const s0 = numAt(t.lineStart, t.cur, 0);
  const e0 = numAt(t.lineStart, t.cur + 1, t.lines.length);
  if (s0 < t.scroll) t.scroll = s0;
  else if (e0 > t.scroll + vh) t.scroll = Math.min(s0, e0 - vh);
  if (d > 0 && t.cur === t.evs.length - 1) t.follow = true;
}
function openTranscript(s: Sess): void {
  const start = Math.max(0, s.size - 6291456);
  tv = { s, evs: [], off: start, scroll: 0, follow: true, expand: false, lines: [], lw: 0, ln: -1, lexp: false, cur: -1, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "" };
  if (start > 0) alignOff();
  if (start > 0) tv.evs.push({ kind: "meta", text: "showing last " + bytes(s.size - start) + " of " + bytes(s.size), ts: "", id: "", full: "" });
  mode = "transcript";
}
function alignOff(): void {
  if (!tv) return;
  const b = readBytes(tv.s.path, tv.off, 1048576);
  let a = 0; while (a < b.length && b[a] !== 10) a++;
  tv.off += a + 1;
}
function cmdOf(h: Harness): string[] {
  const env = h === "claude" ? process.env.AGENTGLASS_CLAUDE : h === "codex" ? process.env.AGENTGLASS_CODEX : process.env.AGENTGLASS_FX;
  const cmd: string = env !== undefined ? env : h;
  return cmd.split(" ").filter((x) => x.length > 0);
}
function sendTmux(t: string, msg: string): void {
  try {
    execFileSync("tmux", ["send-keys", "-t", t, "-l", "--", msg], { stdio: "ignore" });
    // delayed Enter: TUIs like Codex treat an Enter inside a fast key burst as a pasted newline
    setTimeout(() => { run("tmux", ["send-keys", "-t", t, "Enter"]); say("ok", "sent to tmux " + t); }, 400);
  } catch (e) { say("err", "tmux send failed"); }
}
// subagent transcripts are not resumable sessions: prompts and resumes go to the owning session
function owner(s: Sess): Sess | null {
  if (!s.parent) return s;
  const p = parentOf(s);
  if (!p) say("warn", "subagent without its parent session — nothing to resume");
  return p;
}
function sendPrompt(sub: Sess, msg: string): void {
  const s = owner(sub);
  if (!s) return;
  if (s.pid) {
    const t = tmuxTarget(s.pid);
    if (!t) { say("warn", "session is live outside tmux — cannot inject input safely"); return; }
    sendTmux(t, msg);
    return;
  }
  const c = cmdOf(s.h);
  const tail = s.h === "claude" ? ["-p", "--resume", s.id, msg] : s.h === "codex" ? ["exec", "resume", s.id, msg] : ["ask", "--auto", "--resume-id", s.id, "--", msg];
  const args = c.slice(1).concat(tail);
  const logDir = join(HOME, ".agentglass", "logs");
  try { mkdirSync(logDir, { recursive: true }); } catch (e) { /* exists */ }
  const log = join(logDir, s.id + ".log");
  try {
    const fd = openSync(log, "a");
    writeSync(fd, "\n=== " + new Date().toISOString() + " " + c[0] + " " + args.join(" ") + "\n");
    const ch = spawn(c[0], args, { stdio: ["ignore", fd, fd], detached: true, cwd: s.cwd && existsSync(s.cwd) ? s.cwd : HOME });
    closeSync(fd);
    ch.on("error", (e: Error) => say("err", c[0] + ": " + e.message));
    ch.on("exit", (code: number | null) => say(code === 0 ? "ok" : "err", c[0] + " finished (" + String(code) + ") · log " + home(log)));
    ch.unref();
    say("ok", "headless " + c[0] + " resumed · log " + home(log));
  } catch (e) { say("err", "spawn failed: " + String(e)); }
}
function resume(sub: Sess): void {
  const s = owner(sub);
  if (!s) return;
  if (s.pid) {
    const t = tmuxTarget(s.pid);
    if (t && process.env.TMUX) { run("tmux", ["switch-client", "-t", t]); say("ok", "switched to " + t); }
    else say("warn", "already running (pid " + s.pid + ")" + (t ? " in tmux " + t : ""));
    return;
  }
  const c = cmdOf(s.h);
  const args = c.slice(1).concat(s.h === "claude" ? ["--resume", s.id] : ["resume", s.id]);
  leave();
  try { execFileSync(c[0], args, { stdio: "inherit", cwd: s.cwd && existsSync(s.cwd) ? s.cwd : HOME }); } catch (e) { /* non-zero exit */ }
  enter();
  refreshProcs(); scan(); buildView();
}
function killPid(pid: number, sig: string): void {
  if (!pid) { say("warn", "no process linked"); return; }
  try { process.kill(pid, sig); say("ok", sig + " → " + pid); } catch (e) { say("err", "kill failed: " + String(e)); }
  refreshProcs();
}
function trash(s: Sess): void {
  const t = join(HOME, ".Trash");
  try {
    if (s.h === "fx") {
      const d = s.path.slice(0, -"/events.jsonl".length);
      renameSync(d, join(t, "fx-session-" + base(d)));
    } else renameSync(s.path, join(t, base(s.path)));
    const dir = s.path.slice(0, -6);
    if (s.h === "claude" && existsSync(dir)) renameSync(dir, join(t, base(dir)));
    if (s.h === "claude" && existsSync(dir + ".meta.json")) renameSync(dir + ".meta.json", join(t, base(dir) + ".meta.json"));
    sessions.delete(s.path);
    if (tv && tv.s === s) { tv = null; mode = "list"; }
    say("ok", "moved to ~/.Trash");
  } catch (e) { say("err", "trash failed: " + String(e)); }
  buildView();
}
function fullText(q: string): void {
  fullq = q;
  if (!q) { useFull = false; buildView(); return; }
  const dirs = [join(CLAUDE, "projects"), join(CODEX, "sessions"), join(CODEX, "archived_sessions"), join(FX, "sessions")].filter((d) => existsSync(d));
  const r = spawnSync("rg", ["-l", "-i", "-F", "--glob", "*.jsonl", "--", q].concat(dirs), { encoding: "utf8", timeout: 30000 });
  let out = r.stdout;
  if (r.error) out = run("grep", ["-rilF", "--include=*.jsonl", "--", q].concat(dirs));
  fulltext = new Set<string>(out.split("\n").filter((l) => l.length > 0)); useFull = true;
  sel = 0; buildView();
  say("info", fulltext.size + " sessions contain “" + q + "”");
}

// ── input ───────────────────────────────────────────────────────────────────
function tokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      if (s[i + 1] === "[" || s[i + 1] === "O") {
        let j = i + 2;
        while (j < s.length && !/[A-Za-z~]/.test(s[j])) j++;
        out.push(s.slice(i, j + 1)); i = j + 1; continue;
      }
      out.push("esc"); i++; continue;
    }
    const a = s.charCodeAt(i);
    const n = a >= 0xd800 && a <= 0xdbff ? 2 : 1;
    out.push(s.slice(i, i + n)); i += n;
  }
  return out;
}
function keyName(k: string): string {
  const m: Record<string, string> = {
    "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right", "\x1b[D": "left", "\x1bOA": "up", "\x1bOB": "down",
    "\x1b[5~": "pgup", "\x1b[6~": "pgdn", "\x1b[H": "home", "\x1b[F": "end", "\x1b[1~": "home", "\x1b[4~": "end", "\x1bOH": "home", "\x1bOF": "end",
    "\r": "enter", "\n": "enter", "\x7f": "bs", "\b": "bs", "\t": "tab", "\x03": "ctrl-c", "\x15": "ctrl-u", "\x17": "ctrl-w",
  };
  return m[k] ?? k;
}
function onInput(k: string): void {
  if (mode === "input") {
    if (k === "enter") {
      mode = prevMode;
      const v = inputText;
      if (inputAction === "filter") { filter = v; sel = 0; buildView(); }
      else if (inputAction === "fulltext") fullText(v.trim());
      else if (inputAction === "send") { const s = target(); if (s && v.trim()) sendPrompt(s, v); }
      else if (inputAction === "sendpane") { const p = procAt(psel); const t = p ? tmuxTarget(p.pid) : ""; if (t && v.trim()) sendTmux(t, v); }
    } else if (k === "esc") { mode = prevMode; if (inputAction === "filter") { filter = ""; buildView(); } }
    else if (k === "bs") inputText = Array.from(inputText).slice(0, -1).join("");
    else if (k === "ctrl-u") inputText = "";
    else if (k === "ctrl-w") inputText = inputText.replace(/\S*\s*$/, "");
    else if (k.length <= 2 && k.charCodeAt(0) >= 32) inputText += k;
    if (inputAction === "filter" && mode === "input") { filter = inputText; sel = 0; buildView(); }
    return;
  }
  if (mode === "confirm") {
    if (k === "y" || k === "Y") {
      mode = prevMode;
      const s = target();
      if (confirmAction === "TERM") killPid(targetPid(), "SIGTERM");
      else if (confirmAction === "KILL") killPid(targetPid(), "SIGKILL");
      else if (confirmAction === "trash" && s) trash(s);
    } else if (k === "n" || k === "N" || k === "esc" || k === "q") mode = prevMode;
    return;
  }
  if (mode === "help") {
    if (k === "down" || k === "j" || k === "wheeldown") helpScroll++;
    else if (k === "up" || k === "k" || k === "wheelup") helpScroll--;
    else if (k === "pgdn" || k === " ") helpScroll += 10;
    else if (k === "pgup") helpScroll -= 10;
    else { mode = prevMode; helpScroll = 0; }
    return;
  }
  if (k === "ctrl-c") quit();
  if (k === "?") { prevMode = mode; mode = "help"; return; }

  if (mode === "transcript" && tv) {
    const vh = H - 4;
    if (k === "esc" || k === "q" || k === "left") { mode = "list"; tv = null; return; }
    if (k === "up" || k === "k") moveCur(tv, -1, vh);
    else if (k === "down" || k === "j") moveCur(tv, 1, vh);
    else if (k === "enter" || k === "right") openDetail(tv.cur);
    else if (k === "wheelup") { tv.scroll -= 3; tv.follow = false; }
    else if (k === "wheeldown") tv.scroll += 3;
    else if (k === "pgup" || k === "b") { tv.scroll = Math.max(0, tv.scroll - (vh - 1)); tv.follow = false; tv.cur = numAt(tv.lineEv, tv.scroll, tv.cur); }
    else if (k === "pgdn" || k === " ") { tv.scroll += vh - 1; tv.cur = numAt(tv.lineEv, Math.min(tv.scroll, tv.lines.length - 1), tv.cur); }
    else if (k === "g" || k === "home") { tv.scroll = 0; tv.cur = 0; tv.follow = false; }
    else if (k === "G" || k === "end" || k === "f") tv.follow = true;
    else if (k === "t") tv.expand = !tv.expand;
    else if (k === "s") ask("send to " + tv.s.h, "send", "");
    else if (k === "R") resume(tv.s);
    else if (k === "n" || k === "N") cycleSub(k === "n" ? 1 : -1);
    else if (k === "u") { const par = parentOf(tv.s); if (par) openTranscript(par); }
    if (k.startsWith("wheel") || k === "pgdn" || k === " ") { if (tv.lines.length && tv.scroll >= tv.lines.length - vh) tv.follow = true; }
    return;
  }
  if (mode === "detail" && dv) {
    const vh = H - 4;
    if (k === "esc" || k === "q" || k === "left" || k === "backspace") { mode = "transcript"; dv = null; return; }
    if (k === "up" || k === "k") dv.scroll--;
    else if (k === "down" || k === "j") dv.scroll++;
    else if (k === "wheelup") dv.scroll -= 3;
    else if (k === "wheeldown") dv.scroll += 3;
    else if (k === "pgup" || k === "b") dv.scroll -= vh - 1;
    else if (k === "pgdn" || k === " ") dv.scroll += vh - 1;
    else if (k === "g" || k === "home") dv.scroll = 0;
    else if (k === "G" || k === "end") dv.scroll = dv.lines.length;
    else if (k === "]" || k === "n") stepDetail(1);
    else if (k === "[" || k === "p") stepDetail(-1);
    else if (k === "tab") { if (dv.files.length) dv.fsel = (dv.fsel + 1) % dv.files.length; }
    else if (k === "o" || k === "enter") openFileN(dv.fsel, false);
    else if (k === "e") openFileN(dv.fsel, true);
    else if (k === "v") pageDetail();
    else if (k === "y") { try { execFileSync("pbcopy", [], { input: dv.plain }); say("ok", "copied " + dv.plain.length + " chars"); } catch (err) { say("err", "pbcopy failed"); } }
    else if (k.length === 1 && "123456789".indexOf(k) >= 0) openFileN(Number(k) - 1, false);
    return;
  }

  // list mode
  if (k === "q") quit();
  if (k === "tab" || k === "1" || k === "2") { tab = k === "1" ? 0 : k === "2" ? 1 : 1 - tab; return; }
  if (k === "?") return;
  const page = Math.max(1, listH - 1);
  if (tab === 0) {
    if (k === "up" || k === "k" || k === "wheelup") sel--;
    else if (k === "down" || k === "j" || k === "wheeldown") sel++;
    else if (k === "pgup") sel -= page;
    else if (k === "pgdn") sel += page;
    else if (k === "home" || k === "g") sel = 0;
    else if (k === "end" || k === "G") sel = view.length - 1;
    else if (k === "enter" || k === "right") { const s = current(); if (s) openTranscript(s); }
    else if (k === " ") { // fold/unfold the subagent tree of the selected session (or of a subagent's parent)
      const cur = current();
      const root = cur && cur.depth === 1 ? parentOf(cur) : cur;
      if (root && root.subs.length) {
        if (isOpen(root)) { collapsed.add(root.path); expanded.delete(root.path); } else { expanded.add(root.path); collapsed.delete(root.path); }
        buildView(); const i = view.indexOf(root); if (i >= 0 && cur !== root && !isOpen(root)) sel = i;
      }
    }
    else if (k === "/") ask("filter", "filter", filter);
    else if (k === "F") ask("full-text", "fulltext", fullq);
    else if (k === "h") { hfilter = hfilter === "" ? "claude" : hfilter === "claude" ? "codex" : hfilter === "codex" ? "fx" : ""; sel = 0; buildView(); }
    else if (k === "l") { liveOnly = !liveOnly; sel = 0; buildView(); }
    else if (k === "esc") { filter = ""; hfilter = ""; liveOnly = false; useFull = false; fullq = ""; buildView(); }
    else if (k === "s") { const c = current(); const s = c ? owner(c) : null; if (s) ask("send to " + s.h + (c !== s ? " parent" : "") + (s.pid ? " (live)" : " (headless)"), "send", ""); }
    else if (k === "R") { const s = current(); if (s) resume(s); }
    else if (k === "x") { const s = current(); if (s && s.pid) confirm("SIGTERM agent pid " + targetPid() + "?", "TERM"); else say("warn", "session not running"); }
    else if (k === "D") { const s = current(); if (s) { if (s.pid) say("warn", "session is live — stop it first"); else confirm("Move “" + clean(titleOf(s)).slice(0, 40) + "” to ~/.Trash?", "trash"); } }
    else if (k === "y") { const s = current(); if (s) { try { execFileSync("pbcopy", [], { input: s.id }); say("ok", "copied " + s.id); } catch (e) { say("err", "pbcopy failed"); } } }
    sel = Math.max(0, Math.min(sel, view.length - 1));
  } else {
    if (k === "up" || k === "k" || k === "wheelup") psel--;
    else if (k === "down" || k === "j" || k === "wheeldown") psel++;
    else if (k === "home" || k === "g") psel = 0;
    else if (k === "end" || k === "G") psel = procs.length - 1;
    else if (k === "enter" || k === "right") { const p = procAt(psel); const s = p ? procSess(p) : null; if (s) openTranscript(s); else say("info", "no session linked to this process"); }
    else if (k === "x") { const p = procAt(psel); if (p) confirm("SIGTERM " + p.h + " pid " + p.pid + "?", "TERM"); }
    else if (k === "X") { const p = procAt(psel); if (p) confirm("SIGKILL " + p.h + " pid " + p.pid + " (no cleanup)?", "KILL"); }
    else if (k === "s") {
      const p = procAt(psel); const s = p ? procSess(p) : null; const t = p ? tmuxTarget(p.pid) : "";
      if (s) ask("send to " + s.h + " (live)", "send", "");
      else if (t) ask("send to tmux " + t, "sendpane", ""); // fresh agent without a session file yet
      else say("warn", "no session linked and not in tmux");
    }
    else if (k === "a") { const p = procAt(psel); const t = p ? tmuxTarget(p.pid) : ""; if (t && process.env.TMUX) { run("tmux", ["switch-client", "-t", t]); say("ok", "switched to " + t); } else say("warn", t ? "not inside tmux — attach with: tmux a -t " + t : "not running in tmux"); }
    psel = Math.max(0, Math.min(psel, procs.length - 1));
  }
}
function onMouse(k: string): void {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(k);
  if (!m) return;
  const b = Number(m[1] ?? "0"); const x = Number(m[2] ?? "1") - 1; const y = Number(m[3] ?? "1") - 1; // groups are string | undefined: default them or every derived index is untyped
  if (b === 64 || b === 65) { // wheel: over the preview it scrolls nothing, elsewhere it drives the focused view
    if (mode === "list" && tab === 0 && x >= prevX0 && x < prevX1 && y >= prevY0) return;
    onInput(b === 64 ? "wheelup" : "wheeldown");
    return;
  }
  if (m[4] !== "M") return; // ignore releases
  if (b === 2) { onInput("esc"); return; } // right click = back
  if (b !== 0) return;
  const now = Date.now();
  const dbl = y === lastClickY && now - lastClickAt < 450;
  lastClickY = y; lastClickAt = now;
  if (mode === "help") { onInput("esc"); return; }
  if (mode === "input" || mode === "confirm") return;
  if (y === H - 1) { // footer hints are buttons
    for (let i = 0; i < footKey.length; i++) if (x >= numAt(footX0, i, 0) && x < numAt(footX1, i, 0)) { onInput(footKey[i]); return; }
    return;
  }
  if (mode === "detail" && dv) {
    const li = dv.scroll + (y - 2);
    const fi = dv.fileRow.indexOf(li);
    if (y >= 2 && fi >= 0) { if (dv.fsel === fi || dbl) openFileN(fi, false); else dv.fsel = fi; }
    return;
  }
  if (mode === "transcript" && tv) {
    const li = tv.scroll + (y - 2);
    if (y < 2 || li >= tv.lines.length) return;
    const ei = numAt(tv.lineEv, li, -1);
    if (ei < 0) return;
    if (ei === tv.cur || dbl) openDetail(ei); else { tv.cur = ei; tv.follow = false; }
    return;
  }
  if (mode !== "list") return;
  if (y === 0) { if (x >= 16 && x < 28) tab = 0; else if (x >= 28 && x < 42) tab = 1; return; }
  if (tab === 0 && prevSess && x >= prevX0 && x < prevX1 && y >= prevY0) { // preview rows jump straight in
    const r = y - prevY0;
    const kind = numAt(prevKind, r, 0); const at = numAt(prevIdx, r, 0);
    if (kind === 1 && at < prevKids.length) { openTranscript(prevKids[at]); return; }
    if (kind === 2 && at < prevSess.evs.length) {
      const e = prevSess.evs[at];
      openTranscript(prevSess);
      if (tv) { tv.focusKind = e.kind; tv.focusTs = e.ts; tv.focusText = e.text; }
    }
    return;
  }
  if (x < listX || x >= listX + listW || y < listY || y >= listY + listH) return;
  if (tab === 0) { const i = top + (y - listY); if (i < view.length && (i === sel || dbl)) { sel = i; const s = current(); if (s) openTranscript(s); } else if (i < view.length) sel = i; }
  else { const i = ptop + (y - listY); if (i < procs.length && (i === psel || dbl)) { psel = i; onInput("enter"); } else if (i < procs.length) psel = i; }
}

// ── terminal lifecycle ──────────────────────────────────────────────────────
function termSize(): void {
  const r = spawnSync("stty", ["size"], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  const m = /(\d+)\s+(\d+)/.exec(r.stdout);
  const h = m ? Number(m[1]) : 24; const w = m ? Number(m[2]) : 80;
  if (h > 0 && w > 0 && (h !== H || w !== W)) { H = Math.max(10, h); W = Math.max(60, w); process.stdout.write(CSI + "2J"); }
}
function enter(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h" + CSI + "2J"); // ?7l: no autowrap, overlong rows never scroll
  termSize();
}
function leave(): void {
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
function quit(): never { leave(); process.exit(0); }

function main(): void {
  if (!process.stdin.isTTY) { console.error("agentglass needs an interactive terminal"); process.exit(1); }
  enter();
  scan(); refreshProcs(); refreshSlow(); buildView();
  render();
  process.stdin.on("data", (d: Uint8Array) => {
    for (const t of tokens(new TextDecoder("utf-8").decode(d))) {
      if (t.startsWith("\x1b[<")) onMouse(t); else onInput(keyName(t));
    }
    render();
  });
  process.on("SIGTERM", () => quit());
  let tick = 0;
  setInterval(() => {
    tick++; frame++;
    termSize();
    if (tick % 3 === 0) { refreshProcs(); }
    if (tick % 6 === 0) { scan(); buildView(); }
    if (tick % 10 === 0) refreshSlow();
    if (mode === "list" && tab === 0) buildView();
    render();
  }, 500);
}
main();
