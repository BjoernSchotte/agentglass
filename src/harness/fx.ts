// agentglass — fx (~/.fx) adapter
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, parse as parseJson } from "../util/json.ts";
import { FX, readText, listDir } from "../util/fs.ts";
import { numAt } from "../util/text.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C, CSI, RST, fg } from "../ui/theme.ts";
import { type Acc, bucket, tool, pend, file, lines, turn, nlines, num } from "../features/usage/record.ts";
import { done, patchFiles } from "../features/usage/calls.ts";
import type { AddFn, HarnessAdapter } from "./types.ts";
import { toolArg, turnBusy, prompts } from "./common.ts";

const SESSIONS = join(FX, "sessions");
function scan(add: AddFn): void { for (const id of listDir(SESSIONS)) add(join(SESSIONS, id, "events.jsonl"), id, "", false); }
// fx events.jsonl: {seq, timestamp_ms, event: {<kind>: {...}}} — one kind per line
function fxResult(preview: string): string {
  const p = parseJson(preview);
  if (!p) return preview;
  const t = str(p["output_delta"]) || str(p["result"]) || str(p["output"]) || str(p["error"]) || str(p["error_code"]);
  return t || preview;
}
function parse(o: Obj, out: Ev[], s: Sess | null): void {
  const logPath = s ? s.path : "";
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
function meta(s: Sess): void {
  const dir = s.path.slice(0, -"events.jsonl".length);
  const o = parseJson(readText(dir + "session.json", 0, 65536).trim());
  if (o) {
    s.cwd = str(o["workspace_root"]) || str(o["origin_workspace_root"]);
    s.title = str(o["title"]);
    s.model = str(o["model"]);
    if (o["subagent_child"] === true) s.kind = "subagent";
  }
  const own = parseJson(readText(dir + "subagent/owner.json", 0, 4096).trim());
  if (own) { s.parent = str(own["parent_id"]); if (!s.kind) s.kind = "subagent"; }
}
function usage(a: Acc, l: string): void {
  if (l.indexOf("\"user\":{") >= 0) { const o = parseJson(l); const n = o ? prompts(parse, o) : 0; if (o && n) turn(bucket(a, num(o["timestamp_ms"]), ""), n); return; }
  const res = l.indexOf("\"tool_result\"") >= 0;
  if (!res && l.indexOf("\"tool_call\"") < 0) return;
  const o = parseJson(l); if (!o) return;
  const e = obj(o["event"]); if (!e) return;
  const ms = num(o["timestamp_ms"]);
  const r = res ? obj(e["tool_result"]) : null;
  if (r) {
    const id = str(r["call_id"]); const p = a.pend.get(id); if (!p) return;
    a.pend.delete(id);
    // fx stamps a whole turn's events alike: 0 ms means "unknown", not "instant"
    done(p, ms > p.t && p.t > 0 ? ms - p.t : -1, str(r["status"]) !== "success", num(r["output_bytes"]), id, []);
    return;
  }
  const c = obj(e["tool_call"]); if (!c) return;
  const d = bucket(a, ms, ""); const name = str(c["tool_name"]) || "tool";
  const st = tool(a, d, name);
  const aj = str(c["arguments_json"]); const args = parseJson(aj);
  const cmd = name === "shell" && args ? str(args["command"]) : "";
  pend(a, d, st, name, str(c["call_id"]), ms, ms > 0 ? new Date(ms).toISOString() : "", toolArg(name, null, aj), cmd ? [cmd] : []);
  if (!args) return;
  // edits, best effort: a path plus new content / replacements, or an embedded patch (totals come from usage-v2.json)
  const fp = str(args["path"]) || str(args["file_path"]);
  if (aj.indexOf("*** Begin Patch") >= 0) { for (const f of patchFiles(str(args["patch"]) || str(args["input"]))) file(d, name, f.p, f.add, f.del); }
  else if (fp && (args["content"] !== undefined || args["new_string"] !== undefined || args["edits"] !== undefined)) file(d, name, fp, nlines(str(args["content"]) || str(args["new_string"])), nlines(str(args["old_string"])));
}
// fx keeps running totals in usage-v2.json; attribute changes to the day the file was written
function usageSidecar(s: Sess, a: Acc): void {
  const f = s.path.slice(0, -"events.jsonl".length) + "usage-v2.json";
  let mt = 0; try { mt = statSync(f).mtimeMs; } catch (e) { return; }
  if (mt === a.xM) return;
  a.xM = mt;
  const o = parseJson(readText(f, 0, 1048576).trim()); const sn = o ? obj(o["snapshot"]) : null; if (!sn) return;
  const cur = [num(sn["input_tokens"]), num(sn["output_tokens"]), num(sn["cache_read_tokens"]), num(sn["cache_write_tokens"]), num(sn["total_cost"]), num(sn["lines_added"]), num(sn["lines_removed"])];
  const dl: number[] = [];
  for (let i = 0; i < 7; i++) dl.push(Math.max(0, (cur[i] ?? 0) - numAt(a.x, i, 0)));
  a.x = cur;
  const d = bucket(a, mt, "");
  const inp = dl[0] ?? 0; const out = dl[1] ?? 0; const cr = dl[2] ?? 0; const cw = dl[3] ?? 0; const c = dl[4] ?? 0;
  a.inTok += inp; a.outTok += out; a.cr += cr; a.cw += cw; d.inTok += inp; d.outTok += out; d.cr += cr; d.cw += cw;
  if (c > 0) { a.cost += c; d.cost += c; }
  else if ((cur[4] ?? 0) === 0 && a.unk === 0) { a.unk = 1; d.unk += 1; } // custom model connections report $0 → unknown
  lines(a, d, dl[5] ?? 0, dl[6] ?? 0);
}

export const fx: HarnessAdapter = {
  id: "fx", label: "fx", glyph: "▲", mark: "▲", color: () => C.fx,
  badge: () => fg(C.text) + CSI + "1m" + "▲" + RST + fg(C.fx) + CSI + "1m" + " 𝒇x" + RST + fg(C.fx) + "      " + RST,
  bin: "fx", procs: ["fx"],
  roots: () => [SESSIONS], scan, meta, refresh: meta, headBytes: 524288,
  parse,
  busy: (s: Sess) => turnBusy(s, true), // fx logs no turn-start marker: a trailing user event is one
  liveFile: (p: string) => p.endsWith(".jsonl") && p.indexOf("/.fx/sessions/") >= 0,
  headless: (s: Sess, msg: string) => ["ask", "--auto", "--resume-id", s.id, "--", msg],
  resume: (s: Sess) => ["resume", s.id],
  files: (s: Sess) => [s.path.slice(0, -"/events.jsonl".length)], // the whole session dir
  usage, usageSidecar,
};
