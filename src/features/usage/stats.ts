// agentglass — Stats tab, preview usage line and header cost widget, all read from the usage ledger
// SPDX-License-Identifier: Apache-2.0
import { fit, fitStyled, fillTo, width, clean, numAt, home, bytes } from "../../util/text.ts";
import type { Sess } from "../../model/types.ts";
import { S, say } from "../../state.ts";
import { H, type Tab, display } from "../../hooks.ts";
import { sessions, titleOf } from "../../model/sessions.ts";
import { C, CSI, RST, fg, bg, heat } from "../../ui/theme.ts";
import { put, box, badge, gauge, spin } from "../../ui/screen.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { ledger, accOf, pending } from "./ledger.ts";
import { L, todayKey, lastDays, startOfDay } from "./record.ts";
import { PRICES_FROM } from "./pricing.ts";
import { type Rec, type Cnt, HB, EDGE, newCnt, pct, fmtMs, mcpServer } from "./calls.ts";
import "./cache.ts";
import "./bill-live.ts";
import { HARNESSES, harnessOf, harnessIndex } from "../../harness/index.ts";

// ── formatting ──────────────────────────────────────────────────────────────
export function kfmt(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + "K";
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e8 ? 1 : 0) + "M";
  return (n / 1e9).toFixed(1) + "B";
}
export function grp(n: number): string {
  const s = String(Math.round(n)); let out = "";
  for (let i = 0; i < s.length; i++) { if (i > 0 && (s.length - i) % 3 === 0) out += ","; out += s.charAt(i); }
  return out;
}
export function money(c: number, unk: number): string {
  if (c === 0 && unk > 0) return "cost ?";
  return "≈$" + (c < 1000 ? c.toFixed(2) : grp(c)) + (unk > 0 ? "+?" : "");
}
const dot = fg(C.dim) + " · " + RST;
function rj(s: string, w: number): string { const n = width(s); return n >= w ? fit(s, w) : " ".repeat(w - n) + s; }

// ── aggregation over a set of local days (cached per ledger version) ────────
interface HA { h: string; sess: number; tools: number; inTok: number; outTok: number; cr: number; cw: number; cost: number; unk: number; add: number; del: number }
interface Agg { key: string; ver: number; at: number; rows: HA[]; tot: HA; names: Map<string, Cnt>; hours: number[]; perDay: number[]; dayCost: number[]; busy: Sess | null; busyTools: number; busyCost: number; done: number; total: number }
function ha(h: string): HA { return { h, sess: 0, tools: 0, inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0, add: 0, del: 0 }; }
function zeros(n: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(0); return a; }
function addCnt(m: Map<string, Cnt>, k: string, n: number, err: number, add: number, del: number): void {
  let c = m.get(k);
  if (!c) { c = newCnt(); m.set(k, c); }
  c.n = c.n + n; c.err = c.err + err;
  c.add = c.add + add; c.del = c.del + del;
}
const cache = new Map<string, Agg>();
function agg(days: string[]): Agg {
  const key = days.join(",");
  const hit = cache.get(key);
  if (hit && hit.ver === L.ver && Date.now() - hit.at < 5000) return hit;
  const rows = HARNESSES.map((ad) => ha(ad.id)); const tot = ha("total");
  const g: Agg = { key, ver: L.ver, at: Date.now(), rows, tot, names: new Map<string, Cnt>(), hours: zeros(24), perDay: zeros(days.length), dayCost: zeros(days.length), busy: null, busyTools: 0, busyCost: 0, done: 0, total: 0 };
  const from = startOfDay() - (days.length - 1) * 86400000; // ±1h around DST: fine for a progress gauge
  for (const s of sessions.values()) {
    const a = ledger.get(s.path);
    if (s.mtime >= from) { g.total += s.size; if (a) g.done += pending(s, a) ? Math.min(a.off, s.size) : s.size; }
    if (!a) continue;
    const ri = harnessIndex(s.h); const r = ri >= 0 ? rows[ri] : tot;
    let st = 0; let sc = 0; let any = false;
    for (let i = 0; i < days.length; i++) {
      const d = a.days.get(days[i] ?? ""); if (!d) continue;
      any = true;
      for (const x of [r, tot]) { x.tools += d.tools; x.inTok += d.inTok; x.outTok += d.outTok; x.cr += d.cr; x.cw += d.cw; x.cost += d.cost; x.unk += d.unk; x.add += d.add; x.del += d.del; }
      st += d.tools; sc += d.cost;
      g.perDay[i] = numAt(g.perDay, i, 0) + d.tools; g.dayCost[i] = numAt(g.dayCost, i, 0) + d.cost;
      for (const [n, c] of d.tt) addCnt(g.names, n, c.n, c.err, 0, 0);
      for (let hh = 0; hh < 24; hh++) g.hours[hh] = numAt(g.hours, hh, 0) + numAt(d.hours, hh, 0);
    }
    if (any && !s.parent) { r.sess++; tot.sess++; }
    if (st > g.busyTools) { g.busyTools = st; g.busyCost = sc; g.busy = s; }
  }
  cache.set(key, g);
  return g;
}

