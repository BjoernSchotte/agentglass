// agentglass — kiro-cli (~/.kiro): event parsing, subagent meta, resume commands
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, arr, parse } from "../util/json.ts";
import { readText } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { toolArg, blockText, isNoise } from "./common.ts";

// kiro-cli transcript (.jsonl): one {version, kind, data} object per line.
// kind ∈ {Prompt, AssistantMessage, ToolResults, Compaction}; the versioned format may add more,
// so unknown kinds fall through to a generic meta event instead of crashing.
// Lines carry no timestamp; ts is left "" (turn timing lives in the sidecar .json metadata).
export function parseKiro(o: Obj, out: Ev[], s: Sess | null): void {
  const kind = str(o["kind"]);
  const d = obj(o["data"]);
  if (kind === "Prompt") {
    if (!d) return;
    const t = blockText(d["content"]);
    if (t && !isNoise(t)) out.push({ kind: "user", text: t, ts: "", id: "", full: "" });
    return;
  }
  if (kind === "AssistantMessage") {
    if (!d) return;
    for (const b of arr(d["content"])) {
      const bo = obj(b);
      if (!bo) continue;
      const bt = str(bo["kind"]);
      if (bt === "text") { const t = str(bo["data"]); if (t) out.push({ kind: "assistant", text: t, ts: "", id: "", full: "" }); }
      else if (bt === "thinking") { const td = obj(bo["data"]); const t = td ? str(td["text"]) : ""; if (t) out.push({ kind: "thinking", text: t, ts: "", id: "", full: "" }); }
      else if (bt === "toolUse") {
        const u = obj(bo["data"]);
        if (!u) continue;
        const n = str(u["name"]) || "tool";
        const inp = obj(u["input"]);
        out.push({ kind: "tool", text: n + "\u0000" + toolArg(n, inp, ""), ts: "", id: str(u["toolUseId"]), full: inp ? JSON.stringify(inp) : "" });
      }
    }
    return;
  }
  if (kind === "ToolResults") {
    if (!d) return;
    for (const b of arr(d["content"])) {
      const bo = obj(b);
      if (!bo || str(bo["kind"]) !== "toolResult") continue;
      const r = obj(bo["data"]);
      if (!r) continue;
      const status = str(r["status"]);
      const t = blockText(r["content"]);
      out.push({ kind: "result", text: (status && status !== "success" ? "[" + status + "] " : "") + t, ts: "", id: str(r["toolUseId"]), full: "" });
    }
    return;
  }
  if (kind === "Compaction") { out.push({ kind: "meta", text: "context compacted", ts: "", id: "", full: "" }); return; }
  if (kind) out.push({ kind: "meta", text: kind.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(), ts: "", id: "", full: "" }); // unknown/future kind: never crash
}

// kiro-cli: ~/.kiro/sessions/cli/<uuid>.json {session_id, cwd, title, parent_session_id, session_created_reason}
// subagents set session_created_reason == "subagent" + parent_session_id (mirror codexSub).
export function kiroMeta(s: Sess): void {
  const o = parse(readText(s.path.slice(0, -6) + ".json", 0, 65536).trim());
  if (!o) return;
  const c = str(o["cwd"]); if (c) s.cwd = c;
  const t = str(o["title"]); if (t) s.title = t;
  const par = str(o["parent_session_id"]);
  if (par) {
    s.parent = par;
    s.kind = str(o["session_created_reason"]) || "subagent";
  }
}
// kiro-cli resume/headless flags are unverified against the real binary; stub until confirmed.
// The interactive path (tmux send / R to attach) works regardless; -p/exec resume are guesses so we omit them.
export function kiroHeadless(id: string, msg: string): string[] { return []; }
export function kiroResume(id: string): string[] { return []; }
