// agentglass — the Wait tab (key 5): what agents wait on — wall time per command family, kind or tool, the agent-time
// split, heavy commands at the same time in history (peak, time at ≥ 2, overlapped vs alone) and now (spec agent-wait §6)
// SPDX-License-Identifier: Apache-2.0
// The report runs only while the tab is visible: on open, on a period or filter change, and when the ledger moved and
// 30 s passed; ≤ 20 ms a frame (stepWait, a session at a time). The now line reads the watchdog tick's last look.
import { fit, fitStyled, fillTo, width, vwidth, clean } from "../../util/text.ts";
import { S, say } from "../../state.ts";
import { H, type Tab, type Ctx, display } from "../../hooks.ts";
import { sessions, titleOf } from "../../model/sessions.ts";
import { C, CSI, RST, fg, bg } from "../../ui/theme.ts";
import { put, box, spin } from "../../ui/screen.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { L, startOfDay, todayKey } from "../usage/record.ts";
import { pct, fmtMs } from "../usage/calls.ts";
import { grp } from "../usage/costs.ts";
import { callCutoff } from "../usage/callcache.ts";
import { type Compiled, EMPTY } from "../query/eval.ts";
import type { Clause } from "../query/types.ts";
import { tabFilter, chips } from "../query/ui.ts";
import { localFor, setLocal, addClause } from "../query/scope.ts";
import { R } from "../rules/state.ts";
import { DEBUG_PARTS } from "../../util/selfmem.ts";
import { newRun } from "../triage/run.ts";
import { openTriage } from "../triage/view.ts";
import { addActions, keyAction, tabNamed } from "../palette/actions.ts";
import { shownFam } from "./family.ts";
import { type WRow, type WaitRun, type WaitReport, type SlowCall, type Drill, newWaitRun, stepWait, waitResult, waitProgress, trendOf, shareOf, newDrill, stepDrill } from "./report.ts";
import { BACKFILL } from "./backfill.ts";
import type { GroupOverlap } from "./overlap.ts";
import { type Run, LIVE, liveNow, heavyNow } from "./live.ts";
import { maxOf, overlapFor, groupFor, rowsBy, hours, pctTxt, trendTxt, kindShort, whenTxt, splitTxt } from "./fmt.ts";
import type { Obj } from "../../util/json.ts";
import { FLEET } from "../fleet/hosts.ts";
import { WANT } from "../fleet/ssh.ts";
import { HOSTQ } from "../query/eval.ts";
import { waitJson, rowJson } from "./cli.ts";
import { mergeWait, reportOfObj, rowsOfObj } from "./merge.ts";

// ── state ──
export const SORTS = ["total", "count", "p95", "err", "trend", "peak"];
const VIEWS = ["family", "kind", "tool"];
const WV = { period: "w", view: "family", sort: 0, sel: 0, top: 0, selKey: "", detail: "", dsel: 0, dtop: 0, hosts: "merged" /* fleet: merged | per host */ };
// run: the report being computed; rep: the last finished one (shown meanwhile when only the ledger moved); key: what it
// was computed for (period, filter, day); fixed: a check's report (never recomputed)
const J = { run: null as WaitRun | null, rep: null as WaitReport | null, key: "", at: 0, ver: -1, ovF: [] as GroupOverlap[], ovK: [] as GroupOverlap[], fixed: false, cpu: 0, slice: 0, last: 0 };
export function waitState(): { period: string; view: string; sort: string; detail: string } { return { period: WV.period, view: WV.view, sort: SORTS[WV.sort] ?? "total", detail: WV.detail }; }
// checks: a fixed report (null: compute again on the next render)
export function setWaitForTest(rep: WaitReport | null): void {
  J.run = null; J.rep = rep; J.fixed = rep !== null; J.key = ""; J.at = 0;
  if (rep) { J.ovF = overlapFor(rep, "family"); J.ovK = overlapFor(rep, "kind"); }
}
function sinceOf(p: string): number { const d = startOfDay(); return p === "d" ? d : p === "m" ? d - 29 * 86400000 : p === "a" ? callCutoff() : d - 6 * 86400000; }
function periodName(): string { return WV.period === "d" ? "today" : WV.period === "m" ? "30 days" : WV.period === "a" ? "all kept days" : "7 days"; }
const REFRESH_MS = 30000;
// one slice of report work (render calls it: nothing runs while the tab is hidden)
function work(f: Compiled): void {
  const now = Date.now(); const k = WV.period + "|" + f.key + "|" + todayKey();
  if (J.fixed) return;
  if (J.run && J.key !== k) J.run = null; // the period or filter changed under it
  if (!J.run && (J.key !== k || !J.rep || (L.ver !== J.ver && now - J.at >= REFRESH_MS))) {
    if (J.key !== k) J.rep = null; // another question: the old answer would mislead
    J.run = newWaitRun(f, sinceOf(WV.period), now + 1); J.key = k; J.ver = L.ver; J.at = now; J.cpu = 0; J.slice = 0;
  }
  const r = J.run; if (!r) return;
  const t0 = Date.now(); const fin = stepWait(r, 15); const d = Date.now() - t0; // 15: a slice ends after the session it is in (≤ 20 ms)
  J.cpu += d; if (d > J.slice) J.slice = d;
  if (fin) { const rep = waitResult(r); J.rep = rep; J.run = null; J.ovF = overlapFor(rep, "family"); J.ovK = overlapFor(rep, "kind"); J.last = J.cpu; }
  S.dirty = true;
}
DEBUG_PARTS.push((): string => J.last > 0 || J.run ? "wait " + String(J.run ? J.cpu : J.last) + "ms (slice ≤ " + String(J.slice) + "ms)" : "");
function ovOf(): GroupOverlap[] { return fleetOn() ? [] : WV.view === "kind" ? J.ovK : J.ovF; }

