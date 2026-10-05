// agentglass — Stats tab, preview usage line and header cost widget, all read from the usage ledger
// SPDX-License-Identifier: Apache-2.0
import { fit, fitStyled, fillTo, width, vwidth, clean, numAt, home, bytes } from "../../util/text.ts";
import { type Sess, newSess } from "../../model/types.ts";
import { S, say } from "../../state.ts";
import { H, type Tab, display } from "../../hooks.ts";
import { sessions, titleOf } from "../../model/sessions.ts";
import { C, CSI, RST, fg, bg, heat } from "../../ui/theme.ts";
import { put, box, badge, gauge, spin } from "../../ui/screen.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { ledger, accOf, pending } from "./ledger.ts";
import { type Day, L, todayKey, lastDays, startOfDay, skillUses, newDay, heavy } from "./record.ts";
import { pricesFrom } from "./pricing.ts";
import { type Rec, type Cnt, HB, EDGE, newCnt, pct, fmtMs, mcpServer, hb } from "./calls.ts";
import { kfmt, grp, type ModeSum, newSum, addDay, total, single, money, moneyTag, split, unpricedLine, projText, estTop } from "./costs.ts";
import { type Bill, type GW, MODES, tag, asBill, planLabel, gaugeWins, claudeWins } from "./billing.ts";
import { modeOf, allowance } from "./bill-live.ts";
import { costNow, budget, sourceCounts } from "./summary.ts";
import { PP, renderPanel, panelKey, setStatsGo } from "./pricepanel.ts";
import { REDACT } from "../redact-on.ts";
import { CONFIG_FILE } from "../../util/config.ts";
import { HARNESSES, harnessOf, harnessIndex } from "../../harness/index.ts";
import { DICT, nameOf, localOf } from "./facts.ts";
import type { Call } from "./facts.ts";
import type { Clause } from "../query/types.ts";
import { parse } from "../query/parse.ts";
import { type Compiled, EMPTY, compile, sessMatches, dayMatches, eachCall } from "../query/eval.ts";
import { type Totals, totals } from "../query/agg.ts";
import { setLocal } from "../query/scope.ts";
import { tabFilter, chips, contentOk, callsChip, timeStep } from "../query/ui.ts";

// ── formatting ──────────────────────────────────────────────────────────────
export { kfmt, grp };
const dot = fg(C.dim) + " · " + RST;
function rj(s: string, w: number): string { const n = width(s); return n >= w ? fit(s, w) : " ".repeat(w - n) + s; }

// ── aggregation over a set of local days (cached per ledger version) ────────
// ms = cost by billing mode + unpriced; modes = each session's label with whether it is assumed from config ("plan\tteam\t*")
interface HA { h: string; sess: number; tools: number; inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number; add: number; del: number; ms: ModeSum; modes: string[] }
interface Agg { key: string; ver: number; at: number; rows: HA[]; tot: HA; names: Map<string, Cnt>; skills: Map<string, Cnt>; hours: number[]; perDay: number[]; dayCost: number[]; busy: Sess | null; busyTools: number; busyCost: number; done: number; total: number; scoped: boolean }
function ha(h: string): HA { return { h, sess: 0, tools: 0, inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0, add: 0, del: 0, ms: newSum(), modes: [] }; }
function zeros(n: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(0); return a; }
function addCnt(m: Map<string, Cnt>, k: string, n: number, err: number, add: number, del: number): void {
  let c = m.get(k);
  if (!c) { c = newCnt(); m.set(k, c); }
  c.n = c.n + n; c.err = c.err + err;
  c.add = c.add + add; c.del = c.del + del;
}
const cache = new Map<string, Agg>();
// the session passes the filter's session clauses and its content clauses (full-text; ok = contentOk(f)) — EMPTY passes everything
function sessOk(f: Compiled, ok: (path: string) => boolean, s: Sess): boolean { return f === EMPTY || (sessMatches(f, s) && ok(s.path)); }
// per (session path, day): the matching call rows of a filter with call clauses (tools, errors, per tool, per hour)
interface RowDay { n: number; names: Map<string, Cnt>; hours: number[] }
function rowDays(f: Compiled, days: string[], cp: (path: string) => boolean): Map<string, RowDay> {
  const m = new Map<string, RowDay>();
  eachCall(f, days, (s: Sess, c: Call) => {
    if (!cp(s.path)) return;
    const k = s.path + "\t" + localOf(c.t).day;
    let r = m.get(k); if (!r) { r = { n: 0, names: new Map<string, Cnt>(), hours: zeros(24) }; m.set(k, r); }
    r.n++; addCnt(r.names, nameOf(DICT.tool, c.tool), 1, c.err === 1 ? 1 : 0, 0, 0);
    const h = localOf(c.t).hour; r.hours[h] = numAt(r.hours, h, 0) + 1;
  });
  return m;
}
function aggF(days: string[], f: Compiled): Agg {
  const key = days.join(",") + "|" + f.key;
  const hit = cache.get(key);
  if (hit && hit.ver === L.ver && Date.now() - hit.at < Math.min(5000, timeStep(f.cs))) return hit; // an age clause: its own step
  const rows = HARNESSES.map((ad) => ha(ad.id)); const tot = ha("total");
  const g: Agg = { key, ver: L.ver, at: Date.now(), rows, tot, names: new Map<string, Cnt>(), skills: new Map<string, Cnt>(), hours: zeros(24), perDay: zeros(days.length), dayCost: zeros(days.length), busy: null, busyTools: 0, busyCost: 0, done: 0, total: 0, scoped: f.needsCalls };
  const cp = contentOk(f);
  const rows0 = f.needsCalls; const rd = rows0 ? rowDays(f, days, cp) : new Map<string, RowDay>(); // call clauses: tools from matching rows, money from the session-days holding them
  const from = startOfDay() - (days.length - 1) * 86400000; // ±1h around DST: fine for a progress gauge
  for (const s of sessions.values()) {
    const a = ledger.get(s.path);
    if (s.mtime >= from) { g.total += s.size; if (a) g.done += pending(s, a) ? Math.min(a.off, s.size) : s.size; }
    if (!a || !sessOk(f, cp, s)) continue;
    const ri = harnessIndex(s.h); const r = ri >= 0 ? rows[ri] : tot;
    let st = 0; let sc = 0; let any = false;
    for (let i = 0; i < days.length; i++) {
      const dk = days[i] ?? ""; const d = a.days.get(dk); if (!d) continue;
      if (f !== EMPTY && !dayMatches(f, s, dk, d)) continue;
      const m = rows0 ? rd.get(s.path + "\t" + dk) : undefined; if (rows0 && !m) continue;
      any = true;
      const nt = m ? m.n : d.tools;
      for (const x of [r, tot]) { x.tools += nt; x.inTok += d.inTok; x.outTok += d.outTok; x.cr += d.cr; x.cw += d.cw; x.cost += d.cost; x.unk += d.unk; x.add += d.add; x.del += d.del; addDay(x.ms, d, (p: string): Bill => modeOf(s, p)); }
      st += nt; sc += d.cost;
      g.perDay[i] = numAt(g.perDay, i, 0) + nt; g.dayCost[i] = numAt(g.dayCost, i, 0) + d.cost;
      if (m) for (const [n, c] of m.names) addCnt(g.names, n, c.n, c.err, 0, 0); else for (const [n, c] of heavy(d).tt) addCnt(g.names, n, c.n, c.err, 0, 0);
      if (!m) for (const [n, c] of d.skills) addCnt(g.skills, n, c.n, 0, 0, 0);
      const hs = m ? m.hours : d.hours;
      for (let hh = 0; hh < 24; hh++) g.hours[hh] = numAt(g.hours, hh, 0) + numAt(hs, hh, 0);
    }
    if (any && !s.parent) { r.sess++; tot.sess++; const mk = s.bill + "\t" + s.plan + "\t" + (s.billSrc === "config" ? "*" : ""); if (r.modes.indexOf(mk) < 0) r.modes.push(mk); }
    if (st > g.busyTools) { g.busyTools = st; g.busyCost = sc; g.busy = s; }
  }
  cache.set(key, g);
  return g;
}

