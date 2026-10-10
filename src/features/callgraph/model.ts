// agentglass — call-graph model: session events → turn / tool / subagent spans, lanes, aggregates (pure, no UI)
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import type { Mark } from "../../model/marks.ts";
import { newCursor, feed } from "./turns.ts";

export const K_TURN = 0; export const K_TOOL = 1; export const K_AGENT = 2;
export const CATS = ["shell", "edit", "read", "web", "agent", "mcp", "other"];
export interface Span {
  t0: number; t1: number; depth: number; row: number; kind: number; cat: number;
  name: string; arg: string; id: string; // id = tool call id (Claude subagents name theirs in meta.json toolUseId)
  err: number; open: boolean; est: boolean; // err -1 unknown/unfinished, 0 ok, 1 error; est = time position guessed (no timing in the log)
  src: number; ev: number; parent: number; ix: number; // source session index, event index in it (-1 none), parent span (-1 root), own index
}
// one session's events; sources after the first are subagents of the first
export interface Src { evs: Ev[]; live: boolean; kind: string; spawn: string }
export interface Graph { spans: Span[]; rows: Span[][]; t0: number; t1: number; noTiming: boolean }

export function ms(ts: string): number { const v = ts ? new Date(ts).getTime() : 0; return v > 0 ? v : 0; }
export function toolName(e: Ev): string { const i = e.text.indexOf("\u0000"); return i >= 0 ? e.text.slice(0, i) : e.text; }
export function toolArg(e: Ev): string { const i = e.text.indexOf("\u0000"); return i >= 0 ? e.text.slice(i + 1) : ""; }
export function catOf(name: string): number {
  const n = name.toLowerCase();
  if (n.startsWith("mcp")) return 5;
  if (n.indexOf("todo") >= 0) return 6;
  if (/^(agent|task|subagent|spawn|send_input|wait_agent|delegate)/.test(n)) return 4;
  if (/bash|shell|exec|command|terminal|run/.test(n)) return 0;
  if (/edit|write|patch|notebook|replace/.test(n)) return 1;
  if (/web|fetch|http|browser|url/.test(n)) return 3; // before read/search: WebSearch is web
  if (/read|grep|glob|search|find|^ls|view|list|cat/.test(n)) return 2;
  return 6;
}
// ponytail: text heuristics — the parsed Ev keeps no is_error flag; add one to Ev if these miss too much
export function isErr(text: string): boolean {
  const t = text.trimStart().slice(0, 200);
  if (/^(<tool_use_error>|error|\[(error|failed|denied|cancel|timeout))/i.test(t) || /^Exit code:? [1-9]/.test(t) || /^Process exited with code [1-9]/.test(t) || /^The user doesn't want to proceed/.test(t)) return true;
  return /"exit_code":\s*[1-9]/.test(text.slice(-300)); // codex: {"output": …, "metadata": {"exit_code": n}}
}
function span(t0: number, depth: number, kind: number, name: string, arg: string, src: number, ev: number, parent: number): Span {
  return { t0, t1: t0, depth, row: 0, kind, cat: kind === K_TURN ? -1 : kind === K_AGENT ? 4 : catOf(name), name, arg, id: "", err: -1, open: false, est: false, src, ev, parent, ix: 0 };
}
// kids of a container that carry no timing of their own (fx logs a whole turn under one timestamp): lay them out side by side
function spread(out: Span[], p: number): void {
  const c = out[p];
  if (c.t1 <= c.t0) return;
  const kids: Span[] = [];
  for (const s of out) if (s.parent === p) { if (s.t1 > s.t0) return; kids.push(s); }
  if (!kids.length) return;
  const slot = (c.t1 - c.t0) / kids.length;
  for (let i = 0; i < kids.length; i++) { kids[i].t0 = c.t0 + i * slot; kids[i].t1 = kids[i].t0 + slot * 0.9; kids[i].est = true; }
}
// one session → spans appended to out. Top level (parent -1) gets turn spans; a subagent's tools hang under its agent span.
export function sessionSpans(evs: Ev[], src: number, parent: number, depth: number, live: boolean, now: number, out: Span[]): void {
  const pending = new Map<string, number>(); const anon: number[] = [];
  let turn = -1; let last = 0;
  const cur = newCursor();
  const closeTurn = (): void => { if (turn >= 0) { if (out[turn].t1 < last) out[turn].t1 = last; spread(out, turn); } turn = -1; };
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i];
    const t = ms(e.ts) || last;
    if (t > last) last = t;
    const prev = cur.n; const wasPrompt = cur.open && cur.prompt;
    const st = feed(cur, e, parent < 0); // shared turn rules (turns.ts)
    if (st === "open") { // a prompt, codex "turn started" (its prompt follows), or activity while no turn is open
      closeTurn();
      turn = out.length;
      const user = e.kind === "user"; const marker = e.kind === "meta";
      const arg = user ? e.text : marker ? "" : prev ? "(no prompt logged)" : "(its prompt is before the loaded part of the log)";
      out.push(span(t, depth, K_TURN, prev || user || marker ? "turn " + cur.n : "earlier turn", arg, src, user ? i : -1, -1));
    } else if (e.kind === "user" && wasPrompt && turn >= 0) { out[turn].ev = i; out[turn].arg = e.text; } // prompt of a turn opened by "turn started"
    else if (st === "close" && turn >= 0) {
      const m = /· ([\d.]+)s/.exec(e.text); // fx: "turn complete · 44.3s", logged with the turn's last timestamp
      const dur = m ? Number(m[1] ?? "0") * 1000 : 0;
      if (dur > 0 && t - dur < out[turn].t0) out[turn].t0 = t - dur;
      out[turn].t1 = t;
      closeTurn();
    }
    if (e.kind === "tool") {
      const p = parent >= 0 ? parent : turn;
      const s = span(t, p >= 0 ? out[p].depth + 1 : depth, K_TOOL, toolName(e), toolArg(e), src, i, p);
      s.id = e.id; s.open = true;
      if (e.id) pending.set(e.id, out.length); else anon.push(out.length);
      out.push(s);
    } else if (e.kind === "result") {
      let k = e.id ? pending.get(e.id) ?? -1 : -1;
      if (k >= 0) pending.delete(e.id);
      else if (anon.length) k = anon.shift() ?? -1;
      else if (!e.id) for (const v of pending.values()) { k = v; break; } // no id to go by: the oldest open call
      if (k >= 0) { const s = out[k]; s.t1 = Math.max(s.t0, t); s.open = false; s.err = isErr(e.text) ? 1 : 0; if (s.id) pending.delete(s.id); }
    }
  }
  const end = live ? Math.max(now, last) : last;
  for (const s of out) if (s.src === src && s.open) s.t1 = Math.max(s.t0, end);
  if (turn >= 0 && live) out[turn].t1 = Math.max(out[turn].t1, end);
  closeTurn();
}
// the parent-session span a subagent hangs under: its spawning call by id, else the latest spawn-like call started before it, else the enclosing span
function hostOf(out: Span[], spawn: string, t: number): number {
  if (spawn) for (let i = 0; i < out.length; i++) if (out[i].src === 0 && out[i].id === spawn) return i;
  let best = -1;
  for (let i = 0; i < out.length; i++) { const s = out[i]; if (s.src === 0 && s.kind === K_TOOL && s.cat === 4 && s.t0 <= t + 1000) best = i; }
  if (best >= 0) return best;
  for (let i = 0; i < out.length; i++) { const s = out[i]; if (s.src === 0 && s.t0 <= t && s.t1 >= t && (best < 0 || s.depth >= out[best].depth)) best = i; }
  return best;
}
export function buildGraph(srcs: Src[], now: number): Graph {
  const out: Span[] = [];
  for (let k = 0; k < srcs.length; k++) {
    const sc = srcs[k];
    if (k === 0) { sessionSpans(sc.evs, 0, -1, 0, sc.live, now, out); continue; }
    let a = 0; let z = 0; let first = -1;
    for (let i = 0; i < sc.evs.length; i++) { const t = ms(sc.evs[i].ts); if (!t) continue; if (!a) { a = t; first = i; } z = t; }
    if (!a) continue;
    if (sc.live) z = Math.max(z, now);
    const host = hostOf(out, sc.spawn, a);
    const d = host >= 0 ? out[host].depth + 1 : 0;
    const ag = out.length;
    const s = span(a, d, K_AGENT, sc.kind || "subagent", "", k, first, host);
    s.t1 = z; s.open = sc.live;
    if (z <= a && host >= 0) { s.t0 = out[host].t0; s.t1 = Math.max(out[host].t1, s.t0); s.est = true; } // no timing: fill the spawning call
    out.push(s);
    sessionSpans(sc.evs, k, ag, d + 1, sc.live, now, out);
    spread(out, ag);
  }
  let t0 = 0; let t1 = 0;
  for (const s of out) { if (!t0 || s.t0 < t0) t0 = s.t0; if (s.t1 > t1) t1 = s.t1; }
  let noTiming = false;
  if (out.length && t1 <= t0) { // nothing timed at all: one unit per turn, tools spread inside
    noTiming = true;
    let n = 0;
    for (let i = 0; i < out.length; i++) if (out[i].parent < 0) { out[i].t0 = t0 + n * 1000; out[i].t1 = out[i].t0 + 1000; n++; spread(out, i); }
    t1 = t0 + Math.max(1, n) * 1000;
  }
  return { spans: out, rows: lanes(out), t0, t1, noTiming };
}
// greedy lane packing per depth: overlapping siblings (parallel tool calls) get stacked rows
function lanes(out: Span[]): Span[][] {
  let maxD = 0; for (const s of out) if (s.depth > maxD) maxD = s.depth;
  const rows: Span[][] = [];
  for (let d = 0; d <= maxD; d++) {
    const idx: Span[] = [];
    for (let i = 0; i < out.length; i++) if (out[i].depth === d) { out[i].ix = i; idx.push(out[i]); }
    idx.sort((a, b) => a.t0 - b.t0);
    const ends: number[] = []; const base = rows.length;
    for (const s of idx) {
      let l = 0;
      while (l < ends.length && numOf(ends, l) > s.t0) l++;
      if (l === ends.length) { ends.push(0); rows.push([]); }
      ends[l] = Math.max(s.t1, s.t0 + 1);
      s.row = base + l;
      for (const r of rows.slice(base + l, base + l + 1)) r.push(s);
    }
  }
  return rows;
}
function numOf(a: number[], i: number): number { let v = 0; for (const x of a.slice(i, i + 1)) v = x; return v; }

