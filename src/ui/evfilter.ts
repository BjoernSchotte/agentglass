// agentglass — the one event-kind filter for every event view (skill-usage §5a): transcript (and replay), call graph,
// related events, the Wait tab and the preview's recent events ask it which events show; it holds the state per view (or
// one shared state when linked, L), presets, solo (i), invert (!), the K chip bar, persistence and the f= of deep links
// SPDX-License-Identifier: Apache-2.0
// The filter is a filter-language expression over event clauses (event.kind, mcp.server, shell.family, call clauses);
// chips, presets and solo write that expression, so chips and text are one state. Pinned event clauses (P) apply in every
// view. Masks are computed once per (state, events array, its length, its kinds) — a linear pass, never a log read.
import { readFileSync, openSync, writeSync, closeSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Ev, Sess } from "../model/types.ts";
import { type Mark, famOf, markKind } from "../model/marks.ts";
import { kindIds, kindPairs, kindVer, kindSet, kindSets, kindsIn, famsIn, kindsOfFam, specific } from "../model/kinds.ts";
import { S, say } from "../state.ts";
import { section } from "../util/config.ts";
import { parse, printClause } from "../features/query/parse.ts";
import type { Clause } from "../features/query/types.ts";
import { attrOf } from "../features/query/attrs.ts";
import { type Compiled, type EvX, compile, evxOf } from "../features/query/eval.ts";
import { RUN_DIR, myUid, secureDir } from "../features/palette/rundir.ts";
import { OS } from "../platform/index.ts";
import { type Chip, chipLine } from "./chips.ts";

// the views with a filter of their own (the preview's recent events follow "preview"; replay plays the transcript's)
export const VIEWS = ["transcript", "callgraph", "related", "wait", "preview"];
export const VIEW_NAMES: { [k: string]: string } = { transcript: "transcript", callgraph: "call graph", related: "related events", wait: "Wait", preview: "preview" };
// flag: what a preset adds to its expression's events — causes (the reply right before each failing call), outcomes
// (the last reply of each turn)
export interface Preset { key: string; name: string; expr: string; flag: string }
export const PRESETS: Preset[] = [
  { key: "1", name: "all events", expr: "", flag: "" },
  { key: "2", name: "skills only", expr: "event.kind is skill", flag: "" },
  { key: "3", name: "MCP only", expr: "event.kind is mcp", flag: "" },
  { key: "4", name: "shell only", expr: "event.kind is shell", flag: "" },
  { key: "5", name: "errors + causes", expr: "event.kind is error", flag: "causes" },
  { key: "6", name: "my prompts + outcomes", expr: "event.kind is_one_of prompt error", flag: "outcomes" },
];
// expr: the expression ("" = no filter); err / errCol: the last refused text's problem (the filter stays the old one);
// inv: shown ⇄ hidden; solo: the kind i solos ("" none); preset: the index of the preset that wrote expr (-1 none)
export interface VF { expr: string; f: Compiled | null; err: string; errCol: number; inv: boolean; solo: string; preset: number; flag: string; ver: number }
function newVF(): VF { return { expr: "", f: null, err: "", errCol: -1, inv: false, solo: "", preset: -1, flag: "", ver: 0 }; }
const ST = { per: new Map<string, VF>(), shared: newVF(), link: false, loaded: false, ver: 0, dirty: 0, saved: "" };
export const VF_STORE = { path: "", remember: true }; // checks point the file elsewhere
// the match count each view shows in the footer ("3 of 412"), registered by the view
interface VCount { view: string; f: () => string }
const COUNTS: VCount[] = [];
export function setCount(view: string, f: () => string): void { for (const c of COUNTS) if (c.view === view) { c.f = f; return; } COUNTS.push({ view, f }); }
export function hasCount(view: string): boolean { for (const c of COUNTS) if (c.view === view) return true; return false; }
export function countText(view: string): string { for (const c of COUNTS) if (c.view === view) { const f = c.f; return f(); } return ""; }