// ── Stats tab ───────────────────────────────────────────────────────────────
let week = false;
function period(): string[] { return week ? lastDays(7) : [todayKey()]; }
// the effective Stats filter (pins ∘ Stats local)
function statsFilter(): Compiled { return tabFilter("Stats", "stats"); }
// the d/w period ∩ day/weekday clauses: "" when some day of the period can match, else the message shown instead of the tables
export function periodMessage(f: Compiled, days: string[]): string {
  const dc: Clause[] = []; for (const c of f.cs) if (c.key === "day" || c.key === "weekday") dc.push(c);
  if (!dc.length) return "";
  const r = compile(dc, "stats"); const g = r.f; if (!g) return "";
  for (const dk of days) { let ok = true; for (const p of g.day) if (!p(NOSESS, dk, NODAY)) { ok = false; break; } if (ok) return ""; }
  const txt: string[] = []; for (const c of dc) txt.push(c.key + " " + c.op + " " + c.vals.join(" "));
  return (days.length > 1 ? "no days of the last " + String(days.length) + " match " : "today does not match ") + txt.join(" and ");
}
const NOSESS = newSess("", "", "", false); const NODAY: Day = newDay(); // day/weekday clauses read only the day key
// totals of an expression over the current period (checks; also what the summary shows under a filter)
export function statsTotalsFor(expr: string): Totals { const r = compile(parse(expr).cs, "stats"); return totals(r.f ?? EMPTY, period()); }
export function statsPeriod(): string[] { return period(); }
// the Stats summary row (Σ total) of an expression over the current period, as the tab computes it (checks)
export function statsSummaryFor(expr: string): { sess: number; tools: number; cost: number; inTok: number; outTok: number; add: number; del: number; scoped: boolean } {
  const r = compile(parse(expr).cs, "stats"); const g = aggF(period(), r.f ?? EMPTY); const t = g.tot;
  return { sess: t.sess, tools: t.tools, cost: t.cost, inTok: t.inTok, outTok: t.outTok, add: t.add, del: t.del, scoped: g.scoped };
}
export function statsDrillTool(): string { return dKey; }
export function statsTabIndex(): number { return 2 + H.tabs.indexOf(tab); }
// switch to the Stats tab with this local filter and open the drill-down of tool ("mcp__<server>" = the server)
export function statsDrill(tool: string, local: Clause[], wk: boolean): void {
  const i = H.tabs.indexOf(tab); if (i >= 0) S.tab = i + 2;
  S.mode = "list"; week = wk; setLocal("Stats", local);
  const sv = tool.startsWith("mcp__") && tool.indexOf("__", 5) < 0;
  dKey = tool; dServer = sv; dLabel = sv ? "⧉ " + tool.slice(5) : display("tool", tool, null); dsel = 0; dCache = null;
}
const BLK = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WD = "SuMoTuWeThFrSa";

// "Claude plan (team)" per harness with sessions in the period; "mixed" for more than one mode, assumed ones dim with *
function billingOf(rows: HA[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (!r.modes.length) continue;
    const bs: string[] = []; let plan = ""; let assumed = false;
    for (const m of r.modes) { const f = m.split("\t"); const b = f[0] || "unknown"; if (bs.indexOf(b) < 0) bs.push(b); if (f[1]) plan = f[1]; if (f[2]) assumed = true; }
    const one = bs.length === 1 ? asBill(bs[0] ?? "") : null;
    const word = one ? (one === "unknown" ? "unknown" : one === "gateway" ? "gateway" : tag(one)) + (one === "plan" && plan ? " (" + planLabel(plan, REDACT) + ")" : "") : "mixed";
    out.push((assumed ? fg(C.dim) : fg(C.sub)) + harnessOf(r.h).label + " " + word + (assumed ? "*" : "") + RST);
  }
  return out;
}
// line 1's tail within w columns: prices + billing; narrow drops the price source first, then trailing harnesses ("+2")
function sourcesOf(rows: HA[], w: number): string {
  const sc = sourceCounts(period()); const from = pricesFrom();
  const pr = fg(C.dim) + "   prices: " + (from === "built-in" ? from : "built-in + " + from) + (sc ? " · " + sc : "") + RST; const bs = billingOf(rows);
  const bl = (n: number, lead: string): string => !bs.length ? "" : fg(C.dim) + lead + "billing: " + RST + bs.slice(0, n).join(fg(C.dim) + " · " + RST) + (n < bs.length ? fg(C.dim) + " +" + String(bs.length - n) + RST : "");
  if (vwidth(pr + bl(bs.length, " · ")) <= w) return pr + bl(bs.length, " · ");
  if (!bs.length) return pr;
  for (let n = bs.length; n > 0; n--) if (vwidth(bl(n, "   ")) <= w) return bl(n, "   ");
  return "";
}
// one cost cell: the figure with its tag, "≈$x mixed" over several modes, "?" when only unpriced usage exists
function cellOf(x: HA): string {
  if (x.cost === 0 && (x.unk > 0 || x.ms.uc > 0)) return "?";
  const one = single(x.ms);
  return one ? moneyTag(total(x.ms), one, x.ms.est > 1e-9) : total(x.ms) > 0 ? money(total(x.ms), "") + " mixed" : money(0, "");
}
// modes whose cost counts (budget.counts, or all without a budget) are all API spend: figures without ≈
function allApi(): boolean {
  const c = costNow("");
  for (let i = 1; i < MODES.length; i++) {
    if (budget.usd > 0 && budget.counts.indexOf(MODES[i] ?? "unknown") < 0) continue;
    if ((c.month.by[i] ?? 0) > 0 || (c.projByMode[i]?.month ?? 0) > 0) return false;
  }
  return true;
}
function projLine(): string { const c = costNow(""); const p = budget.usd > 0 ? c.projCounted : c.proj; return projText(p.today, p.month, budget, c.bs, allApi()); }
function linesStr(add: number, del: number): string { return fg(C.green) + "+" + grp(add) + RST + " " + fg(C.red) + "−" + grp(del) + RST; }