// ── skill lanes (skill-usage §6.2): each load a band from load to unload (open: to end) on lanes under the turns, one lane
// per concurrently open skill, at most max; the loads that find no lane are counted in more. skillVis: the marks come from
// marksOf (view.ts), their labels already the shown names, omitted skills not among them ──
export interface Band { t0: number; t1: number; label: string; open: boolean; ref: string }
export function skillLanes(marks: Mark[], end: number, max: number): { lanes: Band[][]; more: number } {
  const lanes: Band[][] = []; const ends: number[] = []; let more = 0;
  for (const m of marks) {
    if (m.kind !== "skill:load" || m.t0 <= 0) continue;
    const t1 = m.t1 > 0 ? Math.max(m.t0, m.t1) : Math.max(m.t0, end);
    let l = 0; while (l < ends.length && numOf(ends, l) > m.t0) l++;
    if (l >= max) { more++; continue; }
    if (l === ends.length) { ends.push(0); lanes.push([]); }
    ends[l] = t1;
    for (const r of lanes.slice(l, l + 1)) r.push({ t0: m.t0, t1, label: m.label, open: m.t1 < 0, ref: m.ref });
  }
  return { lanes, more };
}
// the call tree's skills row: per skill its loads (count) and time in context (total, max); kids by name
export const SKILL_ROW = "✧ skills";
export function skillAgg(marks: Mark[], end: number): Agg | null {
  const top: Agg = { name: SKILL_ROW, total: 0, self: 0, count: 0, max: -1, err: 0, best: -1, agent: false, kids: [] };
  for (const m of marks) {
    if (m.kind !== "skill:load" || m.t0 <= 0) continue;
    const d = Math.max(0, (m.t1 > 0 ? m.t1 : Math.max(m.t0, end)) - m.t0);
    let ki = -1; for (let i = 0; i < top.kids.length; i++) if (top.kids[i].name === "✧ " + m.label) ki = i;
    if (ki < 0) { ki = top.kids.length; top.kids.push({ name: "✧ " + m.label, total: 0, self: 0, count: 0, max: -1, err: 0, best: -1, agent: false, kids: [] }); }
    for (const a of [top, top.kids[ki]]) { a.total = a.total + d; a.self = a.self + d; a.count++; if (d > a.max) a.max = d; }
  }
  return top.count ? top : null;
}

