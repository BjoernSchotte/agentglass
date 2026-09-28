// agentglass — event-parsing helpers shared by the harness parsers
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, str, arr, parse } from "../util/json.ts";

export function toolArg(name: string, inp: Obj | null, raw: string): string {
  if (inp) {
    const keys = ["command", "cmd", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill", "task", "location", "__tool_use_purpose"];
    for (const k of keys) { const v = str(inp[k]); if (v) return v; }
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
    const t = str(o["text"]); // Claude/Codex text blocks and kiro {kind:"text", data} results
    if (t) { parts.push(t); continue; }
    const d = o["data"]; // kiro nests the payload under "data"; render json results too
    if (typeof d === "string") parts.push(d);
    else if (d !== undefined) parts.push(JSON.stringify(d));
  }
  return parts.join("\n");
}
export function isNoise(t: string): boolean {
  const s = t.trimStart();
  return s.length === 0 || s.startsWith("<") || s.startsWith("# AGENTS.md") || s.startsWith("Caveat:");
}