function renderStats(): void {
  const W = S.W; const Ht = S.H;
  const days = period();
  if (dKey) { renderDrill(days); return; }
  const f = statsFilter(); const g = aggF(days, f); const t = g.tot;
  // summary; the subtitle carries the filter chips
  const ch = f === EMPTY ? "" : chips("Stats", "stats", Math.max(10, W - 30));
  box(0, 1, W, 5, "usage", ch ? ch + fg(C.dim) + " · " + (week ? "last 7 days" : "today") + RST : week ? "last 7 days" : "today", true);
  const chip = (on: boolean, k: string, label: string): string => (on ? bg(C.accent) + fg("20;20;24") + CSI + "1m" : bg(C.sel) + fg(C.sub)) + " " + k + " " + label + " " + RST;
  const frac = g.total > 0 ? g.done / g.total : 1;
  const idx = frac < 0.999 ? fg(C.yellow) + spin() + " indexing " + RST + gauge(frac, 12) + fg(C.text) + " " + Math.floor(frac * 100) + "%" + RST
    : fg(C.green) + "✔ indexed" + RST;
  const l1h = chip(!week, "d", "Today") + " " + chip(week, "w", "7 days") + "   " + idx;
  const l1 = l1h + sourcesOf(t.sess ? g.rows : [], W - 4 - vwidth(l1h));
  const wide = W >= 130; const sp = wide ? " " : "";
  // the split figure ("$3.10 spend + ≈$9.20 plan"), or the ≈ total when the line would not fit (the table keeps the tags);
  // still too long (80 columns): the parts the table below repeats go first — unpriced, sessions, cache write, lines
  const l2f = (narrow: boolean, drop: number): string => fg(C.yellow) + CSI + "1m" + split(t.ms, narrow) + RST + (wide ? "   " : "  ") + fg(C.cyan) + "↑" + sp + kfmt(t.inTok) + RST + fg(C.sub) + " in  " + RST + fg(C.purple) + "↓" + sp + kfmt(t.outTok) + RST + fg(C.sub) + " out  " + RST +
    fg(C.accent) + "↻" + sp + kfmt(t.cr) + RST + fg(C.sub) + (wide ? " cache read" : " cr") + RST + (drop >= 3 ? "" : "  " + fg(C.accent) + "⇡" + sp + kfmt(t.cw) + RST + fg(C.sub) + (wide ? " cache write" : " cw") + RST) + dot +
    fg(C.text) + CSI + "1m" + grp(t.tools) + RST + fg(C.sub) + (wide ? " tool calls" : " tools") + RST + (drop >= 4 ? "" : dot + linesStr(t.add, t.del)) + (drop >= 2 ? "" : dot + fg(C.text) + t.sess + RST + fg(C.sub) + " sessions" + RST) + (t.ms.est > 0.005 && drop < 1 ? fg(C.dim) + " · " + money(t.ms.est, "", true) + " by alias" + RST : "") + (t.ms.unk > 0 && drop < 1 ? fg(C.dim) + " · unpriced " + kfmt(t.ms.unk) + " tok" + RST : "");
  const sc = g.scoped ? fg(C.dim) + " · cost: days with matching calls" + RST : "";
  let l2 = l2f(false, 0);
  for (let d = 0; d <= 4 && vwidth(l2 + sc) > W - 4; d++) l2 = l2f(true, d);
  l2 += sc;
  const b = g.busy;
  const busiest = b ? fg(C.yellow) + "★ busiest  " + RST + badge(b.h) + fg(C.text) + CSI + "1m" + grp(g.busyTools) + RST + fg(C.sub) + " tools " + RST + fg(C.yellow) + (g.busyCost > 0 ? moneyTag(g.busyCost, asBill(b.bill)) + " " : "") + RST +
    fg(C.text) + clean(titleOf(b)) + RST : fg(C.dim) + "no activity yet" + RST;
  // the projection: after "busiest" when wide, else in its place (busiest stays first in the table order)
  const pj = projLine(); const bst = costNow("").bs.state;
  const pjs = (bst === "over" ? fg(C.red) : bst === "watch" ? fg(C.yellow) : fg(C.sub)) + pj + RST;
  // the projection is about all spend: under a filter the line shows the busiest matching session instead
  const cc = g.scoped ? callsChip(f, days) : "";
  const l3 = f !== EMPTY ? busiest + (cc ? dot + cc : "") : wide ? (b ? busiest + dot : "") + pjs : pjs;
  for (const [i, l] of [l1, l2, l3].entries()) put(1, 2 + i, " " + fitStyled(l, W - 4) + fillTo(fitStyled(l, W - 4), W - 4) + " ");
  const pm = periodMessage(f, days);
  if (pm) { // the period and the day clauses do not intersect: say so instead of empty tables
    box(0, 6, W, Math.max(3, Ht - 7), "filter", "", false);
    put(2, 7, fg(C.yellow) + fit(pm + " — d / w switch the period, / edits the filter", W - 4) + RST);
    for (let y = 8; y < Ht - 2; y++) put(1, y, " ".repeat(W - 2));
    return;
  }
  // per-harness table
  // harness sessions tools in out cache-r cache-w cost (with its billing tag), then lines; narrow: slimmer count columns so the tag fits
  const tight = W - 4 < 79;
  const cols = tight ? [10, 8, 7, 8, 8, 9, 9, 15] : [10, 9, 11, 8, 8, 9, 9, 15];
  let used = 0; for (const c of cols) used += c;
  // narrower still (60 columns): cache write, then cache read leave rather than cutting the cost column off
  for (let i = 6; i >= 5; i--) if (used > W - 4) { used -= numAt(cols, i, 0); cols[i] = 0; }
  const lw0 = Math.min(18, Math.max(0, W - 4 - used)); const lw = lw0 >= 9 ? lw0 : 0; // no room for "+12 −3": leave lines out
  const shareW = Math.max(0, W - 4 - used - lw - 2);
  const nh = HARNESSES.length;
  let up = unpricedLine(t.ms, 2); if (width(up) > W - 14) up = unpricedLine(t.ms, 1); // narrow: the top model and "+N models"
  box(0, 6, W, nh + (up ? 6 : 5), "by harness", "", false);
  const hdr = ["harness", "sessions", tight ? "tools" : "tool calls", "in", "out", "cache r", "cache w", "cost"];
  let hl = fg(C.dim);
  for (let i = 0; i < hdr.length; i++) hl += i === 0 ? fit(hdr[i] ?? "", numAt(cols, i, 0)) : rj(hdr[i] ?? "", numAt(cols, i, 0));
  hl += (lw ? rj("lines ±", lw) : "") + (shareW >= 6 ? "  " + fit(shareW >= 19 ? "share of tool calls" : shareW >= 14 ? "share of calls" : "share", shareW) : "") + RST;
  put(1, 7, " " + fitStyled(hl, W - 4) + " ");
  const row = (x: HA, y: number, label: string): void => {
    const lead = label ? fg(C.text) + CSI + "1m" + fit(label, 10) + RST : badge(x.h);
    const quiet = x.tools === 0 && x.inTok + x.outTok + x.cr === 0;
    const c = quiet ? fg(C.dim) : fg(C.text);
    let s = lead + c + rj(String(x.sess), numAt(cols, 1, 9)) + rj(grp(x.tools), numAt(cols, 2, 11)) + rj(kfmt(x.inTok), 8) + rj(kfmt(x.outTok), 8) + (cols[5] ? rj(kfmt(x.cr), 9) : "") + (cols[6] ? rj(kfmt(x.cw), 9) : "") + RST;
    const cs = cellOf(x);
    s += (cs === "?" ? fg(C.dim) : fg(C.yellow)) + rj(cs, 15) + RST;
    const ls = "+" + grp(x.add) + " −" + grp(x.del);
    if (lw) s += " ".repeat(Math.max(0, lw - width(ls))) + linesStr(x.add, x.del);
    if (shareW >= 6 && !label) s += "  " + gauge(t.tools ? x.tools / t.tools : 0, shareW - 5) + fg(C.sub) + rj(t.tools ? Math.round((x.tools / t.tools) * 100) + "%" : "", 5) + RST;
    put(1, y, " " + fitStyled(s, W - 4) + fillTo(fitStyled(s, W - 4), W - 4) + " ");
  };
  for (let i = 0; i < nh; i++) row(i < g.rows.length ? g.rows[i] : ha(""), 8 + i, "");
  put(1, 8 + nh, " " + fg(C.line) + "─".repeat(W - 4) + RST + " ");
  row(t, 9 + nh, "Σ total");
  if (up) {
    const hint = fg(C.dim) + " · $ set prices" + RST; // the price panel; narrow: fewer models before the hint is cut
    if (width(up) + 15 > W - 14) { const u1 = unpricedLine(t.ms, 1); if (width(u1) < width(up)) up = u1; }
    const ul = fg(C.dim) + fit("unpriced", 10) + RST + fg(C.sub) + up + RST + hint; put(1, 10 + nh, " " + fitStyled(ul, W - 4) + fillTo(fitStyled(ul, W - 4), W - 4) + " "); }
  // bottom: top tools | activity
  const y0 = 11 + nh + (up ? 1 : 0); const bh = Ht - 1 - y0;
  if (PP.open) { if (bh >= 4) renderPanel(0, y0, W, bh, days); else put(2, Ht - 2, fg(C.yellow) + fit("price panel: the terminal is too short — enlarge it or $ to close", W - 4) + RST); return; }
  if (bh < 5) return;
  const lw2 = Math.max(34, Math.floor(W * 0.42)); const rw = W - lw2;
  box(0, y0, lw2, bh, "top tools", String(g.names.size) + " distinct · ↵ details", false);
  const rows = toolRows(g.names, g.skills); lastRows = rows;
  let si = 0; for (const [i, r] of rows.entries()) if (r.key === selKey) si = i;
  const vis = bh - 2;
  if (si < ttop) ttop = si;
  if (si >= ttop + vis) ttop = si - vis + 1;
  ttop = Math.max(0, Math.min(ttop, rows.length - vis));
  listY0 = y0 + 1; listN = Math.min(vis, rows.length - ttop); listX1 = lw2;
  let mx = 1; for (const r of rows) if (!r.kid && r.n > mx) mx = r.n;
  const nw = Math.min(22, Math.max(8, Math.floor((lw2 - 4) * 0.4)));
  const bw = Math.max(0, lw2 - 4 - nw - 1 - 7 - 7);
  for (let r = 0; r < vis; r++) {
    const i = ttop + r;
    let l = "";
    const e = i < rows.length ? rows[i] : undefined;
    if (e) {
      const on = i === si;
      const fold = open.has(e.key) ? "▾ " : "▸ ";
      const label = e.server ? fold + "⧉ " + e.label : e.kid ? "   " + e.label : e.skill ? fold + e.label : e.label;
      l = (on ? fg(C.accent) + "▌" + RST + bg(C.sel) : " ") + (e.server ? fg(C.purple) : e.kid ? fg(C.sub) : e.skill ? fg(C.cyan) : fg(C.text)) + (on ? CSI + "1m" : "") + fit(label, nw) + RST + " " +
        gauge(e.n / mx, bw) + fg(e.kid ? C.dim : C.sub) + rj(grp(e.n), 7) + RST + errCol(e.n, e.err, 7);
    }
    const f = l || " ";
    put(1, y0 + 1 + r, f + fillTo(f, lw2 - 3) + " ");
  }
  if (!rows.length) put(2, y0 + 1, fg(C.dim) + "no tool calls in this period" + RST);
  const vals = week ? g.perDay : g.hours;
  box(lw2, y0, rw, bh, week ? "activity by day" : "activity by hour", "tool calls", false);
  chart(lw2 + 1, y0 + 1, rw - 2, bh - 2, vals, days, g.dayCost, single(t.ms) === "api" ? "$" : "≈$");
}
// error rate cell, right-aligned in w columns: "·" when clean, else green → red by rate (≥ 20% is full red)
function errCol(n: number, err: number, w: number): string {
  const r = n > 0 ? err / n : 0;
  const s = err === 0 ? "·" : (r < 0.1 ? (r * 100).toFixed(1) : String(Math.round(r * 100))) + "%";
  return " ".repeat(Math.max(0, w - s.length)) + fg(err === 0 ? C.dim : heat(Math.min(1, r * 5))) + s + RST;
}