// ── fleet (spec §9): hosts' wait reports (fleet pull --wait, asked while the tab shows), merged or per host ──
interface HostWait { name: string; o: Obj; at: number }
const RW = new Map<string, HostWait>(); // the last wait report per host (a pull without --wait keeps the one before)
const FX = { rep: null as WaitReport | null, local: null as Obj | null, key: "", rows: [] as WRow[], hostOf: [] as string[], mrep: null as WaitReport | null };
function hostWaits(): HostWait[] {
  for (const rh of FLEET.hosts) { const r = rh.report; if (rh.cfg.enabled && r && r.wait && !rh.dupOf) { const old = RW.get(rh.cfg.name); if (!old || old.at !== rh.okAt) RW.set(rh.cfg.name, { name: rh.cfg.name, o: r.wait, at: rh.okAt }); } }
  return [...RW.values()];
}
function fleetOn(): boolean { return FLEET.hosts.length > 0 && RW.size > 0 && J.rep !== null; }
function localObj(rep: WaitReport): Obj {
  const o = waitJson(rep, J.ovF, null, {}, "family", 500); const ks: Obj[] = []; const ts: Obj[] = [];
  for (const w of rep.kinds) ks.push(rowJson(w, groupFor(J.ovK, w, "kind"), rep));
  for (const w of rep.tools) ts.push(rowJson(w, null, rep));
  o["kinds"] = ks; o["tools"] = ts; return o;
}
// the rows the table shows: this machine's, or (fleet) merged / per host with the host of each row
function fleetRows(): void {
  const rep = J.rep; if (!rep) return;
  const hw = hostWaits(); const k = String(J.at) + "|" + WV.view + "|" + WV.hosts + "|" + hw.map((h: HostWait) => h.name + "@" + String(h.at)).join(",");
  if (k === FX.key) return;
  FX.key = k; if (!FX.local || FX.rep !== rep) { FX.local = localObj(rep); FX.rep = rep; }
  const loc = FX.local ?? {}; FX.rows = []; FX.hostOf = [];
  if (WV.hosts === "merged") { const objs: Obj[] = [loc]; for (const h of hw) objs.push(h.o); const m = reportOfObj(mergeWait(objs)); FX.rows = rowsBy(m, WV.view); FX.mrep = m; return; }
  for (const w of rowsOfObj(loc, WV.view)) { FX.rows.push(w); FX.hostOf.push(HOSTQ.local); }
  for (const h of hw) for (const w of rowsOfObj(h.o, WV.view)) { FX.rows.push(w); FX.hostOf.push(h.name); }
  const all: Obj[] = [loc]; for (const h of hw) all.push(h.o); FX.mrep = reportOfObj(mergeWait(all));
}