// ── Stats tab ───────────────────────────────────────────────────────────────
let week = false;
function period(): string[] { return week ? lastDays(7) : [todayKey()]; }
const BLK = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const WD = "SuMoTuWeThFrSa";

function costStr(x: HA): string { return x.cost === 0 && x.unk > 0 ? fg(C.dim) + "?" + RST : fg(C.yellow) + money(x.cost, x.unk) + RST; }
function linesStr(add: number, del: number): string { return fg(C.green) + "+" + grp(add) + RST + " " + fg(C.red) + "−" + grp(del) + RST; }

function renderStats(): void {
  const W = S.W; const Ht = S.H;
  const days = period();
  if (dKey) { renderDrill(days); return; }
  const g = agg(days); const t = g.tot;
  // summary
  box(0, 1, W, 5, "usage", week ? "last 7 days" : "today", true);
  const chip = (on: boolean, k: string, label: string): string => (on ? bg(C.accent) + fg("20;20;24") + CSI + "1m" : bg(C.sel) + fg(C.sub)) + " " + k + " " + label + " " + RST;
  const frac = g.total > 0 ? g.done / g.total : 1;
  const idx = frac < 0.999 ? fg(C.yellow) + spin() + " indexing " + RST + gauge(frac, 12) + fg(C.text) + " " + Math.floor(frac * 100) + "%" + RST
    : fg(C.green) + "✔ indexed" + RST;
  const l1 = chip(!week, "d", "Today") + " " + chip(week, "w", "7 days") + "   " + idx + fg(C.dim) + "   ≈ API list price · " + PRICES_FROM + RST;
  const wide = W >= 130; const sp = wide ? " " : "";
  const l2 = fg(C.yellow) + CSI + "1m" + money(t.cost, t.unk) + RST + (wide ? "   " : "  ") + fg(C.cyan) + "↑" + sp + kfmt(t.inTok) + RST + fg(C.sub) + " in  " + RST + fg(C.purple) + "↓" + sp + kfmt(t.outTok) + RST + fg(C.sub) + " out  " + RST +
    fg(C.accent) + "↻" + sp + kfmt(t.cr) + RST + fg(C.sub) + (wide ? " cache read  " : " cr  ") + RST + fg(C.accent) + "⇡" + sp + kfmt(t.cw) + RST + fg(C.sub) + (wide ? " cache write" : " cw") + RST + dot +
    fg(C.text) + CSI + "1m" + grp(t.tools) + RST + fg(C.sub) + (wide ? " tool calls" : " tools") + RST + dot + linesStr(t.add, t.del) + dot + fg(C.text) + t.sess + RST + fg(C.sub) + " sessions" + RST;
  const b = g.busy;
  const l3 = b ? fg(C.yellow) + "★ busiest  " + RST + badge(b.h) + fg(C.text) + CSI + "1m" + grp(g.busyTools) + RST + fg(C.sub) + " tools " + RST + fg(C.yellow) + (g.busyCost > 0 ? money(g.busyCost, 0) + " " : "") + RST +
    fg(C.text) + clean(titleOf(b)) + RST : fg(C.dim) + "no activity yet" + RST;
  for (const [i, l] of [l1, l2, l3].entries()) put(1, 2 + i, " " + fitStyled(l, W - 4) + fillTo(fitStyled(l, W - 4), W - 4) + " ");
  // per-harness table
  const cols = [10, 9, 11, 8, 8, 9, 9, 12]; // harness sessions tools in out cache-r cache-w cost, then lines
  let used = 0; for (const c of cols) used += c;
  const lw = Math.min(18, Math.max(0, W - 4 - used));
  const shareW = Math.max(0, W - 4 - used - lw - 2);
  const nh = HARNESSES.length;
  box(0, 6, W, nh + 5, "by harness", "", false);
  const hdr = ["harness", "sessions", "tool calls", "in", "out", "cache r", "cache w", "≈cost"];
  let hl = fg(C.dim);
  for (let i = 0; i < hdr.length; i++) hl += i === 0 ? fit(hdr[i] ?? "", numAt(cols, i, 0)) : rj(hdr[i] ?? "", numAt(cols, i, 0));
  hl += rj("lines ±", lw) + (shareW >= 6 ? "  " + fit("share of tool calls", shareW) : "") + RST;
  put(1, 7, " " + fitStyled(hl, W - 4) + " ");
  const row = (x: HA, y: number, label: string): void => {
    const lead = label ? fg(C.text) + CSI + "1m" + fit(label, 10) + RST : badge(x.h);
    const quiet = x.tools === 0 && x.inTok + x.outTok + x.cr === 0;
    const c = quiet ? fg(C.dim) : fg(C.text);
    let s = lead + c + rj(String(x.sess), 9) + rj(grp(x.tools), 11) + rj(kfmt(x.inTok), 8) + rj(kfmt(x.outTok), 8) + rj(kfmt(x.cr), 9) + rj(kfmt(x.cw), 9) + RST;
    const cs = x.cost === 0 && x.unk > 0 ? "?" : money(x.cost, x.unk);
    s += (x.cost === 0 && x.unk > 0 ? fg(C.dim) : fg(C.yellow)) + rj(cs, 12) + RST;
    const ls = "+" + grp(x.add) + " −" + grp(x.del);
    s += " ".repeat(Math.max(0, lw - width(ls))) + linesStr(x.add, x.del);
    if (shareW >= 6 && !label) s += "  " + gauge(t.tools ? x.tools / t.tools : 0, shareW - 5) + fg(C.sub) + rj(t.tools ? Math.round((x.tools / t.tools) * 100) + "%" : "", 5) + RST;
    put(1, y, " " + fitStyled(s, W - 4) + fillTo(fitStyled(s, W - 4), W - 4) + " ");
  };
  for (let i = 0; i < nh; i++) row(i < g.rows.length ? g.rows[i] : ha(""), 8 + i, "");
  put(1, 8 + nh, " " + fg(C.line) + "─".repeat(W - 4) + RST + " ");
  row(t, 9 + nh, "Σ total");
  // bottom: top tools | activity
  const y0 = 11 + nh; const bh = Ht - 1 - y0;
  if (bh < 5) return;
  const lw2 = Math.max(34, Math.floor(W * 0.42)); const rw = W - lw2;
  box(0, y0, lw2, bh, "top tools", String(g.names.size) + " distinct · ↵ details", false);
  const rows = toolRows(g); lastRows = rows;
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
      const label = e.server ? (open.has(e.key) ? "▾ ⧉ " : "▸ ⧉ ") + e.label : e.kid ? "   " + e.label : e.label;
      l = (on ? fg(C.accent) + "▌" + RST + bg(C.sel) : " ") + (e.server ? fg(C.purple) : e.kid ? fg(C.sub) : fg(C.text)) + (on ? CSI + "1m" : "") + fit(label, nw) + RST + " " +
        gauge(e.n / mx, bw) + fg(e.kid ? C.dim : C.sub) + rj(grp(e.n), 7) + RST + errCol(e.n, e.err, 7);
    }
    const f = l || " ";
    put(1, y0 + 1 + r, f + fillTo(f, lw2 - 3) + " ");
  }
  if (!rows.length) put(2, y0 + 1, fg(C.dim) + "no tool calls in this period" + RST);
  const vals = week ? g.perDay : g.hours;
  box(lw2, y0, rw, bh, week ? "activity by day" : "activity by hour", "tool calls", false);
  chart(lw2 + 1, y0 + 1, rw - 2, bh - 2, vals, days, g.dayCost);
}
// error rate cell, right-aligned in w columns: "·" when clean, else green → red by rate (≥ 20% is full red)
function errCol(n: number, err: number, w: number): string {
  const r = n > 0 ? err / n : 0;
  const s = err === 0 ? "·" : (r < 0.1 ? (r * 100).toFixed(1) : String(Math.round(r * 100))) + "%";
  return " ".repeat(Math.max(0, w - s.length)) + fg(err === 0 ? C.dim : heat(Math.min(1, r * 5))) + s + RST;
}

