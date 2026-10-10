// agentglass — harness-neutral event kinds (skill-usage §5a.2): every event of a transcript gets one or more kinds
// (prompt, reply, shell:<kind>, edit, read, web, mcp:<server>, subagent, skill:*, error, approval, meta …) that every
// event view, --watch, `agentglass events` and the MCP server filter on the same way
// SPDX-License-Identifier: Apache-2.0
// Kinds come from what a view already holds — its events, the shell family of a call's command line and the session's
// marks (marks.ts) — never from a log read. Per events array they are kept as one Int32Array of interned kind-set ids,
// extended as the array grows (a result tags its call with `error` when it failed).
import type { Ev, Sess } from "./types.ts";
import { type Mark, marksOf, famOf, markKind } from "./marks.ts";
import { textFam, famKind, famName, toolKind, SHELL_KINDS } from "../features/wait/family.ts";
import { mcpServer, norm, argv, execCmds } from "../features/usage/calls.ts";
import { parse as parseJson, str } from "../util/json.ts";
import { catOf, isErr, toolName, toolArg } from "../features/callgraph/model.ts";

// the families in chip order; debug is registered by debug-episodes' marks, other = a tool nothing else claims
export const FAMILIES = ["prompt", "reply", "shell", "edit", "read", "web", "mcp", "subagent", "skill", "debug", "error", "approval", "meta", "other"];
// the kinds below a family that exist without a session to look at (completion, validation, docs)
export const SUBKINDS = ["prompt:agent", "reply:thinking", "read:search", "meta:compact", "skill:load", "skill:unload"].concat(SHELL_KINDS.map((k: string): string => "shell:" + k));
// file-writing tools of every adapter (claude Edit/Write/MultiEdit/NotebookEdit, codex apply_patch, gemini write_file/replace,
// pi/OpenCode edit/write/patch); kinds.check.ts holds each adapter's names against this list
export const T_EDIT = ["edit", "write", "multiedit", "notebookedit", "apply_patch", "write_file", "replace", "patch", "str_replace_editor", "create_file"];
const T_SEARCH = ["grep", "glob", "ls", "list_directory", "search_file_content", "find", "list", "codesearch", "rg"];
// tools that load a skill (claude Skill, OpenCode skill, gemini activate_skill)
const T_SKILL = ["skill", "activate_skill"];
// the old `event` values (--watch before event kinds): they keep matching the raw event kind, so old filters and pins
// mean what they meant (user = the prompt events, assistant = replies without thinking, tool / result = the call or its
// output); `meta` is raw under `event` and the family under `event.kind`
export const LEGACY_EVENT = new Map<string, string[]>([
  ["user", ["prompt"]], ["assistant", ["reply"]], ["thinking", ["reply:thinking"]], ["tool", ["tool"]], ["result", ["result"]],
  ["meta", ["meta"]], ["live", ["live"]], ["exit", ["exit"]], ["alert", ["alert"]],
]);
export const RAW_EVENT = ["user", "assistant", "thinking", "tool", "result", "meta", "live", "exit", "alert"];

// a kind or family the filter language accepts: a known family (or a registered mark family) and an optional :name
export function validKind(v: string): boolean {
  const f = famOf(v); if (!/^[a-z][a-z0-9_-]*$/.test(f)) return false;
  if (v.length > f.length && !/^:[a-z0-9][a-z0-9_.@/-]*$/.test(v.slice(f.length))) return false;
  return FAMILIES.indexOf(f) >= 0 || RAW_EVENT.indexOf(v) >= 0 || markKind(f) !== null;
}
// "shell" matches every shell:*, anything else only itself
export function kindMatch(kinds: string[], want: string): boolean {
  const fam = want.indexOf(":") < 0;
  for (const k of kinds) if (k === want || (fam && famOf(k) === want)) return true;
  return false;
}
// the most specific kind of a set (i solo): a family:name before a bare family, error last
export function specific(kinds: string[]): string {
  let best = "";
  for (const k of kinds) { if (k === "error") continue; if (!best || (k.indexOf(":") >= 0 && best.indexOf(":") < 0)) best = k; }
  return best || (kinds[0] ?? "");
}