// ── aggregates ──────────────────────────────────────────────────────────────
export interface Agg { name: string; total: number; self: number; count: number; max: number; err: number; best: number; agent: boolean; kids: Agg[] }
function aggAdd(list: Agg[], name: string, agent: boolean, s: Span, i: number, self: number): Agg {
  let a: Agg | null = null;
  for (const x of list) if (x.name === name) a = x;
  if (!a) { a = { name, total: 0, self: 0, count: 0, max: -1, err: 0, best: -1, agent, kids: [] }; list.push(a); }
  const d = s.t1 - s.t0;
  a.total = a.total + d; a.self = a.self + self; a.count++;
  if (s.err > 0) a.err++;
  if (d > a.max) { a.max = d; a.best = i; }
  return a;
}
// call tree roots: the session's own tools by name, and one row per subagent type whose kids are the tools run inside those
// subagents; hide[i] (an event-kind filter's hidden spans): those go into one "┄ n hidden" root instead (null = none hidden)
export const HIDDEN_ROW = "┄ hidden";
export function aggregate(g: Graph, hide: boolean[] | null = null): Agg[] {
  const kidDur: number[] = [];
  for (let i = 0; i < g.spans.length; i++) kidDur.push(0);
  for (const s of g.spans) if (s.parent >= 0 && s.parent < kidDur.length) kidDur[s.parent] = numOf(kidDur, s.parent) + (s.t1 - s.t0);
  const roots: Agg[] = [];
  const hid = (i: number): boolean => hide !== null && i < hide.length && hide[i] === true;
  for (let i = 0; i < g.spans.length; i++) {
    const s = g.spans[i];
    const self = Math.max(0, s.t1 - s.t0 - numOf(kidDur, i));
    if (s.kind !== K_TURN && hid(i)) { aggAdd(roots, HIDDEN_ROW, false, s, i, self); continue; }
    if (s.kind === K_TOOL && s.src === 0) aggAdd(roots, s.name, false, s, i, self);
    else if (s.kind === K_AGENT) aggAdd(roots, "⑂ " + s.name, true, s, i, self);
  }
  for (let i = 0; i < g.spans.length; i++) {
    const s = g.spans[i];
    if (s.kind !== K_TOOL || s.src === 0 || s.parent < 0 || s.parent >= g.spans.length || hid(i)) continue;
    const ag = g.spans[s.parent];
    for (const r of roots) if (r.agent && r.name === "⑂ " + ag.name) aggAdd(r.kids, s.name, false, s, i, Math.max(0, s.t1 - s.t0 - numOf(kidDur, i)));
  }
  return roots;
}
export const SORTS = ["total", "self", "count", "avg", "max", "errors", "name"];
export function sortAggs(list: Agg[], by: number): void {
  const key = (a: Agg): number => by === 0 ? a.total : by === 1 ? a.self : by === 2 ? a.count : by === 3 ? a.total / Math.max(1, a.count) : by === 4 ? a.max : a.err;
  if (by === 6) list.sort((a, b) => a.name.localeCompare(b.name));
  else list.sort((a, b) => key(b) - key(a) || b.total - a.total);
  const k = list.findIndex((a: Agg) => a.name === SKILL_ROW); if (k >= 0) { const x = list.splice(k, 1); for (const a of x) list.push(a); } // skills after the calls
  const h = list.findIndex((a: Agg) => a.name.startsWith("┄")); if (h >= 0) { const x = list.splice(h, 1); for (const a of x) list.push(a); } // hidden calls last
  for (const a of list) sortAggs(a.kids, by);
}
export interface Summary { wall: number; active: number; turns: number; tools: number; agents: number; longest: number }
export function summary(g: Graph): Summary {
  const iv: number[][] = [];
  let turns = 0; let tools = 0; let agents = 0; let longest = -1; let ld = -1;
  for (let i = 0; i < g.spans.length; i++) {
    const s = g.spans[i];
    if (s.kind === K_TURN) { turns++; continue; }
    if (s.kind === K_TOOL) tools++; else agents++;
    iv.push([s.t0, s.t1]);
    if (s.t1 - s.t0 > ld) { ld = s.t1 - s.t0; longest = i; }
  }
  iv.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  let active = 0; let a = 0; let z = -1;
  for (const v of iv) { // union of tool/agent intervals
    const x = v[0] ?? 0; const y = v[1] ?? 0;
    if (x > z) { if (z > a) active += z - a; a = x; z = y; } else if (y > z) z = y;
  }
  if (z > a) active += z - a;
  return { wall: g.t1 - g.t0, active, turns, tools, agents, longest };
}
export function dur(v: number): string {
  if (v < 1000) return Math.round(v) + "ms";
  if (v < 60000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + "s";
  const s = Math.round(v / 1000);
  if (s < 3600) return Math.floor(s / 60) + "m" + String(s % 60).padStart(2, "0") + "s";
  return Math.floor(s / 3600) + "h" + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + "m";
}
