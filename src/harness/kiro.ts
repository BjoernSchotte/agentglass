// agentglass — kiro-cli (~/.kiro) adapter
// SPDX-License-Identifier: Apache-2.0
// Based on the kiro-cli adapter by Tim Gitchel (PR #2), ported to the HarnessAdapter port.
import { statSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { HOME, readText, listDir } from "../util/fs.ts";
import { numAt } from "../util/text.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C } from "../ui/theme.ts";
import { type Acc, bucket, tool, pend, file, lines, nlines, num } from "../features/usage/record.ts";
import { done } from "../features/usage/calls.ts";
import { userRate } from "../features/usage/pricing.ts";
import type { AddFn, HarnessAdapter, Live } from "./types.ts";
import { toolArg, blockText, isNoise } from "./common.ts";

// ~/.kiro/sessions/cli/<uuid>.jsonl (transcript), <uuid>.json (metadata + per-turn usage), <uuid>.lock ({pid} while open)
const DIR = join(HOME, ".kiro", "sessions", "cli");
function scan(add: AddFn): void { for (const f of listDir(DIR)) if (f.length === 42 && f.endsWith(".jsonl")) add(join(DIR, f), f.slice(0, -6), "", false); }
function side(s: Sess): Obj | null { return parseJson(readText(s.path.slice(0, -6) + ".json", 0, 4194304).trim()); }
// {session_id, cwd, title, parent_session_id, session_created_reason: "subagent" | …}
function meta(s: Sess): void {
  const o = side(s);
  if (!o) return;
  const c = str(o["cwd"]); if (c) s.cwd = c;
  const t = str(o["title"]); if (t) s.title = t;
  const par = str(o["parent_session_id"]);
  if (par) { s.parent = par; s.kind = str(o["session_created_reason"]) || "subagent"; }
}

// transcript: one {version, kind, data} per line; kind ∈ Prompt | AssistantMessage | ToolResults | Compaction (versioned:
// unknown kinds become a meta event). Lines carry no timestamps — turn times live in the .json (see usageSidecar).
function parse(o: Obj, out: Ev[], s: Sess | null): void {
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

// no turn markers: mid-turn unless the last thing said is the assistant's text
function busy(s: Sess): boolean { const e = s.evs.length ? s.evs[s.evs.length - 1] : null; return !!e && e.kind !== "assistant" && e.kind !== "meta"; }

// <uuid>.lock holds the owning pid; locks outlive crashed processes, so the pid must still be running
function liveRegistry(alive: (pid: number) => boolean, harnessOfPid: (pid: number) => string): Live[] {
  const out: Live[] = [];
  for (const f of listDir(DIR)) {
    if (!f.endsWith(".lock")) continue;
    const o = parseJson(readText(join(DIR, f), 0, 4096).trim());
    const pid = o ? num(o["pid"]) : 0;
    if (pid && alive(pid)) out.push({ id: f.slice(0, -5), pid, status: "open", name: "" });
  }
  return out;
}

// ── usage ──
// Acc.x: [0] prompts seen in the transcript (= index of the current turn + 1), [1] turns already booked from the .json,
// [2 + i] end time (ms) of turn i. Tool calls are booked on their turn's day; a turn still running counts as now.
function turnMs(a: Acc): number { const t = numAt(a.x, 0, 0) - 1; return t >= 0 ? numAt(a.x, 2 + t, 0) : 0; }
function usage(a: Acc, l: string): void {
  while (a.x.length < 2) a.x.push(0);
  if (l.indexOf("\"kind\":\"Prompt\"") >= 0) { a.x[0] = numAt(a.x, 0, 0) + 1; return; }
  const isAsst = l.indexOf("\"kind\":\"AssistantMessage\"") >= 0;
  const isRes = l.indexOf("\"kind\":\"ToolResults\"") >= 0;
  if (!isAsst && !isRes) return;
  const o = parseJson(l); if (!o) return;
  const d0 = obj(o["data"]); if (!d0) return;
  if (isRes) {
    for (const b of arr(d0["content"])) {
      const bo = obj(b); if (!bo || str(bo["kind"]) !== "toolResult") continue;
      const r = obj(bo["data"]); if (!r) continue;
      const id = str(r["toolUseId"]); const p = a.pend.get(id); if (!p) continue;
      a.pend.delete(id);
      done(p, -1, str(r["status"]) !== "success", 0, id, []); // no per-call timing in kiro logs
    }
    return;
  }
  const d = bucket(a, turnMs(a), "");
  for (const b of arr(d0["content"])) {
    const bo = obj(b); if (!bo || str(bo["kind"]) !== "toolUse") continue;
    const u = obj(bo["data"]); if (!u) continue;
    const name = str(u["name"]) || "tool";
    const st = tool(a, d, name);
    const inp = obj(u["input"]);
    const cmd = (name === "shell" || name === "execute_bash") && inp ? str(inp["command"]) : "";
    pend(a, d, st, name, str(u["toolUseId"]), 0, "", toolArg(name, inp, ""), cmd ? [cmd] : []);
    if (!inp) continue;
    // fs_write-style edits: command ∈ create | strReplace | insert, with content / newStr / oldStr
    const path = str(inp["path"]) || str(inp["file_path"]);
    if (path && (inp["content"] !== undefined || inp["newStr"] !== undefined || inp["oldStr"] !== undefined)) {
      const add = nlines(str(inp["newStr"]) || str(inp["content"])); const del = nlines(str(inp["oldStr"]));
      lines(a, d, add, del); file(d, name, path, add, del);
    }
  }
}
// .json session_state.conversation_metadata.user_turn_metadatas[]: {end_timestamp (s), input/output_token_count,
// metering_usage[{unit: "credit", value}]}. kiro bills credits, not tokens: cost = credits × kiroCreditUsd from
// ~/.agentglass/prices.json (or AGENTGLASS_KIRO_CREDIT_USD); unset = unknown, never a guessed dollar figure.
// Plan allotments/overage are account-wide (kiro-cli /usage, a network call) and not modelled here.
function creditUsd(): number { const e = Number(process.env.AGENTGLASS_KIRO_CREDIT_USD ?? ""); return e > 0 ? e : userRate("kiroCreditUsd"); }
function usageSidecar(s: Sess, a: Acc): void {
  const f = s.path.slice(0, -6) + ".json";
  let mt = 0; try { mt = statSync(f).mtimeMs; } catch (e) { return; }
  if (mt === a.xM) return;
  a.xM = mt;
  while (a.x.length < 2) a.x.push(0);
  const o = side(s); const ss = o ? obj(o["session_state"]) : null; const cm = ss ? obj(ss["conversation_metadata"]) : null;
  if (!cm) return;
  const turns = arr(cm["user_turn_metadatas"]);
  const rate = creditUsd();
  for (let i = 0; i < turns.length; i++) {
    const tm = obj(turns[i]); if (!tm) continue;
    const end = num(tm["end_timestamp"]) * 1000;
    while (a.x.length < 3 + i) a.x.push(0);
    a.x[2 + i] = end;
    if (i < numAt(a.x, 1, 0)) continue; // booked on an earlier read
    const d = bucket(a, end, "");
    const nIn = num(tm["input_token_count"]); const nOut = num(tm["output_token_count"]);
    a.inTok = a.inTok + nIn; a.outTok = a.outTok + nOut; d.inTok = d.inTok + nIn; d.outTok = d.outTok + nOut;
    let cr = 0;
    for (const m of arr(tm["metering_usage"])) { const mo = obj(m); if (mo && str(mo["unit"]) === "credit") cr += num(mo["value"]); }
    if (rate > 0) { a.cost = a.cost + cr * rate; d.cost = d.cost + cr * rate; }
    else if (cr > 0) { a.unk = a.unk + cr; d.unk = d.unk + cr; }
  }
  a.x[1] = turns.length;
}

export const kiro: HarnessAdapter = {
  id: "kiro", label: "Kiro", glyph: "◇", mark: "◇", color: () => C.purple,
  bin: "kiro-cli", procs: ["kiro-cli", "kiro-cli-chat"],
  roots: () => [DIR], scan, meta, refresh: meta, headBytes: 524288,
  parse, busy, liveRegistry,
  headless: (s: Sess, msg: string) => ["chat", "--no-interactive", "--resume-id", s.id, msg],
  resume: (s: Sess) => ["chat", "--resume-id", s.id],
  files: (s: Sess) => { const b = s.path.slice(0, -6); return [s.path, b + ".json", b + ".lock"]; },
  usage, usageSidecar,
};
