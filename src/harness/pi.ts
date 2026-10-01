// agentglass — pi (~/.pi/agent) adapter
// SPDX-License-Identifier: Apache-2.0
import { join, dirname, basename } from "node:path";
import { statSync } from "node:fs";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { HOME, readText, readLines, listDir } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C } from "../ui/theme.ts";
import { type Acc, type Day, bucket, tool, pend, retool, file, lines, usageExact, isoMs, nlines, num } from "../features/usage/record.ts";
import { done, fmtMs } from "../features/usage/calls.ts";
import type { AddFn, HarnessAdapter } from "./types.ts";
import { toolArg, blockText } from "./common.ts";

// sessions live in <session dir>/--<cwd>--/<ts>_<id>.jsonl; a custom session dir may hold the files directly
function tilde(p: string): string { return p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p; }
function sessionRoot(): string {
  const env = process.env["PI_CODING_AGENT_SESSION_DIR"];
  if (env) return tilde(env);
  const ad = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = ad ? tilde(ad) : join(HOME, ".pi", "agent");
  const st = parseJson(readText(join(agentDir, "settings.json"), 0, 262144).trim());
  const sd = st ? str(st["sessionDir"]) : "";
  return sd ? tilde(sd) : join(agentDir, "sessions");
}
function fileId(f: string): string { return f.slice(f.indexOf("_") + 1, -6); } // <ts>_<id>.jsonl
function header(path: string): Obj | null {
  const h = readText(path, 0, 4096); const nl = h.indexOf("\n");
  const o = parseJson((nl >= 0 ? h.slice(0, nl) : h).trim());
  return o && str(o["type"]) === "session" ? o : null;
}
// subagent files of the pi-subagents packages carry their id only in the header (run-<i>/session.jsonl): read once per path
const hdrIds = new Map<string, string>();
function headerId(path: string, f: string): string {
  let id = hdrIds.get(path);
  if (id === undefined) { const o = header(path); id = (o ? str(o["id"]) : "") || (f ? fileId(f) : path); hdrIds.set(path, id); }
  return id;
}
// one dir of sessions; a session's sibling dir <base>/ holds its subagents: tasks/*.jsonl (@gotgenes/pi-subagents),
// forks/*.jsonl and <runId>/run-<i>/session.jsonl (pi-subagents)
function scanDir(dir: string, add: AddFn): void {
  const names = listDir(dir); const has = new Set<string>(names);
  for (const f of names) {
    if (!f.endsWith(".jsonl")) continue;
    const pid = fileId(f);
    add(join(dir, f), pid, "", false);
    const base = f.slice(0, -6); if (!has.has(base)) continue;
    const bd = join(dir, base);
    for (const e of listDir(bd)) {
      const ed = join(bd, e);
      if (e === "tasks" || e === "forks") { for (const c of listDir(ed)) if (c.endsWith(".jsonl")) add(join(ed, c), headerId(join(ed, c), c), pid, false); continue; }
      for (const r of listDir(ed)) {
        if (!r.startsWith("run-") || listDir(join(ed, r)).indexOf("session.jsonl") < 0) continue;
        const p = join(ed, r, "session.jsonl");
        add(p, headerId(p, ""), pid, false);
      }
    }
  }
}
function scan(add: AddFn): void {
  const root = sessionRoot();
  scanDir(root, add);
  for (const d of listDir(root)) if (d.startsWith("--")) scanDir(join(root, d), add);
}

