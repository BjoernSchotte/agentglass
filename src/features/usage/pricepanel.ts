// agentglass — Stats price panel ($): every model of the period with its price source; set a price, alias it, remove it.
// A write goes to prices.json (userprices.ts) and re-prices the ledger in place (repricer.ts): costs change on the next frame.
// SPDX-License-Identifier: Apache-2.0
import { S, say } from "../../state.ts";
import { H, type Action, type Ctx } from "../../hooks.ts";
import { ask, confirm } from "../../actions.ts";
import { fit, vwidth, fitStyled, fillTo, home } from "../../util/text.ts";
import { C, CSI, RST, fg } from "../../ui/theme.ts";
import { put, box } from "../../ui/screen.ts";
import { sessions, parentOf } from "../../model/sessions.ts";
import { ledger } from "./ledger.ts";
import { todayKey, modelUses } from "./record.ts";
import { kfmt, grp } from "./costs.ts";
import { PRICES_FILE, resolve } from "./pricing.ts";
import { type PRow, reportedNote, rates, srcLabel } from "./pricerows.ts";
import { pricedRows } from "./summary.ts";
import { parsePriceLine, entryOf, storedKey, setUserEntry, userEntry } from "./userprices.ts";
import { reloadPrices, pricesWritten } from "./repricer.ts";
import { keyAction, addActions, tabNamed } from "../palette/actions.ts";
import type { Obj } from "../../util/json.ts";

// open = the panel replaces the bottom of Stats; model = the one the input line / confirm acts on; period = Stats' days
export const PP = { open: false, sel: 0, top: 0, model: "", what: "price", period: (): string[] => [todayKey()], label: (): string => "today" };
export function panelRows(days: string[]): PRow[] { return pricedRows(days, ""); }