// ── pure helpers (checks) ──
const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
// values → one bar per cell, scaled to the max; more values than cells: each cell is the max of its values
export function sparkline(vs: number[], w: number): string {
  if (!vs.length || w <= 0) return "";
  const n = Math.min(w, vs.length); const out: string[] = []; let mx = 0;
  const cells: number[] = [];
  for (let c = 0; c < n; c++) { const a = Math.floor((c * vs.length) / n); const b = Math.max(a + 1, Math.floor(((c + 1) * vs.length) / n)); let m = 0; for (let i = a; i < b; i++) m = Math.max(m, vs[i] ?? 0); cells.push(m); mx = Math.max(mx, m); }
  for (const v of cells) out.push(mx > 0 ? BARS[Math.min(7, Math.round((v / mx) * 7))] ?? "▁" : "▁");
  return out.join("");
}
function sortVal(w: WRow, s: string, ov: GroupOverlap[]): number {
  if (s === "count") return w.n;
  if (s === "p95") return pct(w.hist, 0.95, w.max);
  if (s === "err") return w.n ? w.err / w.n : -1;
  if (s === "trend") { const t = trendOf(w, J.rep ? J.rep.complete : false); return t === null ? -1e9 : t; }
  if (s === "peak") { const g = groupFor(ov, w, WV.view); return g ? g.peak : -1; }
  return w.ms;
}
export function sortRows(rows: WRow[], s: string, ov: GroupOverlap[]): WRow[] {
  const o = rows.slice();
  o.sort((a: WRow, b: WRow) => sortVal(b, s, ov) - sortVal(a, s, ov) || b.ms - a.ms || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return o;
}
function rows(): WRow[] {
  const r = J.rep; if (!r) return [];
  if (fleetOn()) { fleetRows(); if (WV.hosts === "merged") return sortRows(FX.rows, SORTS[WV.sort] ?? "total", []); return FX.rows; }
  return sortRows(rowsBy(r, WV.view), SORTS[WV.sort] ?? "total", ovOf());
}
// the report whose split and trend the table shows (fleet: the merged one)
function shownRep(): WaitReport | null { return fleetOn() && FX.mrep ? FX.mrep : J.rep; }
function cur(): WRow | null { const rs = rows(); return rs[WV.sel] ?? null; }

// ── drawing ──
function rj(s: string, w: number): string { const n = width(s); return n >= w ? fit(s, w) : " ".repeat(w - n) + s; }
function line(x: number, y: number, w: number, s: string): void { const f = fitStyled(s, w); put(x, y, f + fillTo(f, w)); }
const dot = fg(C.dim) + " · " + RST;
function chip(on: boolean, k: string, label: string): string { return (on ? bg(C.accent) + fg("20;20;24") + CSI + "1m" : bg(C.sel) + fg(C.sub)) + " " + k + " " + label + " " + RST; }
function rssTxt(kb: number): string { return kb < 0 ? "" : kb >= 1048576 ? (kb / 1048576).toFixed(1) + "G" : String(Math.round(kb / 1024)) + "M"; }
function ageTxt(sec: number): string { return fmtMs(sec * 1000).replace(/\.\d+s$/, "s"); }
// the now line: heavy commands with age and RSS (red at the contention threshold), host load and memory
function nowLine(w: number): string {
  const lw = liveNow(Date.now());
  if (!lw.at) {
    const on = R.set.rules.some((r) => r.id === "contention" && r.enabled);
    return fg(C.dim) + "now  no agent live" + (on ? "" : " · contention alert off — rules.json: {\"rules\": [{\"id\": \"contention\", \"enabled\": true}]}") + RST;
  }
  const hv = heavyNow(lw, "", ""); const max = maxOf(R.set);
  const host = (lw.load1 >= 0 ? "load " + lw.load1.toFixed(1) + (lw.cpus > 0 ? "/" + String(lw.cpus) : "") : "") + (lw.memAvailPct >= 0 ? " · mem " + String(lw.memAvailPct) + "% free" : "");
  if (!hv.length) return fg(C.dim) + "now  " + RST + fg(C.sub) + "no heavy command running" + RST + (host ? dot + fg(C.sub) + host + RST : "");
  const by = new Map<string, Run[]>(); for (const r of hv) { const l = by.get(r.family); if (l) l.push(r); else by.set(r.family, [r]); }
  const parts: string[] = [];
  for (const [fam, rs] of by) {
    let old = 0; let rss = 0; let known = false; for (const r of rs) { old = Math.max(old, r.ageSec); if (r.rssKb >= 0) { rss += r.rssKb; known = true; } }
    parts.push(fam + (rs.length > 1 ? " ×" + String(rs.length) : "") + " " + ageTxt(old) + (known ? " " + rssTxt(rss) : ""));
  }
  const col = hv.length >= max ? C.red : C.yellow;
  const left = fg(C.dim) + "now  " + RST + fg(col) + CSI + "1m" + String(hv.length) + " heavy" + RST + fg(col) + ": " + parts.join(" · ") + RST;
  const pad = Math.max(2, w - vwidth(left) - width(host));
  return vwidth(left) + width(host) + 2 <= w ? left + " ".repeat(pad) + fg(C.sub) + host + RST : left;
}
// "computing 42%": sessions done of the report's (a first report after an upgrade works out their digests on the way)
function progress(): string { const r = J.run; if (!r) return ""; const p = waitProgress(r); return " · " + spin() + " computing " + String(p.n ? Math.floor((p.i * 100) / p.n) : 0) + "%"; }
interface Cols { name: number; kind: number; share: number; total: number; n: number; p50: number; p95: number; err: number; trend: number; peak: number }
function cols(iw: number): Cols {
  const kind = iw >= 100 ? 10 : 6; const c: Cols = { name: 0, kind, share: 6, total: 7, n: 7, p50: 7, p95: 7, err: 5, trend: 6, peak: 5 };
  c.name = Math.max(10, iw - 1 - kind - c.share - c.total - c.n - c.p50 - c.p95 - c.err - c.trend - c.peak);
  return c;
}
function rowText(w: WRow, c: Cols, rep: WaitReport, ov: GroupOverlap[], on: boolean, host: string): string {
  const b = on ? bg(C.sel) : ""; const g = groupFor(ov, w, WV.view);
  const p50 = pct(w.hist, 0.5, w.max); const p95 = pct(w.hist, 0.95, w.max); const tr = trendOf(w, rep.complete);
  const e = w.n ? w.err / w.n : 0;
  const name = (host ? fit(host, 8) + " " : "") + clean(WV.view === "family" ? shownFam(w.key, w.generic) : WV.view === "tool" ? display("tool", w.key, null) : w.key);
  return (on ? fg(C.accent) + "▌" + RST + b : " ") + (on ? fg(C.text) + CSI + "1m" : fg(w.heavy ? C.text : C.sub)) + fit(name, c.name) + RST + b +
    fg(C.dim) + fit(" " + (c.kind < 10 ? kindShort(w.kind) : w.kind), c.kind) + RST + b + fg(C.text) + rj(pctTxt(shareOf(w, rep.split)), c.share) + rj(hours(w.ms), c.total) + rj(grp(w.n), c.n) + RST + b +
    fg(C.sub) + rj(p50 < 0 ? "·" : fmtMs(p50), c.p50) + rj(p95 < 0 ? "·" : fmtMs(p95), c.p95) + RST + b +
    fg(w.err ? (e >= 0.2 ? C.red : C.yellow) : C.dim) + rj(w.n ? pctTxt(e) : "·", c.err) + RST + b +
    fg(tr === null ? C.dim : tr > 0.1 ? C.yellow : tr < -0.1 ? C.green : C.sub) + rj(trendTxt(tr), c.trend) + RST + b +
    fg(g && g.peak > 1 ? C.text : C.dim) + rj(g && g.peak > 1 ? String(g.peak) : "·", c.peak) + RST;
}
// the selection's overlap figures and its timeline
function bottom(w: WRow | null, rep: WaitReport, ov: GroupOverlap[], iw: number): string[] {
  if (!w) return ["", ""];
  const name = WV.view === "family" ? shownFam(w.key, w.generic) : w.key;
  if (WV.view === "tool") return [fg(C.dim) + "── " + RST + fg(C.text) + name + RST + fg(C.dim) + " · " + w.kind + " · not a shell command: no overlap figures" + RST, fg(C.dim) + "↵ calls · t triage · f filter sessions" + RST];
  const g = groupFor(ov, w, WV.view);
  if (!g || !w.heavy) return [fg(C.dim) + "── " + RST + fg(C.text) + name + RST + fg(C.dim) + (w.heavy ? " · no heavy call ≥ the minimum duration" : " · not a heavy kind: no contention figures") + RST, fg(C.dim) + "↵ calls · t triage · f filter sessions" + RST];
  const sd = g.slowdown >= 0 ? " · overlapped p50 " + fmtMs(g.overP50) + " vs " + fmtMs(g.aloneP50) + " alone (×" + g.slowdown.toFixed(1) + ", correlation)" : " · " + String(g.over) + " of " + String(g.n) + " calls overlapped";
  const l1 = fg(C.dim) + "── " + RST + fg(C.text) + name + RST + fg(C.sub) + " · ≥2 at once " + hours(g.atLeast[0] ?? 0) + sd + RST;
  const tail = "  peak " + String(g.peak) + (g.peak > 0 ? " at " + whenTxt(g.peakAt) : "") + " · " + String(w.agents) + " sessions · ↵ calls  t triage  f filter";
  const sw = Math.max(0, Math.min(g.timeline.length, iw - 2 - width(tail)));
  return [l1, fg(C.accent) + sparkline(g.timeline, sw) + RST + fg(C.dim) + tail + RST];
}
function renderList(): void {
  const W = S.W; const Ht = S.H; const iw = W - 2;
  const f = tabFilter("Wait", "stats");
  work(f);
  LIVE.want = Date.now() + 5000; // host load and memory for the now line, while the tab shows
  if (FLEET.hosts.length) WANT.wait = Date.now() + 120000; // the hosts' next pulls bring their wait reports
  const rows0 = rows(); const rep = shownRep(); const ov = ovOf(); const fl = fleetOn();
  const ch = f === EMPTY ? "" : chips("Wait", "stats", Math.max(10, W - 40));
  const fh = fl ? " · " + String(RW.size + 1) + " hosts " + (WV.hosts === "merged" ? "merged" : "per host") + " (h)" : "";
  box(0, 1, W, Ht - 2, "wait" + progress(), ch ? ch + fg(C.dim) + " · " + periodName() + fh + RST : periodName() + (rep && !fl ? " · " + String(rep.sessions) + " sessions" : "") + fh, true);
  line(1, 2, iw, " " + chip(WV.period === "d", "d", "Today") + " " + chip(WV.period === "w", "w", "7 days") + " " + chip(WV.period === "m", "m", "30 days") + " " + chip(WV.period === "a", "a", "All") +
    fg(C.dim) + "  v " + RST + fg(C.text) + WV.view + RST + fg(C.dim) + "  s " + RST + fg(C.text) + (SORTS[WV.sort] ?? "total") + RST);
  const sp = rep ? splitTxt(rep) : ""; const vs = rep && !rep.complete ? " · no trend: the period before is past retention" : " · trend vs the " + periodName() + " before";
  line(1, 3, iw, " " + (rep ? fg(C.sub) + sp + RST + (width(sp + vs) < iw - 1 ? fg(C.dim) + vs + RST : "") : fg(C.dim) + "computing…" + RST));
  line(1, 4, iw, " " + nowLine(iw - 1));
  const c = cols(iw);
  line(1, 5, iw, " " + fg(C.dim) + fit(WV.view, c.name) + fit(" kind", c.kind) + rj("share", c.share) + rj("total", c.total) + rj("n", c.n) + rj("p50≈", c.p50) + rj("p95≈", c.p95) + rj("err", c.err) + rj("trend", c.trend) + rj("peak", c.peak) + RST);
  const rs = rows0; const y0 = 6; const vis = Math.max(0, Ht - 2 - y0 - 2);
  if (WV.selKey) for (let i = 0; i < rs.length; i++) if (rs[i]?.key === WV.selKey) { WV.sel = i; break; }
  WV.sel = Math.max(0, Math.min(WV.sel, rs.length - 1)); WV.selKey = rs[WV.sel]?.key ?? "";
  if (WV.sel < WV.top) WV.top = WV.sel;
  if (WV.sel >= WV.top + vis) WV.top = WV.sel - vis + 1;
  WV.top = Math.max(0, Math.min(WV.top, Math.max(0, rs.length - vis)));
  LY.y0 = y0; LY.n = Math.min(vis, rs.length - WV.top);
  for (let i = 0; i < vis; i++) {
    const w = rs[WV.top + i];
    if (!w || !rep) { line(1, y0 + i, iw, i === 0 && !rs.length ? "  " + fg(C.dim) + emptyText(f) + RST : ""); continue; }
    const on = WV.top + i === WV.sel;
    line(1, y0 + i, iw, (on ? bg(C.sel) : "") + rowText(w, c, rep, ov, on, fl && WV.hosts !== "merged" ? FX.hostOf[WV.top + i] ?? "" : ""));
  }
  const bl = rep && !fl ? bottom(rs[WV.sel] ?? null, rep, ov, iw) : fl ? [fg(C.dim) + "── fleet: sums and histograms over the hosts; peaks and overlap stay per host (h: per host)" + RST, fleetNow(iw)] : ["", ""];
  line(1, Ht - 4, iw, " " + (bl[0] ?? "")); line(1, Ht - 3, iw, " " + (bl[1] ?? ""));
}
// one now summary per remote host (its report's now block and age)
function fleetNow(iw: number): string {
  const ps: string[] = [];
  for (const h of RW.values()) {
    const nw = h.o["now"]; const n = nw && typeof nw === "object" ? (nw as Obj)["heavyRunning"] : null;
    ps.push(h.name + " " + (typeof n === "number" ? String(n) + " heavy" : "?") + " (" + fmtMs(Date.now() - h.at).replace(/\.\d+s$/, "s") + " ago)");
  }
  return fg(C.sub) + fit("now on hosts: " + ps.join(" · "), iw - 2) + RST;
}
function emptyText(f: Compiled): string {
  if (J.run) return "computing…";
  const v = WV.view === "tool" ? "non-shell tool calls" : "shell calls";
  return "no " + v + " in " + periodName() + (f !== EMPTY ? " matching the filter — / edits it" : "") + " — d/w/m/a switch the period, v the view";
}
const LY = { y0: 0, n: 0 };
// ↵: the row's slowest calls (↵ there opens the session at that call). The days a digest summed are read for them on
// demand, a slice per frame and tick (report.ts newDrill); the list shows what is known meanwhile.
const DR = { d: null as Drill | null, key: "", rep: null as WaitReport | null, list: [] as SlowCall[], done: true };
function drillFor(rep: WaitReport, w: WRow): void {
  const k = WV.view + "\t" + w.key;
  if (DR.d && DR.key === k && DR.rep === rep) return;
  const members = WV.view === "kind" ? rep.fams.concat(rep.tools).filter((m: WRow): boolean => m.kind === w.key) : [w];
  DR.d = newDrill(rep, w, members); DR.key = k; DR.rep = rep; DR.done = false; DR.list = DR.d.out;
}
function drillWork(): void { const d = DR.d; if (!d || DR.done) return; DR.done = stepDrill(d, 20); DR.list = d.out; S.dirty = true; }
function slowList(): SlowCall[] { return DR.d && DR.rep === J.rep ? DR.list : []; }
function renderDetail(): void {
  const W = S.W; const Ht = S.H; const iw = W - 2;
  const rep = J.rep; let w: WRow | null = null; if (rep) for (const x of rowsBy(rep, WV.view)) if (x.key === WV.detail) w = x;
  if (rep && w) { drillFor(rep, w); drillWork(); }
  const name = w ? (WV.view === "family" ? shownFam(w.key, w.generic) : w.key) : WV.detail;
  box(0, 1, W, Ht - 2, name + (DR.done ? "" : " · " + spin() + " reading calls"), "slowest calls · " + periodName() + " · ↵ open · esc back", true);
  const sl: SlowCall[] = w ? slowList() : [];
  if (!sl.length) { line(1, 2, iw, " " + fg(C.dim) + (DR.done ? "no timed calls" : "reading calls…") + RST); for (let y = 3; y < Ht - 2; y++) line(1, y, iw, ""); return; }
  WV.dsel = Math.max(0, Math.min(WV.dsel, sl.length - 1));
  const vis = Math.max(0, Ht - 4); if (WV.dsel < WV.dtop) WV.dtop = WV.dsel; if (WV.dsel >= WV.dtop + vis) WV.dtop = WV.dsel - vis + 1;
  DL.y0 = 2; DL.n = Math.min(vis, sl.length - WV.dtop);
  for (let i = 0; i < vis; i++) {
    const k = WV.dtop + i; const x = sl[k];
    if (!x) { line(1, 2 + i, iw, ""); continue; }
    const on = k === WV.dsel; const b = on ? bg(C.sel) : ""; const s = sessions.get(x.path);
    const t = s ? clean(titleOf(s)) : "(session gone)";
    line(1, 2 + i, iw, b + (on ? fg(C.accent) + "▌" + RST + b : " ") + fg(C.sub) + whenTxt(x.t) + RST + b + fg(C.text) + rj(fmtMs(x.ms), 9) + RST + b + "  " + (s ? fg(C.dim) + s.h + " " + RST + b : "") + (on ? fg(C.text) + CSI + "1m" : fg(C.sub)) + t + RST);
  }
}
const DL = { y0: 0, n: 0 };

// ── keys ──
function clauseOf(w: WRow): Clause {
  if (WV.view === "kind") return { key: "kind", op: "is", vals: [w.key], neg: false, pinned: false };
  if (WV.view === "tool") { const sv = w.key.startsWith("mcp "); return { key: sv ? "server" : "tool", op: "is", vals: [sv ? w.key.slice(4) : w.key], neg: false, pinned: false }; }
  return { key: "family", op: "is", vals: [w.key], neg: false, pinned: false };
}
function triage(w: WRow): void {
  const tab = S.tab; const days = WV.period === "d" ? 1 : WV.period === "m" ? 30 : WV.period === "a" ? Math.max(1, Math.round((startOfDay() - callCutoff()) / 86400000) + 1) : 7;
  openTriage(newRun("Wait", "call", localFor("Wait").concat(S.pins), [clauseOf(w)], days), (): void => { S.mode = "list"; S.tab = tab; });
}
function filterSessions(w: WRow): void {
  const r = addClause(localFor("Sessions"), clauseOf(w)); setLocal("Sessions", r.cs);
  S.tab = 0; S.sel = 0; say("info", "Sessions filtered to " + clauseOf(w).key + " is " + (clauseOf(w).vals[0] ?? "") + " — esc clears");
}
function jump(x: SlowCall): void {
  const s = sessions.get(x.path); if (!s) { say("warn", "that session is no longer on disk"); return; }
  openTranscript(s);
  const t = S.tv; if (t && x.id) { t.focusKind = "tool"; t.focusTs = ""; t.focusText = x.id; }
}
function key(k: string): boolean {
  if (k === "d" || k === "w" || k === "m" || k === "a") { WV.period = k; WV.sel = 0; WV.top = 0; WV.selKey = ""; return true; }
  if (WV.detail) {
    const sl: SlowCall[] = slowList();
    if (k === "esc" || k === "bs" || k === "backspace" || k === "left") { WV.detail = ""; return true; }
    if (k === "up" || k === "k" || k === "wheelup") WV.dsel = Math.max(0, WV.dsel - 1);
    else if (k === "down" || k === "j" || k === "wheeldown") WV.dsel = Math.min(Math.max(0, sl.length - 1), WV.dsel + 1);
    else if (k === "g" || k === "home") WV.dsel = 0;
    else if (k === "G" || k === "end") WV.dsel = Math.max(0, sl.length - 1);
    else if (k === "enter" || k === "right") { const x = sl[WV.dsel]; if (x) jump(x); }
    else return false;
    return true;
  }
  const rs = rows(); const n = rs.length; const page = Math.max(1, LY.n - 1);
  if (k === "up" || k === "k" || k === "wheelup") WV.sel = Math.max(0, WV.sel - 1);
  else if (k === "down" || k === "j" || k === "wheeldown") WV.sel = Math.min(Math.max(0, n - 1), WV.sel + 1);
  else if (k === "pgup") WV.sel = Math.max(0, WV.sel - page);
  else if (k === "pgdn") WV.sel = Math.min(Math.max(0, n - 1), WV.sel + page);
  else if (k === "g" || k === "home") WV.sel = 0;
  else if (k === "G" || k === "end") WV.sel = Math.max(0, n - 1);
  else if (k === "s") { WV.sort = (WV.sort + 1) % SORTS.length; WV.sel = 0; WV.top = 0; WV.selKey = ""; say("info", "wait rows sorted by " + (SORTS[WV.sort] ?? "total")); return true; }
  else if (k === "h") { if (!fleetOn()) { say("info", FLEET.hosts.length ? "no fleet host has sent wait data yet: pull hosts send it with their next pull; snapshot hosts do not — agentglass wait --fleet asks them" : "no fleet hosts configured (fleet.hosts)"); return true; } WV.hosts = WV.hosts === "merged" ? "per host" : "merged"; WV.sel = 0; WV.top = 0; WV.selKey = ""; return true; }
  else if (k === "v") { WV.view = VIEWS[(VIEWS.indexOf(WV.view) + 1) % VIEWS.length] ?? "family"; WV.sel = 0; WV.top = 0; WV.selKey = ""; return true; }
  else if (k === "enter" || k === "right") { const w = rs[WV.sel]; if (w) { WV.detail = w.key; WV.dsel = 0; WV.dtop = 0; } }
  else if (k === "t") { const w = rs[WV.sel]; if (w) triage(w); }
  else if (k === "f") { const w = rs[WV.sel]; if (w) filterSessions(w); }
  else return false;
  WV.selKey = rs[WV.sel]?.key ?? "";
  return true;
}
function mouse(x: number, y: number, dbl: boolean): void {
  if (WV.detail) {
    if (y < DL.y0 || y >= DL.y0 + DL.n) return;
    const i = WV.dtop + (y - DL.y0); if (i === WV.dsel || dbl) { WV.dsel = i; key("enter"); } else WV.dsel = i;
    return;
  }
  if (y === 2 && x >= 2 && x < 44) { const ks = ["d", "w", "m", "a"]; let at = 2; for (const [i, w] of [9, 10, 11, 7].entries()) { if (x >= at && x < at + w) { key(ks[i] ?? "w"); return; } at += w + 1; } return; }
  if (y < LY.y0 || y >= LY.y0 + LY.n) return;
  const i = WV.top + (y - LY.y0); const rs = rows(); const w = rs[i]; if (!w) return;
  if (i === WV.sel || dbl) { WV.sel = i; key("enter"); } else { WV.sel = i; WV.selKey = w.key; }
}
export const WAIT_TAB: Tab = { name: "Wait", render: () => { if (WV.detail) renderDetail(); else renderList(); }, key, mouse };
H.tabs.push(WAIT_TAB);
function mine(): boolean { return S.mode === "list" && S.tab - 2 === H.tabs.indexOf(WAIT_TAB); }
H.backlog.push(() => (J.run !== null || (!DR.done && WV.detail !== "")) && mine()); // a report or drill-down in slices: tick at the burst cadence until it is done
H.onTick.push(() => { if (!mine()) return; if (J.run) work(tabFilter("Wait", "stats")); else if (WV.detail) drillWork(); }); // a slice per tick too, not only per frame (nothing while hidden)
BACKFILL.busy = (): boolean => J.run !== null; // the report works out its window's digests itself
H.footerHints.push((mode: string): string[][] => {
  if (mode !== "list" || S.tab - 2 !== H.tabs.indexOf(WAIT_TAB)) return [];
  if (WV.detail) return [["↑↓", "call"], ["↵", "open at the call"], ["esc", "back"], ["d/w/m/a", "period"]];
  const h: string[][] = fleetOn() ? [["h", WV.hosts === "merged" ? "per host" : "merged"]] : [];
  return [["↑↓", WV.view], ["↵", "calls"], ["v", "view"], ["s", "sort"], ["d/w/m/a", "period"]].concat(h, [["t", "triage"], ["f", "filter sessions"], ["/", "filter"]]);
});
H.helpSections.push({ name: "wait", ctx: "Wait", keys: [["d w m a", "period: today, 7 days, 30 days, all kept days (vs the period before)"], ["v", "view: command families, kinds, non-shell tools"],
  ["s", "sort: total, count, p95, err, trend, peak"], ["↵  click", "the row's slowest calls · ↵ there opens the session at that call"], ["t", "triage: what is different about this family's calls"],
  ["f", "filter the Sessions list to this family (kind, tool)"], ["h", "fleet: all hosts merged ↔ per host (hosts send wait data with their next pull)"], ["esc  ⌫", "back from the calls"], ["/  p  P", "filter the calls first (repo is x, harness is codex) · pin · pins"],
  ["", "share = time ÷ agent time (parallel calls each count); p50/p95 ≈ from a histogram; trend vs the period before"],
  ["", "peak = most heavy calls at once (tests, type checks, lint, builds, installs ≥ wait.minSec); overlapped = ≥ 50 % of a"],
  ["", "  call ran beside another; slower when overlapped is a correlation, not a cause"],
  ["", "now = heavy commands running on this machine (age, RSS) · contention alert: rules.json id contention (off by default)"],
  ["", "tool time includes approval dialogs; background runs end at launch and are not timed"]] });
function waitTab(): number { return 2 + H.tabs.indexOf(WAIT_TAB); }
addActions([
  { id: "wait.open", title: "Wait: what agents wait on (tab)", group: "Wait", keys: "5", when: (c: Ctx): boolean => c.mode === "list", run: (): void => { S.mode = "list"; S.tab = waitTab(); } },
  keyAction("wait.today", "Wait", "Wait: today", "d", "d", (c: Ctx): boolean => tabNamed(c, "Wait")),
  keyAction("wait.week", "Wait", "Wait: last 7 days", "w", "w", (c: Ctx): boolean => tabNamed(c, "Wait")),
  keyAction("wait.month", "Wait", "Wait: last 30 days", "m", "m", (c: Ctx): boolean => tabNamed(c, "Wait")),
  keyAction("wait.all", "Wait", "Wait: all kept days", "a", "a", (c: Ctx): boolean => tabNamed(c, "Wait")),
  keyAction("wait.view", "Wait", "Wait: families / kinds / tools", "v", "v", (c: Ctx): boolean => tabNamed(c, "Wait")),
  keyAction("wait.sort", "Wait", "Wait: next sort", "s", "s", (c: Ctx): boolean => tabNamed(c, "Wait")),
]);
