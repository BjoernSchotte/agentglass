// agentglass — usage ledger: incremental, budgeted per-session/per-day token, cost, tool and line counts from the raw logs
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { type Obj, obj, str, arr, parse } from "../../util/json.ts";
import { readBytes, readText } from "../../util/fs.ts";
import type { Sess } from "../../model/types.ts";
import { H } from "../../hooks.ts";
import { sessions } from "../../model/sessions.ts";
import { price, cost } from "./pricing.ts";

// one local day of one session; unk = tokens (or fx turns) whose price is unknown
export interface Day { tools: number; names: Map<string, number>; hours: number[]; inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number; add: number; del: number }
export interface Acc {
  off: number; skip: boolean; stall: number; // next unread byte; inside a >1 MB line; size at which only a partial line was left
  ids: Set<string>; days: Map<string, Day>; model: string;
  cx: number[]; // codex cumulative totals seen so far: input, cached, cache write, output
  fx: number[]; fxM: number; // fx usage snapshot seen so far: in, out, cache r, cache w, cost, +, −
  inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number; tools: number; add: number; del: number;
}
export const ledger = new Map<string, Acc>();
export const L = { ver: 0, done: 0, total: 0, prio: "", prioAt: 0, rlPct: -1, rlWin: 0, rlReset: 0, rlAt: 0 }; // rl* = latest Codex primary rate limit

const BUDGET = 4194304; const CHUNK = 1048576; const SLICE_MS = 100;

function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
function two(n: number): string { return (n < 10 ? "0" : "") + n; }
export function dayKey(d: Date): string { return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()); }
export function todayKey(): string { return dayKey(new Date()); }
// local midnight today (ms); scriptc has no new Date(y, m, d)
export function startOfDay(): number { const t = new Date(); return t.getTime() - ((t.getHours() * 60 + t.getMinutes()) * 60 + t.getSeconds()) * 1000 - t.getMilliseconds(); }
// last n local days, oldest first (anchored at noon so DST shifts can't skip a day)
export function lastDays(n: number): string[] {
  const noon = startOfDay() + 43200000; const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(new Date(noon - i * 86400000)));
  return out;
}
function nlines(s: string): number { if (!s) return 0; const n = s.split("\n").length; return s.endsWith("\n") ? n - 1 : n; }

function newAcc(): Acc {
  return { off: 0, skip: false, stall: -1, ids: new Set<string>(), days: new Map<string, Day>(), model: "", cx: [0, 0, 0, 0], fx: [0, 0, 0, 0, 0, 0, 0], fxM: 0,
    inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0, tools: 0, add: 0, del: 0 };
}
export function accOf(s: Sess): Acc {
  let a = ledger.get(s.path);
  if (!a || s.size < a.off) { a = newAcc(); ledger.set(s.path, a); } // new or truncated/rewritten
  return a;
}
export function pending(s: Sess, a: Acc): boolean { return a.off < s.size && a.stall !== s.size; }

// timestamp → day bucket + local hour; the conversion is cached per UTC hour prefix (lines arrive in order)
let tsKey = ""; let tsDay = ""; let tsHour = 0;
function bucket(a: Acc, ms: number, iso: string): Day {
  if (iso) {
    const k = iso.slice(0, 13);
    if (k !== tsKey) { const d = new Date(iso); tsKey = k; tsDay = dayKey(d); tsHour = d.getHours(); }
  } else { const d = new Date(ms > 0 ? ms : Date.now()); tsKey = ""; tsDay = dayKey(d); tsHour = d.getHours(); }
  let d = a.days.get(tsDay);
  if (!d) { d = { tools: 0, names: new Map<string, number>(), hours: [], inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0, add: 0, del: 0 }; for (let i = 0; i < 24; i++) d.hours.push(0); a.days.set(tsDay, d); }
  return d;
}
function tool(a: Acc, d: Day, name: string): void {
  a.tools++; d.tools++;
  d.names.set(name, (d.names.get(name) ?? 0) + 1);
  d.hours[tsHour] = (d.hours[tsHour] ?? 0) + 1;
}
function lines(a: Acc, d: Day, nAdd: number, nDel: number): void {
  a.add = a.add + nAdd;
  a.del = a.del + nDel;
  d.add = d.add + nAdd;
  d.del = d.del + nDel;
}
function tokens(a: Acc, d: Day, model: string, nIn: number, nOut: number, nCr: number, w5: number, w1: number): void {
  // ponytail: spelled out — scriptc rejects some `obj.field += n` pairs on one line (SC1043)
  a.inTok = a.inTok + nIn; a.outTok = a.outTok + nOut; a.cr = a.cr + nCr; a.cw = a.cw + w5 + w1;
  d.inTok = d.inTok + nIn; d.outTok = d.outTok + nOut; d.cr = d.cr + nCr; d.cw = d.cw + w5 + w1;
  const p = price(model);
  if (p) { const c = cost(p, nIn, nOut, nCr, w5, w1); a.cost += c; d.cost += c; }
  else { const t = nIn + nOut + nCr + w5 + w1; a.unk += t; d.unk += t; }
}

