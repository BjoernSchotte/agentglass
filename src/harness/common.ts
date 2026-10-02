// agentglass — event-parsing helpers shared by the harness parsers
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, arr, parse } from "../util/json.ts";
import type { Sess } from "../model/types.ts";

export function toolArg(name: string, inp: Obj | null, raw: string): string {
  if (inp) {
    if (name === "mcp" && str(inp["tool"])) { const sv = str(inp["server"]); return (sv ? sv + "/" : "") + str(inp["tool"]); } // pi-mcp-adapter proxy
    const keys = ["command", "cmd", "file_path", "path", "pattern", "url", "query", "code", "description", "prompt", "skill", "task", "location", "__tool_use_purpose"];
    for (const k of keys) {
      const v = str(inp[k]); if (!v) continue;
      if (k !== "code") return v;
      for (const ln of v.split("\n")) { const t = ln.trim(); if (t) return t.length > 120 ? t.slice(0, 119) + "…" : t; } // script: its first line
    }
    const req = obj(inp["request"]);
    if (req) return toolArg(name, req, "");
    return JSON.stringify(inp);
  }
  const j = parse(raw);
  if (j) return toolArg(name, j, "");
  return raw;
}
export function blockText(v: unknown): string {
  if (typeof v === "string") return v;
  const parts: string[] = [];
  for (const b of arr(v)) {
    const o = obj(b);
    if (!o) continue;
    const t = str(o["text"]); // Claude/Codex text blocks
    if (t) { parts.push(t); continue; }
    const k = str(o["kind"]); if (k !== "text" && k !== "json") continue; // kiro blocks only: pi image blocks carry base64 in `data`
    const d = o["data"]; // kiro: {kind: "text" | "json", data}
    if (typeof d === "string") parts.push(d);
    else if (d !== undefined && d !== null) parts.push(JSON.stringify(d));
  }
  return parts.join("\n");
}
// leading tags the harnesses inject into user messages: never a prompt. Anything else starting with < (<div>, < 3) is one.
export const NOISE_TAGS = [
  "local-command-stdout", "local-command-stderr", "local-command-caveat", "system-reminder", "bash-stdout", "bash-stderr", "user-prompt-submit-hook", // claude
  "environment_context", "recommended_plugins", "user_instructions", "turn_aborted", "skill", "user_shell_command", "collaboration_mode", // codex
  "session_context", "state_snapshot", // gemini
];
// x of a leading <x> or <x attr…>, else ""
export function leadTag(t: string): string { const m = /^<([A-Za-z][\w-]*)[\s>]/.exec(t.trimStart()); return m ? m[1] ?? "" : ""; }
export function isNoise(t: string): boolean {
  const s = t.trimStart(); const lt = leadTag(s);
  return s.length === 0 || NOISE_TAGS.indexOf(lt) >= 0 || lt === "task-notification" || s.startsWith("# AGENTS.md") || s.startsWith("Caveat:");
}
// mid-turn? scans back for the last turn marker ("turn started" … "turn complete"/"turn aborted");
// userStarts: a user event also opens a turn (harnesses that log no start marker)
export function turnBusy(s: Sess, userStarts: boolean): boolean {
  for (let i = s.evs.length - 1; i >= 0; i--) {
    const e = s.evs[i];
    if (e.kind === "meta" && e.text === "turn started") return true;
    if (e.kind === "meta" && (e.text.startsWith("turn complete") || e.text === "turn aborted")) return false;
    if (userStarts && e.kind === "user") return true;
  }
  return false;
}
