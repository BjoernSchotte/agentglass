// agentglass — filter scopes: pinned clauses (all tabs, remembered across runs) and per-tab local clauses (spec §6)
// SPDX-License-Identifier: Apache-2.0
import { S, say } from "../../state.ts";
import { section, setConfig } from "../../util/config.ts";
import { str } from "../../util/json.ts";
import type { Clause, QErr } from "./types.ts";
import { parse, print, printClause, sameClause } from "./parse.ts";
import { attrOf, isNumeric } from "./attrs.ts";

const EQ = ["is", "is_one_of"]; const NE = ["is_not", "is_not_one_of"];
const UP = [">", ">="]; const DOWN = ["<", "<="];
function lowerAll(xs: string[]): string[] { const o: string[] = []; for (const x of xs) o.push(x.toLowerCase()); return o; }
function overlap(a: string[], b: string[]): boolean { const la = lowerAll(a); for (const x of lowerAll(b)) if (la.indexOf(x) >= 0) return true; return false; }
function union(a: string[], b: string[]): string[] { const o = a.slice(); const lo = lowerAll(o); for (const x of b) if (lo.indexOf(x.toLowerCase()) < 0) { o.push(x); lo.push(x.toLowerCase()); } return o; }
function withVals(c: Clause, op: string, vals: string[]): Clause { return { key: c.key, op, vals, neg: c.neg, pinned: c.pinned }; }
// a set of values can be written as is_one_of only for text-like attributes (numbers and booleans have no one_of)
function canUnion(key: string): boolean { const a = attrOf(key); return !!a && !isNumeric(a.type) && a.type !== "bool" && key !== "content"; }

// same-key merge inside one scope (§6.2); note = the toast text, "" when nothing was merged or replaced
export function addClause(scope: Clause[], c: Clause): { cs: Clause[]; note: string } {
  const cs = scope.slice();
  for (const o of cs) if (sameClause(o, c)) return { cs, note: "" }; // duplicate
  for (let i = 0; i < cs.length; i++) {
    const o = cs[i]; if (o.key !== c.key || c.key === "text" || c.key === "content") continue;
    const oe = EQ.indexOf(o.op) >= 0; const ce = EQ.indexOf(c.op) >= 0; const on = NE.indexOf(o.op) >= 0; const cn = NE.indexOf(c.op) >= 0;
    if (oe && ce) {
      if (!canUnion(c.key)) { cs[i] = c; return { cs, note: "replaced: " + printClause(c) }; }
      const vs = union(o.vals, c.vals); const m = withVals(o, vs.length > 1 ? "is_one_of" : "is", vs);
      cs[i] = m; return { cs, note: "merged: " + printClause(m) };
    }
    if (on && cn && canUnion(c.key)) { const vs = union(o.vals, c.vals); const m = withVals(o, vs.length > 1 ? "is_not_one_of" : "is_not", vs); cs[i] = m; return { cs, note: "merged: " + printClause(m) }; }
    if (((oe && cn) || (on && ce)) && overlap(o.vals, c.vals)) { cs[i] = c; return { cs, note: "replaced: " + printClause(c) }; }
    if (o.neg === c.neg && ((UP.indexOf(o.op) >= 0 && UP.indexOf(c.op) >= 0) || (DOWN.indexOf(o.op) >= 0 && DOWN.indexOf(c.op) >= 0))) { cs[i] = c; return { cs, note: "replaced: " + printClause(c) }; }
  }
  cs.push(c);
  return { cs, note: "" };
}
export function addAll(scope: Clause[], add: Clause[]): { cs: Clause[]; notes: string[] } {
  let cs = scope; const notes: string[] = [];
  for (const c of add) { const r = addClause(cs, c); cs = r.cs; if (r.note) notes.push(r.note); }
  return { cs, notes };
}

// pins ∘ local (§6.3): a local equality clause overrides a pinned equality clause on the same key (shown struck)
export interface Eff { cs: Clause[]; struck: Clause[] }
export function effective(pins: Clause[], local: Clause[]): Eff {
  const cs: Clause[] = []; const struck: Clause[] = [];
  for (const p of pins) {
    let over = false;
    if (EQ.indexOf(p.op) >= 0) for (const l of local) if (l.key === p.key && EQ.indexOf(l.op) >= 0) over = true;
    if (over) struck.push(p); else cs.push(p);
  }
  for (const l of local) cs.push(l);
  return { cs, struck };
}

function pinned(cs: Clause[], on: boolean): Clause[] { const o: Clause[] = []; for (const c of cs) o.push({ key: c.key, op: c.op, vals: c.vals, neg: c.neg, pinned: on }); return o; }
const listeners: (() => void)[] = [];
export function onScopeChange(fn: () => void): void { listeners.push(fn); }
function changed(): void { for (const f of listeners) f(); }
export function localFor(tab: string): Clause[] { return S.local.get(tab) ?? []; }
export function setLocal(tab: string, cs: Clause[]): void { S.local.set(tab, pinned(cs, false)); changed(); }

// ── persistence (config filter.pinned; filter.remember false = never saved, a saved value ignored) ──
export interface PinStore { load: () => string; save: (v: string) => void; remember: boolean }
let store: PinStore = { load: () => "", save: (v: string) => {}, remember: false };
function persist(): void { if (store.remember) { const sv = store.save; sv(print(S.pins)); } }
export function chipText(cs: Clause[]): string { const o: string[] = []; for (const c of cs) o.push(printClause(c)); return o.join(" · "); }
// restores the saved pins; returns the start toast ("" when nothing was restored)
export function initPins(st: PinStore): string {
  store = st; S.pins = [];
  if (!st.remember) return "";
  const ld = st.load; const saved = ld().trim(); if (!saved) return "";
  const p = parse(saved);
  if (p.err) return "saved pinned filter dropped: " + p.err.msg;
  S.pins = pinned(addAll([], p.cs).cs, true); changed();
  return "pinned: " + chipText(S.pins) + " — P edits, P then enter on empty unpins";
}
// `P` editor result: "" unpins all
export function setPins(expr: string): QErr | null {
  const p = parse(expr);
  if (p.err) return p.err;
  S.pins = pinned(addAll([], p.cs).cs, true); persist(); changed();
  return null;
}
// `p`: every local clause of the tab into the pins (merge rules apply); the toast
export function pinAll(tab: string): string {
  const loc = localFor(tab);
  if (!loc.length) return "nothing to pin — / adds a filter, p pins it";
  const r = addAll(S.pins, pinned(loc, true));
  S.pins = pinned(r.cs, true); S.local.set(tab, []); persist(); changed();
  return "pinned: " + chipText(S.pins) + (r.notes.length ? " (" + r.notes.join("; ") + ")" : "") + " — P edits pins";
}
// sessions the pins alone exclude: total(local) − total(pins ∘ local)
export function hiddenByPins(tab: string, total: (cs: Clause[]) => number): number {
  if (!S.pins.length) return 0;
  const loc = localFor(tab);
  return Math.max(0, total(loc) - total(effective(S.pins, loc).cs));
}
// the real store: ~/.agentglass/config.json "filter": {"pinned": "<expr>", "remember": true}
export function configStore(): PinStore {
  const sec = section("filter"); const rm = sec["remember"];
  if (rm !== undefined && typeof rm !== "boolean") say("warn", "config filter.remember must be true or false — using true");
  return { load: () => str(section("filter")["pinned"]), save: (v: string) => { try { setConfig("filter", "pinned", v); } catch (e) { say("warn", "could not save pinned filter: " + String(e)); } }, remember: rm !== false };
}
