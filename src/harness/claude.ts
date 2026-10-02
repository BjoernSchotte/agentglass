// agentglass — Claude Code (~/.claude) adapter
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { CLAUDE, readText, listDir } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C, CSI, RST, fg } from "../ui/theme.ts";
import { type Acc, bucket, tool, pend, file, lines, tokens, isoMs, nlines, num } from "../features/usage/record.ts";
import { done } from "../features/usage/calls.ts";
import type { AddFn, HarnessAdapter, Live } from "./types.ts";
import { toolArg, blockText, isNoise, leadTag } from "./common.ts";

const PROJECTS = join(CLAUDE, "projects");

// ~/.claude/projects/<project>/<session>.jsonl, subagents in <project>/<session>/subagents/agent-<id>.jsonl
function scan(add: AddFn): void {
  for (const proj of listDir(PROJECTS)) {
    for (const f of listDir(join(PROJECTS, proj))) {
      if (f.endsWith(".jsonl")) { add(join(PROJECTS, proj, f), f.slice(0, -6), "", false); continue; }
      if (f.length !== 36) continue; // <session-uuid>/ dirs hold subagent transcripts
      const sd = join(PROJECTS, proj, f, "subagents");
      for (const a of listDir(sd)) if (a.endsWith(".jsonl")) add(join(sd, a), a.slice(6, -6), f, false);
    }
  }
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
    if (pid && alive(pid)) out.push({ id: str(o["sessionId"]), pid, status: str(o["status"]), name: str(o["name"]) });
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
function usage(a: Acc, l: string): void {
  if (l.indexOf("\"type\":\"assistant\"") < 0) { if (a.pend.size && l.indexOf("\"tool_use_id\":\"") >= 0) claudeResult(a, l); return; }
  const o = parseJson(l); if (!o || str(o["type"]) !== "assistant") return;
  const m = obj(o["message"]); if (!m) return;
  const iso = str(o["timestamp"]);
  const d = bucket(a, 0, iso);
  const id = str(m["id"]); const u = obj(m["usage"]);
  if (u && !(id && a.ids.has(id))) { // one API message is split over several lines carrying the same id + usage
    if (id) a.ids.add(id);
    const model = str(m["model"]) || a.model; if (model) a.model = model;
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
    const name = str(bo["name"]) || "tool"; const st = tool(a, d, name);
    const inp = obj(bo["input"]);
    pend(a, d, st, name, str(bo["id"]), isoMs(iso), iso, toolArg(name, inp, ""), name === "Bash" && inp ? [str(inp["command"])] : []);
    if (!inp) continue;
    let add = 0; let del = 0;
    if (name === "Edit") { add = nlines(str(inp["new_string"])); del = nlines(str(inp["old_string"])); }
    else if (name === "Write") add = nlines(str(inp["content"]));
    else if (name === "NotebookEdit") add = nlines(str(inp["new_source"]));
    else if (name === "MultiEdit") for (const e of arr(inp["edits"])) { const eo = obj(e); if (eo) { add += nlines(str(eo["new_string"])); del += nlines(str(eo["old_string"])); } }
    else continue;
    lines(a, d, add, del); file(d, name, str(inp["file_path"]) || str(inp["notebook_path"]), add, del);
  }
}

export const claude: HarnessAdapter = {
  id: "claude", label: "Claude", glyph: "✻", mark: "✻", color: () => C.claude,
  badge: () => fg(C.claude) + CSI + "1m" + "✻" + RST + fg(C.claude) + " Claude  " + RST, // terracotta spark
  bin: "claude", procs: ["claude"],
  roots: () => [PROJECTS], scan, meta, headBytes: 131072,
  parse, spawnOf: (s: Sess) => spawnCall(s),
  busy: (s: Sess) => s.status === "busy", // the registry knows; its logs carry no turn markers
  liveRegistry,
  headless: (s: Sess, msg: string) => ["-p", "--resume", s.id, msg],
  resume: (s: Sess) => ["--resume", s.id],
  files, usage,
};