// ── the kinds of one call (its name and argument text) ──
// shell family of a command line: the agent-wait family (its kind names the shell:<kind>), "" when not a shell call
export function shellFam(name: string, args: string): string { const c = catOf(name) === 0 ? shellCmd(args) : ""; return c ? famName(textFam(norm(c))) : ""; }
// the command line of a shell call's argument text: the text itself, or (Codex) the command inside its JSON arguments —
// an argv like ["bash", "-lc", "<script>"], a cmd string, or the exec_command calls of its JS wrapper
export function shellCmd(args: string): string {
  const t = args.trim();
  if (t.indexOf("exec_command(") >= 0) { const cs = execCmds(t); if (cs.length) return cs.join(" && "); }
  if (!t.startsWith("{")) return t;
  const o = parseJson(t); if (!o) return t;
  return argv(o["command"]) || str(o["cmd"]) || t;
}
// the MCP server of a call: mcp__<server>__<tool>, or pi's mcp proxy tool ("server/tool")
export function serverOf(name: string, args: string): string {
  const s = mcpServer(name); if (s) return s;
  if (name === "mcp") { const i = args.indexOf("/"); return i > 0 ? args.slice(0, i) : ""; }
  return "";
}
export function toolKinds(name: string, args: string): string[] {
  const n = name.toLowerCase();
  const sv = serverOf(name, args); if (sv || n === "mcp" || n.startsWith("mcp__")) return ["mcp:" + (sv ? sv.toLowerCase() : "unknown")];
  if (T_SKILL.indexOf(n) >= 0) return ["skill:load"];
  const tk = toolKind(name);
  if (tk === "user") return ["approval"];
  if (tk === "agent") return ["subagent"];
  if (tk === "web") return ["web"];
  if (T_EDIT.indexOf(n) >= 0) return ["edit"];
  const c = catOf(name);
  if (tk === "file" || c === 2) return [T_SEARCH.indexOf(n) >= 0 ? "read:search" : "read"];
  if (c === 0 || tk === "wait") {
    if (tk === "wait") return ["shell:wait"];
    const cmd = shellCmd(args); const f = cmd ? textFam(norm(cmd)) : -1;
    return ["shell:" + (f >= 0 ? famKind(f) : "other")];
  }
  if (c === 1) return ["edit"];
  if (c === 3) return ["web"];
  if (c === 4) return ["subagent"];
  return ["other"];
}
// one event's own kinds; a result takes its call's (call = the paired tool event, null unknown) and adds error when it failed
export function evKindList(e: Ev, call: Ev | null): string[] {
  const k = e.kind;
  if (k === "user") return ["prompt"];
  if (k === "assistant") return ["reply"];
  if (k === "thinking") return ["reply:thinking"];
  if (k === "tool") return toolKinds(toolName(e), toolArg(e));
  if (k === "result") { const o = call ? toolKinds(toolName(call), toolArg(call)) : ["other"]; if (isErr(e.text)) o.push("error"); return o; }
  if (k === "meta") {
    const t = e.text;
    if (t.startsWith("⇄ ") || t.startsWith("⟲ ")) return ["prompt:agent"]; // a peer's message, a task notification
    if (t.startsWith("skill: ")) return ["skill:load"]; // OpenCode's skill part
    if (t.indexOf("compact") >= 0) return t.startsWith("[error]") ? ["meta:compact", "error"] : ["meta:compact"];
    return t.startsWith("[error]") ? ["meta", "error"] : ["meta"];
  }
  return [k]; // --watch's live, exit, alert
}

// ── interned kind sets ──
// (wrapped: scriptc 0.1.7 cannot lower an element read of a string[][] that is joined or sliced)
interface KSet { ks: string[] }
const SETS: KSet[] = [{ ks: [] }]; const SETID = new Map<string, number>([["", 0]]);
const MAX_SETS = 65000;
export function intern(kinds: string[]): number {
  const ks: string[] = []; for (const k of kinds) if (ks.indexOf(k) < 0) ks.push(k);
  ks.sort();
  const key = ks.join(",");
  const hit = SETID.get(key); if (hit !== undefined) return hit;
  if (SETS.length >= MAX_SETS) return intern(["other"]); // never on real data: a few hundred sets per machine
  SETS.push({ ks }); SETID.set(key, SETS.length - 1);
  return SETS.length - 1;
}
// how many kind sets exist (ids are 0 … n-1): scratch arrays indexed by id
export function kindSets(): number { return SETS.length; }
export function kindSet(id: number): string[] { if (id >= 0 && id < SETS.length) return SETS[id].ks; return SETS[0].ks; }
const ADD = new Map<string, number>();
function withKind(id: number, k: string): number {
  const key = String(id) + "\t" + k; const hit = ADD.get(key); if (hit !== undefined) return hit;
  const o = kindSet(id).slice(); o.push(k); const r = intern(o); ADD.set(key, r); return r;
}

