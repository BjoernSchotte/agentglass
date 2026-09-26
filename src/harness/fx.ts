// agentglass — fx (~/.fx): event parsing, session meta, resume commands
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, parse } from "../util/json.ts";
import { readText } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { toolArg } from "./common.ts";

// fx events.jsonl: {seq, timestamp_ms, event: {<kind>: {...}}} — one kind per line
function fxResult(preview: string): string {
  const p = parse(preview);
  if (!p) return preview;
  const t = str(p["output_delta"]) || str(p["result"]) || str(p["output"]) || str(p["error"]) || str(p["error_code"]);
  return t || preview;
}
export function parseFx(o: Obj, out: Ev[], logPath: string): void {
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
// fx: ~/.fx/sessions/<id>/{session.json, events.jsonl, subagent/owner.json {parent_id}}
export function fxMeta(s: Sess): void {
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
export function fxHeadless(id: string, msg: string): string[] { return ["ask", "--auto", "--resume-id", id, "--", msg]; }
export function fxResume(id: string): string[] { return ["resume", id]; }
