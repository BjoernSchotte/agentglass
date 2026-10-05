// agentglass — Claude Code (~/.claude) adapter
// SPDX-License-Identifier: Apache-2.0
import { join, dirname } from "node:path";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { CLAUDE, readText, readBytes, listDir, listDirCached, KNOWN, LISTING } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C, CSI, RST, fg } from "../ui/theme.ts";
import { type Acc, bucket, tool, pend, file, lines, tokens, skill, turn, isoMs, nlines, num, stamp } from "../features/usage/record.ts";
import { MQ_MSG } from "../features/usage/facts.ts";
import { modelBill } from "../features/usage/billing.ts";
import { done } from "../features/usage/calls.ts";
import { OWN, claim } from "../features/usage/owners.ts";
import { own } from "../util/own.ts";
import type { AddFn, HarnessAdapter, Live } from "./types.ts";
import { toolArg, blockText, isNoise, leadTag, prompts } from "./common.ts";

const PROJECTS = join(CLAUDE, "projects");

// ~/.claude/projects/<project>/<session>.jsonl, subagents in <project>/<session>/subagents/agent-<id>.jsonl
// a project dir's logs and subagent dirs as paths, kept while its listing is the same (no path building per scan)
const PJ = new Map<string, { names: string[]; logs: string[][]; subs: string[][] }>();
// the project dirs' paths and listings in the projects listing's order, while it stands
const TOP = { names: [] as string[], pds: [] as string[], ms: [] as { names: string[]; logs: string[][]; subs: string[][] }[] };
const SD = new Map<string, { names: string[]; logs: string[][] }>(); // the same per subagent dir
const IDLE_MS = 300000; const QUIET_MS = 3600000; // a session not written for 5 min spawns no subagent (the spawning call is written first)
// a live session (registry) whose log the scan does not know yet wakes every project dir for a minute, when it first
// shows and whenever its registry entry moves (a first prompt creates the log); ids = the logs the scan lists
const WAKE = { at: 0, ids: new Set<string>(), unknown: new Map<string, string>() };
// the project dir Claude Code keeps a cwd's logs in: every character but letters and digits as "-"
export function projectDirOf(cwd: string): string {
  let o = ""; for (let i = 0; i < cwd.length; i++) { const c = cwd.charCodeAt(i); o += (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? cwd.charAt(i) : "-"; }
  return join(PROJECTS, o);
}
function scan(add: AddFn): void {
  const quiet = Date.now() - WAKE.at < 60000 ? -1 : QUIET_MS; // a project dir unchanged for an hour: once a minute, unless a new live session is unknown (or a new agent: fs.ts WAKE_ALL)
  const top = listDirCached(PROJECTS);
  let changed = top !== TOP.names;
  if (changed) { TOP.names = top; TOP.pds = []; TOP.ms = []; for (const proj of top) TOP.pds.push(join(PROJECTS, proj)); }
  const now = Date.now();
  // look at every dir first (the cached listings, a stat where due); emit only when one changed or the caller has no copy
  for (let i = 0; i < TOP.pds.length; i++) {
    const pd = TOP.pds[i] ?? "";
    const names = listDirCached(pd, quiet, "claude");
    let m = i < TOP.ms.length ? TOP.ms[i] : null;
    if (!m || m.names !== names) {
      m = PJ.get(pd) ?? null;
      if (!m || m.names !== names) {
        m = { names, logs: [], subs: [] };
        for (const f of names) {
          if (f.endsWith(".jsonl")) { m.logs.push([join(pd, f), f.slice(0, -6)]); WAKE.ids.add(f.slice(0, -6)); }
          else if (f.length === 36) m.subs.push([join(pd, f, "subagents"), f, join(pd, f + ".jsonl")]); // <session-uuid>/ dirs hold subagent transcripts
        }
        PJ.set(pd, m); changed = true;
      }
      if (i < TOP.ms.length) TOP.ms[i] = m; else TOP.ms.push(m);
    }
    for (const d of m.subs) {
      const sd = d[0] ?? "";
      const pm = KNOWN.mtime(d[2] ?? ""); // its session idle (or gone): no new subagents now, the dir looked at once a minute
      const ns = listDirCached(sd, pm === 0 || now - pm >= IDLE_MS ? 0 : -1, "claude");
      const k = SD.get(sd);
      if (!k || k.names !== ns) { const kk = { names: ns, logs: [] as string[][] }; for (const a of ns) if (a.endsWith(".jsonl")) kk.logs.push([join(sd, a), a.slice(6, -6)]); SD.set(sd, kk); changed = true; }
    }
  }
  if (!changed && LISTING.want) { LISTING.same = true; return; } // the caller still holds what this would list
  for (const m of TOP.ms) {
    for (const l of m.logs) add(l[0] ?? "", l[1] ?? "", "", false);
    for (const d of m.subs) { const k = SD.get(d[0] ?? ""); if (k) for (const l of k.logs) add(l[0] ?? "", l[1] ?? "", d[1] ?? "", false); }
  }
  if (PJ.size > 4096) PJ.clear();
  if (SD.size > 65536) SD.clear();
}
// subagents: agent-<id>.meta.json {agentType, description, model, toolUseId}
function meta(s: Sess): void {
  if (!s.parent) return;
  s.kind = "agent";
  const o = parseJson(readText(s.path.slice(0, -6) + ".meta.json", 0, 4096).trim());
  if (!o) return;
  s.kind = str(o["agentType"]) || "agent";
  s.title = str(o["description"]);
  s.model = str(o["model"]);
}
function spawnCall(s: Sess): string {
  const m = /"toolUseId":"([^"]+)"/.exec(readText(s.path.slice(0, -6) + ".meta.json", 0, 8192));
  return m ? m[1] ?? "" : "";
}
export type UserKind = "human" | "notify" | "peer" | "meta" | "noise";
const PEER_WRAP = "Another Claude session sent a message"; // + <agent-message from="…">: older transcripts carry no origin
// known leading tags first, so an origin can never promote hook or command output to a prompt; then origin; then old-transcript fallbacks
export function classifyUser(o: Obj, text: string): UserKind {
  const lt = leadTag(text);
  if (lt === "bash-input" || lt === "command-name" || lt === "command-message") return "meta";
  if (lt !== "task-notification" && isNoise(text)) return "noise";
  const og = obj(o["origin"]); const k = og ? str(og["kind"]) : ""; const to = str(o["turnOrigin"]);
  if (k === "human" || to === "human" || to === "sdk" || to === "scheduled") return "human"; // a person or their script asked
  if (k === "task-notification" || k === "auto-continuation" || to === "task_notification" || to === "auto_continuation") return "notify";
  if (k === "peer" || to === "peer") return "peer";
  if (lt === "task-notification") return "notify";
  if (text.startsWith(PEER_WRAP) && text.indexOf("<agent-message") >= 0) return "peer";
  if (lt === "teammate-message") return "peer"; // agent teams: the lead (or a teammate) writing to this agent
  return "human"; // unknown = visible
}
function inner(t: string, tag: string): string {
  const a = t.indexOf("<" + tag + ">"); if (a < 0) return "";
  const b = t.indexOf("</" + tag + ">", a); return t.slice(a + tag.length + 2, b > a ? b : t.length).trim();
}
function firstLine(t: string, n: number): string { for (const ln of t.split("\n")) { const x = ln.trim(); if (x) return x.length > n ? x.slice(0, n - 1) + "…" : x; } return ""; }
// ⇄ <sender> · <first line of the message>; a subagent hand-back's frame text is skipped up to the report itself
function peerText(o: Obj, t: string): string {
  const og = obj(o["origin"]);
  const tm = /^\s*<teammate-message teammate_id="([^"]*)"(?: summary="([^"]*)")?[^>]*>/.exec(t);
  if (tm) return "\u21c4 " + ((tm[1] ?? "") || "peer") + " · " + ((tm[2] ?? "") || firstLine(t.slice((tm[0] ?? "").length).split("</teammate-message>")[0] ?? "", 120));
  const at = /<agent-message from="([^"]*)">/.exec(t);
  const from = (og ? str(og["name"]) || str(og["from"]) : "") || (at ? at[1] ?? "" : "") || "peer";
  let body = og ? str(og["body"]) : "";
  if (!body && at) { const a = t.indexOf(at[0] ?? "") + (at[0] ?? "").length; const b = t.indexOf("</agent-message>", a); body = t.slice(a, b > a ? b : t.length); }
  if (!body) body = t;
  const rf = body.indexOf("The report follows:"); if (rf >= 0) body = body.slice(rf + 19);
  return "\u21c4 " + from + " · " + firstLine(body, 120);
}
// one user text → its event: prompt, ⟲ notification (id = the spawning call), ⇄ peer message, ! shell input, or nothing
function userEvs(o: Obj, t: string, ts: string, out: Ev[]): void {
  const k = classifyUser(o, t);
  if (k === "human") out.push({ kind: "user", text: t, ts, id: "", full: "" });
  else if (k === "meta") { if (leadTag(t) === "bash-input") out.push({ kind: "meta", text: "! " + inner(t, "bash-input"), ts, id: "", full: "" }); }
  else if (k === "peer") out.push({ kind: "meta", text: peerText(o, t), ts, id: "", full: "" });
  else if (k === "notify") {
    const st = inner(t, "status"); const sm = inner(t, "summary");
    const og = obj(o["origin"]); const auto = (og ? str(og["kind"]) : "") === "auto-continuation" || str(o["turnOrigin"]) === "auto_continuation";
    out.push({ kind: "meta", text: "\u27f2 " + (st || (auto ? "auto-continue" : "resumed")) + (sm ? " · " + sm : ""), ts, id: inner(t, "tool-use-id"), full: "" });
  }
}
const renamed = new Map<string, string[]>(); // path → [custom title ("" = renamed to empty), its timestamp]: /rename wins over the ai-title Claude re-appends after it
// the head memo (model/sessions.ts) keeps a rename its head held: "<timestamp>\t<title>"
function headState(s: Sess): string { const r = renamed.get(s.path); return r ? (r[1] ?? "") + "\t" + (r[0] ?? "") : ""; }
function setHeadState(s: Sess, x: string): void {
  const i = x.indexOf("\t"); if (i < 0) return;
  const ts = x.slice(0, i); const prev = renamed.get(s.path);
  if (prev && ts && (prev[1] ?? "") > ts) return; // like a replayed custom-title line: never roll back a newer rename
  renamed.set(s.path, [x.slice(i + 1), ts]);
}
function parse(o: Obj, out: Ev[], s: Sess | null): void {
  const ts = str(o["timestamp"]); const type = str(o["type"]);
  if (type === "custom-title") {
    if (!s) return;
    const t = str(o["customTitle"]).trim(); const prev = renamed.get(s.path);
    if (prev && ts && (prev[1] ?? "") > ts) return; // an older rename (head read after tail) never rolls back a newer one
    renamed.set(s.path, [t, ts]); if (t) s.title = t;
    return;
  }
  if (type === "ai-title") { if (s) { const r = renamed.get(s.path); const t = r ? r[0] ?? "" : ""; s.title = t || str(o["aiTitle"]); } return; }
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
    else userEvs(o, c, ts, out);
    return;
  }
  for (const b of arr(c)) {
    const bo = obj(b);
    if (!bo) continue;
    const bt = str(bo["type"]);
    if (bt === "text") { const t = str(bo["text"]); if (type === "assistant") out.push({ kind: "assistant", text: t, ts, id: "", full: "" }); else userEvs(o, t, ts, out); }
    else if (bt === "thinking") { const t = str(bo["thinking"]); if (t) out.push({ kind: "thinking", text: t, ts, id: "", full: "" }); }
    else if (bt === "tool_use") { const n = str(bo["name"]); const inp = obj(bo["input"]); out.push({ kind: "tool", text: n + "\u0000" + toolArg(n, inp, ""), ts, id: str(bo["id"]), full: inp ? JSON.stringify(inp) : "" }); }
    else if (bt === "tool_result") { const tur = obj(o["toolUseResult"]); out.push({ kind: "result", text: blockText(bo["content"]), ts, id: str(bo["tool_use_id"]), full: tur ? JSON.stringify(tur) : "" }); }
  }
}
// ~/.claude/sessions/<pid>.json: {pid, sessionId, status: busy|idle|…, name} for every running claude
function liveRegistry(alive: (pid: number) => boolean, harnessOfPid: (pid: number) => string): Live[] { // claude writes one file per running pid: alive is enough
  const out: Live[] = [];
  const sd = join(CLAUDE, "sessions");
  for (const f of listDir(sd)) {
    if (!f.endsWith(".json")) continue;
    const o = parseJson(readText(join(sd, f), 0, 8192).trim());
    if (!o) continue;
    const pid = num(o["pid"]);
    if (pid && alive(pid)) { const id = str(o["sessionId"]); out.push({ id, pid, status: str(o["status"]), name: str(o["name"]) }); if (id && !WAKE.ids.has(id)) { const k = str(o["status"]) + "|" + String(num(o["updatedAt"])); if (WAKE.unknown.get(id) !== k) { WAKE.unknown.set(id, k); WAKE.at = Date.now(); } } }
  }
  return out;
}
function files(s: Sess): string[] { const d = s.path.slice(0, -6); return [s.path, d, d + ".meta.json"]; }