// ── per events array: kind-set ids, extended as it grows ──
// base = the events' own kinds; out = base plus the marks anchored on them (skill:load on a Skill call …), redone when the
// marks or the events changed; calls = tool call id → its event (results pair by it); gen = the marks array laid in;
// pair = a result's call event (-1 none), tid = the interned text of a call (a result: its call's; -1 none), texts = that
// interning: a filter that reads more than kinds judges each (text, kind set) once without building string keys
interface KMemo { s: Sess; evs: Ev[]; n: number; base: Int32Array; calls: Map<string, number>; marks: Mark[] | null; out: Int32Array; outN: number; ver: number; pair: Int32Array; tid: Int32Array; texts: Map<string, number> }
const MEMO: KMemo[] = []; const MEMO_MAX = 8;
export const KIND_STATS = { built: 0, events: 0 };
function grow(a: Int32Array, n: number): Int32Array { if (n <= a.length) return a; const b = new Int32Array(Math.max(n, a.length * 2, 256)); b.set(a); return b; }
function msOf(ts: string): number { if (!ts) return 0; const t = new Date(ts.replace(/(\.\d{3})\d+/, "$1")).getTime(); return t > 0 ? t : 0; }
// the event a mark lands on in this array: its call (anchor call=<id>), else the first event at or after its start;
// evs.length = later than every event (no event carries it, a list view draws it at the end); -1 = no time and no call
function anchorIn(evs: Ev[], m: Mark, calls: Map<string, number>): number {
  if (m.anchor.startsWith("call=")) { const j = calls.get(m.anchor.slice(5)); if (j !== undefined) return j; }
  const t0 = m.t0 > 0 ? m.t0 : m.anchor.startsWith("ts=") ? msOf(m.anchor.slice(3)) : 0;
  if (t0 <= 0) return -1;
  let lo = 0; let hi = evs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; const e = evs[mid]; if (msOf(e ? e.ts : "") < t0) lo = mid + 1; else hi = mid; }
  return lo;
}
// the event index of evs a mark lands on, as the kinds place it (the list views draw its line there), -1 none
export function markAt(s: Sess, evs: Ev[], m: Mark): number { kindIds(s, evs); return anchorIn(evs, m, memoOf(s, evs).calls); }
function memoOf(s: Sess, evs: Ev[]): KMemo {
  for (let i = 0; i < MEMO.length; i++) {
    const m = MEMO[i];
    if (m.evs === evs) { if (m.s !== s || evs.length < m.n) { MEMO.splice(i, 1); break; } return m; } // a reused array: start over
  }
  const m: KMemo = { s, evs, n: 0, base: new Int32Array(0), calls: new Map<string, number>(), marks: null, out: new Int32Array(0), outN: -1, ver: 0, pair: new Int32Array(0), tid: new Int32Array(0), texts: new Map<string, number>() };
  if (MEMO.length >= MEMO_MAX) MEMO.shift();
  MEMO.push(m);
  return m;
}
// the kind-set ids of evs (index i = evs[i]); valid until evs grows (call again: only the new events are classified)
export function kindIds(s: Sess, evs: Ev[]): Int32Array {
  const m = memoOf(s, evs);
  const n0 = m.n;
  if (evs.length > n0) {
    m.base = grow(m.base, evs.length); m.pair = grow(m.pair, evs.length); m.tid = grow(m.tid, evs.length);
    for (let i = n0; i < evs.length; i++) {
      const e = evs[i];
      let call: Ev | null = null; let ci = -1;
      if (e.kind === "result" && e.id) { const j = m.calls.get(e.id); if (j !== undefined) { ci = j + 0; if (ci < evs.length) call = evs[ci]; } }
      const ks = evKindList(e, call);
      m.base[i] = intern(ks);
      m.pair[i] = ci; m.tid[i] = ci >= 0 ? m.tid[ci] + 0 : -1;
      if (e.kind === "tool") { const t = m.texts.get(e.text); if (t !== undefined) m.tid[i] = t + 0; else { m.tid[i] = m.texts.size; m.texts.set(e.text, m.texts.size); } }
      if (e.kind === "tool" && e.id) m.calls.set(e.id, i);
      if (ci >= 0 && ks.indexOf("error") >= 0) m.base[ci] = withKind(m.base[ci] + 0, "error"); // the failed call is an error too
    }
    m.n = evs.length; KIND_STATS.events += evs.length - n0;
  }
  const mk = marksOf(s, null);
  if (m.outN !== m.n || m.marks !== mk) {
    KIND_STATS.built++; m.ver = KIND_STATS.built;
    m.out = grow(m.out, m.n); m.out.set(m.base.subarray(0, m.n));
    for (const x of mk) { const j = anchorIn(evs, x, m.calls); if (j >= 0 && j < m.n) m.out[j] = withKind(m.out[j] + 0, x.kind); }
    m.marks = mk; m.outN = m.n;
  }
  return m.out;
}
// per event of evs (after kindIds): a result's call event and every call's interned text (results: their call's), -1 none
export interface KPairs { pair: Int32Array; tid: Int32Array }
export function kindPairs(s: Sess, evs: Ev[]): KPairs { kindIds(s, evs); const m = memoOf(s, evs); return { pair: m.pair, tid: m.tid }; }
// a view that lets go of evs drops their memo too (else it lives until MEMO_MAX newer arrays pushed it out)
export function forgetKinds(evs: Ev[]): void { for (let i = MEMO.length - 1; i >= 0; i--) if (MEMO[i].evs === evs) MEMO.splice(i, 1); }
// changes whenever kindIds(…, evs) rewrote its ids (new events, other marks): a memo over them keys on it (-1 none yet)
export function kindVer(evs: Ev[]): number { for (const m of MEMO) if (m.evs === evs) return m.ver; return -1; }
// spec §5a: the kind set of s.evs[i]
export function evKinds(s: Sess, i: number): number { if (i < 0 || i >= s.evs.length) return 0; return kindIds(s, s.evs)[i] + 0; }
// kinds present in evs (marks included) → events carrying them, families counted too ("shell" = every shell:* event)
export function kindsIn(s: Sess, evs: Ev[]): Map<string, number> {
  const ids = kindIds(s, evs); const per = new Map<number, number>();
  for (let i = 0; i < evs.length; i++) { const id = ids[i] + 0; per.set(id, (per.get(id) ?? 0) + 1); }
  const out = new Map<string, number>();
  for (const [id, n] of per) {
    const fams: string[] = [];
    for (const k of kindSet(id)) { out.set(k, (out.get(k) ?? 0) + n); const f = famOf(k); if (f !== k && fams.indexOf(f) < 0) fams.push(f); }
    for (const f of fams) if (kindSet(id).indexOf(f) < 0) out.set(f, (out.get(f) ?? 0) + n);
  }
  return out;
}
export function kindsOf(s: Sess): Map<string, number> { return kindsIn(s, s.evs); }
// families present in a kinds map, in chip order (FAMILIES, then registered ones), with their counts
export function famsIn(m: Map<string, number>): string[] {
  const o: string[] = [];
  for (const f of FAMILIES) if ((m.get(f) ?? 0) > 0) o.push(f);
  for (const k of m.keys()) if (k.indexOf(":") < 0 && o.indexOf(k) < 0 && (m.get(k) ?? 0) > 0) o.push(k);
  return o;
}
// the kinds of one family present (shell → shell:test, shell:vcs …), most frequent first
export function kindsOfFam(m: Map<string, number>, fam: string): string[] {
  const o: string[] = []; for (const k of m.keys()) if (k.indexOf(":") > 0 && famOf(k) === fam) o.push(k);
  o.sort((a: string, b: string): number => (m.get(b) ?? 0) - (m.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  return o;
}
