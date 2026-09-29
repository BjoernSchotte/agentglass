// agentglass — Codex (~/.codex) adapter
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, parse as parseJson } from "../util/json.ts";
import { CODEX, readText, listDir } from "../util/fs.ts";
import { numAt } from "../util/text.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C, CSI, RST, fg, bg } from "../ui/theme.ts";
import { type Acc, L, bucket, tool, pend, tokens, isoMs, num, patchLines } from "../features/usage/record.ts";
import { done, argv, execCmds, exitCodes, codexFailed } from "../features/usage/calls.ts";
import type { AddFn, HarnessAdapter } from "./types.ts";
import { toolArg, blockText, isNoise } from "./common.ts";

// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (+ archived_sessions/, flat)
const titles = new Map<string, string>(); // thread names from session_index.jsonl
let indexM = 0;
function scan(add: AddFn): void {
  const walk = (dir: string, archived: boolean, depth: number): void => {
    for (const f of listDir(dir)) {
      const p = join(dir, f);
      if (f.endsWith(".jsonl")) add(p, f.length > 42 ? f.slice(-42, -6) : f, "", archived);
      else if (depth < 3 && /^\d+$/.test(f)) walk(p, archived, depth + 1);
    }
  };
  walk(join(CODEX, "sessions"), false, 0);
  walk(join(CODEX, "archived_sessions"), true, 3);
  const idx = join(CODEX, "session_index.jsonl");
  try {
    const st = statSync(idx);
    if (st.mtimeMs !== indexM) {
      indexM = st.mtimeMs;
      for (const l of readText(idx, 0, st.size).split("\n")) { const o = parseJson(l); if (o) titles.set(str(o["id"]), str(o["thread_name"])); }
    }
  } catch (e) { /* no codex */ }
}
// Codex: first line (session_meta) names parent_thread_id + source.subagent {thread_spawn{agent_role,agent_nickname} | other:"guardian"}
function meta(s: Sess): void {
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
function parse(o: Obj, out: Ev[], s: Sess | null): void {
  const ts = str(o["timestamp"]); const type = str(o["type"]);
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

const SHELL = ["exec_command", "shell", "shell_command", "container.exec"];
function usage(a: Acc, l: string): void {
  const h = l.slice(0, 200); // cheap pre-filter: most bytes are tool outputs and messages we never parse
  const tc = h.indexOf("\"payload\":{\"type\":\"token_count\"") >= 0;
  const ctx = h.indexOf("\"type\":\"turn_context\"") >= 0;
  const call = h.indexOf("\"payload\":{\"type\":\"function_call\"") >= 0 || h.indexOf("\"payload\":{\"type\":\"custom_tool_call\"") >= 0 || h.indexOf("\"payload\":{\"type\":\"local_shell_call\"") >= 0;
  if (h.indexOf("_call_output\"") >= 0) { // outputs: no JSON.parse — only the head, the exit codes and the size
    const m = /"call_id":"([^"]+)"/.exec(l.slice(0, 400)); const id = m ? m[1] ?? "" : "";
    const p = a.pend.get(id); if (!p) return;
    a.pend.delete(id);
    const tm = /"timestamp":"([^"]+)"/.exec(h); const t = tm ? isoMs(tm[1] ?? "") : 0;
    const codes = exitCodes(l);
    done(p, t > 0 && p.t > 0 ? t - p.t : -1, codexFailed(l, codes), l.length, id, codes);
    return;
  }
  if (!tc && !ctx && !call) return;
  const o = parseJson(l); if (!o) return;
  const p = obj(o["payload"]); if (!p) return;
  const iso = str(o["timestamp"]);
  if (ctx) { const m = str(p["model"]); if (m) a.model = m; return; }
  const d = bucket(a, 0, iso);
  if (call) {
    const t = str(p["type"]);
    const ns = str(p["namespace"]);
    const bn = str(p["name"]) || (t === "local_shell_call" ? "shell" : "tool");
    const name = ns.startsWith("mcp__") ? ns + "__" + bn : bn; // MCP tools come namespaced: group them like Claude's mcp__server__tool
    const st = tool(a, d, name);
    const id = str(p["call_id"]); const tms = isoMs(iso);
    const inp = str(p["input"]);
    if (t === "local_shell_call") { const act = obj(p["action"]); const c = argv(act ? act["command"] : null); pend(a, d, st, name, id, tms, iso, c, [c]); return; }
    if (t === "function_call") {
      const raw = str(p["arguments"]); const args = parseJson(raw);
      const c = args && SHELL.indexOf(name) >= 0 ? argv(args["cmd"] ?? args["command"]) : "";
      pend(a, d, st, name, id, tms, iso, c || toolArg(name, args, raw), c ? [c] : []);
      if (name === "apply_patch" && args) patchLines(a, d, name, str(args["input"]));
      return;
    }
    if (name === "apply_patch") { pend(a, d, st, name, id, tms, iso, inp, []); patchLines(a, d, name, inp); return; }
    const cmds = execCmds(inp);
    pend(a, d, st, name, id, tms, iso, cmds.length ? cmds.join(" ; ") : inp, cmds);
    // newer Codex calls tools.apply_patch("*** Begin Patch\n…") from inside its JS `exec` tool: patches are escaped string literals
    let at = inp.indexOf("*** Begin Patch");
    while (at >= 0) {
      const end = inp.indexOf("*** End Patch", at);
      patchLines(a, d, name, inp.slice(at, end > at ? end : inp.length).split("\\n").join("\n"));
      at = end > at ? inp.indexOf("*** Begin Patch", end) : -1;
    }
    return;
  }
  const info = obj(p["info"]); const tu = info ? obj(info["total_token_usage"]) : null;
  if (tu) { // cumulative → attribute the delta to this event's day; input_tokens includes the cached part
    const cur = [num(tu["input_tokens"]), num(tu["cached_input_tokens"]), num(tu["cache_write_input_tokens"]), num(tu["output_tokens"])];
    const dl: number[] = [];
    let back = false;
    while (a.x.length < 4) a.x.push(0);
    for (let i = 0; i < 4; i++) { const v = (cur[i] ?? 0) - numAt(a.x, i, 0); dl.push(v); if (v < 0) back = true; }
    const use = back ? cur : dl; // counter went backwards (new thread in the same file): count it fresh
    const inp = use[0] ?? 0; const ca = use[1] ?? 0; const cw = use[2] ?? 0; const out = use[3] ?? 0;
    if (inp + out + cw > 0) tokens(a, d, a.model, Math.max(0, inp - ca - cw), out, ca, cw, 0);
    a.x = cur;
  }
  const rl = obj(p["rate_limits"]); const pr = rl ? obj(rl["primary"]) : null;
  if (pr) {
    const at = new Date(iso).getTime();
    if (at >= L.rlAt) { L.rlAt = at; L.rlPct = num(pr["used_percent"]); L.rlWin = num(pr["window_minutes"]); L.rlReset = num(pr["resets_at"]); }
  }
}

export const codex: HarnessAdapter = {
  id: "codex", label: "Codex", glyph: ">_", mark: "›", color: () => C.codex,
  badge: () => bg("236;236;240") + fg("16;16;20") + CSI + "1m" + ">_" + RST + fg(C.text) + " Codex  " + RST, // terminal prompt
  bin: "codex", procs: ["codex"],
  roots: () => [join(CODEX, "sessions"), join(CODEX, "archived_sessions")], scan, meta, headBytes: 524288,
  parse, title: (s: Sess) => titles.get(s.id) ?? "",
  liveFile: (p: string) => p.endsWith(".jsonl") && p.indexOf("/rollout-") >= 0, // codex keeps its rollout open
  headless: (id: string, msg: string) => ["exec", "resume", id, msg],
  resume: (id: string) => ["resume", id],
  files: (s: Sess) => [s.path], usage,
};
