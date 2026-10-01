// agentglass — Gemini CLI (~/.gemini) adapter
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { statSync } from "node:fs";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { HOME, readBytes } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C } from "../ui/theme.ts";
import type { Acc } from "../features/usage/record.ts";
import type { AddFn, HarnessAdapter, SessionSource } from "./types.ts";
import { FILE_SOURCE } from "./source.ts";

// ── normalizing source ──
// Gemini upserts: a changed message is re-appended whole under the same id (tokens, then its completed tool calls),
// {"$rewindTo":id} drops a message and all after it, {"$set":{"messages":[…]}} replaces the history (resume, rollback,
// compression). The readers (transcript, tail, ledger) expect an append-only log, so lines() emits each line reduced to
// what appears there first: message fields at the first offset of its id, each tool call at the first offset of its id,
// tokens at the first offset that carried them. Emission depends on byte offsets only → any window yields each id once.
interface Ix {
  at: number; // bytes indexed (a line start)
  msg: Map<string, number>; call: Map<string, number>; tok: Map<string, number>; // id → first byte offset (call key: msg id \t call id)
  spawn: Map<string, string>; // subagent id → the tool call that ran it
  drop: Map<number, number>; // offset of a rewind/checkpoint → messages it dropped from the history
  live: string[]; liveSet: Set<string>; // the history as of `at`, in order
}
const IX = new Map<string, Ix>();
const CH = 4194304;
function statSize(p: string): number { try { return statSync(p).size; } catch (e) { return -1; } }
// complete lines in [from, to) with their byte offsets; a line longer than the chunk is read whole; returns the offset after the last one
function eachLine(path: string, from: number, to: number, f: (l: string, x: number) => void): number {
  let at = from; let win = CH;
  const dec = new TextDecoder("utf-8");
  while (at < to) {
    const n = Math.min(win, to - at);
    const b = readBytes(path, at, n);
    if (!b.length) break;
    let z = b.length - 1; while (z >= 0 && b[z] !== 10) z--;
    if (z < 0) { if (b.length < n || at + b.length >= to) break; win *= 2; continue; } // partial line at EOF or across `to`
    let st = 0;
    for (let i = 0; i <= z; i++) if (b[i] === 10) { f(dec.decode(b.subarray(st, i)), at + st); st = i + 1; }
    at += z + 1; win = CH;
  }
  return at;
}
function seen(ix: Ix, m: Obj, x: number): void {
  const id = str(m["id"]); if (!id) return;
  if (!ix.msg.has(id)) ix.msg.set(id, x);
  if (obj(m["tokens"]) && !ix.tok.has(id)) ix.tok.set(id, x);
  for (const c of arr(m["toolCalls"])) {
    const co = obj(c); if (!co) continue;
    const k = id + "\t" + str(co["id"]);
    if (!ix.call.has(k)) ix.call.set(k, x);
    const ag = str(co["agentId"]); if (ag && !ix.spawn.has(ag)) ix.spawn.set(ag, str(co["id"]));
  }
}
function record(ix: Ix, l: string, x: number): void {
  if (l.indexOf("\"id\"") < 0 && l.indexOf("\"$") < 0) return; // header
  const o = parseJson(l); if (!o) return;
  const rw = o["$rewindTo"];
  if (typeof rw === "string") {
    const i = ix.live.indexOf(rw); if (i < 0) return;
    for (const g of ix.live.slice(i)) ix.liveSet.delete(g);
    ix.drop.set(x, ix.live.length - i); ix.live = ix.live.slice(0, i);
    return;
  }
  const set = obj(o["$set"]);
  if (set) {
    if (!Array.isArray(set["messages"])) return;
    const keep = new Set<string>(); const nl: string[] = [];
    for (const v of arr(set["messages"])) { const m = obj(v); const id = m ? str(m["id"]) : ""; if (!m || !id) continue; seen(ix, m, x); if (!keep.has(id)) { keep.add(id); nl.push(id); } }
    let n = 0; for (const id of ix.live) if (!keep.has(id)) n++;
    if (n > 0) ix.drop.set(x, n);
    ix.live = nl; ix.liveSet = keep;
    return;
  }
  const id = str(o["id"]); if (!id) return;
  seen(ix, o, x);
  if (!ix.liveSet.has(id)) { ix.liveSet.add(id); ix.live.push(id); }
}
// the index of path, extended to `to` (a shrunk file starts over)
function indexTo(path: string, to: number): Ix {
  let ix = IX.get(path);
  if (!ix || statSize(path) < ix.at) {
    ix = { at: 0, msg: new Map<string, number>(), call: new Map<string, number>(), tok: new Map<string, number>(), spawn: new Map<string, string>(), drop: new Map<number, number>(), live: [], liveSet: new Set<string>() };
    IX.set(path, ix);
  }
  const cur = ix;
  if (to > cur.at) cur.at = eachLine(path, cur.at, to, (l: string, x: number) => record(cur, l, x));
  return cur;
}
function dropped(n: number): string { return n > 0 ? ": " + String(n) + (n === 1 ? " message" : " messages") + " dropped" : ""; }
function meta(t: string): string { return "{\"$meta\":" + JSON.stringify(t) + "}"; }
// a message reduced to what first appears at offset x ("" = nothing new)
function msgAt(m: Obj, x: number, ix: Ix): string {
  const id = str(m["id"]); if (!id) return "";
  const first = ix.msg.get(id) === x;
  const tk = obj(m["tokens"]); const tok = !!tk && ix.tok.get(id) === x;
  const calls: unknown[] = [];
  for (const c of arr(m["toolCalls"])) { const co = obj(c); if (co && ix.call.get(id + "\t" + str(co["id"])) === x) calls.push(co); }
  if (!first && !tok && calls.length === 0) return "";
  const r: Obj = {};
  r["id"] = id; r["timestamp"] = str(m["timestamp"]); r["type"] = str(m["type"]);
  if (first) { if (m["content"] !== undefined) r["content"] = m["content"]; if (m["thoughts"] !== undefined) r["thoughts"] = m["thoughts"]; }
  if ((first || tok) && m["model"] !== undefined) r["model"] = m["model"];
  if (tok) r["tokens"] = tk;
  if (calls.length > 0) r["toolCalls"] = calls;
  return JSON.stringify(r);
}
// one raw line at offset x → normalized lines: header as is, messages reduced, {"$title"}, {"$meta"}; other patches dropped
function normalize(o: Obj, l: string, x: number, ix: Ix): string[] {
  if (str(o["sessionId"]) && str(o["projectHash"])) return [l];
  if (typeof o["$rewindTo"] === "string") return [meta("rewound" + dropped(ix.drop.get(x) ?? 0))];
  const set = obj(o["$set"]);
  if (!set) { const e = msgAt(o, x, ix); return e ? [e] : []; }
  const out: string[] = [];
  const t = str(set["summary"]); if (t) out.push("{\"$title\":" + JSON.stringify(t) + "}");
  const n = ix.drop.get(x) ?? 0; if (n > 0) out.push(meta("history rewritten" + dropped(n)));
  for (const v of arr(set["messages"])) { const m = obj(v); if (m) { const e = msgAt(m, x, ix); if (e) out.push(e); } }
  return out;
}
const source: SessionSource = {
  stat: FILE_SOURCE.stat, align: FILE_SOURCE.align, unit: 1,
  lines: (s: Sess, from: number, to: number) => {
    const raw: string[] = []; const off: number[] = [];
    const push = (l: string, x: number): void => { raw.push(l); off.push(x); };
    let next = eachLine(s.path, from, to, push);
    if (next === from && to > from) { const e = FILE_SOURCE.align(s, to); if (e > to) next = eachLine(s.path, from, e, push); } // one line longer than the window: whole
    const ix = indexTo(s.path, next);
    const out: string[] = [];
    for (let i = 0; i < raw.length; i++) { const o = parseJson(raw[i]); if (o) for (const e of normalize(o, raw[i], off[i], ix)) out.push(e); }
    return { lines: out, next };
  },
};

function roots(): string[] { return [join(HOME, ".gemini", "tmp")]; }
function scan(add: AddFn): void { /* Task 3 */ }
function parse(o: Obj, out: Ev[], s: Sess | null): void { /* Task 3 */ }
function busy(s: Sess): boolean { return false; }
function usage(a: Acc, l: string): void { /* Task 4 */ }

export const gemini: HarnessAdapter = {
  id: "gemini", label: "Gemini", glyph: "✦", mark: "✦", color: () => C.gemini,
  bin: "gemini", procs: ["gemini"],
  roots, scan, source, headBytes: 65536,
  parse, busy,
  liveCwd: true, // no lock, no registry, the file is opened per write
  headless: (s: Sess, msg: string) => ["--resume", s.id, "-p", msg], // runs in s.cwd: gemini looks the id up in that project only
  resume: (s: Sess) => ["--resume", s.id],
  files: (s: Sess) => [s.path],
  usage,
};
