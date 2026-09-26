// agentglass — Stats tab, preview usage line and header cost widget, all read from the usage ledger
// SPDX-License-Identifier: Apache-2.0
import { fit, fitStyled, fillTo, width, clean, numAt } from "../../util/text.ts";
import type { Sess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { H, type Tab } from "../../hooks.ts";
import { sessions, titleOf } from "../../model/sessions.ts";
import { C, CSI, RST, fg, bg, heat } from "../../ui/theme.ts";
import { put, box, badge, gauge, spin } from "../../ui/screen.ts";
import { ledger, L, accOf, pending, todayKey, lastDays, startOfDay } from "./ledger.ts";

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
interface Agg { key: string; ver: number; at: number; rows: HA[]; tot: HA; names: Map<string, number>; hours: number[]; perDay: number[]; dayCost: number[]; busy: Sess | null; busyTools: number; busyCost: number; done: number; total: number }
function ha(h: string): HA { return { h, sess: 0, tools: 0, inTok: 0, outTok: 0, cr: 0, cw: 0, cost: 0, unk: 0, add: 0, del: 0 }; }
function zeros(n: number): number[] { const a: number[] = []; for (let i = 0; i < n; i++) a.push(0); return a; }
const cache = new Map<string, Agg>();
function agg(days: string[]): Agg {
  const key = days.join(",");
  const hit = cache.get(key);
  if (hit && hit.ver === L.ver && Date.now() - hit.at < 5000) return hit;
  const rows = [ha("claude"), ha("codex"), ha("fx")]; const tot = ha("total");
  const g: Agg = { key, ver: L.ver, at: Date.now(), rows, tot, names: new Map<string, number>(), hours: zeros(24), perDay: zeros(days.length), dayCost: zeros(days.length), busy: null, busyTools: 0, busyCost: 0, done: 0, total: 0 };
  const from = startOfDay() - (days.length - 1) * 86400000; // ±1h around DST: fine for a progress gauge
  for (const s of sessions.values()) {
    const a = ledger.get(s.path);
    if (s.mtime >= from) { g.total += s.size; if (a) g.done += pending(s, a) ? Math.min(a.off, s.size) : s.size; }
    if (!a) continue;
    const r = s.h === "claude" ? rows[0] : s.h === "codex" ? rows[1] : rows[2];
    let st = 0; let sc = 0; let any = false;
    for (let i = 0; i < days.length; i++) {
      const d = a.days.get(days[i] ?? ""); if (!d) continue;
      any = true;
      for (const x of [r, tot]) { x.tools += d.tools; x.inTok += d.inTok; x.outTok += d.outTok; x.cr += d.cr; x.cw += d.cw; x.cost += d.cost; x.unk += d.unk; x.add += d.add; x.del += d.del; }
      st += d.tools; sc += d.cost;
      g.perDay[i] = numAt(g.perDay, i, 0) + d.tools; g.dayCost[i] = numAt(g.dayCost, i, 0) + d.cost;
      for (const [n, c] of d.names) g.names.set(n, (g.names.get(n) ?? 0) + c);
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
  const days = period(); const g = agg(days); const t = g.tot;
  // summary
  box(0, 1, W, 5, "usage", week ? "last 7 days" : "today", true);
  const chip = (on: boolean, k: string, label: string): string => (on ? bg(C.accent) + fg("20;20;24") + CSI + "1m" : bg(C.sel) + fg(C.sub)) + " " + k + " " + label + " " + RST;
  const frac = g.total > 0 ? g.done / g.total : 1;
  const idx = frac < 0.999 ? fg(C.yellow) + spin() + " indexing " + RST + gauge(frac, 12) + fg(C.text) + " " + Math.floor(frac * 100) + "%" + RST
    : fg(C.green) + "✔ indexed" + RST;
  const l1 = chip(!week, "d", "Today") + " " + chip(week, "w", "7 days") + "   " + idx + fg(C.dim) + "   ≈ API list price" + RST;
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
  box(0, 6, W, 8, "by harness", "", false);
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
  for (let i = 0; i < 3; i++) row(g.rows[i] ?? ha(""), 8 + i, "");
  put(1, 11, " " + fg(C.line) + "─".repeat(W - 4) + RST + " ");
  row(t, 12, "Σ total");
  // bottom: top tools | activity
  const y0 = 14; const bh = Ht - 1 - y0;
  if (bh < 5) return;
  const lw2 = Math.max(34, Math.floor(W * 0.42)); const rw = W - lw2;
  box(0, y0, lw2, bh, "top tools", String(g.names.size) + " distinct", false);
  const names = [...g.names.entries()].sort((x, y) => y[1] - x[1]).slice(0, bh - 2);
  const mx = names.length ? (names[0] ?? ["", 1])[1] : 1;
  const nw = Math.min(18, Math.max(8, Math.floor((lw2 - 4) * 0.35)));
  for (let r = 0; r < bh - 2; r++) {
    const e = names[r];
    const bw = lw2 - 4 - nw - 8;
    const l = e ? fg(C.text) + fit(e[0], nw) + RST + " " + gauge(e[1] / Math.max(1, mx), bw) + fg(C.sub) + rj(grp(e[1]), 7) + RST : "";
    put(1, y0 + 1 + r, " " + l + fillTo(l, lw2 - 4) + " ");
  }
  if (!names.length) put(2, y0 + 1, fg(C.dim) + "no tool calls in this period" + RST);
  const vals = week ? g.perDay : g.hours;
  box(lw2, y0, rw, bh, week ? "activity by day" : "activity by hour", "tool calls", false);
  chart(lw2 + 1, y0 + 1, rw - 2, bh - 2, vals, days, g);
}
// vertical block-bar chart with a heat gradient (green at the bottom → red at the top)
function chart(x: number, y: number, w: number, h: number, vals: number[], days: string[], g: Agg): void {
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
      const c = numAt(g.dayCost, i, 0);
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
  if (k === "d" || k === "left") { week = false; return true; }
  if (k === "w" || k === "right") { week = true; return true; }
  return false;
}
const tab: Tab = { name: "Stats", render: renderStats, key };
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
    const pct = Math.round(L.rlPct) + "%";
    if (n + 9 + win.length + pct.length <= w) { s += fg(C.dim) + " · cx " + win + " " + RST + fg(heat(L.rlPct / 100)) + pct + RST; n += 9; }
  }
  return n <= w ? s : "";
});
H.footerHints.push((mode: string): string[][] => (mode === "list" && mine() ? [["d", "today"], ["w", "7 days"]] : []));
H.helpSections.push({ name: "stats", ctx: "Stats", keys: [["d  ←", "today"], ["w  →", "last 7 days"], ["", "costs ≈ API list price; ~/.agentglass/prices.json overrides"]] });