export function linked(): boolean { load(); return ST.link; }
export function setLinked(on: boolean): void {
  load(); if (ST.link === on) return;
  if (on) { const t = ST.per.get("transcript"); ST.shared = cloneVF(t ? t : newVF()); } // the transcript's filter becomes everyone's
  ST.link = on; ST.ver++; ST.dirty = Date.now();
}
function cloneVF(v: VF): VF { return { expr: v.expr, f: v.f, err: "", errCol: -1, inv: v.inv, solo: v.solo, preset: v.preset, flag: v.flag, ver: v.ver }; }
export function vfOf(view: string): VF {
  load();
  if (ST.link) return ST.shared;
  const hit = ST.per.get(view); if (hit !== undefined) return hit;
  const v = newVF(); ST.per.set(view, v); return v;
}
// a changed state written back: scriptc 0.1.7 may hand a VF out of the map as a copy, so every change is stored again
function keep(view: string, v: VF): void { if (ST.link) ST.shared = v; else ST.per.set(view, v); ST.ver++; ST.dirty = Date.now(); }
// is any filter on in this view (its own, or a pinned event clause)?
export function active(view: string): boolean { const v = vfOf(view); return v.expr !== "" || v.inv || pinnedEv().length > 0; }

// ── the expression ──
// the pinned event clauses (P): they apply in every event view, on top of the view's own filter
function pinnedEv(): Clause[] { const o: Clause[] = []; for (const c of S.pins) { const a = attrOf(c.key); if (a && a.ent === "event") o.push(c); } return o; }
const CMEMO = { key: "", f: null as Compiled | null };
// the view's filter compiled with the pins' event clauses (null = none)
export function compiledOf(view: string): Compiled | null {
  const v = vfOf(view); const pins = pinnedEv();
  if (!v.f && !pins.length) return null;
  const key = v.expr + "\u0001" + pins.map(printClause).join(" and ");
  if (CMEMO.key === key) return CMEMO.f;
  const cs: Clause[] = []; if (v.f) for (const c of v.f.cs) cs.push(c); for (const c of pins) cs.push(c);
  const r = compile(cs, "events"); CMEMO.key = key; CMEMO.f = r.f;
  return r.f;
}
// set a view's expression; a bad one leaves the filter as it was and returns the problem (caret column in errCol)
export function vfSet(view: string, expr: string): string { return setExpr(view, expr, -1, "", ""); }
function setExpr(view: string, expr: string, pi: number, fl: string, so: string): string {
  const v = vfOf(view); const t = expr.trim();
  if (!t) { v.expr = ""; v.f = null; v.err = ""; v.errCol = -1; v.preset = pi; v.flag = fl; v.solo = so; v.ver++; keep(view, v); return ""; }
  const p = parse(t);
  if (p.err) { v.err = p.err.msg; v.errCol = p.err.col; keep(view, v); return p.err.msg; }
  const r = compile(p.cs, "events");
  if (r.err || !r.f) { v.err = r.err ? r.err.msg : "invalid filter"; v.errCol = r.err ? r.err.col : -1; keep(view, v); return v.err; }
  const ps: string[] = []; for (const c of p.cs) ps.push(printClause(c));
  v.expr = ps.join(" and "); v.f = r.f; v.err = ""; v.errCol = -1; v.preset = pi; v.flag = fl; v.solo = so; v.ver++;
  keep(view, v);
  return "";
}
export function vfClear(view: string): void { setInv(view, false); setExpr(view, "", -1, "", ""); }
function setInv(view: string, on: boolean): void { const v = vfOf(view); v.inv = on; v.ver++; keep(view, v); }
export function invert(view: string): void { setInv(view, !vfOf(view).inv); }
export function preset(view: string, i: number): void { const p = PRESETS[i]; if (!p) return; setInv(view, false); setExpr(view, p.expr, i, p.flag, ""); }
// i: the most specific kind of event i → its family → no filter (a solo of another kind starts over at that kind)
export function solo(view: string, s: Sess, evs: Ev[], i: number): string {
  if (i < 0 || i >= evs.length) return "";
  return soloKinds(view, kindSet(kindIds(s, evs)[i] + 0));
}
export function soloKinds(view: string, kinds: string[]): string {
  const v = vfOf(view);
  const k = specific(kinds);
  if (!k) return "";
  const fam = famOf(k);
  const want = v.solo !== k && v.solo !== fam ? k : v.solo === k && k !== fam ? fam : "";
  setInv(view, false);
  setExpr(view, want ? "event.kind is " + want : "", -1, "", want);
  return want;
}