// tool_result lines are the bulk of the bytes: no JSON.parse — the block's keys are unescaped only at the structural level
function claudeResult(a: Acc, l: string): void {
  const at = l.indexOf("\"tool_use_id\":\"");
  const m = /^"tool_use_id":"([^"]+)"/.exec(l.slice(at, at + 200));
  const id = m ? m[1] ?? "" : "";
  const p = a.pend.get(id); if (!p) return;
  a.pend.delete(id);
  const tm = /"timestamp":"([^"]+)"/.exec(l.slice(at));
  const t = tm ? isoMs(tm[1] ?? "") : 0;
  const tr = l.indexOf("\"type\":\"tool_result\"");
  const s0 = tr >= 0 && tr < at ? tr : at; const end = l.indexOf("]},\"uuid\":\"", at); // result block ≈ up to the end of the message (JSON-escaped size)
  done(p, t > 0 && p.t > 0 ? t - p.t : -1, l.indexOf("\"is_error\":true") >= 0, end > s0 ? end - s0 : 0, id, []);
}
// false = the line names this log's own session (session_id: the session its process wrote it in; a background
// continuation's copied lines keep the original's, sessionId is the new file's). Another session it names may own the
// line's message (Acc.xs → carriers)
function copied(a: Acc, o: Obj): boolean {
  const sid = str(o["session_id"]); if (!sid || !a.p) return true;
  if (a.p.indexOf(sid) >= 0) return false;
  if (!a.xs.has(sid)) a.xs.add(own(sid));
  return true;
}
// a user line another log carries too (same uuid): its owner books the prompt
function owned(a: Acc, o: Obj): boolean { const u = str(o["uuid"]); return !u || claim(a, "u:" + u, str(o["timestamp"]), copied(a, o)); }
function userText(o: Obj): string { const m = obj(o["message"]); const c = m ? m["content"] : null; return typeof c === "string" ? c : blockText(c); }
// slash-command skills: the command line, then an isMeta line "Base directory for this skill: …/skills/<name>" with the same
// promptId and no sourceToolUseID (a model's Skill call has one). /compact & co. never get that line.
function userLine(a: Acc, l: string): void {
  if (l.indexOf("<command-name>/") >= 0) {
    const o = parseJson(l); if (!o) return;
    const cm = /<command-name>\/([^<]*)<\/command-name>/.exec(userText(o));
    a.pk = cm && owned(a, o) ? str(o["promptId"]) + "\t" + (cm[1] ?? "").trim() : ""; // a copied command is its owner's
    return;
  }
  if (!a.pk) return;
  const tab = a.pk.indexOf("\t"); const pid = a.pk.slice(0, tab); const name = a.pk.slice(tab + 1);
  if (l.indexOf("Base directory for this skill:") >= 0 && l.indexOf("\"isMeta\":true") >= 0) {
    a.pk = "";
    const o = parseJson(l); if (!o || str(o["sourceToolUseID"]) || !pid || str(o["promptId"]) !== pid) return;
    const bd = /Base directory for this skill:[ \t]*([^\n]*)/.exec(userText(o));
    const dir = bd ? (bd[1] ?? "").trim().replace(/[\/\\]+$/, "") : "";
    if (dir && dir.slice(Math.max(dir.lastIndexOf("/"), dir.lastIndexOf("\\")) + 1) === name.slice(name.lastIndexOf(":") + 1)) skill(bucket(a, 0, str(o["timestamp"])), "command", name);
    return;
  }
  const pm = /"promptId":"([^"]+)"/.exec(l);
  if (!pm || (pm[1] ?? "") !== pid) a.pk = ""; // another prompt: that command had no skill directory
}
function usage(a: Acc, l: string): void {
  if (l.indexOf("\"type\":\"assistant\"") < 0) {
    if (l.indexOf("\"tool_use_id\":\"") >= 0) { if (a.pend.size) claudeResult(a, l); return; }
    if (l.indexOf("\"type\":\"user\"") < 0) return;
    userLine(a, l);
    if (a.sub || l.indexOf("\"isMeta\":true") >= 0) return; // never a (human) prompt
    const o = parseJson(l); const n = o ? prompts(parse, o) : 0;
    if (o && n && owned(a, o)) turn(a, 0, str(o["timestamp"]), n); // a copied prompt is its owner's turn
    return;
  }
  const o = parseJson(l); if (!o || str(o["type"]) !== "assistant") return;
  const m = obj(o["message"]); if (!m) return;
  const iso = str(o["timestamp"]);
  const id = str(m["id"]) || str(o["requestId"]); const u = obj(m["usage"]);
  // a message another log carries too (fork, resume, a second project dir, a forked subagent) books in the first one only
  if (id && !a.ids.has(id) && !claim(a, id, iso, copied(a, o))) return;
  const d = bucket(a, 0, iso);
  const md0 = str(m["model"]); const rowModel = md0 === "<synthetic>" ? "" : md0; // the model that issued this line's calls
  const was = id ? a.ids.get(id) : undefined;
  if (u && was !== undefined) { // a later line of a booked message: output_tokens grew while it streamed (thinking first)
    const o2 = num(u["output_tokens"]); const md = str(m["model"]) || a.model; // the top level mirrors the answering attempt
    if (o2 > was) { a.ids.set(id, o2); if (md !== "<synthetic>") tokens(a, d, md, 0, o2 - was, 0, 0, 0); }
  } else if (u) { // one API message is split over several lines carrying the same id + usage
    if (id) a.ids.set(id, num(u["output_tokens"]));
    const model = str(m["model"]) || a.model; if (model) a.model = model;
    const mb = modelBill(model); if (mb) stamp(a, mb, "", "session");
    const its = arr(u["iterations"]);
    if (its.length >= 2) { // fallback retries: each attempt billed on its own model; the top level mirrors only the last one
      for (const x of its) {
        const it = obj(x); if (!it) continue;
        const md = str(it["model"]) || model; if (md === "<synthetic>") continue;
        const ic = obj(it["cache_creation"]);
        tokens(a, d, md, num(it["input_tokens"]), num(it["output_tokens"]), num(it["cache_read_input_tokens"]), ic ? num(ic["ephemeral_5m_input_tokens"]) : num(it["cache_creation_input_tokens"]), ic ? num(ic["ephemeral_1h_input_tokens"]) : 0);
      }
    } else {
      const cw = num(u["cache_creation_input_tokens"]); const cc = obj(u["cache_creation"]);
      const w1 = cc ? num(cc["ephemeral_1h_input_tokens"]) : 0;
      if (model !== "<synthetic>") tokens(a, d, model, num(u["input_tokens"]), num(u["output_tokens"]), num(u["cache_read_input_tokens"]), Math.max(0, cw - w1), w1);
    }
  }
  for (const b of arr(m["content"])) {
    const bo = obj(b); if (!bo || str(bo["type"]) !== "tool_use") continue;
    const name = str(bo["name"]) || "tool"; const st = tool(a, d, name, rowModel, MQ_MSG);
    const inp = obj(bo["input"]);
    if (name === "Skill" && inp) skill(d, "model", str(inp["skill"]));
    pend(a, d, st, name, str(bo["id"]), isoMs(iso), iso, toolArg(name, inp, ""), name === "Bash" && inp ? [str(inp["command"])] : []);
    if (!inp) continue;
    let add = 0; let del = 0;
    if (name === "Edit") { add = nlines(str(inp["new_string"])); del = nlines(str(inp["old_string"])); }
    else if (name === "Write") add = nlines(str(inp["content"]));
    else if (name === "NotebookEdit") add = nlines(str(inp["new_source"]));
    else if (name === "MultiEdit") for (const e of arr(inp["edits"])) { const eo = obj(e); if (eo) { add += nlines(str(eo["new_string"])); del += nlines(str(eo["old_string"])); } }
    else continue;
    lines(a, d, add, del); file(a, d, name, str(inp["file_path"]) || str(inp["notebook_path"]), add, del);
  }
}

