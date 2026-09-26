// agentglass — Claude Code (~/.claude): event parsing, subagent meta, resume commands
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, arr, parse } from "../util/json.ts";
import { readText } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { toolArg, blockText, isNoise } from "./common.ts";

export function parseClaude(o: Obj, ts: string, type: string, out: Ev[], s: Sess | null): void {
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
}
// Claude: <project>/<session>/subagents/agent-<id>.jsonl + agent-<id>.meta.json {agentType, description, model}
export function claudeSub(s: Sess, parent: string): void {
  s.parent = parent;
  s.kind = "agent";
  const o = parse(readText(s.path.slice(0, -6) + ".meta.json", 0, 4096).trim());
  if (!o) return;
  s.kind = str(o["agentType"]) || "agent";
  s.title = str(o["description"]);
  s.model = str(o["model"]);
}
export function claudeHeadless(id: string, msg: string): string[] { return ["-p", "--resume", id, msg]; }
export function claudeResume(id: string): string[] { return ["--resume", id]; }