// a @tintinweb/pi-subagents child: same dir as its parent, parentSession set, session_info name "<type>#<8 hex>"
const SUBNAME = /^[^#\s]+#[0-9a-f]{8}$/;
// liveness links a process to the session by cwd, before any head is loaded: read the header line (first line, small) once
function meta(s: Sess): void {
  const o = header(s.path);
  if (o) s.cwd = str(o["cwd"]);
  if (s.parent) { if (!s.kind) s.kind = "subagent"; return; } // found in a parent's subagent dir
  const ps = o ? str(o["parentSession"]) : ""; if (!ps) return;
  // parentSession alone is also a /fork, which stays top-level (the user continues in it; it keeps the live pid)
  for (const l of readText(s.path, 0, 262144).split("\n")) {
    if (l.indexOf("\"session_info\"") < 0) continue;
    const io = parseJson(l); const n = io ? str(io["name"]) : "";
    if (!SUBNAME.test(n)) continue;
    s.parent = ps.endsWith(".jsonl") ? fileId(ps.slice(ps.lastIndexOf("/") + 1)) : ps;
    s.kind = n.slice(0, n.indexOf("#")); subHex.set(s.path, n.slice(n.indexOf("#") + 1));
    return;
  }
}

function ev(out: Ev[], kind: string, text: string, ts: string, id: string, full: string): void { out.push({ kind, text, ts, id, full }); }
function parse(o: Obj, out: Ev[], s: Sess | null): void {
  const type = str(o["type"]); const ts = str(o["timestamp"]);
  if (type === "session") { if (s) { const c = str(o["cwd"]); if (c) s.cwd = c; } return; }
  if (type === "session_info") { if (s) { const n = str(o["name"]); if (n) s.title = n; } return; }
  if (type === "model_change") { if (s) { const m = str(o["modelId"]); if (m) s.model = m; } return; }
  if (type === "compaction") { ev(out, "meta", "context compacted", ts, "", ""); return; }
  if (type === "branch_summary") { ev(out, "meta", "branch: " + str(o["summary"]).split("\n")[0], ts, "", ""); return; }
  if (type !== "message") return;
  const m = obj(o["message"]); if (!m) return;
  const role = str(m["role"]);
  if (role === "user") {
    const c = m["content"];
    let t = typeof c === "string" ? c : blockText(c);
    if (!t) for (const b of arr(c)) { const bo = obj(b); if (bo && str(bo["type"]) === "image") { t = "[image]"; break; } } // an image-only prompt still starts a turn
    if (t) ev(out, "user", t, ts, "", "");
  } else if (role === "assistant") {
    if (s) { const md = str(m["responseModel"]) || str(m["model"]); if (md) s.model = md; }
    for (const b of arr(m["content"])) {
      const bo = obj(b); if (!bo) continue;
      const bt = str(bo["type"]);
      if (bt === "text") { const t = str(bo["text"]); if (t) ev(out, "assistant", t, ts, "", ""); }
      else if (bt === "thinking") { const t = str(bo["thinking"]); if (t) ev(out, "thinking", t, ts, "", ""); }
      else if (bt === "toolCall") { const n = str(bo["name"]) || "tool"; const inp = obj(bo["arguments"]); ev(out, "tool", n + "\u0000" + toolArg(n, inp, ""), ts, str(bo["id"]), inp ? JSON.stringify(inp) : ""); }
    }
    const stop = str(m["stopReason"]);
    if (stop === "error" || stop === "aborted") ev(out, "meta", "[" + stop + "] " + str(m["errorMessage"]), ts, "", "");
  } else if (role === "toolResult") {
    const det = obj(m["details"]); const id = str(m["toolCallId"]);
    ev(out, "result", (m["isError"] === true ? "[error] " : "") + blockText(m["content"]), ts, id, det ? JSON.stringify(det) : "");
    for (const c of nested(m, det, id)) { // script-nested calls have no events of their own: one line each
      const st = c.status === "error" ? "[error] " + (c.error.split("\n")[0] ?? "") : c.status || "ok";
      ev(out, "meta", "\u21b3 " + c.name + " " + st + (c.ms >= 0 ? " " + fmtMs(c.ms) : ""), ts, "", "");
    }
  } else if (role === "system") { // pi ≥ 0.99: the MCP servers whose tools are not declared (codemode / tool_search exposure)
    const sec = obj(m["sections"]); const ms = sec ? sec["mcp_servers"] : undefined;
    const names: string[] = [];
    if (typeof ms === "string") { for (const ln of ms.split("\n")) if (ln.startsWith("- ")) { const n = ln.slice(2).split(" ")[0] ?? ""; if (n) names.push(n.startsWith("mcp__") ? n.slice(5) : n); } }
    else for (const v of arr(ms)) { const vo = obj(v); const n = vo ? str(vo["name"]) : str(v); if (n) names.push(n); }
    if (names.length > 0) ev(out, "meta", "MCP: " + names.join(", "), ts, "", "");
  } else if (role === "bashExecution") { // the user's own `!cmd`: pi records it outside any turn (while streaming: at agent_end)
    const id = str(o["id"]); const cmd = str(m["command"]);
    ev(out, "tool", "!bash\u0000" + cmd, ts, id, JSON.stringify({ command: cmd }));
    const code = num(m["exitCode"]); const bad = m["cancelled"] === true || (m["exitCode"] !== undefined && m["exitCode"] !== null && code !== 0);
    ev(out, "result", (bad ? "[error] " : "") + str(m["output"]), ts, id, "");
  }
}
// mid-turn, from the tail's events alone (the log has no turn markers): the last event is the user's prompt, a tool call
// or a tool result — not a `!bash` pair, which is no turn; assistant text/thinking, an error or an abort end the turn
function busy(s: Sess): boolean {
  for (let i = s.evs.length - 1; i >= 0; i--) {
    const e = s.evs[i];
    if (e.kind === "meta") { if (e.text.startsWith("[error]") || e.text.startsWith("[aborted]")) return false; continue; }
    if (e.kind === "result") { const c = i > 0 ? s.evs[i - 1] : null; return !(c && c.kind === "tool" && c.id === e.id && c.text.startsWith("!bash\u0000")); }
    return e.kind === "user" || e.kind === "tool";
  }
  return false;
}

// tokens and cost: pi writes usage.cost.total itself (usage.cost 0 = unpriced model → table fallback in usageExact)
function book(a: Acc, u: Obj | null, model: string, iso: string): void {
  if (!u) return;
  const d = bucket(a, 0, iso);
  const c = obj(u["cost"]); const w1 = num(u["cacheWrite1h"]);
  const usd = typeof u["cost"] === "number" ? num(u["cost"]) : c && typeof c["total"] === "number" ? num(c["total"]) : -1; // subagent results: a number
  const md = model || a.model; if (md) a.model = md;
  usageExact(a, d, md, num(u["input"]), num(u["output"]), num(u["cacheRead"]), Math.max(0, num(u["cacheWrite"]) - w1), w1, usd);
}
// subagents run by pi-subagents / the example extension report their usage on the parent's result; a child with its own
// session file (sessionFile) is counted from that file, one without (--no-session) only here
function bookSubs(a: Acc, m: Obj, det: Obj | null, iso: string): void {
  const tn = str(m["toolName"]); if (!det || (tn !== "subagent" && tn !== "Agent")) return;
  const keep = a.model;
  for (const v of arr(det["results"])) { const r = obj(v); if (r && !str(r["sessionFile"])) book(a, obj(r["usage"]), str(r["model"]), iso); }
  a.model = keep; // the child's model is not the parent's
}
// the parent's tool call that spawned subagent s: pi-subagents → the result listing its sessionFile;
// @tintinweb/pi-subagents → the Agent result whose agentId starts with the child's 8 hex. Cached; misses retried when the parent grew
function statSize(p: string): number { try { return statSync(p).size; } catch (e) { return -1; } }
const spawnCache = new Map<string, { size: number; id: string }>();
const subHex = new Map<string, string>(); // tintinweb child path → the 8 hex of its name (meta)
function spawnCall(s: Sess): string {
  if (!s.parent) return "";
  let pp = ""; let needle = ""; let agent = false;
  const hex = subHex.get(s.path);
  if (hex) { // same dir as the parent; parentSession names it (its file name, wherever the dir lives now)
    const ho = header(s.path); const ps = ho ? str(ho["parentSession"]) : ""; if (!ps.endsWith(".jsonl")) return "";
    pp = join(dirname(s.path), basename(ps)); needle = "\"agentId\":\"" + hex; agent = true;
  } else {
    if (basename(dirname(s.path)) === "tasks") return ""; // @gotgenes: the link lives in memory only
    const up = s.path.endsWith("/session.jsonl") ? dirname(dirname(dirname(s.path))) : dirname(dirname(s.path)); // <base>/<runId>/run-<i>/ | <base>/forks/
    pp = up + ".jsonl"; needle = s.path.slice(dirname(up).length) + "\""; // "/<base>/…/session.jsonl" — the file may be read through another root
  }
  const st = statSize(pp);
  const hit = spawnCache.get(s.path);
  if (hit && (hit.id || hit.size === st)) return hit.id;
  let id = "";
  let off = 0; let win = 1048576;
  while (off < st && !id) {
    const r = readLines(pp, off, Math.min(st, off + win), false);
    if (r.next === off) { if (off + win >= st) break; win *= 2; continue; } // one line longer than the window
    for (const l of r.lines) {
      if (l.indexOf(needle) < 0 || (agent && l.indexOf("\"toolName\":\"Agent\"") < 0) || (!agent && l.indexOf("\"sessionFile\":") < 0)) continue;
      const m = /"toolCallId":"([^"]+)"/.exec(l); if (m) { id = m[1] ?? ""; break; }
    }
    off = r.next;
  }
  spawnCache.set(s.path, { size: st, id });
  return id;
}
function usage(a: Acc, l: string): void {
  if (l.startsWith("{\"type\":\"session\"")) { // header: a fork copies its parent's entries verbatim, their usage is not this file's
    const h = parseJson(l); if (!h) return;
    a.x = [isoMs(str(h["timestamp"])), str(h["parentSession"]) ? 1 : 0];
    return;
  }
  const hasU = l.indexOf("\"usage\":{") >= 0; const call = l.indexOf("\"toolCall\"") >= 0; const res = l.indexOf("\"toolCallId\"") >= 0;
  if (!hasU && !call && !res) return;
  const o = parseJson(l); if (!o) return;
  const iso = str(o["timestamp"]);
  if (a.x.length > 1 && a.x[1] === 1 && isoMs(iso) < a.x[0]) return;
  const type = str(o["type"]);
  if (type === "usage" || type === "compaction" || type === "branch_summary") { book(a, obj(o["usage"]), str(o["model"]), iso); return; }
  if (type !== "message") return;
  const m = obj(o["message"]); if (!m) return;
  const role = str(m["role"]);
  if (role === "toolResult") {
    book(a, obj(m["usage"]), "", iso);
    const id = str(m["toolCallId"]); const p = a.pend.get(id);
    const det = obj(m["details"]);
    if (p) {
      a.pend.delete(id);
      const t = isoMs(iso);
      // MCP (native and pi-mcp-adapter): the result names server and tool → one row per real tool, whatever the call was named;
      // adapter housekeeping (search, describe, status, …) stays under its proxy tool
      const srv = det ? str(det["server"]) : ""; const tl = det ? str(det["tool"]) : ""; const mode = det ? str(det["mode"]) : "";
      if (srv && tl && (mode === "" || mode === "call")) retool(a, p, "mcp__" + srv + "__" + tl);
      const derr = det ? str(det["error"]) : ""; // adapters < 2.11 leave isError false on failed calls
      done(p, t > 0 && p.t > 0 ? t - p.t : -1, m["isError"] === true || derr === "tool_error" || derr === "call_failed", blockText(m["content"]).length, id, []);
    }
    // calls made inside a codemode/mcpScript script have no messages of their own: they count like top-level calls, at the result's time
    bookSubs(a, m, det, iso);
    const ns = nested(m, det, id);
    if (ns.length === 0) return;
    const d = bucket(a, 0, iso);
    for (const c of ns) {
      callStats(a, d, c.name, c.id, c.inp, iso, 0);
      const p2 = a.pend.get(c.id); if (!p2) continue;
      a.pend.delete(c.id);
      done(p2, c.ms, c.status === "error", 0, c.id, []);
    }
    return;
  }
  if (role !== "assistant") return;
  book(a, obj(m["usage"]), str(m["responseModel"]) || str(m["model"]), iso);
  const d = bucket(a, 0, iso);
  for (const b of arr(m["content"])) {
    const bo = obj(b); if (!bo || str(bo["type"]) !== "toolCall") continue;
    callStats(a, d, str(bo["name"]) || "tool", str(bo["id"]), obj(bo["arguments"]), iso, isoMs(iso));
  }
}
// a call nested in a script: status ok | error | unfinished/running/cancelled (no duration); inp null = arguments dropped
interface Nested { id: string; name: string; inp: Obj | null; ms: number; status: string; error: string }
// pi ≥ 0.99 message.nestedCalls (any tool using ctx.executeTool), else codemode's own details.calls, else pi-mcp-adapter mcpScript
function nested(m: Obj, det: Obj | null, parent: string): Nested[] {
  const out: Nested[] = [];
  const nc = obj(m["nestedCalls"]);
  const dcs = det ? arr(det["calls"]) : [];
  const script = !!det && str(det["mode"]) === "script";
  const src = nc ? arr(nc["calls"]) : dcs;
  let i = 0;
  for (const v of src) {
    const c = obj(v); i++; if (!c) continue;
    const ms = typeof c["durationMs"] === "number" ? Math.round(num(c["durationMs"])) : -1;
    if (script && !nc) { // adapter: {operation, path, ok, error, durationMs}; only "call" operations are tool calls
      if (str(c["operation"]) !== "call") continue;
      const ok = c["ok"] !== false;
      out.push({ id: parent + "/" + String(i), name: str(c["path"]) || "tool", inp: null, ms, status: ok ? "ok" : "error", error: str(c["error"]) });
      continue;
    }
    const st = str(c["status"]); if (!str(c["name"])) continue; // some other extension's details.calls
    const inp = nc ? obj(c["arguments"]) : parseJson(str(c["args"]));
    out.push({ id: str(c["id"]) || parent + "/" + String(i), name: str(c["name"]), inp, ms: st === "ok" || st === "error" ? ms : -1, status: st, error: str(c["error"]) });
  }
  return out;
}
// one tool call: tool row + pending result, shell programs, edit/write lines and files (inp null = arguments unknown)
function callStats(a: Acc, d: Day, name: string, id: string, inp: Obj | null, iso: string, t: number): void {
  const st = tool(a, d, name);
  pend(a, d, st, name, id, t, iso, toolArg(name, inp, ""), name === "bash" && inp ? [str(inp["command"])] : []);
  if (!inp) return;
  let add = 0; let del = 0;
  if (name === "edit") {
    const es = arr(inp["edits"]);
    for (const e of es) { const eo = obj(e); if (eo) { add += nlines(str(eo["newText"])); del += nlines(str(eo["oldText"])); } }
    if (es.length === 0) { add = nlines(str(inp["newText"])); del = nlines(str(inp["oldText"])); } // legacy: top-level oldText/newText
  } else if (name === "write") add = nlines(str(inp["content"]));
  else return;
  lines(a, d, add, del); file(d, name, str(inp["path"]), add, del);
}

export const pi: HarnessAdapter = {
  id: "pi", label: "pi", glyph: "π", mark: "π", color: () => C.cyan,
  bin: "pi", procs: ["pi", "pi-rpc"],
  roots: () => [sessionRoot()], scan, meta, headBytes: 262144, // the first entry is a large system message
  parse, busy,
  liveCwd: true, // no lock, no registry, the file is not kept open
  headless: (s: Sess, msg: string) => ["-p", "--session", s.path, "--", msg], // the file path: a bare id outside the cwd's dir prompts to fork
  resume: (s: Sess) => ["--session", s.path],
  files: (s: Sess) => [s.path],
  usage, spawnOf: (s: Sess) => spawnCall(s),
};
