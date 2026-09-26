// agentglass — Codex (~/.codex): event parsing, subagent meta, resume commands
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str } from "../util/json.ts";
import { readText } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { toolArg, blockText, isNoise } from "./common.ts";

export function parseCodex(o: Obj, ts: string, type: string, out: Ev[], s: Sess | null): void {
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
// Codex: first line (session_meta) names parent_thread_id + source.subagent {thread_spawn{agent_role,agent_nickname} | other:"guardian"}
export function codexSub(s: Sess): void {
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
export function codexHeadless(id: string, msg: string): string[] { return ["exec", "resume", id, msg]; }
export function codexResume(id: string): string[] { return ["resume", id]; }
