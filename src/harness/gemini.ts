// agentglass — Gemini CLI (~/.gemini) adapter
// SPDX-License-Identifier: Apache-2.0
import { join, dirname } from "node:path";
import { statSync } from "node:fs";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { HOME, readBytes, readText, listDir } from "../util/fs.ts";
import type { Ev, Sess } from "../model/types.ts";
import { C } from "../ui/theme.ts";
import type { Acc } from "../features/usage/record.ts";
import type { AddFn, HarnessAdapter, SessionSource } from "./types.ts";
import { FILE_SOURCE } from "./source.ts";
import { toolArg, isNoise } from "./common.ts";

// ── normalizing source ──
// Gemini upserts: a changed message is re-appended whole under the same id (tokens, then its completed tool calls),
// {"$rewindTo":id} drops a message and all after it, {"$set":{"messages":[…]}} replaces the history (resume, rollback,
// compression). The readers (transcript, tail, ledger) expect an append-only log, so lines() emits each line reduced to
// what appears there first: message fields at the first offset of its id, each tool call at the first offset of its id,
// tokens at the first offset that carried them. Emission depends on byte offsets only → any window yields each id once.
interface Ix {
  at: number; // bytes indexed (a line start)
  msg: Map<string, number>; call: Map<string, number>; tok: Map<string, number>; // id → first byte offset (call key: msg id \t call id)
  spawn: Map<string, string>; spawnName: Map<string, string>; // subagent id → the tool call that ran it, its tool name
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
    const ag = str(co["agentId"]); if (ag && !ix.spawn.has(ag)) { ix.spawn.set(ag, str(co["id"])); const a = obj(co["args"]); ix.spawnName.set(ag, (a ? str(a["agent_name"]) : "") || str(co["name"])); } // invoke_agent {agent_name} or a tool named after the agent
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
    ix = { at: 0, msg: new Map<string, number>(), call: new Map<string, number>(), tok: new Map<string, number>(), spawn: new Map<string, string>(), spawnName: new Map<string, string>(), drop: new Map<number, number>(), live: [], liveSet: new Set<string>() };
    IX.set(path, ix);
  }
  const cur = ix;
  if (to > cur.at) cur.at = eachLine(path, cur.at, to, (l: string, x: number) => record(cur, l, x));
  return cur;
}
function dropped(n: number): string { return n > 0 ? ": " + String(n) + (n === 1 ? " message" : " messages") + " dropped" : ""; }
function metaLine(t: string): string { return "{\"$meta\":" + JSON.stringify(t) + "}"; }
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
  if (typeof o["$rewindTo"] === "string") return [metaLine("rewound" + dropped(ix.drop.get(x) ?? 0))];
  const set = obj(o["$set"]);
  if (!set) { const e = msgAt(o, x, ix); return e ? [e] : []; }
  const out: string[] = [];
  const t = str(set["summary"]); if (t) out.push("{\"$title\":" + JSON.stringify(t) + "}");
  const n = ix.drop.get(x) ?? 0; if (n > 0) out.push(metaLine("history rewritten" + dropped(n)));
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