// ── one event against the filter ──
// a single event (or a row of a view without an events array: related, Wait) as EvX; inv applied, preset flags not
export function test(view: string, s: Sess, x: EvX): boolean {
  const f = compiledOf(view); const v = vfOf(view);
  if (!f) return !v.inv;
  let ok = true; for (const p of f.sess) if (!p(s)) { ok = false; break; }
  if (ok) for (const p of f.ev) if (!p(s, x)) { ok = false; break; }
  return ok !== v.inv;
}
export function shownMark(view: string, s: Sess, m: Mark): boolean { return test(view, s, { raw: "meta", kinds: [m.kind], tool: "", args: "", server: "", fam: "", err: -1 }); }
// does the filter decide by kinds alone (and raw kind)? then one evaluation per kind set does for every event
function kindOnly(f: Compiled): boolean {
  if (f.sess.length) return false;
  for (const c of f.cs) { const a = attrOf(c.key); if (!a || a.ent !== "event" || a.key === "mcp.server" || a.key === "shell.family") return false; }
  return true;
}
// the raw kind's slot (0–6) in the per-(kind set, raw kind) cache
function rawIx(k: string): number { return k === "tool" ? 0 : k === "result" ? 1 : k === "assistant" ? 2 : k === "user" ? 3 : k === "thinking" ? 4 : k === "meta" ? 5 : 6; }
interface MaskMemo { view: string; evs: Ev[]; n: number; kv: number; key: string; m: Uint8Array; shown: number }
const MASKS: MaskMemo[] = []; const MASK_MAX = 12;
export const MASK_STATS = { built: 0 };
// the filter's state in one string: a layout over it is stale when it changes
export function fstate(view: string): string { return stateKey(view); }
function stateKey(view: string): string { const v = vfOf(view); return String(ST.link) + "|" + v.expr + "|" + String(v.inv) + "|" + v.flag + "|" + (pinnedEv().length ? pinnedEv().map(printClause).join(" and ") : ""); }
// 1 = shown, per event of evs (index i = evs[i]); no filter: all shown
export function mask(view: string, s: Sess, evs: Ev[]): Uint8Array {
  const ids = kindIds(s, evs); const kv = kindVer(evs); const key = stateKey(view);
  for (const x of MASKS) if (x.view === view && x.evs === evs && x.n === evs.length && x.kv === kv && x.key === key) return x.m;
  MASK_STATS.built++;
  const n = evs.length; const m = new Uint8Array(n);
  const f = compiledOf(view); const v = vfOf(view);
  if (!f) { if (!v.inv) for (let i = 0; i < n; i++) m[i] = 1; }
  else {
    // (kind set, raw kind) → 0 unknown, 1 shown, 2 hidden; a filter that reads the call (its name, server, family) also by
    // the call's interned text: (text, kind set, raw kind) → shown, so repeated commands are judged once
    const fast = kindOnly(f); const nk = kindSets(); const per = new Uint8Array(nk * 8);
    const need = needs(f); const pp = kindPairs(s, evs); const byText = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const e = evs[i]; const id = ids[i] + 0; const ri = rawIx(e.kind);
      let hit = false;
      const t = fast || (e.kind !== "tool" && e.kind !== "result") ? -2 : pp.tid[i] + 0;
      if (t === -2) { // decided by its kinds and raw kind alone: once per pair
        const k = id * 8 + ri;
        const c = k < per.length ? per[k] + 0 : 0;
        if (c !== 0) hit = c === 1;
        else { hit = evalOne(f, s, evs, i, id, pp.pair, need); if (k < per.length) per[k] = hit ? 1 : 2; }
      } else if (t < 0) hit = evalOne(f, s, evs, i, id, pp.pair, need); // a result without its call
      else {
        const k = (t * nk + id) * 8 + ri; const c = byText.get(k);
        if (c !== undefined) hit = c === 1;
        else { hit = evalOne(f, s, evs, i, id, pp.pair, need); byText.set(k, hit ? 1 : 0); }
      }
      if (hit) m[i] = 1;
    }
    if (v.flag === "causes") causes(evs, ids, m);
    if (v.flag === "outcomes") outcomes(evs, m);
    if (v.inv) for (let i = 0; i < n; i++) m[i] = m[i] + 0 === 1 ? 0 : 1;
  }
  let sh = 0; for (let i = 0; i < n; i++) sh += m[i] + 0;
  for (let j = MASKS.length - 1; j >= 0; j--) { const x = MASKS[j]; if (x.view === view && x.evs === evs) MASKS.splice(j, 1); } // one per view and array
  if (MASKS.length >= MASK_MAX) MASKS.shift();
  MASKS.push({ view, evs, n, kv, key, m, shown: sh });
  return m;
}
// which per-event values the filter reads beyond kinds: 1 the call's name and arguments, 2 its MCP server, 4 its shell family
function needs(f: Compiled): number {
  let n = 0;
  for (const c of f.cs) { const a = attrOf(c.key); if (!a) continue; if (a.key === "mcp.server") n |= 3; else if (a.key === "shell.family") n |= 5; else if (a.ent === "call") n |= 1; }
  return n;
}
function evalOne(f: Compiled, s: Sess, evs: Ev[], i: number, id: number, pair: Int32Array, need: number): boolean {
  const e = evs[i]; const j = pair[i] + 0; const call: Ev | null = e.kind === "result" && j >= 0 && j < evs.length ? evs[j] : null;
  const ks = kindSet(id);
  const x: EvX = need === 0 ? { raw: e.kind, kinds: ks, tool: "", args: "", server: "", fam: "", err: ks.indexOf("error") >= 0 ? 1 : e.kind === "result" ? 0 : -1 } : evxOf(e, call, ks, need);
  for (const p of f.ev) if (!p(s, x)) return false;
  return true;
}
// errors + causes: every shown failing call also shows the reply the agent wrote right before it (its reasoning: text,
// or thinking where the harness logs only that, e.g. Gemini), in the same turn
function causes(evs: Ev[], ids: Int32Array, m: Uint8Array): void {
  for (let i = 0; i < evs.length; i++) {
    if (m[i] + 0 !== 1 || evs[i].kind !== "tool" || kindSet(ids[i] + 0).indexOf("error") < 0) continue;
    for (let j = i - 1; j >= 0; j--) { const k = evs[j].kind; if (k === "user") break; if (k === "assistant" || k === "thinking") { m[j] = 1; break; } }
  }
}
// prompts + outcomes: the last reply of each turn (before the next prompt, or the end)
function outcomes(evs: Ev[], m: Uint8Array): void {
  let last = -1;
  for (let i = 0; i < evs.length; i++) {
    const k = evs[i].kind;
    if (k === "user") { if (last >= 0) m[last] = 1; last = -1; }
    else if (k === "assistant") last = i;
  }
  if (last >= 0) m[last] = 1;
}
// a view that lets go of evs drops their masks too
export function forgetMasks(evs: Ev[]): void { for (let j = MASKS.length - 1; j >= 0; j--) if (MASKS[j].evs === evs) MASKS.splice(j, 1); }
export function shown(view: string, s: Sess, evs: Ev[], i: number): boolean { if (i < 0 || i >= evs.length) return false; return mask(view, s, evs)[i] + 0 === 1; }
// shown / total over evs
export function matchCount(view: string, s: Sess, evs: Ev[]): { shown: number; total: number } {
  mask(view, s, evs);
  for (const x of MASKS) if (x.view === view && x.evs === evs && x.n === evs.length) return { shown: x.shown, total: x.n };
  return { shown: evs.length, total: evs.length };
}
// the runs of hidden events in [from, to): first index, how many, their families with counts (most first)
export interface Gap { i: number; hidden: number; kinds: Map<string, number> }
export function runs(view: string, s: Sess, evs: Ev[], from: number, to: number): Gap[] {
  const m = mask(view, s, evs); const ids = kindIds(s, evs); const out: Gap[] = [];
  let cur: Gap | null = null; const per = new Int32Array(kindSets()); const used: number[] = []; // kind-set id → events of the current run
  const close = (): void => { const g = cur; if (!g) return; for (let u = 0; u < used.length; u++) { const id = (used[u] ?? 0) + 0; const c = per[id] + 0; for (const f of famsOfSet(id)) g.kinds.set(f, (g.kinds.get(f) ?? 0) + c); per[id] = 0; } used.length = 0; cur = null; };
  for (let i = Math.max(0, from); i < Math.min(to, evs.length); i++) {
    if (m[i] + 0 === 1) { close(); continue; }
    if (!cur) { cur = { i, hidden: 0, kinds: new Map<string, number>() }; out.push(cur); }
    cur.hidden++;
    const id = ids[i] + 0; if (id < per.length) { if (per[id] + 0 === 0) used.push(id); per[id] = per[id] + 1; }
  }
  close();
  return out;
}
// the families of a kind set (each once; none = other), per set
interface FamSet { id: number; fs: string[] }
const FAMSETS: FamSet[] = [];
function famsOfSet(id: number): string[] {
  if (id >= 0 && id < FAMSETS.length && FAMSETS[id].id === id) return FAMSETS[id].fs;
  while (FAMSETS.length <= id) FAMSETS.push({ id: -1, fs: [] });
  const fs: string[] = []; for (const k of kindSet(id)) { const f = famOf(k); if (fs.indexOf(f) < 0) fs.push(f); }
  if (!fs.length) fs.push("other");
  FAMSETS[id] = { id, fs };
  return fs;
}
// "┄ 37 hidden · reply 20 · shell 12 · read 5 ┄" (families most first, as many as fit w)
export function gapText(g: Gap, w: number): string {
  const ks: string[] = []; for (const k of g.kinds.keys()) ks.push(k);
  ks.sort((a: string, b: string): number => (g.kinds.get(b) ?? 0) - (g.kinds.get(a) ?? 0) || (a < b ? -1 : 1));
  let t = "┄ " + String(g.hidden) + " hidden";
  for (const k of ks) { const p = " · " + k + " " + String(g.kinds.get(k) ?? 0); if (t.length + p.length + 2 > w) { t += " …"; break; } t += p; }
  return t + " ┄";
}
// ] / [: the next / previous shown event strictly past fromEv; with no filter the next event a mark (skill, debug …) lands
// on; -1 none
export function nextMatch(view: string, s: Sess, evs: Ev[], fromEv: number, dir: number): number {
  const on = active(view);
  const m = mask(view, s, evs); const ids = on ? null : kindIds(s, evs);
  for (let i = fromEv + dir; i >= 0 && i < evs.length; i += dir) {
    if (on) { if (m[i] + 0 === 1) return i; continue; }
    if (ids) for (const k of kindSet(ids[i] + 0)) if (markKind(famOf(k)) !== null) return i;
  }
  return -1;
}

