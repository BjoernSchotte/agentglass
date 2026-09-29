// agentglass — pi (~/.pi/agent) adapter
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { HOME, readText, listDir } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C } from "../ui/theme.ts";
import { type Acc, bucket, tool, pend, file, lines, usageExact, isoMs, nlines, num } from "../features/usage/record.ts";
import { done } from "../features/usage/calls.ts";
import type { AddFn, HarnessAdapter } from "./types.ts";
import { toolArg, blockText } from "./common.ts";

// sessions live in <session dir>/--<cwd>--/<ts>_<id>.jsonl; a custom session dir may hold the files directly
function tilde(p: string): string { return p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p; }
function sessionRoot(): string {
  const env = process.env["PI_CODING_AGENT_SESSION_DIR"];
  if (env) return tilde(env);
  const ad = process.env["PI_CODING_AGENT_DIR"];
  const agentDir = ad ? tilde(ad) : join(HOME, ".pi", "agent");
  const st = parseJson(readText(join(agentDir, "settings.json"), 0, 262144).trim());
  const sd = st ? str(st["sessionDir"]) : "";
  return sd ? tilde(sd) : join(agentDir, "sessions");
}
function scan(add: AddFn): void {
  const root = sessionRoot();
  for (const d of listDir(root)) {
    if (d.endsWith(".jsonl")) { add(join(root, d), d.slice(d.indexOf("_") + 1, -6), "", false); continue; }
    if (!d.startsWith("--")) continue;
    for (const f of listDir(join(root, d))) if (f.endsWith(".jsonl")) add(join(root, d, f), f.slice(f.indexOf("_") + 1, -6), "", false);
  }
}

// liveness links a process to the session by cwd, before any head is loaded: read the header line (first line, small) once
function meta(s: Sess): void {
  const h = readText(s.path, 0, 4096); const nl = h.indexOf("\n");
  const o = parseJson((nl >= 0 ? h.slice(0, nl) : h).trim());
  if (o && str(o["type"]) === "session") s.cwd = str(o["cwd"]);
}

function ev(out: Ev[], kind: string, text: string, ts: string, id: string, full: string): void { out.push({ kind, text, ts, id, full }); }
function parse(o: Obj, out: Ev[], s: Sess | null): void {
  const type = str(o["type"]); const ts = str(o["timestamp"]);
  if (type === "session") { if (s) { const c = str(o["cwd"]); if (c) s.cwd = c; } return; }
  if (type === "session_info") { if (s) { const n = str(o["name"]); if (n) s.title = n; } return; }
  if (type === "model_change") { if (s) { const m = str(o["modelId"]); if (m) s.model = m; } return; }
  if (type === "compaction") { ev(out, "meta", "context compacted", ts, "", ""); return; }
  if (type === "branch_summary") { ev(out, "meta", "branch: " + str(o["summary"]).split("\n")[0], ts, "", ""); return; }
  if (type !== "message") return;
  const m = obj(o["message"]); if (!m) return;
  const role = str(m["role"]);
  if (role === "user") {
    const c = m["content"];
    let t = typeof c === "string" ? c : blockText(c);
    if (!t) for (const b of arr(c)) { const bo = obj(b); if (bo && str(bo["type"]) === "image") { t = "[image]"; break; } } // an image-only prompt still starts a turn
    if (t) ev(out, "user", t, ts, "", "");
  } else if (role === "assistant") {
    if (s) { const md = str(m["responseModel"]) || str(m["model"]); if (md) s.model = md; }
    for (const b of arr(m["content"])) {
      const bo = obj(b); if (!bo) continue;
      const bt = str(bo["type"]);
      if (bt === "text") { const t = str(bo["text"]); if (t) ev(out, "assistant", t, ts, "", ""); }
      else if (bt === "thinking") { const t = str(bo["thinking"]); if (t) ev(out, "thinking", t, ts, "", ""); }
      else if (bt === "toolCall") { const n = str(bo["name"]) || "tool"; const inp = obj(bo["arguments"]); ev(out, "tool", n + "\u0000" + toolArg(n, inp, ""), ts, str(bo["id"]), inp ? JSON.stringify(inp) : ""); }
    }
    const stop = str(m["stopReason"]);
    if (stop === "error" || stop === "aborted") ev(out, "meta", "[" + stop + "] " + str(m["errorMessage"]), ts, "", "");
  } else if (role === "toolResult") {
    const det = obj(m["details"]);
    ev(out, "result", (m["isError"] === true ? "[error] " : "") + blockText(m["content"]), ts, str(m["toolCallId"]), det ? JSON.stringify(det) : "");
  } else if (role === "bashExecution") { // the user's own `!cmd`: pi records it outside any turn (while streaming: at agent_end)
    const id = str(o["id"]); const cmd = str(m["command"]);
    ev(out, "tool", "!bash\u0000" + cmd, ts, id, JSON.stringify({ command: cmd }));
    const code = num(m["exitCode"]); const bad = m["cancelled"] === true || (m["exitCode"] !== undefined && m["exitCode"] !== null && code !== 0);
    ev(out, "result", (bad ? "[error] " : "") + str(m["output"]), ts, id, "");
  }
}
// mid-turn, from the tail's events alone (the log has no turn markers): the last event is the user's prompt, a tool call
// or a tool result — not a `!bash` pair, which is no turn; assistant text/thinking, an error or an abort end the turn
function busy(s: Sess): boolean {
  for (let i = s.evs.length - 1; i >= 0; i--) {
    const e = s.evs[i];
    if (e.kind === "meta") { if (e.text.startsWith("[error]") || e.text.startsWith("[aborted]")) return false; continue; }
    if (e.kind === "result") { const c = i > 0 ? s.evs[i - 1] : null; return !(c && c.kind === "tool" && c.id === e.id && c.text.startsWith("!bash\u0000")); }
    return e.kind === "user" || e.kind === "tool";
  }
  return false;
}