// a subagent's fork mark from agent-<id>.meta.json: "" = no fork, "*" = a fork of the root session, else its parent agent's id
const FORK = new Map<string, string>();
function forkOf(path: string): string {
  let f = FORK.get(path); if (f !== undefined) return f;
  const m = readText(path.slice(0, -6) + ".meta.json", 0, 8192);
  f = m.indexOf("\"isFork\":true") < 0 ? "" : "*";
  if (f) { const pm = /"parentAgentId":"([^"]+)"/.exec(m); if (pm) f = pm[1] ?? "*"; }
  FORK.set(path, f); return f;
}
OWN.fork = (path: string): boolean => forkOf(path) !== "";
// a log at home: its project dir is the one Claude names after the session's cwd (each character but a-z A-Z 0-9 → "-";
// past 200 characters cut, plus "-<hash>"). The same session under another dir (a project moved or copied with its
// ~/.claude dir) is a copy: same lines, same times, and nothing else to tell them apart. No cwd in the first MB: at home
// (remembered only once the head is that long: a new log's cwd can follow its queued prompts)
const HOME = new Map<string, boolean>();
function homeOf(path: string): boolean {
  let h = HOME.get(path); if (h !== undefined) return h;
  const i = path.lastIndexOf("/subagents/"); const p = i >= 0 ? path.slice(0, i) : path; // <project>/<session>/subagents/…: as the session's own log
  const d = dirname(p); const proj = d.slice(d.lastIndexOf("/") + 1);
  let cwd = ""; let full = false;
  for (const n of [65536, 1048576]) { // queued prompts can come first, 90 KB each
    const b = readBytes(path, 0, n); full = b.length === n; cwd = cwdOf(new TextDecoder("utf-8").decode(b)); if (cwd || !full) break;
  }
  const ch: string[] = []; for (const c of Array.from(cwd)) ch.push(/^[a-zA-Z0-9]$/.test(c) ? c : "-");
  const enc = ch.join("");
  h = !cwd || proj === enc || (enc.length > 200 && proj.startsWith(enc.slice(0, 200) + "-"));
  if (cwd || full) HOME.set(path, h);
  return h;
}
// the first cwd a log's head names (its complete lines only), "" = none
function cwdOf(head: string): string {
  const ls = head.split("\n"); ls.pop();
  for (const l of ls) { if (l.indexOf("\"cwd\":") < 0) continue; const o = parseJson(l); const c = o ? str(o["cwd"]) : ""; if (c) return c; }
  return "";
}
OWN.home = homeOf;
// a log's place under projects/: "<session>.jsonl", or "<session>/subagents/agent-<id>.jsonl"
function tailOf(path: string): string {
  const i = path.lastIndexOf("/subagents/"); const j = path.lastIndexOf("/", i >= 0 ? i - 1 : path.length - 1);
  return path.slice(j + 1);
}
let twinsGen = -1; let twinsM = new Map<string, string[]>(); // tailOf → the paths with it (one per project dir)
function twins(all: Map<string, Sess>, gen: number): Map<string, string[]> {
  if (gen === twinsGen) return twinsM;
  const m = new Map<string, string[]>();
  for (const [p, s] of all) { if (s.h !== "claude") continue; const k = tailOf(p); const v = m.get(k); if (v) v.push(p); else m.set(k, [p]); }
  twinsGen = gen; twinsM = m; return m;
}
// the same session under another project dir, the sessions its copied lines name, a subagent's root; a fork's parent agent
// and the other forks of that parent (they start with the same copied block)
function carriers(s: Sess, a: Acc, all: Map<string, Sess>, gen: number): string[] {
  const tw = twins(all, gen); const out: string[] = [];
  for (const p of tw.get(tailOf(s.path)) ?? []) if (p !== s.path) out.push(p);
  for (const sid of a.xs) for (const p of tw.get(sid + ".jsonl") ?? []) out.push(p);
  if (!s.parent) return out;
  const sd = dirname(s.path); out.push(join(dirname(dirname(sd)), s.parent + ".jsonl"));
  const f = forkOf(s.path); if (!f) return out;
  if (f !== "*") out.push(join(sd, "agent-" + f + ".jsonl"));
  for (const n of listDir(sd)) { const p = join(sd, n); if (n.endsWith(".jsonl") && p !== s.path && forkOf(p) === f) out.push(p); }
  return out;
}

export const claude: HarnessAdapter = {
  id: "claude", label: "Claude", glyph: "✻", mark: "✻", color: () => C.claude,
  badge: () => fg(C.claude) + CSI + "1m" + "✻" + RST + fg(C.claude) + " Claude  " + RST, // terracotta spark
  bin: "claude", procs: ["claude"],
  roots: () => [PROJECTS], scan, meta, headBytes: 131072,
  parse, spawnOf: (s: Sess) => spawnCall(s),
  busy: (s: Sess) => s.status === "busy", // the registry knows; its logs carry no turn markers
  liveRegistry, wakeDir: projectDirOf,
  headless: (s: Sess, msg: string) => ["-p", "--resume", s.id, msg],
  resume: (s: Sess) => ["--resume", s.id],
  files, usage, carriers, headState, setHeadState,
};