// ── wording ──
// the filter in a few words: "skills only", "mcp:github only", "not shell only", "filter" (a typed expression)
export function label(view: string): string {
  const v = vfOf(view);
  let l = v.preset > 0 ? PRESETS[v.preset]?.name ?? "filter" : v.solo ? v.solo + " only" : "";
  if (!l && v.expr) { const m = /^event\.kind is ([a-z0-9:._@/-]+)$/.exec(v.expr); l = m ? (m[1] ?? "") + " only" : v.expr.length <= 24 ? v.expr : "filter"; }
  if (!l && pinnedEv().length) l = "pinned";
  if (!l) l = "all events";
  return (v.inv ? "not " : "") + l;
}
// the empty state: "no skill events in this session — esc clears the filter, K changes it"
export function emptyText(view: string, where: string = "session"): string {
  const v = vfOf(view);
  const m = /^event\.kind is(?:_one_of)? (.+)$/.exec(v.expr);
  const what = v.inv ? "events outside " + (m ? m[1] ?? "" : "the filter") : m ? (m[1] ?? "").split(" ").join(" or ") : "matching";
  return "no " + what + " events in this " + where + " — esc clears the filter, K changes it";
}

// ── the chip bar (K) ──
// kinds: the counts of the kinds in the view (events, related rows, Wait rows) while the bar is open
const BAR = { view: "", open: false, cur: 0, fam: "", kinds: (): Map<string, number> => new Map<string, number>() };
export function barOpen(view: string): boolean { return BAR.open && BAR.view === view; }
export function openBar(view: string, kinds: () => Map<string, number>): void { BAR.view = view; BAR.open = true; BAR.cur = 0; BAR.fam = ""; BAR.kinds = kinds; }
export function closeBar(): void { BAR.open = false; BAR.fam = ""; }
export function barView(): string { return BAR.open ? BAR.view : ""; }
export function barKinds(): Map<string, number> { const f = BAR.kinds; return f(); }
// the footer while the bar is open: only its keys (ui/footer.ts)
export function barHints(): string[][] { return [["←→", "move"], ["␣", "show/hide"], ["↵", BAR.fam ? "—" : "kinds"], ["!", "invert"], ["1-6", "presets"], ["L", "link"], ["esc", BAR.fam ? "families" : "close"]]; }
// the kinds the expression shows when it is a plain chip clause (event.kind is / is_one_of …), null = everything, [] = the
// expression is something else (typed)
function chipSel(v: VF): string[] | null {
  if (!v.expr) return null;
  const p = parse(v.expr); if (p.err || p.cs.length !== 1) return [];
  const c = p.cs[0]; if (c.key !== "event.kind" || c.neg || (c.op !== "is" && c.op !== "is_one_of")) return [];
  return c.vals.slice();
}
function chipOn(sel: string[] | null, k: string): boolean { if (!sel) return true; for (const x of sel) if (x === k || (x.indexOf(":") < 0 && famOf(k) === x)) return true; return false; }
function chipsOf(view: string, m: Map<string, number>): Chip[] {
  const sel = chipSel(vfOf(view)); const o: Chip[] = [];
  const names = BAR.fam ? kindsOfFam(m, BAR.fam) : famsIn(m);
  for (const k of names) o.push({ name: k, n: m.get(k) ?? 0, on: sel !== null && !sel.length ? false : chipOn(sel, k) });
  return o;
}
export function chipBar(view: string, m: Map<string, number>, w: number): string {
  const cs = chipsOf(view, m); BAR.cur = Math.max(0, Math.min(BAR.cur, cs.length - 1));
  return chipLine(cs, BAR.cur, w, BAR.fam, vfOf(view).inv);
}
// ␣ on a chip: show / hide that family (or kind); the expression becomes the chips' clause
function toggle(view: string, m: Map<string, number>, k: string): void {
  const fams = famsIn(m); const v = vfOf(view);
  let sel = chipSel(v);
  if (sel !== null && !sel.length) { say("info", "the typed filter was replaced by the chips"); sel = null; }
  const cur: string[] = sel ? sel.slice() : fams.slice();
  const on = chipOn(sel, k); let next: string[] = [];
  if (on) {
    const fam = famOf(k);
    for (const x of cur) {
      if (x === k || (k.indexOf(":") < 0 && famOf(x) === k)) continue; // the family and its kinds off
      if (k.indexOf(":") > 0 && x === fam) { for (const y of kindsOfFam(m, fam)) if (y !== k) next.push(y); continue; } // one kind off: its siblings stay
      next.push(x);
    }
  } else {
    next = cur.slice(); next.push(k);
    const fam = famOf(k); const sib = kindsOfFam(m, fam);
    if (k !== fam && sib.length && sib.every((y: string): boolean => next.indexOf(y) >= 0)) next = next.filter((y: string): boolean => famOf(y) !== fam).concat([fam]); // all its kinds: the family
  }
  if (!next.length) { say("info", "at least one kind stays shown — ! inverts the filter"); return; }
  let all = true; for (const f of fams) if (next.indexOf(f) < 0) all = false;
  if (all) setInv(view, false);
  setExpr(view, all ? "" : next.length === 1 ? "event.kind is " + next[0] : "event.kind is_one_of " + next.join(" "), -1, "", "");
}
// a key while the bar is open: true = taken (every key is, but ? and ctrl-c)
export function chipKey(view: string, m: Map<string, number>, k: string): boolean {
  if (k === "?" || k === "ctrl-c") return false;
  const cs = chipsOf(view, m);
  if (k === "esc" || k === "K" || k === "q") { if (BAR.fam && k === "esc") { BAR.cur = Math.max(0, famsIn(m).indexOf(BAR.fam)); BAR.fam = ""; } else closeBar(); return true; }
  if (k === "left" || k === "h") BAR.cur = Math.max(0, BAR.cur - 1);
  else if (k === "right" || k === "l") BAR.cur = Math.min(Math.max(0, cs.length - 1), BAR.cur + 1);
  else if (k === "home" || k === "g") BAR.cur = 0;
  else if (k === "end" || k === "G") BAR.cur = Math.max(0, cs.length - 1);
  else if (k === " ") { const c = cs[BAR.cur]; if (c) toggle(view, m, c.name); }
  else if (k === "enter" || k === "down") { const c = cs[BAR.cur]; if (c && !BAR.fam && kindsOfFam(m, c.name).length) { BAR.fam = c.name; BAR.cur = 0; } else if (c && k === "enter" && !BAR.fam) say("info", c.name + " has no kinds below it"); }
  else if (k === "up" || k === "backspace" || k === "bs") { if (BAR.fam) { BAR.cur = Math.max(0, famsIn(m).indexOf(BAR.fam)); BAR.fam = ""; } }
  else if (k === "!") invert(view);
  else if (k === "L") { setLinked(!linked()); say("info", linked() ? "one filter in all event views (L again: per view)" : "a filter per view"); }
  else if (k.length === 1 && "123456".indexOf(k) >= 0) { preset(view, Number(k) - 1); say("info", PRESETS[Number(k) - 1]?.name ?? ""); }
  return true;
}

