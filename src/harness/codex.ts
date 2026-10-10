// agentglass — Codex (~/.codex) adapter
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { join, dirname } from "node:path";
import { type Obj, obj, str, parse as parseJson } from "../util/json.ts";
import { CODEX, readText, readBytes, listDir, listDirCached } from "../util/fs.ts";
import { numAt } from "../util/text.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C, CSI, RST, fg, bg } from "../ui/theme.ts";
import { type Acc, L, bucket, tool, pend, tokens, reasoning, turn, skill, isoMs, num, patchLines, stamp, skillLoad, skillUnload, skillListing, skillReads, skillReadSegs } from "../features/usage/record.ts";
import { skillReadCmds, outSegs } from "../features/usage/skillrec.ts";
import { MQ_TURN } from "../features/usage/facts.ts";
import { type Pend, done, extend, normFull, argv, execCmds, exitCodes, codexFailed } from "../features/usage/calls.ts";
import { isErr } from "../features/callgraph/model.ts";
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
    for (const f of listDirCached(dir, 86400000, "codex")) { // a dir unchanged for a day: once a minute (new rollouts, also a daemon's, go into today's dir: written today)
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
    const t = blockText(p["output"]); const raw = JSON.stringify(t); // the output as the log line holds it: what codexFailed reads for the call rows
    out.push({ kind: "result", text: !isErr(t) && codexFailed(raw, exitCodes(raw)) ? "[error] " + t : t, ts, id: str(p["call_id"]), full: "" });
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

// ── runs that outlive their call (yields) ──
// Codex answers a command after its yield time while it runs on. The JS `exec` tool's cell yields ("Script running with
// cell ID n"; later `wait` calls on that cell) and a command inside a cell can outlive it (its output chunk names a
// session_id); the older exec_command answers "Process running with session ID n" and write_stdin polls that session.
// The call's row ends at the yield; these extend it (calls.ts extend) to the run's end: a CommandExecution item_completed
// event (exact start, end and exit code) for a command started inside the call's span, the cell's completion seen by a
// `wait`, or a write_stdin that saw the process exit. Only a run that ends by itself inside the turn that started it: one
// still running when the turn ends, or stopped by a signal (^C written to it, an exit code ≥ 128), is a background
// process the agent did not wait on (a dev server, a port-forward) and keeps its yield's duration, as Claude's
// run_in_background calls do. Cell and session numbers start over in a resumed Codex: a number used again replaces the
// old run. In memory only: a restart between yield and end keeps the yield's duration.
interface Run { p: Pend; t0: number; end: number /* when its span closes (cell or call done), 0 = open */; cell: string; sess: string; cmds: string[] }
interface Yd { a: Acc; runs: Run[]; waits: Map<string, string> /* wait call → cell */; polls: Map<string, string> /* write_stdin call → session */; kills: Set<string> /* sessions sent a ^C */; last: number /* newest call start */ }
const YIELDS = new Map<string, Yd>(); // by log path (a restarted entry is a new Acc: its state starts over)
function ydOf(a: Acc): Yd {
  let y = YIELDS.get(a.p);
  if (!y || y.a !== a) { y = { a, runs: [], waits: new Map<string, string>(), polls: new Map<string, string>(), kills: new Set<string>(), last: 0 }; YIELDS.set(a.p, y); }
  return y;
}
function addRun(y: Yd, r: Run): void {
  const o: Run[] = []; for (const x of y.runs) if (!((r.cell && x.cell === r.cell) || (r.sess && x.sess === r.sess))) o.push(x); // a number used again: the old run is gone
  o.push(r); if (o.length > 32) o.shift(); y.runs = o;
}
// the run ended by itself at t (failed when err), inside its turn (a turn's end drops its runs): its call lasted until then
function runTo(r: Run, t: number, err: boolean): void { extend(r.p, t - r.t0, err); }
function signalled(code: number): boolean { return code >= 128 || code < 0; }
// a turn ended (task_complete, turn_aborted): its runs count no further. Their state goes (each run holds its call's rows
// and day sums: a re-index of many logs kept them all in memory)
function turnEnd(a: Acc): void { const y = YIELDS.get(a.p); if (y && y.a === a) YIELDS.delete(a.p); }
// checks: logs with yield state held
export function yieldsHeld(): number { return YIELDS.size; }
const ESC_SID = "session_id\\\":"; // a still-running process in a chunk (JSON text inside the output's JSON text)
// a call's output: does its run go on? (p is done already)
function yielded(a: Acc, p: Pend, l: string, t: number): void {
  const h = l.slice(0, 1200); const cmds: string[] = []; if (p.cmd) for (const x of p.cmd.split("\n")) cmds.push(normFull(x));
  const cell = /Script running with cell ID (\d+)/.exec(h); const proc = /Process running with session ID (\d+)/.exec(h);
  if (cell || proc || (p.name === "exec" && l.indexOf(ESC_SID) >= 0)) {
    addRun(ydOf(a), { p, t0: p.t, end: cell || proc ? 0 : t, cell: cell ? cell[1] ?? "" : "", sess: proc ? proc[1] ?? "" : "", cmds });
  }
}
// a `wait` on a cell or a write_stdin poll answered
function polled(a: Acc, p: Pend, id: string, l: string, t: number): void {
  const y = YIELDS.get(a.p); if (!y || y.a !== a) return;
  const h = l.slice(0, 1200);
  const cell = y.waits.get(id);
  if (cell !== undefined) {
    y.waits.delete(id);
    const m = /Script (completed|failed|error)/.exec(h); if (!m) return;
    for (const r of y.runs) if (r.cell === cell && !r.end) { r.end = t; runTo(r, t, (m[1] ?? "") !== "completed"); }
    return;
  }
  const sess = y.polls.get(id);
  if (sess !== undefined) {
    y.polls.delete(id);
    const m = /Process exited with code (-?\d+)/.exec(h); if (!m) return;
    const code = Number(m[1] ?? "0"); const killed = y.kills.has(sess) || signalled(code); y.kills.delete(sess);
    for (const r of y.runs) if (r.sess === sess && !r.end) { r.end = t; if (!killed) runTo(r, t, code !== 0); }
  }
}
// a command's end (item_completed of a CommandExecution): the run whose span holds its start, preferring the one that
// names its command; none when a newer call started in between and the command is not the run's (it is that call's)
function cmdDone(a: Acc, l: string): void {
  const y = YIELDS.get(a.p); if (!y || y.a !== a || !y.runs.length) return;
  const o = parseJson(l); const p = o ? obj(o["payload"]) : null; const it = p ? obj(p["item"]) : null;
  if (!p || !it || str(it["type"]) !== "CommandExecution") return;
  const s0 = num(p["started_at_ms"]); const s1 = num(p["completed_at_ms"]); if (s0 <= 0 || s1 < s0) return;
  const c = normFull(argv(it["command"])); const ex = it["exit_code"]; const code = typeof ex === "number" ? ex : 0;
  if (signalled(code)) return; const failed = code !== 0 || str(it["status"]) === "failed";
  let best: Run | null = null; let named = false;
  for (const r of y.runs) {
    if (s0 < r.t0 - 1000 || (r.end && s0 > r.end + 1000)) continue;
    const nm = c !== "" && r.cmds.indexOf(c) >= 0;
    if (!best || (nm && !named) || (nm === named && r.t0 > best.t0)) { best = r; named = nm; }
  }
  if (!best || (!named && y.last > best.t0 && y.last <= s0)) return;
  runTo(best, s1, failed);
}

// ── skills (skill-usage spec §2): Codex loads a skill when the agent reads its SKILL.md with a shell command (the text is
// the call's output, ≈ when Codex cut it), or for a $name mention (<skill> block); the developer message lists the skills
// (<skills_instructions>, one "- name: description" line each); a compaction unloads ──
const CUT_MARKS = ["omitted_approx_tokens", "tokens truncated", "lines truncated]", "chars truncated"];
function readOut(a: Acc, l: string, id: string): void {
  if (l.indexOf("Script running with cell ID") >= 0 || l.indexOf("Process running with session ID") >= 0) { a.skr.delete(id); return; } // yielded: no text yet
  const o = parseJson(l); const p = o ? obj(o["payload"]) : null; if (!o || !p) { a.skr.delete(id); return; }
  const out = p["output"]; const t = typeof out === "string" ? str(out) : blockText(out);
  let cut = false; for (const m of CUT_MARKS) if (t.indexOf(m) >= 0) cut = true;
  const iso = str(o["timestamp"]);
  // the text without the call's envelope ("Chunk ID …", "Script completed\nWall time 0.2 seconds\nOutput:\n"): its wall
  // time would make every read of the same file another version; exec's per-command results by their "output" fields
  const h = t.slice(0, 600); const oi = h.indexOf("\nOutput:\n");
  const env = oi >= 0 && /^(Chunk ID|Script |Wall time|Process exited|Exit code)/.test(h);
  const segs = outSegs(t); // an older shell tool's output: {"output": "<text>", "metadata": {…duration…}}
  skillReadSegs(a, bucket(a, 0, iso), id, 0, iso, env ? t.slice(oi + 9) : t.startsWith("{\"output\":\"") && segs.length ? segs[0] ?? "" : t, segs, cut);
}
// js: the commands of Codex's JS exec (its output holds one result per command); else one shell command
function skillCalls(a: Acc, id: string, cmds: string[], js: boolean): void {
  const ps: string[] = []; const ci: number[] = []; let k = 0;
  for (const c of cmds) { for (const p of skillReadCmds(c)) if (ps.indexOf(p) < 0) { ps.push(p); ci.push(k); } k++; }
  if (ps.length) skillReads(a, id, ps, ci, js ? cmds.length : 0);
}
function listing(a: Acc, l: string): void {
  const o = parseJson(l); const p = o ? obj(o["payload"]) : null; if (!o || !p) return;
  const t = blockText(p["content"]);
  const i = t.indexOf("<skills_instructions>"); if (i < 0) return;
  const j = t.indexOf("</skills_instructions>", i); const part = t.slice(i, j > i ? j + 22 : t.length);
  const names: string[] = [];
  for (const ln of part.split("\n")) { if (!ln.startsWith("- ")) continue; const e = ln.indexOf(":", 2); const sp = ln.indexOf(" ", 2); if (e > 2 && (sp < 0 || sp > e)) names.push(ln.slice(2, e)); }
  skillListing(a, 0, str(o["timestamp"]), part, names);
}
// the text of an injected <skill> block without its <name>/<path> lines (the path must not change the hash)
function skillText(t: string): { text: string; dir: string } {
  const i = t.indexOf("<skill>"); const j = t.lastIndexOf("</skill>");
  const inner = t.slice(i >= 0 ? i + 7 : 0, j > i ? j : t.length);
  const pm = /<path>([^<]*)<\/path>/.exec(inner); const path = pm ? (pm[1] ?? "").trim() : "";
  const body: string[] = [];
  for (const ln of inner.split("\n")) if (!/^\s*<(name|path)>[^<]*<\/(name|path)>\s*$/.test(ln)) body.push(ln);
  return { text: body.join("\n").trim(), dir: path.endsWith("/SKILL.md") ? path.slice(0, -9) : path };
}
function usage(a: Acc, l: string): void {
  const h = l.slice(0, 200); // cheap pre-filter: most bytes are tool outputs and messages we never parse
  const tc = h.indexOf("\"payload\":{\"type\":\"token_count\"") >= 0;
  const ctx = h.indexOf("\"type\":\"turn_context\"") >= 0;
  const call = h.indexOf("\"payload\":{\"type\":\"function_call\"") >= 0 || h.indexOf("\"payload\":{\"type\":\"custom_tool_call\"") >= 0 || h.indexOf("\"payload\":{\"type\":\"local_shell_call\"") >= 0;
  if (h.indexOf("_call_output\"") >= 0) { // outputs: no JSON.parse — only the head, the exit codes and the size
    const m = /"call_id":"([^"]+)"/.exec(l.slice(0, 400)); const id = m ? m[1] ?? "" : "";
    if (a.skr.has(id)) readOut(a, l, id);
    const p = a.pend.get(id); if (!p) return;
    a.pend.delete(id);
    const tm = /"timestamp":"([^"]+)"/.exec(h); const t = tm ? isoMs(tm[1] ?? "") : 0;
    const codes = exitCodes(l);
    done(p, t > 0 && p.t > 0 ? t - p.t : -1, codexFailed(l, codes), l.length, id, codes);
    if (t > 0 && p.t > 0) { if (p.name === "wait" || p.name === "write_stdin") polled(a, p, id, l, t); else yielded(a, p, l, t); }
    return;
  }
  if (h.indexOf("\"payload\":{\"type\":\"item_completed\"") >= 0) { if (YIELDS.size) cmdDone(a, l); return; }
  if (YIELDS.size && (h.indexOf("\"payload\":{\"type\":\"task_complete\"") >= 0 || h.indexOf("\"payload\":{\"type\":\"turn_aborted\"") >= 0)) {
    turnEnd(a); // not return: the line is read on as before
  }
  if (h.indexOf("\"type\":\"response_item\"") >= 0 && h.indexOf("\"role\":\"user\"") >= 0) { // prompts (injected context is noise)
    const o = parseJson(l); if (!o) return;
    const iso = str(o["timestamp"]);
    if (h.indexOf("\"text\":\"<skill>") >= 0) { // Codex injects a skill's SKILL.md only for an explicit $name mention: a command use
      const p = obj(o["payload"]); const m = /<name>([^<]*)<\/name>/.exec(p ? blockText(p["content"]) : "");
      const nm = m ? (m[1] ?? "").trim() : "";
      if (nm) { skill(bucket(a, 0, iso), "command", nm); const st = skillText(p ? blockText(p["content"]) : ""); skillLoad(a, nm, "user", 0, iso, st.text, true, st.dir, false); }
    }
    const n = a.sub ? 0 : prompts(parse, o); if (n) turn(a, 0, iso, n);
    return;
  }
  if (h.indexOf("\"type\":\"compacted\"") >= 0 || h.indexOf("\"type\":\"context_compacted\"") >= 0) { const tm = /"timestamp":"([^"]+)"/.exec(h); skillUnload(a, tm ? isoMs(tm[1] ?? "") : 0, "compact"); return; }
  if (l.slice(0, 400).indexOf("\"role\":\"developer\"") >= 0 && l.indexOf("<skills_instructions>") >= 0) { listing(a, l); return; }
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
    if (t === "local_shell_call") { const act = obj(p["action"]); const c = argv(act ? act["command"] : null); pend(a, d, st, name, id, tms, iso, c, [c]); skillCalls(a, id, [c], false); return; }
    if (t === "function_call") {
      const raw = str(p["arguments"]); const args = parseJson(raw);
      if (args && (name === "wait" || name === "write_stdin")) { // a poll of a yielded run: which one
        const y = ydOf(a); const k = name === "wait" ? args["cell_id"] : args["session_id"];
        if (typeof k === "string" || typeof k === "number") (name === "wait" ? y.waits : y.polls).set(id, String(k));
        if (name === "write_stdin" && str(args["chars"]).indexOf("\u0003") >= 0 && (typeof k === "string" || typeof k === "number")) y.kills.add(String(k)); // ^C: the agent stops it
      } else if (YIELDS.has(a.p)) ydOf(a).last = tms;
      const c = args && SHELL.indexOf(name) >= 0 ? argv(args["cmd"] ?? args["command"]) : "";
      pend(a, d, st, name, id, tms, iso, c || toolArg(name, args, raw), c ? [c] : []);
      if (c) skillCalls(a, id, [c], false);
      if (name === "apply_patch" && args) patchLines(a, d, name, str(args["input"]));
      return;
    }
    if (name === "apply_patch") { pend(a, d, st, name, id, tms, iso, inp, []); patchLines(a, d, name, inp); return; }
    const cmds = execCmds(inp);
    if (YIELDS.has(a.p)) ydOf(a).last = tms;
    pend(a, d, st, name, id, tms, iso, cmds.length ? cmds.join(" ; ") : inp, cmds);
    if (cmds.length) skillCalls(a, id, cmds, true);
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

// a new rollout goes into today's dir (local date): the one dir an agent without a session yet can write into
function todayDir(cwd: string): string { const d = new Date(); const two = (n: number): string => (n < 10 ? "0" : "") + String(n); return join(CODEX, "sessions", String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate())); }
export const codex: HarnessAdapter = {
  id: "codex", label: "Codex", glyph: ">_", mark: "›", color: () => C.codex,
  badge: () => bg("236;236;240") + fg("16;16;20") + CSI + "1m" + ">_" + RST + fg(C.text) + " Codex  " + RST, // terminal prompt
  bin: "codex", procs: ["codex"],
  roots: () => [join(CODEX, "sessions"), join(CODEX, "archived_sessions")], scan, meta, headBytes: 524288,
  parse, title: (s: Sess) => titles.get(s.id) ?? "",
  liveFile: (p: string) => p.endsWith(".jsonl") && p.indexOf("/rollout-") >= 0, // codex keeps its rollout open
  wakeDir: todayDir,
  headless: (s: Sess, msg: string) => ["exec", "resume", s.id, msg],
  resume: (s: Sess) => ["resume", s.id],
  files: (s: Sess) => [s.path], usage,
};