// ── discovery ──
// <root>/<slug>/.project_root (the cwd; slugs are basename-N, not reversible), chats/session-<ts>-<id8>.jsonl (main),
// chats/<parent id>/<agent id>.jsonl (subagents); dirs without .project_root are pre-0.29 hash copies or bin/
function geminiHome(): string { const e = process.env["GEMINI_CLI_HOME"]; return e ? e : HOME; }
function roots(): string[] {
  const h = geminiHome(); const out = [join(h, ".gemini", "tmp")];
  const sb = join(h, ".cache", ".gemini", "tmp"); if (statSize(sb) >= 0) out.push(sb); // SANDBOX=sandbox-exec
  return out;
}
const projRoot = new Map<string, string>(); // slug dir → cwd ("" not cached: the next scan looks again)
function cwdOf(slugDir: string): string {
  const hit = projRoot.get(slugDir); if (hit !== undefined) return hit;
  const c = readText(join(slugDir, ".project_root"), 0, 4096).trim();
  if (c) projRoot.set(slugDir, c);
  return c;
}
function slugOf(path: string): string { const i = path.lastIndexOf("/chats/"); return i >= 0 ? path.slice(0, i) : dirname(path); }
// the filename carries only id.slice(0, 8): the full id is in the header (first line, cached once read)
const hdrIds = new Map<string, string>();
function header(path: string): Obj | null { const h = readText(path, 0, 4096); const nl = h.indexOf("\n"); return nl > 0 ? parseJson(h.slice(0, nl)) : null; }
function headerId(path: string): string {
  const hit = hdrIds.get(path); if (hit !== undefined) return hit;
  const o = header(path); const id = o ? str(o["sessionId"]) : "";
  if (id) hdrIds.set(path, id);
  return id;
}
const pathOf = new Map<string, string>(); // session id → its file (spawnOf, subagent kind)
function scan(add: AddFn): void {
  for (const root of roots()) for (const slug of listDir(root)) {
    const sd = join(root, slug); if (!cwdOf(sd)) continue;
    const cd = join(sd, "chats"); const names = listDir(cd);
    // a resume leaves a startup-only file with the same id next to the real one: keep the larger
    const best = new Map<string, string>(); const size = new Map<string, number>();
    for (const f of names) {
      if (!f.startsWith("session-") || !f.endsWith(".jsonl")) continue;
      const p = join(cd, f); const id = headerId(p); if (!id) continue;
      const n = statSize(p); const b = size.get(id);
      if (b === undefined || n > b) { best.set(id, p); size.set(id, n); }
    }
    for (const [id, p] of best) { pathOf.set(id, p); add(p, id, "", false); }
    for (const f of names) {
      if (f.endsWith(".jsonl") || f.endsWith(".json")) continue;
      for (const c of listDir(join(cd, f))) if (c.endsWith(".jsonl")) add(join(cd, f, c), c.slice(0, -6), f, false);
    }
  }
}
// the parent's index knows which tool call ran a subagent (toolCalls[].agentId); written when the call completes
function spawnIx(s: Sess): Ix | null { const pp = s.parent ? pathOf.get(s.parent) ?? "" : ""; return pp ? indexTo(pp, statSize(pp)) : null; }
function spawnOf(s: Sess): string { const ix = spawnIx(s); return ix ? ix.spawn.get(s.id) ?? "" : ""; }
function meta(s: Sess): void {
  s.cwd = cwdOf(slugOf(s.path));
  if (!s.parent) { const o = header(s.path); if (!o || str(o["kind"]) !== "subagent") return; }
  if (s.kind && s.kind !== "subagent") return;
  const ix = spawnIx(s); s.kind = (ix ? ix.spawnName.get(s.id) : undefined) ?? "subagent";
}
function files(s: Sess): string[] {
  const out = [s.path]; if (s.parent) return out;
  const sd = slugOf(s.path); const cd = join(sd, "chats"); const id8 = "-" + s.id.slice(0, 8) + ".jsonl";
  for (const f of listDir(cd)) { const p = join(cd, f); if (p !== s.path && f.startsWith("session-") && f.endsWith(id8) && headerId(p) === s.id) out.push(p); }
  for (const p of [join(cd, s.id), join(sd, "tool-outputs", "session-" + s.id), join(sd, s.id), join(sd, "logs", "session-" + s.id + ".jsonl")]) if (statSize(p) >= 0) out.push(p);
  return out; // never logs.json: every session of the project shares it
}