function num(n: number): string { return String(Math.round(n * 10000) / 10000); }
function money(c: number): string { return c < 1000 ? c.toFixed(2) : kfmt(c); }
function cost(r: PRow): string {
  if (r.cost <= 0) return r.unk > 0 ? "?" : "$0.00";
  return (r.est > 0 ? "≈$" : "$") + money(r.cost) + (r.unk > 0 ? "+?" : "");
}
function srcColor(r: PRow): string { return r.dead ? C.red : r.src === "unpriced" ? C.yellow : r.src === "alias" ? C.purple : r.src === "user" ? C.green : r.src === "gateway" ? C.cyan : C.sub; }
function rj(s: string, w: number): string { const n = vwidth(s); return n >= w ? fit(s, w) : " ".repeat(w - n) + s; }
// the table as styled lines for a box of width w (each ≤ w − 2 cells), h − 2 rows inside it; top = first row shown.
// Columns: MODEL (≥ 18) SOURCE $IN $OUT TOKENS COST; narrow: $IN/$OUT go first, then TOKENS
export function panelLines(rows: PRow[], w: number, h: number, sel: number, top: number): string[] {
  const avail = w - 4;
  let sw = 8; let lm = 18;
  for (const r of rows) { sw = Math.max(sw, vwidth(srcLabel(r)) + 1); lm = Math.max(lm, vwidth(r.model)); }
  sw = Math.min(sw, 24); lm = Math.min(lm, 32);
  let rates2 = true; let toks = true;
  const fixed = (): number => 2 + sw + (rates2 ? 16 : 0) + (toks ? 9 : 0) + 11;
  // the full ids first; then SOURCE shrinks to 12, then $IN/$OUT go, then TOKENS; MODEL keeps ≥ 18
  if (avail - fixed() < lm) sw = Math.max(12, sw - (lm - (avail - fixed())));
  if (avail - fixed() < 18) rates2 = false;
  if (avail - fixed() < 18) toks = false;
  if (avail - fixed() < 18) sw = Math.max(8, avail - 18 - fixed() + sw);
  const mw = Math.max(10, avail - fixed());
  const out: string[] = [];
  out.push(fg(C.dim) + " " + fit("MODEL", mw) + " " + fit("SOURCE", sw) + (rates2 ? rj("$IN", 8) + rj("$OUT", 8) : "") + (toks ? rj("TOKENS", 9) : "") + rj("COST", 11) + RST);
  if (!rows.length) { out.push(fg(C.dim) + " no model usage " + PP.label() + " — d / w switch the period" + RST); return out; }
  const vis = Math.max(1, h - 3); // header + the selected row's note
  for (let i = top; i < rows.length && out.length - 1 < vis; i++) {
    const r = rows[i]; const on = i === sel; const rt = r.p ? rates(r.p) : [];
    const lead = on ? fg(C.accent) + "▌" + RST : " ";
    const tx = on ? fg(C.text) + CSI + "1m" : fg(C.text);
    let l = lead + tx + fit(r.model, mw) + RST + " " + fg(srcColor(r)) + fit(srcLabel(r), sw) + RST;
    if (rates2) l += fg(C.sub) + rj(r.p ? (rt[0] ?? 0).toFixed(2) : "—", 8) + rj(r.p ? (rt[1] ?? 0).toFixed(2) : "—", 8) + RST;
    if (toks) l += fg(C.text) + rj(kfmt(r.tok), 9) + RST;
    l += (r.cost > 0 ? fg(C.yellow) : fg(C.dim)) + rj(cost(r), 11) + RST;
    out.push(l);
    if (on) { // what the row's source means for a price set here
      const n = reportedNote(r);
      const why = n ? n : r.dead ? "alias target " + r.via + " has no price — set one or alias another model" : r.src === "unpriced" ? "no price: ↵ set one, a price it like another model" : r.provs.length ? "other providers: " + r.provs.map((p) => p.prov + " " + (p.src === "gateway" ? "gw " + p.via : p.src)).join(", ") : "";
      if (why && out.length - 1 < vis) out.push(fg(C.dim) + "   " + fit(why, avail - 3) + RST);
    }
  }
  return out;
}
export function renderPanel(x: number, y: number, w: number, h: number, days: string[]): void {
  const rows = panelRows(days);
  PP.sel = Math.max(0, Math.min(PP.sel, rows.length - 1));
  const vis = Math.max(1, h - 4);
  if (PP.sel < PP.top) PP.top = PP.sel;
  if (PP.sel >= PP.top + vis) PP.top = PP.sel - vis + 1;
  PP.top = Math.max(0, Math.min(PP.top, Math.max(0, rows.length - vis)));
  let un = 0; for (const r of rows) if (r.src === "unpriced") un++;
  box(x, y, w, h, "models · " + PP.label(), (un ? String(un) + " unpriced · " : "") + "↵ price · a alias · x remove · $ close", true);
  const ls = panelLines(rows, w, h, PP.sel, PP.top);
  for (let i = 0; i < h - 2; i++) { const l = i < ls.length ? ls[i] : ""; put(x + 1, y + 1 + i, fitStyled(l, w - 2) + fillTo(fitStyled(l, w - 2), w - 2)); }
}