// ── top-tools list: MCP servers grouped (expandable), cursor by key so it survives re-sorting ──
interface Row { key: string; label: string; n: number; err: number; kid: boolean; server: boolean }
const open = new Set<string>();
let selKey = ""; let ttop = 0; let lastRows: Row[] = [];
let listY0 = 0; let listN = 0; let listX1 = 0; // mouse geometry of the list
function toolRows(g: Agg): Row[] {
  const top: Row[] = []; const srv = new Map<string, Row>(); const kids = new Map<string, Row[]>();
  for (const [name, c] of g.names) {
    const sv = mcpServer(name);
    if (!sv) { top.push({ key: name, label: name, n: c.n, err: c.err, kid: false, server: false }); continue; }
    const k = "mcp__" + sv;
    let r = srv.get(k);
    if (!r) { r = { key: k, label: sv, n: 0, err: 0, kid: false, server: true }; srv.set(k, r); top.push(r); kids.set(k, []); }
    r.n = r.n + c.n; r.err = r.err + c.err;
    const ks = kids.get(k); if (ks) ks.push({ key: name, label: name.slice(k.length + 2), n: c.n, err: c.err, kid: true, server: false });
  }
  top.sort((x, y) => y.n - x.n);
  const out: Row[] = [];
  for (const r of top) {
    out.push(r);
    const ks = kids.get(r.key);
    if (ks && open.has(r.key)) for (const k of ks.sort((x, y) => y.n - x.n)) out.push(k);
  }
  return out;
}
function selIdx(): number { for (const [i, r] of lastRows.entries()) if (r.key === selKey) return i; return 0; }
function rowAt(i: number): Row | null { const r = i >= 0 && i < lastRows.length ? lastRows[i] : undefined; return r ? r : null; }
function selRow(): Row | null { return rowAt(selIdx()); }
function moveSel(d: number): void { const r = rowAt(Math.max(0, Math.min(lastRows.length - 1, selIdx() + d))); if (r) selKey = r.key; }
function parentKey(r: Row): string { return "mcp__" + mcpServer(r.key); }
function toggle(r: Row, want: number): void { // want: 1 open, 0 close, -1 flip
  const k = r.kid ? parentKey(r) : r.key;
  if (!r.server && !r.kid) return;
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
  const key = days.join(",") + "|" + dKey;
  const hit = dCache;
  if (hit && hit.key === key && hit.ver === L.ver && Date.now() - hit.at < 3000) return hit;
  const da: DA = { key, ver: L.ver, at: Date.now(), n: 0, err: 0, dn: 0, ms: 0, max: 0, out: 0, hist: zeros(HB), vals: zeros(days.length > 1 ? days.length : 24), hs: zeros(HARNESSES.length), all: 0,
    prog: new Map<string, Cnt>(), cmds: new Map<string, Cnt>(), files: new Map<string, Cnt>(), kids: new Map<string, Cnt>(), slow: [], errs: [] };
  const pre = dKey + "\t";
  for (const s of sessions.values()) {
    const a = ledger.get(s.path); if (!a) continue;
    const hi = harnessIndex(s.h); if (hi < 0) continue;
    for (let i = 0; i < days.length; i++) {
      const d = a.days.get(days[i] ?? ""); if (!d) continue;
      da.all = da.all + d.tools;
      for (const [name, st] of d.tt) {
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
      if (!dServer) { prefixed(d.prog, pre, da.prog); prefixed(d.cmds, pre, da.cmds); prefixed(d.files, pre, da.files); }
    }
  }
  da.slow = da.slow.sort((x, y) => y.r.ms - x.r.ms).slice(0, 10);
  da.errs = da.errs.sort((x, y) => y.r.t - x.r.t).slice(0, 10);
  dCache = da;
  return da;
}
function openDrill(r: Row): void { dKey = r.key; dServer = r.server; dLabel = r.server ? "⧉ " + r.label : r.key; dsel = 0; dCache = null; }
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
  box(0, 1, W, 5, dLabel, (wk ? "last 7 days" : "today") + " · esc back", true);
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
  chart(1, y1 + 1, cw - 2, h1 - 2, da.vals, days, zeros(days.length));
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
function chart(x: number, y: number, w: number, h: number, vals: number[], days: string[], dayCost: number[]): void {
  const n = vals.length; const ch = h - 2; const axis = 5;
  const cwid = Math.max(1, Math.floor((w - axis - 1) / n));
  let mx = 0; for (const v of vals) if (v > mx) mx = v;
  const nowH = new Date().getHours();
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
      const d = new Date(startOfDay() + 43200000 - (n - 1 - i) * 86400000); const wd = d.getDay();
      l1 += fg(i === n - 1 ? C.accent : C.sub) + fit(WD.slice(wd * 2, wd * 2 + 2) + " " + d.getDate(), cwid) + RST;
      const c = numAt(dayCost, i, 0);
      l2 += fg(C.yellow) + fit(c > 0 ? "$" + (c < 100 ? c.toFixed(1) : String(Math.round(c))) : "", cwid) + RST;
    } else {
      const lab = i % (cwid >= 3 ? 2 : 3) === 0 ? String(i) : "";
      l1 += fg(i === nowH ? C.accent : C.dim) + fit(i === nowH ? "▲" + (cwid >= 3 ? String(i) : "") : lab, cwid) + RST;
    }
  }
  if (days.length === 1) {
    let pk = 0; for (let i = 0; i < 24; i++) if (numAt(vals, i, 0) > numAt(vals, pk, 0)) pk = i;
    l2 += fg(C.dim) + "peak " + RST + fg(C.text) + pk + ":00" + RST + fg(C.dim) + " · " + grp(numAt(vals, pk, 0)) + " calls · ▲ now" + RST;
  }
  put(x, y + ch, " " + fitStyled(l1, w - 1)); put(x, y + ch + 1, " " + fitStyled(l2, w - 1));
}
function key(k: string): boolean {
  if (k === "d") { week = false; return true; }
  if (k === "w") { week = true; return true; }
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
  const grouped = r !== null && (r.server || r.kid);
  if (k === "up" || k === "k" || k === "wheelup") moveSel(-1);
  else if (k === "down" || k === "j" || k === "wheeldown") moveSel(1);
  else if (k === "pgup") moveSel(-10);
  else if (k === "pgdn") moveSel(10);
  else if (k === "home" || k === "g") moveSel(-lastRows.length);
  else if (k === "end" || k === "G") moveSel(lastRows.length);
  else if (k === " ") { if (r) toggle(r, -1); }
  else if (k === "enter") { if (r) openDrill(r); }
  // ←/→ fold an MCP server when one is selected, else switch the period
  else if (k === "right") { if (r && r.server && !open.has(r.key)) toggle(r, 1); else week = true; }
  else if (k === "left") { if (r && grouped && (r.kid || open.has(r.key))) toggle(r, 0); else week = false; }
  else return false;
  return true;
}
function mouse(x: number, y: number, dbl: boolean): void {
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
function mine(): boolean { return S.tab - 2 === H.tabs.indexOf(tab); }

// ── preview, header, footer, help ───────────────────────────────────────────
H.previewSections.push((s: Sess, w: number): string[] => {
  const a = accOf(s);
  const k = fg(C.dim) + fit("usage", 9) + RST;
  if (pending(s, a) && a.off < s.size * 0.98) return [k + fg(C.yellow) + spin() + " indexing " + Math.floor((a.off / Math.max(1, s.size)) * 100) + "%" + RST];
  const tok = fg(C.cyan) + "↑" + kfmt(s.inTok) + " " + RST + fg(C.purple) + "↓" + kfmt(s.outTok) + " " + RST + fg(C.accent) + "↻" + kfmt(s.cacheRTok + s.cacheWTok) + RST;
  const out = [k + tok + dot + (s.cost < 0 ? fg(C.dim) + "cost ?" : fg(C.yellow) + money(s.cost, a.unk)) + RST + dot + fg(C.text) + grp(s.tools) + RST + fg(C.sub) + " tools" + RST + dot + linesStr(s.linesAdd, s.linesDel)];
  const d = a.days.get(todayKey());
  if (d && a.days.size > 1 && w > 30) out.push(fg(C.dim) + fit("today", 9) + RST + fg(C.yellow) + (d.cost === 0 && d.unk > 0 ? "cost ?" : money(d.cost, 0)) + RST + dot + fg(C.text) + grp(d.tools) + RST + fg(C.sub) + " tools" + RST + dot + linesStr(d.add, d.del));
  return out;
});
H.headerWidgets.push((w: number): string => {
  if (w < 14) return "";
  const t = agg([todayKey()]).tot;
  const c = t.cost < 100 ? t.cost.toFixed(2) : grp(t.cost);
  let s = fg(C.yellow) + "≈$" + c + RST + fg(C.dim) + " today" + RST; let n = 9 + c.length;
  if (L.rlPct >= 0 && L.rlReset * 1000 > Date.now()) {
    const win = L.rlWin >= 1440 ? Math.round(L.rlWin / 1440) + "d" : Math.round(L.rlWin / 60) + "h";
    const pc = Math.round(L.rlPct) + "%";
    if (n + 9 + win.length + pc.length <= w) { s += fg(C.dim) + " · cx " + win + " " + RST + fg(heat(L.rlPct / 100)) + pc + RST; n += 9; }
  }
  return n <= w ? s : "";
});
H.footerHints.push((mode: string): string[][] => {
  if (mode !== "list" || !mine()) return [];
  if (dKey) return [["↑↓", "call"], ["↵", "open session"], ["esc", "back"], ["d", "today"], ["w", "7 days"]];
  return [["↑↓", "tool"], ["↵", "details"], ["␣", "expand MCP"], ["d", "today"], ["w", "7 days"]];
});
H.helpSections.push({ name: "stats", ctx: "Stats", keys: [["d  ←", "today"], ["w  →", "last 7 days"], ["↑↓ jk", "select a tool (top tools)"], ["␣  → ←", "expand / fold an MCP server"],
  ["↵  click", "tool drill-down: durations, errors, commands, files"], ["↵", "drill-down: open the session at that call"], ["esc", "close the drill-down"],
  ["", "costs ≈ API list price (" + PRICES_FROM + "); ~/.agentglass/prices.json overrides"]] });