// tokens and cost: pi writes usage.cost.total itself (usage.cost 0 = unpriced model → table fallback in usageExact)
function book(a: Acc, u: Obj | null, model: string, iso: string): void {
  if (!u) return;
  const d = bucket(a, 0, iso);
  const c = obj(u["cost"]); const w1 = num(u["cacheWrite1h"]);
  const md = model || a.model; if (md) a.model = md;
  usageExact(a, d, md, num(u["input"]), num(u["output"]), num(u["cacheRead"]), Math.max(0, num(u["cacheWrite"]) - w1), w1, c && typeof c["total"] === "number" ? num(c["total"]) : -1);
}
function usage(a: Acc, l: string): void {
  if (l.startsWith("{\"type\":\"session\"")) { // header: a fork copies its parent's entries verbatim, their usage is not this file's
    const h = parseJson(l); if (!h) return;
    a.x = [isoMs(str(h["timestamp"])), str(h["parentSession"]) ? 1 : 0];
    return;
  }
  const hasU = l.indexOf("\"usage\":{") >= 0; const call = l.indexOf("\"toolCall\"") >= 0; const res = l.indexOf("\"toolCallId\"") >= 0;
  if (!hasU && !call && !res) return;
  const o = parseJson(l); if (!o) return;
  const iso = str(o["timestamp"]);
  if (a.x.length > 1 && a.x[1] === 1 && isoMs(iso) < a.x[0]) return;
  const type = str(o["type"]);
  if (type === "usage" || type === "compaction" || type === "branch_summary") { book(a, obj(o["usage"]), str(o["model"]), iso); return; }
  if (type !== "message") return;
  const m = obj(o["message"]); if (!m) return;
  const role = str(m["role"]);
  if (role === "toolResult") {
    book(a, obj(m["usage"]), "", iso);
    const id = str(m["toolCallId"]); const p = a.pend.get(id); if (!p) return;
    a.pend.delete(id);
    const t = isoMs(iso);
    done(p, t > 0 && p.t > 0 ? t - p.t : -1, m["isError"] === true, blockText(m["content"]).length, id, []);
    return;
  }
  if (role !== "assistant") return;
  book(a, obj(m["usage"]), str(m["responseModel"]) || str(m["model"]), iso);
  const d = bucket(a, 0, iso);
  for (const b of arr(m["content"])) {
    const bo = obj(b); if (!bo || str(bo["type"]) !== "toolCall") continue;
    const name = str(bo["name"]) || "tool"; const st = tool(a, d, name);
    const inp = obj(bo["arguments"]);
    pend(a, d, st, name, str(bo["id"]), isoMs(iso), iso, toolArg(name, inp, ""), name === "bash" && inp ? [str(inp["command"])] : []);
    if (!inp) continue;
    let add = 0; let del = 0;
    if (name === "edit") {
      const es = arr(inp["edits"]);
      for (const e of es) { const eo = obj(e); if (eo) { add += nlines(str(eo["newText"])); del += nlines(str(eo["oldText"])); } }
      if (es.length === 0) { add = nlines(str(inp["newText"])); del = nlines(str(inp["oldText"])); } // legacy: top-level oldText/newText
    } else if (name === "write") add = nlines(str(inp["content"]));
    else continue;
    lines(a, d, add, del); file(d, name, str(inp["path"]), add, del);
  }
}

export const pi: HarnessAdapter = {
  id: "pi", label: "pi", glyph: "π", mark: "π", color: () => C.cyan,
  bin: "pi", procs: ["pi", "pi-rpc"],
  roots: () => [sessionRoot()], scan, meta, headBytes: 262144, // the first entry is a large system message
  parse, busy,
  liveCwd: true, // no lock, no registry, the file is not kept open
  headless: (s: Sess, msg: string) => ["-p", "--session", s.path, "--", msg], // the file path: a bare id outside the cwd's dir prompts to fork
  resume: (s: Sess) => ["--session", s.path],
  files: (s: Sess) => [s.path],
  usage,
};