function claudeLine(a: Acc, l: string): void {
  if (l.indexOf("\"type\":\"assistant\"") < 0) return;
  const o = parse(l); if (!o || str(o["type"]) !== "assistant") return;
  const m = obj(o["message"]); if (!m) return;
  const d = bucket(a, 0, str(o["timestamp"]));
  const id = str(m["id"]); const u = obj(m["usage"]);
  if (u && !(id && a.ids.has(id))) { // one API message is split over several lines carrying the same id + usage
    if (id) a.ids.add(id);
    const model = str(m["model"]) || a.model; if (model) a.model = model;
    const cw = num(u["cache_creation_input_tokens"]); const cc = obj(u["cache_creation"]);
    const w1 = cc ? num(cc["ephemeral_1h_input_tokens"]) : 0;
    if (model !== "<synthetic>") tokens(a, d, model, num(u["input_tokens"]), num(u["output_tokens"]), num(u["cache_read_input_tokens"]), Math.max(0, cw - w1), w1);
  }
  for (const b of arr(m["content"])) {
    const bo = obj(b); if (!bo || str(bo["type"]) !== "tool_use") continue;
    const name = str(bo["name"]) || "tool"; tool(a, d, name);
    const inp = obj(bo["input"]); if (!inp) continue;
    if (name === "Edit") lines(a, d, nlines(str(inp["new_string"])), nlines(str(inp["old_string"])));
    else if (name === "Write") lines(a, d, nlines(str(inp["content"])), 0);
    else if (name === "MultiEdit") for (const e of arr(inp["edits"])) { const eo = obj(e); if (eo) lines(a, d, nlines(str(eo["new_string"])), nlines(str(eo["old_string"]))); }
  }
}

function patchLines(a: Acc, d: Day, patch: string): void {
  let add = 0; let del = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  lines(a, d, add, del);
}
function codexLine(a: Acc, l: string): void {
  const h = l.slice(0, 200); // cheap pre-filter: most bytes are tool outputs and messages we never parse
  const tc = h.indexOf("\"payload\":{\"type\":\"token_count\"") >= 0;
  const ctx = h.indexOf("\"type\":\"turn_context\"") >= 0;
  const call = h.indexOf("\"payload\":{\"type\":\"function_call\"") >= 0 || h.indexOf("\"payload\":{\"type\":\"custom_tool_call\"") >= 0 || h.indexOf("\"payload\":{\"type\":\"local_shell_call\"") >= 0;
  if (!tc && !ctx && !call) return;
  const o = parse(l); if (!o) return;
  const p = obj(o["payload"]); if (!p) return;
  const iso = str(o["timestamp"]);
  if (ctx) { const m = str(p["model"]); if (m) a.model = m; return; }
  const d = bucket(a, 0, iso);
  if (call) {
    const t = str(p["type"]);
    const name = str(p["name"]) || (t === "local_shell_call" ? "shell" : "tool");
    tool(a, d, name);
    if (t !== "custom_tool_call") return;
    const inp = str(p["input"]);
    if (name === "apply_patch") { patchLines(a, d, inp); return; }
    // newer Codex calls tools.apply_patch("*** Begin Patch\n…") from inside its JS `exec` tool: patches are escaped string literals
    let at = inp.indexOf("*** Begin Patch");
    while (at >= 0) {
      const end = inp.indexOf("*** End Patch", at);
      patchLines(a, d, inp.slice(at, end > at ? end : inp.length).split("\\n").join("\n"));
      at = end > at ? inp.indexOf("*** Begin Patch", end) : -1;
    }
    return;
  }
  const info = obj(p["info"]); const tu = info ? obj(info["total_token_usage"]) : null;
  if (tu) { // cumulative → attribute the delta to this event's day; input_tokens includes the cached part
    const cur = [num(tu["input_tokens"]), num(tu["cached_input_tokens"]), num(tu["cache_write_input_tokens"]), num(tu["output_tokens"])];
    const dl: number[] = [];
    let back = false;
    for (let i = 0; i < 4; i++) { const v = (cur[i] ?? 0) - (a.cx[i] ?? 0); dl.push(v); if (v < 0) back = true; }
    const use = back ? cur : dl; // counter went backwards (new thread in the same file): count it fresh
    const inp = use[0] ?? 0; const ca = use[1] ?? 0; const cw = use[2] ?? 0; const out = use[3] ?? 0;
    if (inp + out + cw > 0) tokens(a, d, a.model, Math.max(0, inp - ca - cw), out, ca, cw, 0);
    a.cx = cur;
  }
  const rl = obj(p["rate_limits"]); const pr = rl ? obj(rl["primary"]) : null;
  if (pr) {
    const at = new Date(iso).getTime();
    if (at >= L.rlAt) { L.rlAt = at; L.rlPct = num(pr["used_percent"]); L.rlWin = num(pr["window_minutes"]); L.rlReset = num(pr["resets_at"]); }
  }
}