// ── top-tools list: MCP servers and skills grouped (expandable), cursor by key so it survives re-sorting ──
// skill rows: the group (key SKILLS) and its kids (key "skill\t<name>"); a tool name never holds a tab, so neither collides
interface Row { key: string; label: string; n: number; err: number; kid: boolean; server: boolean; skill: boolean }
const SKILLS = "\tskills";
export const open = new Set<string>();
let selKey = ""; let ttop = 0; let lastRows: Row[] = [];
let listY0 = 0; let listN = 0; let listX1 = 0; // mouse geometry of the list
// skills: "<command | model>\t<name>" → one kid per name: "/" slash-command uses, "⚙" model-invoked, "/3 ⚙5" both
function skillKids(skills: Map<string, Cnt>): Row[] {
  const by = new Map<string, number[]>();
  for (const [k, c] of skills) { const i = k.indexOf("\t"); const nm = k.slice(i + 1); const v = by.get(nm) ?? [0, 0]; v[k.startsWith("command\t") ? 0 : 1] = (v[k.startsWith("command\t") ? 0 : 1] ?? 0) + c.n; by.set(nm, v); }
  const out: Row[] = [];
  for (const [nm, v] of by) {
    const cm = v[0] ?? 0; const md = v[1] ?? 0;
    // markers first: at 80 columns a long skill name is cut, its source must not be
    out.push({ key: "skill\t" + nm, label: (cm && md ? "/" + String(cm) + " ⚙" + String(md) : cm ? "/" : "⚙") + " " + nm, n: cm + md, err: 0, kid: true, server: false, skill: true });
  }
  return out;
}
export function toolRows(names: Map<string, Cnt>, skills: Map<string, Cnt>): Row[] {
  const top: Row[] = []; const srv = new Map<string, Row>(); const kids = new Map<string, Row[]>();
  for (const [name, c] of names) {
    const sv = mcpServer(name);
    if (!sv) { top.push({ key: name, label: display("tool", name, null), n: c.n, err: c.err, kid: false, server: false, skill: false }); continue; }
    const k = "mcp__" + sv;
    let r = srv.get(k);
    if (!r) { r = { key: k, label: sv, n: 0, err: 0, kid: false, server: true, skill: false }; srv.set(k, r); top.push(r); kids.set(k, []); }
    r.n = r.n + c.n; r.err = r.err + c.err;
    const ks = kids.get(k); if (ks) ks.push({ key: name, label: name.slice(k.length + 2), n: c.n, err: c.err, kid: true, server: false, skill: false });
  }
  if (skills.size) {
    const sk = skillKids(skills); let n = 0; for (const r of sk) n += r.n;
    top.push({ key: SKILLS, label: "✧ skills", n, err: 0, kid: false, server: false, skill: true }); kids.set(SKILLS, sk);
  }
  top.sort((x, y) => y.n - x.n);
  const out: Row[] = [];
  for (const r of top) {
    out.push(r);
    const ks = kids.get(r.key);
    if (ks && open.has(r.key)) for (const k of ks.sort((x, y) => y.n - x.n || (x.key < y.key ? -1 : 1))) out.push(k);
  }
  return out;
}
function selIdx(): number { for (const [i, r] of lastRows.entries()) if (r.key === selKey) return i; return 0; }
function rowAt(i: number): Row | null { const r = i >= 0 && i < lastRows.length ? lastRows[i] : undefined; return r ? r : null; }
function selRow(): Row | null { return rowAt(selIdx()); }
function moveSel(d: number): void { const r = rowAt(Math.max(0, Math.min(lastRows.length - 1, selIdx() + d))); if (r) selKey = r.key; }
function parentKey(r: Row): string { return r.skill ? SKILLS : "mcp__" + mcpServer(r.key); }
function toggle(r: Row, want: number): void { // want: 1 open, 0 close, -1 flip
  const k = r.kid ? parentKey(r) : r.key;
  if (!r.server && !r.kid && !r.skill) return;
  const isOpen = open.has(k);
  if (want !== 1 && isOpen) { open.delete(k); selKey = k; } else if (want !== 0 && !isOpen) open.add(k);
}

// ── drill-down: one tool or MCP server over the period ─────────────────────
interface DR { path: string; h: string; r: Rec; err: boolean }
interface DA { key: string; ver: number; at: number; n: number; err: number; dn: number; ms: number; max: number; out: number; hist: number[]; vals: number[]; hs: number[]; all: number;
  prog: Map<string, Cnt>; cmds: Map<string, Cnt>; files: Map<string, Cnt>; kids: Map<string, Cnt>; slow: DR[]; errs: DR[] }
