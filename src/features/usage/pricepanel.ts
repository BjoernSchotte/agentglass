// agentglass — Stats price panel ($): every model of the period with its price source; set a price, alias it, remove it.
// A write goes to prices.json (userprices.ts) and re-prices the ledger in place (repricer.ts): costs change on the next frame.
// SPDX-License-Identifier: Apache-2.0
import { S, say } from "../../state.ts";
import { H, type Action, type Ctx } from "../../hooks.ts";
import { ask, confirm } from "../../actions.ts";
import { fit, vwidth, fitStyled, fillTo, home, ago } from "../../util/text.ts";
import { C, CSI, RST, fg } from "../../ui/theme.ts";
import { put, box } from "../../ui/screen.ts";
import { sessions, parentOf, titleOf } from "../../model/sessions.ts";
import type { Sess } from "../../model/types.ts";
import { repoShown } from "../query/project.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { ledger } from "./ledger.ts";
import { L, todayKey, modelUses } from "./record.ts";
import { kfmt, grp } from "./costs.ts";
import { PRICES_FILE, resolve, readUserFile } from "./pricing.ts";
import { type PRow, reportedNote, reportedShort, rates, srcLabel, srcFit } from "./pricerows.ts";
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
    const sl = srcFit(r, sw);
    let l = lead + tx + fit(r.model, mw) + RST + " " + fg(srcColor(r)) + fit(sl, sw) + RST;
    if (rates2) l += fg(C.sub) + rj(r.p ? (rt[0] ?? 0).toFixed(2) : "—", 8) + rj(r.p ? (rt[1] ?? 0).toFixed(2) : "—", 8) + RST;
    if (toks) l += fg(C.text) + rj(kfmt(r.tok), 9) + RST;
    l += (r.cost > 0 ? fg(C.yellow) : fg(C.dim)) + rj(cost(r), 11) + RST;
    out.push(l);
    if (on) { // what the row's source means for a price set here; a shortened source in full first
      const n = reportedNote(r);
      const w0 = n ? n : r.dead ? "alias target " + r.via + " has no price — set one or alias another model" : r.src === "unpriced" ? "no price: ↵ set one, a price it like another model" : r.provs.length ? "other providers: " + r.provs.map((p) => p.prov + " " + (p.src === "gateway" ? "gw " + p.via : p.src)).join(", ") : "";
      const why = (sl !== srcLabel(r) ? "source " + srcLabel(r) + (w0 ? " · " : "") : "") + w0;
      if (why && out.length - 1 < vis) out.push(fg(C.dim) + "   " + fit(why, avail - 3) + RST);
    }
  }
  return out;
}
export function renderPanel(x: number, y: number, w: number, h: number, days: string[]): void {
  if (MD.model) { renderDrill(x, y, w, h, days); return; }
  const rows = panelRows(days);
  PP.sel = Math.max(0, Math.min(PP.sel, rows.length - 1));
  const vis = Math.max(1, h - 4);
  if (PP.sel < PP.top) PP.top = PP.sel;
  if (PP.sel >= PP.top + vis) PP.top = PP.sel - vis + 1;
  PP.top = Math.max(0, Math.min(PP.top, Math.max(0, rows.length - vis)));
  let un = 0; for (const r of rows) if (r.src === "unpriced") un++;
  box(x, y, w, h, "models · " + PP.label(), (un ? String(un) + " unpriced · " : "") + "s sessions · ↵ price · a alias · x remove · $ close", true);
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
// the pre-fill: the price the row shows (a gateway-priced row resolves only with its provider), else the provider-less one
function priceText(model: string, row: PRow | null): string {
  const e = userEntry(PRICES_FILE, model);
  const r0 = resolve(model, ""); const p = row && row.p ? row.p : r0 ? r0.p : null;
  if (!p) return "";
  const xs = [num(p.i), num(p.o)];
  const cr = e && typeof e["cacheRead"] === "number" ? (e["cacheRead"] as number) : -1; // only what the user wrote: derived rates stay derived
  const cw = e && typeof e["cacheWrite"] === "number" ? (e["cacheWrite"] as number) : -1;
  const c1 = e && typeof e["cacheWrite1h"] === "number" ? (e["cacheWrite1h"] as number) : -1;
  if (cr >= 0 || cw >= 0 || c1 >= 0) xs.push(num(cr >= 0 ? cr : p.i * 0.1));
  if (cw >= 0 || c1 >= 0) xs.push(num(cw >= 0 ? cw : p.i * 1.25));
  if (c1 >= 0) xs.push(num(c1));
  return xs.join(" ");
}
function noteFor(model: string): string { const r = rowOf(model, PP.period()); return r ? reportedNote(r) : ""; }
export function openPrice(model: string): void {
  PP.model = model; const row = rowOf(model, PP.period()); const n = row ? reportedShort(row) : ""; // the full note: under the row, in the toast
  ask("price " + model + (n ? " · " + n : "") + " ($/Mtok: in out [cacheRead [cacheWrite [cacheWrite1h]]])", "price-set", priceText(model, row));
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
  if (MD.model) return drillKey(k, days);
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
  else if (k === "s") { if (r) drillOn(r.model, days); }
  else if (k === "x") {
    if (!r) return true;
    PP.model = r.model;
    const e = userEntry(PRICES_FILE, r.model); PP.what = e && typeof e["alias"] === "string" && typeof e["input"] !== "number" ? "alias" : "price";
    const bad = e ? "" : readUserFile(PRICES_FILE).bad; // a broken file: say so, not "nothing to remove"
    if (e) confirm("remove the user " + PP.what + " of " + r.model + "? (y/n)", "price-unset");
    else if (bad) say("err", home(PRICES_FILE) + ": " + bad + " — fix it first (it was left as it is)");
    else say("info", r.model + ": nothing to remove (source: " + (r.dead ? "alias " + r.via : r.src) + ") — " + home(PRICES_FILE));
  } else return false;
  return true;
}
// ── s: where a model's cost came from (W8.8) — the period's sessions that used it, by project, as the ledger booked
// them (no log is read here; cached until the ledger or the period moves); c sorts by cache read, ↵ opens a session
export interface DRow { proj: string; s: Sess | null; cost: number; cr: number; unk: number; tok: number; n: number; last: number }
export const MD = { model: "", sel: 0, top: 0, cache: false, key: "", rows: [] as DRow[], tot: { cost: 0, cr: 0, unk: 0, tok: 0, n: 0 } };
function dval(r: DRow, cache: boolean): number { return cache ? r.cr : r.cost; }
// project header rows (s null), each followed by its sessions; both highest first
export function drillRows(model: string, days: string[], cache: boolean): DRow[] {
  const key = model + "\t" + days.join(",") + "\t" + (cache ? "c" : "") + "\t" + String(L.ver);
  if (key === MD.key) return MD.rows;
  const ps = new Map<string, DRow>(); const kids = new Map<string, DRow[]>(); const tot = { cost: 0, cr: 0, unk: 0, tok: 0, n: 0 };
  for (const s of sessions.values()) {
    const a = ledger.get(s.path); if (!a) continue;
    const x: DRow = { proj: "", s, cost: 0, cr: 0, unk: 0, tok: 0, n: 1, last: s.mtime }; let hit = false;
    for (const k of days) {
      const d = a.days.get(k); if (!d) continue;
      const r = d.mt.get(model); const u = d.um.get(model) ?? 0; if (!r && !u) continue;
      hit = true; x.unk += u; x.tok += u;
      if (r) { x.cost += r[4] ?? 0; x.cr += r[2] ?? 0; x.tok += (r[0] ?? 0) + (r[1] ?? 0) + (r[2] ?? 0) + (r[3] ?? 0); }
    }
    if (!hit) continue;
    x.proj = repoShown(s) || "(no project)";
    let p = ps.get(x.proj); if (!p) { p = { proj: x.proj, s: null, cost: 0, cr: 0, unk: 0, tok: 0, n: 0, last: 0 }; ps.set(x.proj, p); kids.set(x.proj, []); }
    p.cost += x.cost; p.cr += x.cr; p.unk += x.unk; p.tok += x.tok; p.n++; p.last = Math.max(p.last, x.last);
    tot.cost += x.cost; tot.cr += x.cr; tot.unk += x.unk; tot.tok += x.tok; tot.n++;
    const ks = kids.get(x.proj); if (ks) ks.push(x);
  }
  const hs = [...ps.values()].sort((a: DRow, b: DRow) => dval(b, cache) - dval(a, cache) || (a.proj < b.proj ? -1 : a.proj > b.proj ? 1 : 0));
  const out: DRow[] = [];
  for (const h of hs) { out.push(h); const ks = kids.get(h.proj) ?? []; ks.sort((a: DRow, b: DRow) => dval(b, cache) - dval(a, cache)); for (const k of ks) out.push(k); }
  MD.key = key; MD.rows = out; MD.tot = tot;
  return out;
}
function share(a: number, b: number): string { return b > 0 ? String(Math.round((a / b) * 100)) + "%" : "·"; }
function dcost(r: { cost: number; unk: number }): string { return r.cost <= 0 ? (r.unk > 0 ? "?" : "$0.00") : "$" + money(r.cost) + (r.unk > 0 ? "+?" : ""); }
// the drill-down as styled lines for a box of width w and height h: header, then rows from top; sel = a session row
export function drillLines(rows: DRow[], w: number, h: number, sel: number, top: number): string[] {
  // narrow: LAST goes first, then SHARE; the name keeps the rest
  const avail = w - 4; const last = avail >= 60; const shr = avail - 22 - (last ? 6 : 0) >= 20; const fixed = 22 + (shr ? 6 : 0) + (last ? 6 : 0); const nw = Math.max(8, avail - fixed);
  const out: string[] = [];
  out.push(fg(C.dim) + " " + fit("PROJECT · SESSION", nw) + rj(MD.cache ? "CACHE READ▾" : "CACHE READ", 11) + rj(MD.cache ? "COST" : "COST▾", 11) + (shr ? rj("SHARE", 6) : "") + (last ? rj("LAST", 6) : "") + RST);
  if (!rows.length) { out.push(fg(C.dim) + " no session used " + MD.model + " " + PP.label() + " — d / w switch the period, esc back" + RST); return out; }
  const t = MD.tot;
  for (let i = top; i < rows.length && out.length < h - 2; i++) {
    const r = rows[i]; const on = i === sel; const s = r.s;
    const lead = on ? fg(C.accent) + "▌" + RST : " ";
    const name = s ? "  " + fg(C.sub) + s.h + RST + " " + (on ? fg(C.text) + CSI + "1m" : fg(C.text)) + titleOf(s) + RST + (s.parent ? fg(C.dim) + " · subagent" + RST : "")
      : fg(C.sub) + CSI + "1m" + r.proj + RST + fg(C.dim) + " · " + String(r.n) + (r.n === 1 ? " session" : " sessions") + RST;
    const sh = MD.cache ? share(r.cr, t.cr) : share(r.cost, t.cost);
    out.push(lead + fitStyled(name, nw) + fillTo(fitStyled(name, nw), nw) + fg(C.text) + rj(kfmt(r.cr), 11) + RST + (r.cost > 0 ? fg(C.yellow) : fg(C.dim)) + rj(dcost(r), 11) + RST + (shr ? fg(s ? C.dim : C.sub) + rj(sh, 6) + RST : "") + (last ? fg(C.dim) + rj(s ? ago(r.last) : "", 6) + RST : ""));
  }
  return out;
}
function drillMove(rows: DRow[], d: number): void { // to the next session row that way (project rows are headings)
  let i = MD.sel;
  for (;;) { i += d; if (i < 0 || i >= rows.length) return; const r = rows[i]; if (r && r.s) { MD.sel = i; return; } }
}
function firstSess(rows: DRow[]): number { for (let i = 0; i < rows.length; i++) { const r = rows[i]; if (r && r.s) return i; } return 0; }
export function drillOn(model: string, days: string[]): void { MD.model = model; MD.top = 0; MD.sel = firstSess(drillRows(model, days, MD.cache)); }
function renderDrill(x: number, y: number, w: number, h: number, days: string[]): void {
  const rows = drillRows(MD.model, days, MD.cache);
  MD.sel = Math.max(0, Math.min(MD.sel, rows.length - 1));
  const vis = Math.max(1, h - 3);
  if (MD.sel < MD.top) MD.top = Math.max(0, MD.sel - 1); // the session's project heading stays in view where it can
  if (MD.sel >= MD.top + vis) MD.top = MD.sel - vis + 1;
  MD.top = Math.max(0, Math.min(MD.top, Math.max(0, rows.length - vis)));
  const t = MD.tot; const cr = t.tok > 0 ? " · cache read " + kfmt(t.cr) + " (" + share(t.cr, t.tok) + " of its tokens)" : "";
  box(x, y, w, h, MD.model + " · " + PP.label() + " · " + dcost(t) + " · " + String(t.n) + " sessions" + cr, "↵ open · c " + (MD.cache ? "by cost" : "by cache read") + " · esc models", true);
  const ls = drillLines(rows, w, h, MD.sel, MD.top);
  for (let i = 0; i < h - 2; i++) { const l = i < ls.length ? ls[i] : ""; put(x + 1, y + 1 + i, fitStyled(l, w - 2) + fillTo(fitStyled(l, w - 2), w - 2)); }
}
function drillKey(k: string, days: string[]): boolean {
  const rows = drillRows(MD.model, days, MD.cache);
  if (k === "esc" || k === "bs") MD.model = "";
  else if (k === "$") { MD.model = ""; PP.open = false; }
  else if (k === "up" || k === "k" || k === "wheelup") drillMove(rows, -1);
  else if (k === "down" || k === "j" || k === "wheeldown") drillMove(rows, 1);
  else if (k === "pgup") { for (let i = 0; i < 10; i++) drillMove(rows, -1); }
  else if (k === "pgdn") { for (let i = 0; i < 10; i++) drillMove(rows, 1); }
  else if (k === "home" || k === "g") MD.sel = firstSess(rows);
  else if (k === "end" || k === "G") { MD.sel = rows.length - 1; }
  else if (k === "c") { const r = MD.sel < rows.length ? rows[MD.sel] : null; const s = r ? r.s : null; MD.cache = !MD.cache; const nr = drillRows(MD.model, days, MD.cache); MD.sel = firstSess(nr); if (s) for (let i = 0; i < nr.length; i++) { const x = nr[i]; if (x && x.s === s) MD.sel = i; } }
  else if (k === "enter") {
    const r = MD.sel < rows.length ? rows[MD.sel] : null; const s = r ? r.s : null;
    if (!s) return true;
    if (!sessions.has(s.path)) { say("warn", "that session is no longer on disk"); return true; }
    openTranscript(s);
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