// ── transcript (normalized lines) ──
function ev(out: Ev[], kind: string, text: string, ts: string, id: string, full: string): void { out.push({ kind, text, ts, id, full }); }
// content = string | Part | Part[]; thought parts and function calls/responses are not text
function partsText(c: unknown, thought: boolean): string {
  if (typeof c === "string") return thought ? "" : c;
  const one = obj(c); const ps = one ? [one as unknown] : arr(c);
  const out: string[] = [];
  for (const v of ps) { const p = obj(v); if (p && typeof p["text"] === "string" && (p["thought"] === true) === thought) out.push(str(p["text"])); }
  return out.join("\n");
}
function hasPart(c: unknown, k: string): boolean { const one = obj(c); const ps = one ? [one as unknown] : arr(c); for (const v of ps) { const p = obj(v); if (p && p[k] !== undefined) return true; } return false; }
// gemini's own resume list skips these: slash commands, help, injected context blocks
function noise(t: string): boolean { const u = t.trimStart(); return isNoise(u) || u.startsWith("/") || u.startsWith("?"); }
function resultText(c: Obj): string {
  for (const v of arr(c["result"])) {
    const fr = obj(obj(v) ? (obj(v) as Obj)["functionResponse"] : null); const r = fr ? obj(fr["response"]) : null; if (!r) continue;
    if (typeof r["output"] === "string") return str(r["output"]);
    if (r["error"] !== undefined) return typeof r["error"] === "string" ? str(r["error"]) : JSON.stringify(r["error"]);
    return JSON.stringify(r);
  }
  return str(c["resultDisplay"]);
}
function callArg(name: string, a: Obj | null): string { const d = a ? str(a["agent_name"]) || str(a["dir_path"]) || str(a["objective"]) : ""; return d ? d : toolArg(name, a, ""); }
function parse(o: Obj, out: Ev[], s: Sess | null): void {
  if (o["$title"] !== undefined) { if (s) { const t = str(o["$title"]); if (t && !t.startsWith("{")) s.title = t; } return; } // subagents set their JSON report as summary
  if (o["$meta"] !== undefined) { ev(out, "meta", str(o["$meta"]), "", "", ""); return; }
  const type = str(o["type"]); const ts = str(o["timestamp"]);
  const c = o["content"];
  if (type === "user") {
    if (c === undefined) return;
    let t = partsText(c, false);
    if (!t && (hasPart(c, "inlineData") || hasPart(c, "fileData"))) t = "[image]";
    if (t && !noise(t)) ev(out, "user", t, ts, "", ""); // functionResponse-only = the tool result echo: results come from toolCalls
    return;
  }
  if (type === "info" || type === "error" || type === "warning") { const t = partsText(c, false); if (t) ev(out, "meta", (type === "info" ? "" : "[" + type + "] ") + t, ts, "", ""); return; }
  if (type !== "gemini") return;
  if (s) { const md = str(o["model"]); if (md) s.model = md; }
  for (const v of arr(o["thoughts"])) { const th = obj(v); if (!th) continue; const sj = str(th["subject"]); const d = str(th["description"]); const t = sj && d ? sj + ": " + d : sj || d; if (t) ev(out, "thinking", t, str(th["timestamp"]) || ts, "", ""); }
  if (c !== undefined) {
    const th = partsText(c, true); if (th) ev(out, "thinking", th, ts, "", "");
    const t = partsText(c, false); if (t) ev(out, "assistant", t, ts, "", "");
  }
  for (const v of arr(o["toolCalls"])) {
    const tc = obj(v); if (!tc) continue;
    const n = str(tc["name"]) || "tool"; const id = str(tc["id"]); const a = obj(tc["args"]);
    ev(out, "tool", n + "\u0000" + callArg(n, a), ts, id, a ? JSON.stringify(a) : "");
    const st = str(tc["status"]);
    ev(out, "result", (st && st !== "success" ? "[" + st + "] " : "") + resultText(tc), str(tc["timestamp"]) || ts, id, "");
  }
}
// no turn markers: the prompt, a tool result (the model answers next) or bare thoughts (their calls are written when
// they complete) mean mid-turn; the answer or an error/cancel note end it. Text next to a still-running call reads idle.
function busy(s: Sess): boolean {
  const e = s.evs.length ? s.evs[s.evs.length - 1] : null;
  return !!e && (e.kind === "user" || e.kind === "tool" || e.kind === "result" || e.kind === "thinking");
}
function usage(a: Acc, l: string): void { /* Task 4 */ }

export const gemini: HarnessAdapter = {
  id: "gemini", label: "Gemini", glyph: "✦", mark: "✦", color: () => C.gemini,
  bin: "gemini", procs: ["gemini"],
  roots, scan, meta, refresh: meta, source, headBytes: 65536,
  parse, busy, spawnOf,
  liveCwd: true, // no lock, no registry, the file is opened per write
  headless: (s: Sess, msg: string) => ["--resume", s.id, "-p", msg], // runs in s.cwd: gemini looks the id up in that project only
  resume: (s: Sess) => ["--resume", s.id],
  files,
  usage,
};