// ── keys shared by every event view ──
// K chips (kinds: the view's kind counts), i solo (cur: the kinds under the cursor), ! invert, ] [ next / previous match
// (next(dir): the view's next matching position), esc clear (when a filter is on), / the expression, L link.
// Returns next()'s position for ] [, -1 = handled without a move, -2 = not a filter key
export function filterKey(view: string, k: string, kinds: () => Map<string, number>, cur: string[], next: (dir: number) => number): number {
  if (barOpen(view)) return chipKey(view, kinds(), k) ? -1 : -2;
  if (k === "K") { openBar(view, kinds); return -1; }
  if (k === "i") { const w = soloKinds(view, cur); say("info", w ? "only " + w + " — i again widens, a third time clears" : "all events"); return -1; }
  if (k === "!") { invert(view); say("info", vfOf(view).inv ? "inverted: " + label(view) : label(view)); return -1; }
  if (k === "L") { setLinked(!linked()); say("info", linked() ? "one filter in all event views (L again: per view)" : "a filter per view"); return -1; }
  if (k === "/") { openInput(view); return -1; }
  if (k === "]" || k === "[") {
    const d = k === "]" ? 1 : -1; const j = next(d);
    if (j < 0) say("info", active(view) ? "no " + (d > 0 ? "later" : "earlier") + " match" : "no " + (d > 0 ? "later" : "earlier") + " mark — K filters events, then ] [ step through them");
    return j < 0 ? -1 : j;
  }
  if (k === "esc" && (vfOf(view).expr || vfOf(view).inv)) { vfClear(view); say("info", "event filter cleared — esc again goes back"); return -1; }
  return -2;
}
// filterKey over an events array (transcript, call graph): cur = the cursor's event
export function viewKey(view: string, s: Sess, evs: Ev[], cur: number, k: string): number {
  const ck = cur >= 0 && cur < evs.length ? kindSet(kindIds(s, evs)[cur] + 0) : [];
  return filterKey(view, k, (): Map<string, number> => kindsIn(s, evs), ck, (d: number): number => nextMatch(view, s, evs, cur, d));
}
// the expression input (/): completion and carets from the filter language, the chips' clause as the starting text
export const INPUT = { view: "", kinds: [] as string[] };
export function openInput(view: string): void {
  INPUT.view = view;
  S.inputErr = ""; S.inputErrCol = -1;
  S.prevMode = S.mode === "input" ? S.prevMode : S.mode; S.mode = "input";
  S.inputLabel = "filter " + (VIEW_NAMES[view] ?? view) + " (event.kind is skill · mcp.server is github · shell.family ~ test)";
  S.inputAction = "evfilter"; S.inputText = vfOf(view).expr;
}