function fxLine(a: Acc, l: string): void {
  if (l.indexOf("\"tool_call\"") < 0) return;
  const o = parse(l); if (!o) return;
  const e = obj(o["event"]); const c = e ? obj(e["tool_call"]) : null; if (!c) return;
  tool(a, bucket(a, num(o["timestamp_ms"]), ""), str(c["tool_name"]) || "tool");
}
// fx keeps running totals in usage-v2.json; attribute changes to the day the file was written
function fxUsage(s: Sess, a: Acc): void {
  const f = s.path.slice(0, -"events.jsonl".length) + "usage-v2.json";
  let mt = 0; try { mt = statSync(f).mtimeMs; } catch (e) { return; }
  if (mt === a.fxM) return;
  a.fxM = mt;
  const o = parse(readText(f, 0, 1048576).trim()); const sn = o ? obj(o["snapshot"]) : null; if (!sn) return;
  const cur = [num(sn["input_tokens"]), num(sn["output_tokens"]), num(sn["cache_read_tokens"]), num(sn["cache_write_tokens"]), num(sn["total_cost"]), num(sn["lines_added"]), num(sn["lines_removed"])];
  const dl: number[] = [];
  for (let i = 0; i < 7; i++) dl.push(Math.max(0, (cur[i] ?? 0) - (a.fx[i] ?? 0)));
  a.fx = cur;
  const d = bucket(a, mt, "");
  const inp = dl[0] ?? 0; const out = dl[1] ?? 0; const cr = dl[2] ?? 0; const cw = dl[3] ?? 0; const c = dl[4] ?? 0;
  a.inTok += inp; a.outTok += out; a.cr += cr; a.cw += cw; d.inTok += inp; d.outTok += out; d.cr += cr; d.cw += cw;
  if (c > 0) { a.cost += c; d.cost += c; }
  else if ((cur[4] ?? 0) === 0 && a.unk === 0) { a.unk = 1; d.unk += 1; } // custom model connections report $0 → unknown
  lines(a, d, dl[5] ?? 0, dl[6] ?? 0);
}

// one chunk (≤ CHUNK bytes) of new log lines; returns bytes consumed (0 = nothing to do right now)
function step(s: Sess, a: Acc): number {
  const len = Math.min(CHUNK, s.size - a.off);
  if (len <= 0) return 0;
  const b = readBytes(s.path, a.off, len);
  if (!b.length) { a.stall = s.size; return 0; }
  let z = b.length - 1;
  while (z >= 0 && b[z] !== 10) z--;
  if (z < 0) {
    if (a.off + b.length < s.size) { a.skip = true; a.off += b.length; return b.length; } // a >1 MB line (images, huge outputs): skip it
    a.stall = s.size; return 0; // partial last line, the agent is still writing it
  }
  const ls = new TextDecoder("utf-8").decode(b.subarray(0, z + 1)).split("\n");
  for (let i = a.skip ? 1 : 0; i < ls.length; i++) {
    const l = ls[i] ?? "";
    if (s.h === "claude") claudeLine(a, l); else if (s.h === "codex") codexLine(a, l); else fxLine(a, l);
  }
  a.skip = false;
  a.off += z + 1;
  return z + 1;
}
function apply(s: Sess, a: Acc): void {
  s.inTok = a.inTok; s.outTok = a.outTok; s.cacheRTok = a.cr; s.cacheWTok = a.cw;
  s.cost = a.unk > 0 && a.cost === 0 ? -1 : a.cost;
  s.tools = a.tools; s.linesAdd = a.add; s.linesDel = a.del;
}
function rank(s: Sess, sod: number): number {
  if (s.path === L.prio && Date.now() - L.prioAt < 3000) return 0;
  if (s.pid) return 1;
  return s.mtime >= sod ? 2 : 3;
}
function tick(): void {
  const t0 = Date.now();
  const sod = startOfDay();
  const q: Sess[] = [];
  let done = 0; let total = 0;
  for (const s of sessions.values()) {
    const a = accOf(s);
    if (s.h === "fx") fxUsage(s, a); // a stat per fx session; there are few
    if (pending(s, a)) q.push(s);
    apply(s, a);
  }
  q.sort((x, y) => rank(x, sod) - rank(y, sod) || y.mtime - x.mtime);
  let budget = BUDGET;
  for (const s of q) {
    const a = accOf(s);
    while (budget > 0 && Date.now() - t0 < SLICE_MS) { const n = step(s, a); if (!n) break; budget -= n; }
    apply(s, a);
    if (budget <= 0 || Date.now() - t0 >= SLICE_MS) break;
  }
  if (budget < BUDGET) L.ver++;
  for (const s of sessions.values()) { const a = accOf(s); total += s.size; done += Math.min(a.off, s.size); if (a.stall === s.size) done += s.size - a.off; }
  L.done = done; L.total = total;
}
// blocking: everything up to the end of the file (CLI exports)
export function complete(s: Sess): void {
  const a = accOf(s);
  while (step(s, a) > 0) { /* next chunk */ }
  if (s.h === "fx") fxUsage(s, a);
  apply(s, a);
}

H.onTick.push(tick);
H.enrich.push((s: Sess) => { L.prio = s.path; L.prioAt = Date.now(); }); // O(1): the next tick indexes this one first
H.complete.push(complete);
