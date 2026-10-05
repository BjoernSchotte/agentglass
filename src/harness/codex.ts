// agentglass — Codex (~/.codex) adapter
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { join, dirname } from "node:path";
import { type Obj, obj, str, parse as parseJson } from "../util/json.ts";
import { CODEX, readText, readBytes, listDir, listDirCached } from "../util/fs.ts";
import { numAt } from "../util/text.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C, CSI, RST, fg, bg } from "../ui/theme.ts";
import { type Acc, L, bucket, tool, pend, tokens, reasoning, turn, skill, isoMs, num, patchLines, stamp } from "../features/usage/record.ts";
import { MQ_TURN } from "../features/usage/facts.ts";
import { done, argv, execCmds, exitCodes, codexFailed } from "../features/usage/calls.ts";
import { rlWins } from "../features/usage/billing.ts";
import type { AddFn, HarnessAdapter } from "./types.ts";
import { toolArg, blockText, isNoise, prompts } from "./common.ts";
import { scrubRemote } from "../util/giturl.ts";
import { own } from "../util/own.ts";

// ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl (+ archived_sessions/, flat)
const titles = new Map<string, string>(); // thread names from session_index.jsonl
let indexM = 0;
function scan(add: AddFn): void {
  const walk = (dir: string, archived: boolean, depth: number): void => {
    for (const f of listDirCached(dir, 86400000)) { // a dir unchanged for a day: once a minute (new rollouts, also a daemon's, go into today's dir: written today)
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
    if (s) { const c = str(p["cwd"]); if (c) s.cwd = c; const md = str(p["model"]); if (md) s.model = md; const g = obj(p["git"]); if (g) { const br = str(g["branch"]); if (br) s.branch = br; const ru = str(g["repository_url"]); if (ru) { const r = scrubRemote(ru); s.remote = r ? r.url : ""; } } } // the raw url may carry a token: never stored
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

// a forked rollout (fork_context subagents) starts with a copy of its parent's history under new timestamps: calls and
// token_count totals included. A call whose call_id the parent logged is the parent's (booked there); a total the parent
// logged is only the fork's starting point. The parent is read once per process, in 1 MB chunks, up to the newest fork's
// start (a later line can hold no copied history).
interface Par { path: string; off: number; skip: boolean; until: number; calls: Set<string>; tot: Set<string> }
const PARENTS = new Map<string, Par>(); // parent rollout path → what it logged so far
const FORKS = new Map<string, string>(); // rollout path → its parent's path, "" = not a fork or the parent is gone
const ROLLOUTS = new Map<string, string>(); let rolled = false; // rollout id → path, for a parent in another day's dir
function totKey(tu: Obj): string { return [num(tu["input_tokens"]), num(tu["cached_input_tokens"]), num(tu["cache_write_input_tokens"]), num(tu["output_tokens"]), num(tu["reasoning_output_tokens"])].join(","); }
function parentLine(r: Par, l: string): number { // the line's time (0 = untimed)
  const h = l.slice(0, 200);
  const tm = /"timestamp":"([^"]+)"/.exec(h); const t = tm ? isoMs(tm[1] ?? "") : 0;
  if (h.indexOf("_call\"") >= 0 && h.indexOf("_call_output\"") < 0) { const c = /"call_id":"([^"]+)"/.exec(l); if (c) r.calls.add(own(c[1] ?? "")); } // own(): a match would keep its whole 1 MB chunk alive
  else if (h.indexOf("\"payload\":{\"type\":\"token_count\"") >= 0) {
    const o = parseJson(l); const p = o ? obj(o["payload"]) : null; const info = p ? obj(p["info"]) : null; const tu = info ? obj(info["total_token_usage"]) : null;
    if (tu) r.tot.add(totKey(tu));
  }
  return t;
}
function readParent(r: Par, upTo: number): void {
  let size = 0; try { size = statSync(r.path).size; } catch (e) { return; }
  while (r.off < size && r.until <= upTo) {
    const b = readBytes(r.path, r.off, Math.min(1048576, size - r.off)); if (!b.length) return;
    let z = b.length - 1; while (z >= 0 && b[z] !== 10) z--;
    if (z < 0) { r.off += b.length; r.skip = true; continue; } // a >1 MB line: no call head or total in reach
    const ls = new TextDecoder("utf-8").decode(b.subarray(0, z + 1)).split("\n");
    for (let i = r.skip ? 1 : 0; i < ls.length; i++) { const t = parentLine(r, ls[i] ?? ""); if (t > r.until) r.until = t; }
    r.skip = false; r.off += z + 1;
  }
}
// the fork's parent, read up to the fork's start (+ 1 min of clock skew); null = not a fork
function parentOf(path: string): Par | null {
  let pp = FORKS.get(path);
  if (pp === undefined) {
    const head = readText(path, 0, 16384);
    const m = /"forked_from_id":"([^"]+)"/.exec(head); const pid = m ? m[1] ?? "" : "";
    pp = "";
    if (pid) {
      const name = "-" + pid + ".jsonl";
      for (const f of listDir(dirname(path))) if (f.endsWith(name)) pp = join(dirname(path), f); // forks usually start the same day
      if (!pp) {
        if (!rolled) { rolled = true; scan((p: string, id: string, parent: string, archived: boolean): void => { ROLLOUTS.set(id, p); }); }
        pp = ROLLOUTS.get(pid) ?? "";
      }
      if (pp) {
        const tm = /"timestamp":"([^"]+)"/.exec(head); const t0 = tm ? isoMs(tm[1] ?? "") : 0;
        let r = PARENTS.get(pp); if (!r) { r = { path: pp, off: 0, skip: false, until: 0, calls: new Set<string>(), tot: new Set<string>() }; PARENTS.set(pp, r); }
        readParent(r, t0 > 0 ? t0 + 60000 : 8640000000000000);
      }
    }
    FORKS.set(path, pp);
  }
  return pp ? PARENTS.get(pp) ?? null : null;
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
  if (h.indexOf("\"type\":\"response_item\"") >= 0 && h.indexOf("\"role\":\"user\"") >= 0) { // prompts (injected context is noise)
    const o = parseJson(l); if (!o) return;
    const iso = str(o["timestamp"]);
    if (h.indexOf("\"text\":\"<skill>") >= 0) { // Codex injects a skill's SKILL.md only for an explicit $name mention: a command use
      const p = obj(o["payload"]); const m = /<name>([^<]*)<\/name>/.exec(p ? blockText(p["content"]) : "");
      const nm = m ? (m[1] ?? "").trim() : ""; if (nm) skill(bucket(a, 0, iso), "command", nm);
    }
    const n = a.sub ? 0 : prompts(parse, o); if (n) turn(a, 0, iso, n);
    return;
  }
  if (!tc && !ctx && !call) return;
  const o = parseJson(l); if (!o) return;
  const p = obj(o["payload"]); if (!p) return;
  const iso = str(o["timestamp"]);
  if (ctx) { const m = str(p["model"]); if (m) a.model = m; return; }
  const par = a.p ? parentOf(a.p) : null;
  if (par && call && par.calls.has(str(p["call_id"]))) return; // the parent's call, copied into this fork
  const info = tc ? obj(p["info"]) : null; const tu = info ? obj(info["total_token_usage"]) : null;
  if (par && tu && par.tot.has(totKey(tu))) { a.x = [num(tu["input_tokens"]), num(tu["cached_input_tokens"]), num(tu["cache_write_input_tokens"]), num(tu["output_tokens"]), num(tu["reasoning_output_tokens"])]; return; } // the parent's total, copied: the fork counts on from it
  const d = bucket(a, 0, iso);
  if (call) {
    const t = str(p["type"]);
    const ns = str(p["namespace"]);
    const bn = str(p["name"]) || (t === "local_shell_call" ? "shell" : "tool");
    const name = ns.startsWith("mcp__") ? ns + "__" + bn : bn; // MCP tools come namespaced: group them like Claude's mcp__server__tool
    const st = tool(a, d, name, a.model, MQ_TURN); // Codex fixes the model per turn: the latest turn_context is exact
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
  if (tu) { // cumulative → attribute the delta to this event's day; input_tokens includes the cached part
    const cur = [num(tu["input_tokens"]), num(tu["cached_input_tokens"]), num(tu["cache_write_input_tokens"]), num(tu["output_tokens"]), num(tu["reasoning_output_tokens"])];
    const dl: number[] = [];
    let back = false;
    while (a.x.length < 5) a.x.push(0);
    for (let i = 0; i < 4; i++) { const v = (cur[i] ?? 0) - numAt(a.x, i, 0); dl.push(v); if (v < 0) back = true; }
    dl.push((cur[4] ?? 0) - numAt(a.x, 4, 0));
    const use = back ? cur : dl; // counter went backwards (new thread in the same file): count it fresh
    const inp = use[0] ?? 0; const ca = use[1] ?? 0; const cw = use[2] ?? 0; const out = use[3] ?? 0;
    if (inp + out + cw > 0) tokens(a, d, a.model, Math.max(0, inp - ca - cw), out, ca, cw, 0);
    reasoning(a, d, Math.max(0, use[4] ?? 0)); // a subset of output_tokens (kept in x[4])
    a.x = cur;
  }
  const rl = obj(p["rate_limits"]);
  const pt = rl ? str(rl["plan_type"]) : ""; if (pt) stamp(a, "plan", pt, "session"); // a ChatGPT plan's rate limits name it
  const at = rl ? isoMs(iso) : 0; const ws = rl ? rlWins(rl, at) : [];
  if (ws.length && at >= L.rlAt) { L.rlAt = at; L.rl = ws; } // the newest event across sessions: 5 h and, when the plan has it, 7 d
}

export const codex: HarnessAdapter = {
  id: "codex", label: "Codex", glyph: ">_", mark: "›", color: () => C.codex,
  badge: () => bg("236;236;240") + fg("16;16;20") + CSI + "1m" + ">_" + RST + fg(C.text) + " Codex  " + RST, // terminal prompt
  bin: "codex", procs: ["codex"],
  roots: () => [join(CODEX, "sessions"), join(CODEX, "archived_sessions")], scan, meta, headBytes: 524288,
  parse, title: (s: Sess) => titles.get(s.id) ?? "",
  liveFile: (p: string) => p.endsWith(".jsonl") && p.indexOf("/rollout-") >= 0, // codex keeps its rollout open
  headless: (s: Sess, msg: string) => ["exec", "resume", s.id, msg],
  resume: (s: Sess) => ["resume", s.id],
  files: (s: Sess) => [s.path], usage,
};