let dKey = ""; let dServer = false; let dLabel = ""; let dsel = 0; let dList: DR[] = [];
const hitY: number[] = []; const hitX0: number[] = []; const hitX1: number[] = []; const hitI: number[] = [];
let dCache: DA | null = null;
function prefixed(src: Map<string, Cnt>, pre: string, dst: Map<string, Cnt>): void {
  for (const [k, c] of src) if (k.startsWith(pre)) addCnt(dst, k.slice(pre.length), c.n, c.err, c.add, c.del);
}
function dagg(days: string[]): DA {
  const f = statsFilter();
  const key = days.join(",") + "|" + dKey + "|" + f.key;
  const hit = dCache;
  if (hit && hit.key === key && hit.ver === L.ver && Date.now() - hit.at < Math.min(3000, timeStep(f.cs))) return hit;
  const da: DA = { key, ver: L.ver, at: Date.now(), n: 0, err: 0, dn: 0, ms: 0, max: 0, out: 0, hist: zeros(HB), vals: zeros(days.length > 1 ? days.length : 24), hs: zeros(HARNESSES.length), all: 0,
    prog: new Map<string, Cnt>(), cmds: new Map<string, Cnt>(), files: new Map<string, Cnt>(), kids: new Map<string, Cnt>(), slow: [], errs: [] };
  const pre = dKey + "\t";
  if (f.needsCalls) { rowDrill(da, f, days); dCache = da; return da; }
  const cp = contentOk(f);
  for (const s of sessions.values()) {
    const a = ledger.get(s.path); if (!a || !sessOk(f, cp, s)) continue;
    const hi = harnessIndex(s.h); if (hi < 0) continue;
    for (let i = 0; i < days.length; i++) {
      const dk = days[i] ?? ""; const d = a.days.get(dk); if (!d) continue;
      if (f !== EMPTY && !dayMatches(f, s, dk, d)) continue;
      da.all = da.all + d.tools;
      for (const [name, st] of heavy(d).tt) {
        if (dServer ? !name.startsWith(dKey + "__") : name !== dKey) continue;
        da.n = da.n + st.n; da.err = da.err + st.err; da.dn = da.dn + st.dn; da.ms = da.ms + st.ms; da.out = da.out + st.out;
        if (st.max > da.max) da.max = st.max;
        for (let b = 0; b < HB; b++) da.hist[b] = numAt(da.hist, b, 0) + numAt(st.hist, b, 0);
        if (days.length > 1) da.vals[i] = numAt(da.vals, i, 0) + st.n;
        else for (let hh = 0; hh < 24; hh++) da.vals[hh] = numAt(da.vals, hh, 0) + numAt(st.h, hh, 0);
        da.hs[hi] = numAt(da.hs, hi, 0) + st.n;
        if (dServer) addCnt(da.kids, name.slice(dKey.length + 2), st.n, st.err, 0, 0);
        for (const r of st.slow) da.slow.push({ path: s.path, h: s.h, r, err: false });
        for (const r of st.errs) da.errs.push({ path: s.path, h: s.h, r, err: true });
      }
      if (!dServer) { prefixed(heavy(d).prog, pre, da.prog); prefixed(heavy(d).cmds, pre, da.cmds); prefixed(heavy(d).files, pre, da.files); }
    }
  }
  da.slow = da.slow.sort((x, y) => y.r.ms - x.r.ms).slice(0, 10);
  da.errs = da.errs.sort((x, y) => y.r.t - x.r.t).slice(0, 10);
  dCache = da;
  return da;
}
// the drill-down from call rows (a filter with call clauses): counts, durations, programs/commands/files of the matching
// calls; slowest/error lists keep only the remembered calls whose id is a matching row's
function rowDrill(da: DA, f: Compiled, days: string[]): void {
  const ids = new Set<string>(); const pathsOf = new Set<string>();
  const ix = new Map<string, number>(); for (let i = 0; i < days.length; i++) ix.set(days[i] ?? "", i); const cp = contentOk(f);
  eachCall(f, days, (s: Sess, c: Call) => {
    if (!cp(s.path)) return;
    da.all = da.all + 1;
    const name = nameOf(DICT.tool, c.tool);
    if (dServer ? !name.startsWith(dKey + "__") : name !== dKey) return;
    const hi = harnessIndex(s.h); const lo = localOf(c.t);
    da.n = da.n + 1; if (c.err === 1) da.err = da.err + 1; if (c.err >= 0) da.out = da.out + c.out;
    if (c.ms >= 0) { da.dn = da.dn + 1; da.ms = da.ms + c.ms; if (c.ms > da.max) da.max = c.ms; const b = hb(c.ms); da.hist[b] = numAt(da.hist, b, 0) + 1; }
    if (days.length > 1) { const i = ix.get(lo.day) ?? -1; if (i >= 0) da.vals[i] = numAt(da.vals, i, 0) + 1; } else da.vals[lo.hour] = numAt(da.vals, lo.hour, 0) + 1;
    if (hi >= 0) da.hs[hi] = numAt(da.hs, hi, 0) + 1;
    if (dServer) addCnt(da.kids, name.slice(dKey.length + 2), 1, c.err === 1 ? 1 : 0, 0, 0);
    else {
      for (const p of c.progs) addCnt(da.prog, nameOf(DICT.prog, p), 1, c.err === 1 ? 1 : 0, 0, 0);
      for (const m of c.cmds) addCnt(da.cmds, nameOf(DICT.cmd, m), 1, c.err === 1 ? 1 : 0, 0, 0);
      for (const fl of c.files) addCnt(da.files, nameOf(DICT.file, fl), 1, 0, 0, 0);
    }
    if (c.cid) ids.add(c.cid);
    pathsOf.add(s.path);
  });
  for (const p of pathsOf) {
    const s = sessions.get(p); const a = ledger.get(p); if (!s || !a) continue;
    for (const dk of days) {
      const d = a.days.get(dk); if (!d) continue;
      for (const [name, st] of heavy(d).tt) {
        if (dServer ? !name.startsWith(dKey + "__") : name !== dKey) continue;
        for (const r of st.slow) if (ids.has(r.id)) da.slow.push({ path: s.path, h: s.h, r, err: false });
        for (const r of st.errs) if (ids.has(r.id)) da.errs.push({ path: s.path, h: s.h, r, err: true });
      }
    }
  }
  da.slow = da.slow.sort((x, y) => y.r.ms - x.r.ms).slice(0, 10);
  da.errs = da.errs.sort((x, y) => y.r.t - x.r.t).slice(0, 10);
}
function openDrill(r: Row): void {
  if (r.skill) { if (!r.kid) toggle(r, -1); return; } // no per-skill drill-down: ↵ on the group folds it like ␣
  dKey = r.key; dServer = r.server; dLabel = r.server ? "⧉ " + r.label : display("tool", r.key, null); dsel = 0; dCache = null; }
