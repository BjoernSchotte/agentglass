// agentglass — hand-written session fixtures for the palette checks (claude JSONL lines in real shapes, a temp dir)
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import type { Sess } from "../../model/types.ts";
import { newSess } from "../../model/types.ts";
import { sessions, buildView } from "../../model/sessions.ts";
import { applyMeta } from "../../hooks.ts";

export function tmpDir(name: string): string { const d = "/tmp/agentglass-" + name + "-" + String(process.pid); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; }
export function userLine(ts: string, text: string, cwd = "/tmp/proj"): string { return JSON.stringify({ type: "user", timestamp: ts, cwd, message: { role: "user", content: text } }); }
export function textLine(ts: string, id: string, text: string): string { return JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-sonnet-4-5", content: [{ type: "text", text }], usage: { input_tokens: 1, output_tokens: 1 } } }); }
export function toolLine(ts: string, id: string, call: string, cmd: string): string { return JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: call, name: "Bash", input: { command: cmd } }], usage: { input_tokens: 1, output_tokens: 1 } } }); }
export function resultLine(ts: string, call: string, out: string): string { return JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: call, content: out }] } }); }
// a claude session whose log holds lines; title set (H.meta fakes it under --redact)
export function addSess(dir: string, id: string, title: string, lines: string[], mtime: number, parent: string): Sess {
  const path = dir + "/" + id + ".jsonl";
  writeFileSync(path, lines.join("\n") + "\n");
  const s = newSess("claude", id, path, false);
  s.title = title; s.cwd = lines.length ? (JSON.parse(lines[0]) as { cwd?: string }).cwd ?? "/tmp/proj" : "/tmp/proj"; s.parent = parent; s.size = statSync(path).size; s.mtime = mtime;
  sessions.set(path, s); applyMeta(s); buildView(); // as scan() does: H.meta (redact fakes) runs on every scanned session
  return s;
}
// a small conversation: user, assistant, tool call + result, assistant
export function convo(n: number, cwd = "/tmp/proj"): string[] {
  const t = (s: number): string => "2026-09-30T10:00:" + (s < 10 ? "0" : "") + String(s) + ".000Z";
  return [userLine(t(1), "hello " + String(n), cwd), textLine(t(2), "m1", "hi"), toolLine(t(3), "m2", "toolu_0" + String(n), "ls"), resultLine(t(4), "toolu_0" + String(n), "a\nb"), textLine(t(5), "m3", "done")];
}