// ── editing ──
function rowOf(model: string, days: string[]): PRow | null { for (const r of panelRows(days)) if (r.model === model) return r; return null; }
function periodCost(days: string[]): number {
  let c = 0;
  for (const s of sessions.values()) { const a = ledger.get(s.path); if (!a) continue; for (const k of days) { const d = a.days.get(k); if (d) c += d.cost; } }
  return c;
}
function priceText(model: string): string {
  const e = userEntry(PRICES_FILE, model);
  const r = resolve(model, "");
  if (!r) return "";
  const xs = [num(r.p.i), num(r.p.o)];
  const cr = e && typeof e["cacheRead"] === "number" ? (e["cacheRead"] as number) : -1; // only what the user wrote: derived rates stay derived
  const cw = e && typeof e["cacheWrite"] === "number" ? (e["cacheWrite"] as number) : -1;
  const c1 = e && typeof e["cacheWrite1h"] === "number" ? (e["cacheWrite1h"] as number) : -1;
  if (cr >= 0 || cw >= 0 || c1 >= 0) xs.push(num(cr >= 0 ? cr : r.p.i * 0.1));
  if (cw >= 0 || c1 >= 0) xs.push(num(cw >= 0 ? cw : r.p.i * 1.25));
  if (c1 >= 0) xs.push(num(c1));
  return xs.join(" ");
}
function noteFor(model: string): string { const r = rowOf(model, PP.period()); return r ? reportedNote(r) : ""; }
export function openPrice(model: string): void {
  PP.model = model; const n = noteFor(model);
  ask("price " + model + " ($/Mtok: in out [cacheRead [cacheWrite [cacheWrite1h]]])" + (n ? " — " + n : ""), "price-set", priceText(model));
  S.inputErr = "";
}
// an alias suggestion: the priced model the parent session used most (a subagent such as Codex's guardian reviews its
// parent's work), else the priced model with the most tokens in the period's sessions of the same harness
export function suggestAlias(model: string, days: string[]): string {
  const hs = new Set<string>(); const parents: string[] = [];
  for (const s of sessions.values()) {
    const a = ledger.get(s.path); if (!a) continue;
    let uses = false; for (const k of days) { const d = a.days.get(k); if (d && d.mt.has(model)) uses = true; }
    if (!uses) continue;
    hs.add(s.h);
    const p = parentOf(s); if (p && parents.indexOf(p.path) < 0) parents.push(p.path);
  }
  const best = (paths: string[], all: boolean): string => {
    const by = new Map<string, number>();
    for (const s of sessions.values()) {
      if (all ? !hs.has(s.h) : paths.indexOf(s.path) < 0) continue;
      const a = ledger.get(s.path); if (!a) continue;
      for (const u of modelUses(a, all ? days : null)) if (u.model !== model && u.cost > 0 && resolve(u.model, "")) by.set(u.model, (by.get(u.model) ?? 0) + u.inTok + u.outTok + u.cr + u.cw);
    }
    let m = ""; let n = 0; for (const [k, v] of by) if (v > n) { n = v; m = k; }
    return m;
  };
  return best(parents, false) || best([], true);
}
export function openAlias(model: string): void {
  PP.model = model;
  const cur = userEntry(PRICES_FILE, model); const t = cur && typeof cur["alias"] === "string" ? String(cur["alias"]) : "";
  ask("price " + model + " like:", "price-alias", t || suggestAlias(model, PP.period()));
  S.inputErr = "";
}
// "" = a valid alias target for the model, else why not (the CLI's rules)
function aliasErr(model: string, target: string): string {
  const t = target.trim(); if (!t) return "a model to price it like";
  const tk = storedKey(t);
  if (tk === storedKey(model)) return model + " cannot be an alias of itself";
  const r = resolve(tk, "");
  if (r && r.src === "alias") return "aliases do not chain: " + t + " is an alias of " + r.via;
  if (!r) return t + " has no price — set one first";
  return "";
}
function delta(usd: number): string { const a = Math.abs(usd); return (usd >= 0 ? "+" : "−") + "$" + (a < 1000 ? a.toFixed(2) : grp(a)); }
// write one prices.json change, re-price in place, say what moved; a write error changes nothing
function apply(model: string, e: Obj | null, what: string): void {
  const days = PP.period(); const before = periodCost(days);
  try { setUserEntry(PRICES_FILE, model, e); }
  catch (x) { say("err", (x instanceof Error ? x.message : String(x)) + " — nothing changed"); return; }
  reloadPrices("editor"); pricesWritten();
  panelOn(model, days, PP.open); // the selection follows the model to its new place in the order
  const n = noteFor(model);
  say("ok", model + ": " + what + " — history re-priced, " + PP.label() + " " + delta(periodCost(days) - before) + (n ? " · " + n : ""));
}
H.input.push((action: string, ev: string, text: string): boolean => {
  if (action === "price-set") {
    const r = parsePriceLine(text);
    if (ev === "change") { S.inputErr = text.trim() ? r.err : ""; return false; }
    if (ev !== "enter") return false;
    if (!r.p) { S.inputErr = r.err; return true; }
    const p = r.p;
    apply(PP.model, entryOf(p), p.i === 0 && p.o === 0 ? "user $0 (free)" : "user price $" + num(p.i) + "/$" + num(p.o));
    return false;
  }
  if (action === "price-alias") {
    if (ev === "change") { S.inputErr = text.trim() ? aliasErr(PP.model, text) : ""; return false; }
    if (ev === "tab") { // complete a priced model id seen in the period (again: the next one)
      const c: string[] = []; for (const r of panelRows(PP.period())) if (r.src !== "unpriced" && r.model !== PP.model) c.push(r.model);
      c.sort();
      const t = text.trim(); let pick = "";
      const i = c.indexOf(t);
      if (i >= 0) pick = c[(i + 1) % c.length] ?? "";
      else for (const m of c) if (m.startsWith(t)) { pick = m; break; }
      if (pick) { S.inputText = String(pick); S.inputErr = aliasErr(PP.model, pick); }
      return false;
    }
    if (ev !== "enter") return false;
    const err = aliasErr(PP.model, text); if (err) { S.inputErr = err; return true; }
    const tk = storedKey(text.trim()); const r = resolve(tk, "");
    apply(PP.model, { alias: tk }, "≈ " + tk + (r ? " ($" + num(r.p.i) + "/$" + num(r.p.o) + ", an estimate)" : ""));
    return false;
  }
  return false;
});
H.confirmed.push((action: string): void => { if (action === "price-unset") apply(PP.model, null, "user " + PP.what + " removed"); });