function top(m: Map<string, Cnt>, n: number): [string, Cnt][] { return [...m.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, n); }
// keep the end of long paths: the file name matters more than the root
function tail(s: string, w: number): string { const a: string[] = []; for (const ch of s) a.push(ch); return a.length <= w ? fit(s, w) : "…" + a.slice(a.length - w + 1).join(""); }
function glyph(h: string): string { const ad = harnessOf(h); return fg(ad.color()) + ad.mark + RST; }
function when(t: number, wk: boolean): string {
  if (t <= 0) return "--:--";
  const d = new Date(t); const hm = (d.getHours() < 10 ? "0" : "") + d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes();
  const wd = d.getDay();
  return wk ? WD.slice(wd * 2, wd * 2 + 2) + " " + hm : hm + ":" + (d.getSeconds() < 10 ? "0" : "") + d.getSeconds();
}
// rows of a (name, gauge, calls, error rate) table
function cntRows(x: number, y: number, w: number, h: number, rows: [string, Cnt][], total: number, empty: string, kind: string): void {
  const nw = Math.max(8, Math.floor((w - 4) * 0.45)); const bw = Math.max(0, w - 4 - nw - 1 - 7 - 7);
  let mx = 1; for (const r of rows) if (r[1].n > mx) mx = r[1].n;
  for (let i = 0; i < h; i++) {
    const e = rows[i];
    const l = e ? fg(C.text) + fit(kind ? display(kind, e[0], null) : e[0], nw) + RST + " " + gauge(e[1].n / mx, bw) + fg(C.sub) + rj(grp(e[1].n), 7) + RST + errCol(e[1].n, e[1].err, 7) : i === 0 && !rows.length ? fg(C.dim) + empty + RST : "";
    const f = fitStyled(l, w - 4);
    put(x + 1, y + i, " " + f + fillTo(f, w - 4) + " ");
  }
}
function recRows(x: number, y: number, w: number, h: number, list: DR[], base: number, wk: boolean, empty: string): void {
  for (let i = 0; i < h; i++) {
    let l = "";
    const e = i < list.length ? list[i] : undefined;
    if (e) {
      const on = base + i === dsel;
      const a = clean(display("tool:" + dKey, e.r.arg, sessions.get(e.path) ?? null) || "(no arguments)"); const aw = w - 3 - (wk ? 9 : 8) - 7 - 4;
      const arg = a.startsWith("/") && a.indexOf(" ") < 0 ? tail(home(a), aw) : a; // a bare path: keep its file name
      l = (on ? fg(C.accent) + "▌" + RST + bg(C.sel) : " ") + fg(C.dim) + fit(when(e.r.t, wk), wk ? 9 : 8) + RST + (on ? bg(C.sel) : "") + fg(e.r.ms >= 60000 ? C.red : e.r.ms >= 10000 ? C.yellow : C.text) + rj(fmtMs(e.r.ms), 7) + RST + " " + glyph(e.h) + " " +
        (on ? bg(C.sel) : "") + fg(e.err ? C.red : C.sub) + arg + RST;
      hitY.push(y + i); hitX0.push(x); hitX1.push(x + w); hitI.push(base + i);
    } else if (i === 0 && !list.length) l = " " + fg(C.dim) + empty + RST;
    const f = fitStyled(l, w - 3);
    put(x + 1, y + i, f + fillTo(f, w - 3) + " ");
  }
}
function renderDrill(days: string[]): void {
  const W = S.W; const Ht = S.H; const wk = days.length > 1;
  const da = dagg(days);
  dList = da.slow.concat(da.errs);
  dsel = Math.max(0, Math.min(dsel, dList.length - 1));
  hitY.length = 0; hitX0.length = 0; hitX1.length = 0; hitI.length = 0;
  // header
  const ch = statsFilter() === EMPTY ? "" : chips("Stats", "stats", Math.max(10, W - 40));
  box(0, 1, W, 5, dLabel, ch ? ch + fg(C.dim) + " · " + (wk ? "last 7 days" : "today") + " · esc back" + RST : (wk ? "last 7 days" : "today") + " · esc back", true);
  const er = da.n ? da.err / da.n : 0;
  const errs = da.err === 0 ? fg(C.green) + "no errors" + RST : fg(heat(Math.min(1, er * 5))) + CSI + "1m" + grp(da.err) + " errors" + RST + fg(C.sub) + " (" + (er < 0.1 ? (er * 100).toFixed(1) : String(Math.round(er * 100))) + "%)" + RST;
  const l1 = fg(C.text) + CSI + "1m" + grp(da.n) + RST + fg(C.sub) + " calls" + RST + dot + errs + dot + fg(C.text) + (da.all ? ((da.n / da.all) * 100).toFixed(1) : "0") + "%" + RST + fg(C.sub) + " of all " + grp(da.all) + " tool calls" + RST;
  const p = (q: number): string => fg(C.text) + fmtMs(da.dn ? pct(da.hist, q, da.max) : -1) + RST;
  const l2 = fg(C.accent) + "⏱ " + RST + fg(C.sub) + "p50 " + RST + p(0.5) + fg(C.sub) + "   p95 " + RST + p(0.95) + fg(C.sub) + "   max " + RST + fg(C.text) + fmtMs(da.dn ? da.max : -1) + RST +
    fg(C.sub) + "   avg " + RST + fg(C.text) + fmtMs(da.dn ? da.ms / da.dn : -1) + RST + dot + fg(C.dim) + "timed " + grp(da.dn) + "/" + grp(da.n) + RST +
    (da.out > 0 && da.n ? dot + fg(C.sub) + "≈" + bytes(Math.round(da.out / da.n)) + " per result" + RST : "");
  let l3 = "";
  for (let i = 0; i < HARNESSES.length; i++) { const c = numAt(da.hs, i, 0); if (c) l3 += badge(HARNESSES[i].id) + fg(C.text) + grp(c) + RST + " " + gauge(c / Math.max(1, da.n), 10) + fg(C.sub) + " " + Math.round((c / Math.max(1, da.n)) * 100) + "%   " + RST; }
  for (const [i, l] of [l1, l2, l3].entries()) put(1, 2 + i, " " + fitStyled(l, W - 4) + fillTo(fitStyled(l, W - 4), W - 4) + " ");
  // middle: calls over time | breakdown
  const y1 = 6; const R = Ht - 1 - y1;
  const h1 = Math.max(8, Math.floor(R * 0.45)); const h2 = R - h1;
  const cw = Math.max(wk ? 45 : 38, Math.floor(W * 0.38)); const rw = W - cw; // 7 days need 5 columns per "Mo 21" label
  box(0, y1, cw, h1, wk ? "calls by day" : "calls by hour", "", false);
  chart(1, y1 + 1, cw - 2, h1 - 2, da.vals, days, zeros(days.length), "");
  const ih = h1 - 2;
  if (dServer) {
    box(cw, y1, rw, h1, "tools", String(da.kids.size) + " used", false);
    cntRows(cw, y1 + 1, rw, ih, top(da.kids, ih), da.n, "no calls", "");
  } else if (da.prog.size) {
    const pw = Math.min(40, Math.floor(rw * 0.4));
    box(cw, y1, pw, h1, "programs", String(da.prog.size), false);
    cntRows(cw, y1 + 1, pw, ih, top(da.prog, ih), da.n, "", "prog");
    box(cw + pw, y1, rw - pw, h1, "top commands", String(da.cmds.size) + " distinct", false);
    cntRows(cw + pw, y1 + 1, rw - pw, ih, top(da.cmds, ih), da.n, "", "cmd");
  } else if (da.files.size) {
    box(cw, y1, rw, h1, "most-changed files", String(da.files.size) + " files", false);
    const fw = rw - 4; const cols = 22; const pw = Math.max(10, fw - cols);
    const fs = top(da.files, ih);
    for (let i = 0; i < ih; i++) {
      const e = fs[i];
      const l = e ? fg(C.text) + tail(home(display("file", e[0], null)) || "(unknown)", pw) + RST + fg(C.sub) + rj(grp(e[1].n) + "×", 6) + RST + " " + fg(C.green) + rj("+" + grp(e[1].add), 7) + RST + " " + fg(C.red) + fit("−" + grp(e[1].del), 7) + RST : "";
      const f = fitStyled(l, fw);
      put(cw + 1, y1 + 1 + i, " " + f + fillTo(f, fw) + " ");
    }
  } else {
    box(cw, y1, rw, h1, "duration histogram", da.dn ? grp(da.dn) + " timed" : "", false);
    let b0 = HB; let b1 = -1;
    for (let b = 0; b < HB; b++) if (numAt(da.hist, b, 0) > 0) { if (b < b0) b0 = b; b1 = b; }
    if (b1 < 0) put(cw + 2, y1 + 1, fg(C.dim) + "no durations recorded (fx logs a turn's events with one timestamp)" + RST);
    else {
      if (b1 - b0 + 1 > ih) b0 = Math.max(0, b1 - ih + 1);
      let mx = 1; for (let b = b0; b <= b1; b++) mx = Math.max(mx, numAt(da.hist, b, 0));
      for (let b = b0; b <= b1; b++) {
        const c = numAt(da.hist, b, 0);
        const l = fg(C.sub) + rj((b === 0 ? "<" : "≥") + fmtMs(numAt(EDGE, b === 0 ? 0 : b - 1, 0)), 8) + RST + " " + gauge(c / mx, Math.max(4, rw - 22)) + fg(C.text) + rj(grp(c), 8) + RST;
        put(cw + 1, y1 + 1 + b - b0, " " + fitStyled(l, rw - 4) + fillTo(fitStyled(l, rw - 4), rw - 4) + " ");
      }
    }
  }
  // bottom: slowest calls | recent errors (↵ opens the session at that call)
  if (h2 < 3) return;
  const y2 = y1 + h1; const hw = Math.floor(W / 2);
  box(0, y2, hw, h2, "slowest calls", "↵ open session", dsel < da.slow.length && dList.length > 0);
  recRows(0, y2 + 1, hw, h2 - 2, da.slow, 0, wk, "no timed calls");
  box(hw, y2, W - hw, h2, "most recent errors", grp(da.err) + " total", dsel >= da.slow.length && dList.length > 0);
  recRows(hw, y2 + 1, W - hw, h2 - 2, da.errs, da.slow.length, wk, "no errors");
}
function jump(x: DR): void {
  const s = sessions.get(x.path);
  if (!s) { say("warn", "that session is no longer on disk"); return; }
  openTranscript(s);
  const t = S.tv;
  if (t && x.r.id) { t.focusKind = "tool"; t.focusTs = x.r.ts; t.focusText = x.r.id; } // focusText may name the event id
}
// vertical block-bar chart with a heat gradient (green at the bottom → red at the top); dayCost labels the 7-day view
// cur = the per-day cost labels' currency mark: "$" only when every figure is API spend
// labels under a bar column of cw cells keep the bars' gap (cw > 2: the bar is cw − 1 wide), else they run together
// ("Mo 28Tu 29", "≈1615≈1348"): the weekday goes first, then the cents, then the "$", then the figure shrinks to 1.6K
export function dayLabel(wd: number, dom: number, cw: number): string {
  const room = cw > 2 ? cw - 1 : cw; // "Mo 28" on every column or on none: the same form across the axis
  return room >= 5 ? WD.slice(wd * 2, wd * 2 + 2) + " " + String(dom) : String(dom);
}
export function costLabel(c: number, cur: string, cw: number): string {
  if (c <= 0) return "";
  const room = cw > 2 ? cw - 1 : cw; const cn = c < 100 ? c.toFixed(1) : String(Math.round(c)); const one = cur === "$" ? "$" : "≈";
  for (const l of [cur + cn, one + cn, one + kfmt(c), kfmt(c)]) if (width(l) <= room) return l;
  return "";
}
// the hour axis under bars of cwid < 3 cells: every third hour, its figure running into the empty columns after it;
// ▲ marks now, and a figure that would touch it is left out
export function hourAxis(n: number, cwid: number, h0: number, nowH: number): string {
  const cells: string[] = []; for (let i = 0; i < n * cwid; i++) cells.push(" ");
  const nc = (nowH - h0) * cwid;
  for (let i = 0; i < n; i++) {
    const hr = h0 + i; const lab = String(hr); const at = i * cwid;
    if (hr % 3 !== 0 || hr === nowH || (nc >= at - 1 && nc <= at + lab.length) || at + lab.length > n * cwid) continue;
    for (let j = 0; j < lab.length; j++) cells[at + j] = lab.charAt(j);
  }
  if (nc >= 0 && nc < cells.length) cells[nc] = "▲";
  return cells.join("");
}
// today's first hour shown when 24 bars do not fit in room cells: the hours up to now that fit
export function hourStart(len: number, room: number, nowH: number): number { return len > room ? Math.max(0, Math.min(len - room, nowH + 1 - room)) : 0; }
function chart(x: number, y: number, w: number, h: number, all: number[], days: string[], dayCost: number[], cur: string): void {
  const ch = h - 2; const axis = 5; const nowH = new Date().getHours();
  // today's 24 hours in fewer cells (60 columns): the hours up to now that fit, rather than bars past the box
  const room = Math.max(1, w - axis - 1); const h0 = days.length === 1 ? hourStart(all.length, room, nowH) : 0;
  const vals = days.length === 1 && all.length > room ? all.slice(h0, h0 + room) : all;
  const n = vals.length;
  const cwid = Math.max(1, Math.floor((w - axis - 1) / n));
  let mx = 0; for (const v of vals) if (v > mx) mx = v;
  for (let r = 0; r < ch; r++) {
    const lab = r === 0 ? rj(kfmt(mx), axis - 1) + "┤" : r === ch - 1 ? rj("0", axis - 1) + "┤" : " ".repeat(axis - 1) + "│";
    let l = fg(C.dim) + lab + RST + fg(heat(1 - r / Math.max(1, ch - 1)));
    const level = (ch - 1 - r) * 8;
    for (let i = 0; i < n; i++) {
      const v = numAt(vals, i, 0);
      const e = mx > 0 ? Math.round((v / mx) * ch * 8) : 0;
      const k = Math.max(0, Math.min(8, e - level));
      const cell = (v > 0 && k === 0 && r === ch - 1) ? "▁" : (BLK[k] ?? " "); // keep tiny nonzero values visible
      l += cell.repeat(Math.max(1, cwid - (cwid > 2 ? 1 : 0))) + (cwid > 2 ? " " : "");
    }
    put(x, y + r, " " + l + RST + " ".repeat(Math.max(0, w - 1 - axis - n * cwid)));
  }
  // labels
  let l1 = " ".repeat(axis); let l2 = " ".repeat(axis);
  for (let i = 0; i < n; i++) {
    if (days.length > 1) {
      // bars without a gap (60 columns): every other day, today's included, labels its own and the next column
      const pair = cwid <= 2 && (n - 1 - i) % 2 === 1;
      if (pair) { if (i === 0) { l1 += " ".repeat(cwid); l2 += " ".repeat(cwid); } continue; }
      const span = cwid <= 2 && i < n - 1 ? 2 * cwid : cwid;
      const d = new Date(startOfDay() + 43200000 - (n - 1 - i) * 86400000);
      l1 += fg(i === n - 1 ? C.accent : C.sub) + fit(dayLabel(d.getDay(), d.getDate(), span), span) + RST;
      l2 += fg(C.yellow) + fit(costLabel(numAt(dayCost, i, 0), cur, span), span) + RST;
    } else if (cwid >= 3) {
      const hr = h0 + i; const lab = hr % 2 === 0 ? String(hr) : "";
      l1 += fg(hr === nowH ? C.accent : C.dim) + fit(hr === nowH ? "▲" + String(hr) : lab, cwid) + RST;
    }
  }
  if (days.length === 1 && cwid < 3) { const ax = hourAxis(n, cwid, h0, nowH); const k = ax.indexOf("▲"); l1 += k < 0 ? fg(C.dim) + ax + RST : fg(C.dim) + ax.slice(0, k) + fg(C.accent) + "▲" + fg(C.dim) + ax.slice(k + 1) + RST; }
  if (days.length === 1) {
    let pk = 0; for (let i = 0; i < 24; i++) if (numAt(all, i, 0) > numAt(all, pk, 0)) pk = i;
    l2 += fg(C.dim) + "peak " + RST + fg(C.text) + pk + ":00" + RST + fg(C.dim) + " · " + grp(numAt(all, pk, 0)) + (w >= 34 ? " calls · ▲ now" : " calls") + RST;
  }
  put(x, y + ch, " " + fitStyled(l1, w - 1)); put(x, y + ch + 1, " " + fitStyled(l2, w - 1));
}
function budgetInfo(): void {
  if (budget.usd <= 0) { say("info", "no budget — set budget.monthlyUsd in " + home(CONFIG_FILE)); return; }
  const c = costNow(""); const ap = c.bs.approx ? "≈" : "";
  const pr = c.bs.projected >= 0 ? " · projected " + ap + "$" + grp(c.bs.projected) : "";
  say(c.bs.state === "over" ? "warn" : "info", "budget $" + grp(budget.usd) + "/month (counts " + budget.counts.join(", ") + "): " + c.bs.state + " · used " + ap + "$" + c.bs.used.toFixed(2) + pr + " · " + home(CONFIG_FILE));
}
function key(k: string): boolean {
  if (k === "B") { budgetInfo(); return true; }
  if (k === "d") { week = false; return true; }
  if (k === "w") { week = true; return true; }
  if (k === "$" && !dKey && !PP.open) { PP.open = true; return true; } // the price panel (pricepanel.ts) in place of the bottom boxes
  if (PP.open && !dKey && panelKey(k, period())) return true;
  if (dKey) {
    if (k === "esc" || k === "bs") { dKey = ""; return true; }
    if (k === "up" || k === "k" || k === "wheelup") dsel = Math.max(0, dsel - 1);
    else if (k === "down" || k === "j" || k === "wheeldown") dsel = Math.min(Math.max(0, dList.length - 1), dsel + 1);
    else if (k === "home" || k === "g") dsel = 0;
    else if (k === "end" || k === "G") dsel = Math.max(0, dList.length - 1);
    else if (k === "enter") { const x = dsel < dList.length ? dList[dsel] : undefined; if (x) jump(x); }
    else if (k === "left") week = false;
    else if (k === "right") week = true;
    else return false;
    return true;
  }
  const r = selRow();
  const grouped = r !== null && (r.server || r.kid || r.skill);
  if (k === "up" || k === "k" || k === "wheelup") moveSel(-1);
  else if (k === "down" || k === "j" || k === "wheeldown") moveSel(1);
  else if (k === "pgup") moveSel(-10);
  else if (k === "pgdn") moveSel(10);
  else if (k === "home" || k === "g") moveSel(-lastRows.length);
  else if (k === "end" || k === "G") moveSel(lastRows.length);
  else if (k === " ") { if (r) toggle(r, -1); }
  else if (k === "enter") { if (r) openDrill(r); }
  // ←/→ fold an MCP server or the skills group when one is selected, else switch the period
  else if (k === "right") { if (r && (r.server || (r.skill && !r.kid)) && !open.has(r.key)) toggle(r, 1); else week = true; }
  else if (k === "left") { if (r && grouped && (r.kid || open.has(r.key))) toggle(r, 0); else week = false; }
  else return false;
  return true;
}
function mouse(x: number, y: number, dbl: boolean): void {
  if (PP.open && !dKey && y !== 2) return; // the panel: keys only (the period chips still click)
  if (dKey) {
    for (let i = 0; i < hitY.length; i++) {
      if (y !== numAt(hitY, i, -1) || x < numAt(hitX0, i, 0) || x >= numAt(hitX1, i, 0)) continue;
      const j = numAt(hitI, i, 0);
      if (j === dsel || dbl) { dsel = j; key("enter"); } else dsel = j;
    }
    return;
  }
  if (y === 2 && x >= 2 && x < 22) { week = x >= 12; return; } // the Today / 7 days chips
  if (y < listY0 || y >= listY0 + listN || x >= listX1) return;
  const r = rowAt(ttop + (y - listY0)); if (!r) return;
  if (r.key === selKey || dbl) { selKey = r.key; openDrill(r); } else selKey = r.key;
}
const tab: Tab = { name: "Stats", render: renderStats, key, mouse };
H.tabs.push(tab);
PP.period = period; PP.label = (): string => (week ? "7 days" : "today");
setStatsGo((): void => { S.tab = H.tabs.indexOf(tab) + 2; S.mode = "list"; dKey = ""; });
function mine(): boolean { return S.tab - 2 === H.tabs.indexOf(tab); }