// ── persistence: ~/.agentglass/run/viewfilters.json (0600), written 1 s after the last change; config filter.remember
// false = never read or written ──
interface Saved { expr: string; inv: boolean; preset: number; flag: string; solo: string }
function filePath(): string { return VF_STORE.path || join(RUN_DIR, "viewfilters.json"); }
function remember(): boolean { if (VF_STORE.path) return VF_STORE.remember; return section("filter")["remember"] !== false; }
function load(): void {
  if (ST.loaded) return;
  ST.loaded = true;
  if (!remember()) return;
  let txt = ""; try { txt = readFileSync(filePath(), "utf8"); } catch (e) { return; }
  let o: unknown = null; try { o = JSON.parse(txt); } catch (e) { return; }
  if (!o || typeof o !== "object") return;
  const r = o as { [k: string]: unknown };
  const put = (v: VF, x: unknown): void => {
    if (!x || typeof x !== "object") return;
    const y = x as { [k: string]: unknown };
    const ex = typeof y["expr"] === "string" ? String(y["expr"]) : "";
    if (ex) { const p = parse(ex); const c = p.err ? null : compile(p.cs, "events"); if (c && c.f) { v.expr = ex; v.f = c.f; } } // a filter that no longer parses is dropped
    v.inv = y["inv"] === true; v.flag = y["flag"] === "causes" || y["flag"] === "outcomes" ? String(y["flag"]) : "";
    v.preset = typeof y["preset"] === "number" ? Number(y["preset"]) : -1; v.solo = typeof y["solo"] === "string" ? String(y["solo"]) : "";
  };
  const vs = r["views"];
  if (vs && typeof vs === "object") for (const name of VIEWS) { const x = (vs as { [k: string]: unknown })[name]; if (x) { const v = newVF(); put(v, x); ST.per.set(name, v); } }
  put(ST.shared, r["shared"]);
  ST.link = r["link"] === true;
  ST.saved = serialize();
}
function savedOf(v: VF): Saved { return { expr: v.expr, inv: v.inv, preset: v.preset, flag: v.flag, solo: v.solo }; }
function serialize(): string {
  const views: { [k: string]: Saved } = {};
  for (const name of VIEWS) { const v = ST.per.get(name); if (v && (v.expr || v.inv)) views[name] = savedOf(v); }
  return JSON.stringify({ link: ST.link, shared: savedOf(ST.shared), views });
}
// write when a change is older than a second (onTick), or now (quit); false = not written (nothing to do, off, failed)
export function flush(force: boolean): boolean {
  if (!ST.dirty || (!force && Date.now() - ST.dirty < 1000)) return false;
  ST.dirty = 0;
  if (!remember()) return false;
  const txt = serialize(); if (txt === ST.saved) return false;
  const p = filePath();
  if (!VF_STORE.path && secureDir(RUN_DIR, myUid(), (x: string) => OS.fileInfo(x), true)) return false; // an unsafe run dir: not written
  try {
    const tmp = p + "." + String(process.pid) + ".tmp";
    const fd = openSync(tmp, "w"); chmodSync(tmp, 0o600); // before any byte is written
    writeSync(fd, txt + "\n"); closeSync(fd); renameSync(tmp, p); ST.saved = txt; return true;
  } catch (e) { return false; }
}
// checks: forget the state (a fresh run)
export function resetForTest(): void { ST.per.clear(); ST.shared = newVF(); ST.link = false; ST.loaded = false; ST.dirty = 0; ST.saved = ""; BAR.open = false; BAR.fam = ""; MASKS.length = 0; CMEMO.key = ""; }