// ── keys (Stats routes them here while the panel is open; d / w / B stay Stats') ──
export function panelKey(k: string, days: string[]): boolean {
  if (!PP.open) return false;
  const rows = panelRows(days); const r = PP.sel < rows.length ? rows[PP.sel] : null;
  if (k === "esc" || k === "$" || k === "bs") PP.open = false;
  else if (k === "up" || k === "k" || k === "wheelup") PP.sel = Math.max(0, PP.sel - 1);
  else if (k === "down" || k === "j" || k === "wheeldown") PP.sel = Math.min(Math.max(0, rows.length - 1), PP.sel + 1);
  else if (k === "pgup") PP.sel = Math.max(0, PP.sel - 10);
  else if (k === "pgdn") PP.sel = Math.min(Math.max(0, rows.length - 1), PP.sel + 10);
  else if (k === "home" || k === "g") PP.sel = 0;
  else if (k === "end" || k === "G") PP.sel = Math.max(0, rows.length - 1);
  else if (k === "enter" || k === "e") { if (r) openPrice(r.model); }
  else if (k === "a") { if (r) openAlias(r.model); }
  else if (k === "x") {
    if (!r) return true;
    PP.model = r.model;
    const e = userEntry(PRICES_FILE, r.model); PP.what = e && typeof e["alias"] === "string" && typeof e["input"] !== "number" ? "alias" : "price";
    if (e) confirm("remove the user " + PP.what + " of " + r.model + "? (y/n)", "price-unset");
    else say("info", r.model + ": nothing to remove (source: " + (r.dead ? "alias " + r.via : r.src) + ") — " + home(PRICES_FILE));
  } else return false;
  return true;
}
// open the panel on a model (palette)
export function panelOn(model: string, days: string[], open = true): void {
  PP.open = open; const rows = panelRows(days);
  for (let i = 0; i < rows.length; i++) if (rows[i].model === model) PP.sel = i;
}

// ── palette: the panel, and one "Set price for <model>" per unpriced model of the Stats period ──
const STATS = { go: (): void => {} }; // stats.ts: switch to the Stats tab
export function setStatsGo(f: () => void): void { STATS.go = f; }
addActions([keyAction("prices.panel", "Prices", "Edit model prices", "$", "$", (c: Ctx): boolean => tabNamed(c, "Stats"))]);
H.dynActions.push((): Action[] => {
  const out: Action[] = [];
  for (const r of panelRows(PP.period())) {
    if (r.src !== "unpriced") continue;
    const m = String(r.model);
    out.push({ id: "prices.set." + m, title: "Set price for " + m, group: "Prices", keys: "$",
      when: (c: Ctx): boolean => c.mode === "list" || c.mode === "transcript" || c.mode === "detail",
      run: (c: Ctx): void => { STATS.go(); panelOn(m, PP.period()); openPrice(m); } });
  }
  return out;
});