// ── preview, header, footer, help ───────────────────────────────────────────
H.previewSections.push((s: Sess, w: number): string[] => {
  const a = accOf(s);
  const k = fg(C.dim) + fit("usage", 9) + RST;
  if (pending(s, a) && a.off < s.size * 0.98) return [k + fg(C.yellow) + spin() + " indexing " + Math.floor((a.off / Math.max(1, s.size)) * 100) + "%" + RST];
  const tok = fg(C.cyan) + "↑" + kfmt(s.inTok) + " " + RST + fg(C.purple) + "↓" + kfmt(s.outTok) + " " + RST + fg(C.accent) + "↻" + kfmt(s.cacheRTok + s.cacheWTok) + RST;
  const bill = asBill(s.bill); const pl = bill === "plan" && s.plan ? fg(C.sub) + " (" + planLabel(s.plan, REDACT) + ")" + RST : "";
  // narrow (60 columns): the lines, then the tool count go whole rather than being cut mid-figure
  const es = estTop(a); // alias-priced share: an estimate, ≈ even on an API key
  const tl = [k + tok + dot + (s.cost < 0 ? fg(C.dim) + "cost ?" : fg(C.yellow) + moneyTag(s.cost, bill, es.usd > 1e-9)) + RST + pl, fg(C.text) + grp(s.tools) + RST + fg(C.sub) + " tools" + RST, linesStr(s.linesAdd, s.linesDel)];
  if (es.usd > 0.005) tl.splice(1, 0, fg(C.dim) + "incl. " + money(es.usd, "", true) + " alias (" + es.model + (es.n > 1 ? " +" + String(es.n - 1) : "") + ")" + RST);
  while (tl.length > 1 && vwidth(tl.join(dot)) > w) tl.pop();
  const out = [tl.join(dot)];
  const pad = fit("", 9);
  if (s.unkTok > 0 || s.unkCr > 0) {
    let top = ""; let tn = 0; const um = new Map<string, number>();
    for (const dd of a.days.values()) for (const [m, n] of dd.um) { const v = (um.get(m) ?? 0) + n; um.set(m, v); if (v > tn) { tn = v; top = m; } }
    const parts: string[] = [];
    if (s.unkTok > 0) parts.push("+ " + kfmt(s.unkTok) + " tok unpriced" + (top ? " (" + top + (um.size > 1 ? " +" + String(um.size - 1) : "") + ")" : ""));
    if (s.unkCr > 0) parts.push("+ " + kfmt(s.unkCr) + " credits (set kiroCreditUsd)");
    out.push(pad + fg(C.sub) + parts.join(" · ") + RST);
  }
  if (s.billSrc === "config") out.push(pad + fg(C.dim) + "billing assumed from current config" + RST);
  const d = a.days.get(todayKey());
  if (d && a.days.size > 1 && w > 30) out.push(fg(C.dim) + fit("today", 9) + RST + fg(C.yellow) + (d.cost === 0 && (d.unk > 0 || d.uc > 0) ? "cost ?" : moneyTag(d.cost, bill)) + RST + dot + fg(C.text) + grp(d.tools) + RST + fg(C.sub) + " tools" + RST + dot + linesStr(d.add, d.del));
  const sk = new Map<string, number>(); for (const u of skillUses(a, null)) sk.set(u.name, (sk.get(u.name) ?? 0) + u.n); // both sources per name
  if (sk.size && w > 30) out.push(fg(C.dim) + fit("skills", 9) + RST + [...sk.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).slice(0, 5)
    .map((e) => fg(C.cyan) + e[0] + RST + (e[1] > 1 ? fg(C.dim) + " ×" + String(e[1]) + RST : "")).join(fg(C.dim) + ", " + RST) + (sk.size > 5 ? fg(C.dim) + " +" + String(sk.size - 5) + RST : ""));
  return out;
});
// an allowance gauge " · <tag> 5h 13% 7d 64%": every window, the fuller in heat colour + bold; narrow drops the others, then the gauge
export function allowGauge(tag: string, ws: GW[], w: number): string {
  const part = (x: GW): string => (x.hi ? fg(heat(x.pct / 100)) + CSI + "1m" : fg(C.dim)) + x.lbl + " " + String(x.pct) + "%" + RST;
  const build = (xs: GW[]): string => { if (!xs.length) return ""; let t = fg(C.dim) + " · " + tag + RST; for (const x of xs) t += " " + part(x); return t; };
  for (const xs of [ws, ws.filter((x: GW) => x.hi)]) { const g = build(xs); if (g && vwidth(g) <= w) return g; }
  return "";
}
H.headerWidgets.push((w: number): string => {
  if (w < 14) return "";
  const cn = costNow(""); const st = cn.bs.state;
  const col = st === "over" ? fg(C.red) + CSI + "1m" : st === "watch" ? fg(C.yellow) + CSI + "1m" : fg(C.yellow);
  let fig = split(cn.today, w < 40);
  if (width(fig) + 6 > w) fig = split(cn.today, true); // a mixed split that does not fit shrinks to the ≈ total
  let s = col + fig + RST + fg(C.dim) + " today" + RST; let n = width(fig) + 6;
  const cx = allowGauge("cx", gaugeWins(L.rl, Date.now()), w - n); s += cx; n += vwidth(cx); // Codex rate limits
  const al = allowance(); // Claude plan allowance
  if (al) { const cc = allowGauge("cc", claudeWins(al), w - n); s += cc; n += vwidth(cc); }
  return n <= w ? s : "";
});
H.footerHints.push((mode: string): string[][] => {
  if (mode !== "list" || !mine()) return [];
  if (dKey) return [["↑↓", "call"], ["↵", "open session"], ["esc", "back"], ["d", "today"], ["w", "7 days"], ["/", "filter"]];
  if (PP.open) return [["↑↓", "model"], ["↵", "price"], ["a", "alias"], ["x", "remove"], ["$", "close"], ["d", "today"], ["w", "7 days"]];
  return [["↑↓", "tool"], ["↵", "details"], ["$", "prices"], ["␣", "expand MCP/skills"], ["d", "today"], ["w", "7 days"], ["/", "filter"], ["p", "pin"], ["P", "pins"], ["B", "budget"]];
});
H.helpSections.push({ name: "stats", ctx: "Stats", keys: [["d  ←", "today"], ["w  →", "last 7 days"], ["↑↓ jk", "select a tool (top tools)"], ["␣  → ←", "expand / fold an MCP server or the skills group"],
  ["↵  click", "tool drill-down: durations, errors, commands, files"], ["↵", "drill-down: open the session at that call"], ["esc", "close the drill-down"],
  ["B", "budget: current state and the config path"], ["t", "triage the Stats filter's calls (drill-down: that tool's errors)"], ["C", "compare this period with the previous one (today vs yesterday, 7 days vs the 7 before)"],
  ["/  p  P", "filter Stats (tool is Bash, repo is x, day >= -3d…) · pin it · edit pins"],
  ["$", "prices: every model of the period with its price source; ↵ set a price, a alias, x remove (see prices below)"],
  ["", "costs = API list price (" + pricesFrom() + "); prices.json, aliases and gateway configs override it"],
  ["", "cost tags: spend = API key (real), plan = list-price equivalent, cloud = Bedrock/Vertex/Foundry, gw = gateway, ? = unknown; * = assumed from current config"],
  ["", "projection: today from the 14-day hourly profile, month from the 14-day mean; history = what is still on disk"]] });
