// agentglass — Repos tab: sessions of all harnesses grouped by project, with cost, active time, errors, files, harness mix
// SPDX-License-Identifier: Apache-2.0
// List (one row per project) and, in the same tab, a project's detail: its sessions, most-changed files, failing tools
// and branches. The active and pinned filters apply to the sessions before grouping.
import { fit, fitTail, fitStyled, fillTo, width, vwidth, clean, numAt, ago } from "../../util/text.ts";
import { basename } from "node:path";
import type { Sess } from "../../model/types.ts";
import { S, say } from "../../state.ts";
import { remoteOnly } from "../../model/remote.ts";
import { H, type Tab, display, realCwd } from "../../hooks.ts";
import { sessions, titleOf, loadHead, loadTail, current, parentOf } from "../../model/sessions.ts";
import { subOf } from "../../model/project.ts";
import { C, CSI, RST, fg, bg, heat } from "../../ui/theme.ts";
import { put, box, spin } from "../../ui/screen.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { harnessOf, isHarness } from "../../harness/index.ts";
import { ledger, pending as pendingBytes } from "../usage/ledger.ts";
import { type Acc, todayKey, lastDays, spanMin, startOfDay, heavy } from "../usage/record.ts";
import type { Cnt } from "../usage/calls.ts";
import { kfmt, grp, money, split, single } from "../usage/costs.ts";
import { asBill } from "../usage/billing.ts";
import { EMPTY } from "../query/eval.ts";
import { tabFilter, chips } from "../query/ui.ts";
import { identOf, identSync } from "../query/project.ts";
import { openGraph } from "../callgraph/view.ts";
import { type RepoAgg, type HarnessAgg, type BranchAgg, type FileAgg, repoAgg, relFile, errPct, allDays, topFiles } from "./agg.ts";
import { perCommit, openGit } from "../vcs/view.ts";
export { topFiles };

// ── pure helpers (checks) ──
// 9h12m, 1h05m, 12m
export function hm(min: number): string { const m = Math.round(min); if (m < 60) return String(m) + "m"; const r = m % 60; return String(Math.floor(m / 60)) + "h" + (r < 10 ? "0" : "") + String(r) + "m"; }
// one harness id per cell, proportional to cost (to sessions when nothing is priced), largest remainder; any share > 0 gets a cell
interface Share { id: string; w: number; n: number; rem: number }
export function mixBar(by: Map<string, HarnessAgg>, cells: number): string[] {
  let costSum = 0; for (const h of by.values()) costSum += h.cost;
  const xs: Share[] = [];
  for (const [id, h] of by) { const w = costSum > 0 ? h.cost : h.sess; if (w > 0) xs.push({ id, w, n: 0, rem: 0 }); }
  let tw = 0; for (const x of xs) tw += x.w;
  if (tw <= 0 || cells <= 0) return [];
  xs.sort((x: Share, y: Share) => y.w - x.w || (x.id < y.id ? -1 : 1));
  let used = 0;
  for (const x of xs) { const q = (x.w / tw) * cells; x.n = Math.floor(q); x.rem = q - x.n; used += x.n; }
  while (used < cells) { let best: Share | null = null; for (const x of xs) if (!best || x.rem > best.rem) best = x; if (!best) break; best.n++; best.rem = -1; used++; }
  if (xs.length <= cells) for (const x of xs) {
    if (x.n > 0) continue;
    let big: Share | null = null; for (const y of xs) if (y.n > 1 && (!big || y.n > big.n)) big = y;
    if (big) { big.n--; x.n = 1; }
  }
  const out: string[] = [];
  for (const x of xs) for (let k = 0; k < x.n; k++) out.push(x.id);
  return out;
}
export const SORTS = ["cost", "active", "sessions", "err", "last"];
function sortVal(r: RepoAgg, by: string): number {
  if (by === "active") return r.activeMin;
  if (by === "sessions") return r.sessions;
  if (by === "err") return errPct(r.err, r.calls);
  if (by === "last") return r.last;
  return r.cost + (r.cost === 0 && r.unk > 0 ? 1e-9 : 0); // unpriced-only projects above empty ones
}
// descending by the key, ties by label
export function sortRepos(rows: RepoAgg[], by: string): RepoAgg[] {
  const out = rows.slice();
  out.sort((x: RepoAgg, y: RepoAgg) => sortVal(y, by) - sortVal(x, by) || (x.label.toLowerCase() < y.label.toLowerCase() ? -1 : x.label.toLowerCase() > y.label.toLowerCase() ? 1 : 0));
  return out;
}
// the project's sessions (top-level, newest first); with a file: only those whose matching days changed it (a subagent's edit counts for its parent)
export function detailSessions(r: RepoAgg, file: string): string[] {
  if (!file) return r.paths;
  const out: string[] = [];
  for (const p of r.paths) {
    const s = sessions.get(p); if (!s) continue;
    let hit = touched(s, r, file);
    if (!hit) for (const k of s.subs) if (touched(k, r, file)) { hit = true; break; }
    if (hit) out.push(p);
  }
  return out;
}
function touched(s: Sess, r: RepoAgg, file: string): boolean {
  const a = ledger.get(s.path); const id = identOf(s); if (!a || !id || id.key !== r.key) return false;
  const cwd = realCwd(s);
  for (const dk of r.days) { const d = a.days.get(dk); if (!d) continue; for (const k of heavy(d).files.keys()) if (relFile(id.top, cwd, k.slice(k.indexOf("\t") + 1)) === file) return true; }
  return false;
}
// tools by errors, then calls
export function topErrTools(r: RepoAgg, n: number): [string, Cnt][] {
  const xs: [string, Cnt][] = [...r.tools.entries()];
  xs.sort((x: [string, Cnt], y: [string, Cnt]) => y[1].err - x[1].err || y[1].n - x[1].n || (x[0] < y[0] ? -1 : 1));
  return xs.slice(0, n);
}

// ── state ──
const RV = { period: "w", sort: "cost", sel: 0, selKey: "", top: 0, detail: "", focus: 0, file: "", s0: 0, s1: 0, s2: 0, s3: 0, t0: 0, t1: 0, t2: 0, t3: 0 };
export function reposState(): { period: string; detail: string; file: string; focus: number } { return { period: RV.period, detail: RV.detail, file: RV.file, focus: RV.focus }; }
function periodDays(): string[] { return RV.period === "d" ? [todayKey()] : RV.period === "m" ? lastDays(30) : RV.period === "a" ? allDays() : lastDays(7); }
function periodName(): string { return RV.period === "d" ? "today" : RV.period === "m" ? "last 30 days" : RV.period === "a" ? "all time" : "last 7 days"; }
let lastRows: RepoAgg[] = []; let lastDetail: RepoAgg | null = null;
let listY0 = 0; let listN = 0; // mouse geometry of the list
interface Area { x0: number; x1: number; y0: number; n: number; top: number }
const areas: Area[] = [{ x0: 0, x1: 0, y0: 0, n: 0, top: 0 }, { x0: 0, x1: 0, y0: 0, n: 0, top: 0 }, { x0: 0, x1: 0, y0: 0, n: 0, top: 0 }, { x0: 0, x1: 0, y0: 0, n: 0, top: 0 }];
function rows(): RepoAgg[] { return sortRepos(repoAgg(periodDays(), tabFilter("Repos", "stats")), RV.sort); }
function selOf(i: number): number { return i === 0 ? RV.s0 : i === 1 ? RV.s1 : i === 2 ? RV.s2 : RV.s3; }
function setSel(i: number, v: number): void { if (i === 0) RV.s0 = v; else if (i === 1) RV.s1 = v; else if (i === 2) RV.s2 = v; else RV.s3 = v; }
function topOf(i: number): number { return i === 0 ? RV.t0 : i === 1 ? RV.t1 : i === 2 ? RV.t2 : RV.t3; }
function setTop(i: number, v: number): void { if (i === 0) RV.t0 = v; else if (i === 1) RV.t1 = v; else if (i === 2) RV.t2 = v; else RV.t3 = v; }
function openDetail(key: string): void { RV.detail = key; RV.focus = 0; RV.file = ""; for (let i = 0; i < 4; i++) { setSel(i, 0); setTop(i, 0); } }

// ── drawing helpers ──
function rj(s: string, w: number): string { const n = width(s); return n >= w ? fit(s, w) : " ".repeat(w - n) + s; }
function rjs(styled: string, w: number): string { const n = vwidth(styled); return n >= w ? fitStyled(styled, w) : " ".repeat(w - n) + styled; }
function line(x: number, y: number, w: number, s: string): void { const f = fitStyled(s, w); put(x, y, f + fillTo(f, w)); }
const dot = fg(C.dim) + " · " + RST;
function chip(on: boolean, k: string, label: string): string { return (on ? bg(C.accent) + fg("20;20;24") + CSI + "1m" : bg(C.sel) + fg(C.sub)) + " " + k + " " + label + " " + RST; }
function costCell(r: { cost: number; unk: number }, modesTxt: string): string {
  if (r.cost === 0 && r.unk > 0) return fg(C.dim) + "cost ?" + RST;
  return fg(C.yellow) + modesTxt + RST + (r.unk > 0 ? fg(C.dim) + "+?" + RST : "");
}
function errCell(err: number, n: number, w: number): string {
  const p = errPct(err, n);
  if (p < 0) return " ".repeat(Math.max(0, w - 1)) + fg(C.dim) + "·" + RST;
  const s = (p < 10 ? p.toFixed(1) : String(Math.round(p))) + "%";
  return " ".repeat(Math.max(0, w - s.length)) + fg(err === 0 ? C.dim : heat(Math.min(1, p / 20))) + s + RST;
}
function marks(hs: string[]): string { let o = ""; for (const h of hs) if (isHarness(h)) { const ad = harnessOf(h); o += fg(ad.color()) + ad.mark + RST; } return o; }
function mixCells(by: Map<string, HarnessAgg>, cells: number): string {
  const ids = mixBar(by, cells); let o = "";
  for (const id of ids) o += fg(isHarness(id) ? harnessOf(id).color() : C.purple) + "█" + RST;
  return o + " ".repeat(Math.max(0, cells - ids.length));
}
function byShare(by: Map<string, HarnessAgg>): string[] { const xs = [...by.entries()]; xs.sort((x: [string, HarnessAgg], y: [string, HarnessAgg]) => y[1].cost - x[1].cost || y[1].sess - x[1].sess); return xs.map((e: [string, HarnessAgg]) => e[0]); }
function shown(label: string): string { return display("repo", label, null); }
// placement progress of the period's sessions (those with ledger days in it): left = not yet in a project (cwd in an
// unread head, or a cwd still queued for its identity); idx = the period's share of indexed log bytes (1 = done)
export const PL = { left: 0, total: 0, idx: 1 };
function inPeriod(a: Acc, days: string[], all: boolean): boolean {
  if (all) return a.days.size > 0;
  for (const dk of days) if (a.days.has(dk)) return true;
  return false;
}
// one slice of placement work: head (then tail) reads for at most maxMs, so keys stay responsive and rows appear as
// their projects resolve; identOf queues each newly known cwd for the budgeted resolver (model/project.ts resolveTick)
export function placeTick(days: string[], all: boolean, maxMs: number): void {
  const t0 = Date.now(); let left = 0; let total = 0; let loads = 0;
  const from = all ? 0 : startOfDay() - Math.max(0, days.length - 1) * 86400000; let done = 0; let size = 0;
  for (const s of sessions.values()) {
    const a = ledger.get(s.path);
    if (s.mtime >= from) { size += s.size; done += a && !pendingBytes(s, a) ? s.size : a ? Math.min(a.off, s.size) : 0; }
    if (!a || !inPeriod(a, days, all)) continue;
    total++;
    if (identOf(s)) continue;
    if (!s.cwd && Date.now() - t0 < maxMs) {
      const p = s.parent ? parentOf(s) : null; // a subagent whose own log names no cwd books under its parent's
      if (!s.headDone) loadHead(s); else if (s.tailSize < 0 && !s.parent) loadTail(s); else if (p && !p.headDone) loadHead(p); // a head without a cwd line (huge first lines): the tail has one
      loads++;
      if (identOf(s)) continue;
    }
    left++;
  }
  if (loads || left !== PL.left || total !== PL.total) S.dirty = true;
  PL.left = left; PL.total = total; PL.idx = size - done < 1048576 ? 1 : done / size; // live appends (< 1 MB behind) are not "indexing"
}

// ── list ──
function renderList(): void {
  const W = S.W; const Ht = S.H; const iw = W - 4;
  const f = tabFilter("Repos", "stats");
  const rs = rows(); lastRows = rs;
  const ch = f === EMPTY ? "" : chips("Repos", "stats", Math.max(10, W - 40));
  const title = "repos" + progress();
  box(0, 1, W, Ht - 2, title, ch ? ch + fg(C.dim) + " · " + periodName() + RST : periodName() + " · " + String(rs.length) + " projects", true);
  line(1, 2, W - 2, " " + chip(RV.period === "d", "d", "Today") + " " + chip(RV.period === "w", "w", "7 days") + " " + chip(RV.period === "m", "m", "30 days") + " " + chip(RV.period === "a", "a", "All") +
    fg(C.dim) + "   sort " + RST + fg(C.text) + RV.sort + RST + fg(C.dim) + " (s)" + RST);
  // columns: repo | sess live | cost | active | err% | harness mix | files | last
  const wide = iw >= 78; const mixW = iw >= 70 ? 8 : 0; const mkW = iw >= 86 ? 5 : 0;
  const cS = 5; const cL = wide ? 5 : 0; const cC = 11; const cG = iw >= 92 ? 8 : 0; const cA = 7; const cE = 6; const cF = wide ? 6 : 0; const cT = 5;
  const fixed = cS + cL + cC + cG + cA + cE + (mixW ? mixW + 2 : 0) + mkW + cF + cT;
  const rw = Math.max(10, iw - 1 - fixed);
  const hdr = fg(C.dim) + " " + fit("repo", rw) + rj("sess", cS) + (cL ? rj("live", cL) : "") + rj("cost", cC) + (cG ? rj("commits", cG) : "") + rj("active", cA) + rj("err%", cE) + (mixW ? "  " + fit("harness mix", mixW + mkW) : "") + (cF ? rj("files", cF) : "") + rj("last", cT) + RST;
  line(1, 3, W - 2, " " + hdr);
  const y0 = 4; const vis = Math.max(0, Ht - 2 - y0);
  if (RV.selKey) for (let i = 0; i < rs.length; i++) if (rs[i]?.key === RV.selKey) { RV.sel = i; break; } // rows reorder as projects resolve: the cursor stays on its project
  RV.sel = Math.max(0, Math.min(RV.sel, rs.length - 1)); RV.selKey = rs[RV.sel]?.key ?? "";
  if (RV.sel < RV.top) RV.top = RV.sel;
  if (RV.sel >= RV.top + vis) RV.top = RV.sel - vis + 1;
  RV.top = Math.max(0, Math.min(RV.top, Math.max(0, rs.length - vis)));
  listY0 = y0; listN = Math.min(vis, rs.length - RV.top);
  for (let i = 0; i < vis; i++) {
    const r = RV.top + i < rs.length ? rs[RV.top + i] : undefined;
    if (!r) { line(1, y0 + i, W - 2, i === 0 && !rs.length ? "  " + fg(C.dim) + emptyLine(f !== EMPTY) + RST : ""); continue; }
    const on = RV.top + i === RV.sel; const b = on ? bg(C.sel) : "";
    const nm = clean(shown(r.label));
    // the worktree count goes before the name is cut; a name still too long ends in "…" (a path keeps its end: the
    // folder, "(gone)")
    const wt = r.worktrees.size > 1 && width(nm) + (r.unread ? 2 : 0) + 2 + String(r.worktrees.size).length <= rw ? fg(C.dim) + " ⑂" + String(r.worktrees.size) + RST + b : "";
    const nr = Math.max(1, rw - (r.unread ? 2 : 0) - vwidth(wt));
    const nmF = width(nm) <= nr ? nm : (r.kind === "path" ? fitTail(nm, nr) : fit(nm, nr)).replace(/ +$/, "");
    const lab = (on ? fg(C.text) + CSI + "1m" : fg(r.kind === "path" || r.kind === "none" ? C.sub : C.text)) + nmF + RST + b + (r.unread ? fg(C.dim) + " ?" + RST + b : "") + wt;
    const mt = mixW ? "  " + mixCells(r.byHarness, mixW) + b + (mkW ? " " + fitStyled(marks(byShare(r.byHarness)), mkW - 1) + fillTo(fitStyled(marks(byShare(r.byHarness)), mkW - 1), mkW - 1) : "") + b : "";
    const nf = r.files.size + (r.outside.n > 0 ? 1 : 0);
    const s = (on ? fg(C.accent) + "▌" + RST + b : " ") + fitStyled(lab, rw) + fillTo(fitStyled(lab, rw), rw) + b +
      fg(C.text) + rj(String(r.sessions), cS) + RST + b + (cL ? (r.live ? fg(C.green) : fg(C.dim)) + rj(r.live ? String(r.live) : "·", cL) + RST + b : "") +
      rjs(costCell(r, split(r.modes, true)), cC) + b + (cG ? (r.commits ? fg(C.green) : fg(C.dim)) + rj(r.commits ? grp(r.commits) : "·", cG) + RST + b : "") + fg(C.text) + rj(r.activeMin > 0 ? hm(r.activeMin) : "·", cA) + RST + b + errCell(r.err, r.calls, cE) + b + mt +
      (cF ? fg(C.sub) + rj(nf ? grp(nf) : "·", cF) + RST + b : "") + fg(C.dim) + rj(r.last > 0 ? ago(r.last) : "", cT) + RST;
    line(1, y0 + i, W - 2, b + s + b);
  }
}
// " · ⠋ resolving 312 of 1,204 sessions… · indexing 40%" while the period is still being placed or indexed
function progress(): string {
  const idx = PL.idx < 0.999 ? "indexing " + String(Math.floor(PL.idx * 100)) + "%" : "";
  const res = PL.left > 0 ? "resolving " + grp(PL.left) + " of " + grp(PL.total) + " sessions…" : "";
  return res || idx ? " · " + spin() + " " + [res, idx].filter((x: string) => x.length > 0).join(" · ") : ""; // box titles are plain text
}
function emptyLine(filtered: boolean): string {
  if (PL.left > 0 || PL.idx < 0.999) return "placing sessions in their projects…";
  return filtered ? "no project matches the filter in this period — / edits it, d/w/m/a switch the period" : "no session activity in this period — d/w/m/a switch the period";
}

// ── detail ──
interface SRow { s: Sess; cost: number; unk: number; act: number; calls: number; err: number }
function sessRow(s: Sess, days: string[]): SRow {
  const o: SRow = { s, cost: 0, unk: 0, act: 0, calls: 0, err: 0 };
  const add = (x: Sess): void => {
    const a = ledger.get(x.path); if (!a) return;
    for (const dk of days) { const d = a.days.get(dk); if (!d) continue; o.cost += d.cost; o.unk += d.unk; o.act += spanMin(d.act); for (const st of heavy(d).tt.values()) { o.calls += st.n; o.err += st.err; } }
  };
  add(s); for (const k of s.subs) if (!k.cwd) add(k); // subagents without a cwd of their own book here (as in the aggregation)
  return o;
}
const whereMemo = new Map<string, string>();
// the session's checkout: a linked worktree's name; with several checkouts (clones) the checkout's dir name; plus
// ":sub/dir" below its top ("repo:sub/dir" with one checkout)
function whereOf(s: Sess, multi: boolean): string {
  const id = identOf(s); if (!id) return "";
  if (id.worktree) return display("repo", id.worktree, s);
  const cw = realCwd(s); const k = id.key + "\t" + cw + "\t" + (multi ? "m" : ""); const hit = whereMemo.get(k); if (hit !== undefined) return hit;
  const sub = subOf(id, cw); const name = multi && id.top ? display("repo", basename(id.top), s) : "repo";
  const w = sub ? name + ":" + display("file", sub, s) : multi ? name : "";
  if (whereMemo.size > 2000) whereMemo.clear();
  whereMemo.set(k, w); return w;
}
function focusList(r: RepoAgg): number[] { return r.branches.size ? [0, 1, 2, 3] : [0, 1, 2]; }
function itemsOf(i: number, r: RepoAgg): number {
  if (i === 0) return detailSessions(r, RV.file).length;
  if (i === 1) return topFiles(r, 20).length;
  if (i === 2) return topErrTools(r, 8).length;
  return r.branches.size;
}
// a list inside a box: clamps selection/scroll, records the mouse area, draws rows via draw(index, selected)
function listIn(i: number, x: number, y: number, w: number, h: number, n: number, draw: (k: number, on: boolean) => string, empty: string): void {
  const vis = Math.max(0, h); const sel = Math.max(0, Math.min(selOf(i), n - 1)); setSel(i, sel);
  let top = topOf(i); if (sel < top) top = sel; if (sel >= top + vis) top = sel - vis + 1; top = Math.max(0, Math.min(top, Math.max(0, n - vis))); setTop(i, top);
  const ar = areas[i]; if (ar) { ar.x0 = x; ar.x1 = x + w; ar.y0 = y; ar.n = Math.min(vis, n - top); ar.top = top; }
  const focus = RV.focus === i;
  for (let r = 0; r < vis; r++) {
    const k = top + r;
    if (k >= n) { line(x, y + r, w, r === 0 && n === 0 ? " " + fg(C.dim) + empty + RST : ""); continue; }
    const on = focus && k === sel; const b = on ? bg(C.sel) : "";
    line(x, y + r, w, b + (on ? fg(C.accent) + "▌" + RST + b : " ") + draw(k, on));
  }
}
function renderDetail(): void {
  const W = S.W; const Ht = S.H;
  const rs = rows(); let r: RepoAgg | null = null; for (const x of rs) if (x.key === RV.detail) r = x;
  lastDetail = r;
  if (!r) {
    box(0, 1, W, Ht - 2, "project", periodName(), true);
    line(2, 2, W - 4, fg(C.yellow) + (PL.left > 0 ? spin() + " resolving " + grp(PL.left) + " sessions…" : "no activity of this project in " + periodName() + " (or none matches the filter) — d/w/m/a switch the period, esc back") + RST);
    for (let y = 3; y < Ht - 2; y++) line(1, y, W - 2, "");
    return;
  }
  const rr: RepoAgg = r;
  // header: label, remote, kind, worktrees, totals
  const iw = W - 4;
  const fc = RV.file ? fg(C.accent) + "file:" + display("file", RV.file, null) + RST + fg(C.dim) + " (esc clears) · " + RST : "";
  const ch = tabFilter("Repos", "stats") === EMPTY ? "" : chips("Repos", "stats", Math.max(10, W - 50)) + fg(C.dim) + " · " + RST;
  box(0, 1, W, 5, shown(r.label), fc + ch + fg(C.dim) + periodName() + RST, false);
  const via = r.via && r.via !== "origin" ? fg(C.dim) + " (remote: " + r.via + ")" + RST : "";
  const l1 = fg(C.text) + CSI + "1m" + clean(shown(r.label)) + RST + "  " + (r.remote ? fg(C.sub) + clean(display("remote", r.remote, null)) + RST + via : fg(C.dim) + "no remote" + RST) + dot + fg(C.dim) + r.kind + (r.unread ? " · .git unreadable" : "") + RST;
  const wts: string[] = [];
  for (const [n, top] of r.worktrees) wts.push(fg(C.text) + display("repo", n, null) + RST + fg(C.dim) + " " + clean(display("cwd", top, null)) + RST);
  const l2 = fg(C.dim) + (r.worktrees.size > 1 ? "worktrees (" + String(r.worktrees.size) + ") " : "worktree ") + RST + wts.join(dot);
  const l3 = costCell(r, split(r.modes, false)) + dot + fg(C.cyan) + "↑" + kfmt(r.inTok) + RST + fg(C.sub) + " in " + RST + fg(C.purple) + "↓" + kfmt(r.outTok) + RST + fg(C.sub) + " out" + RST + dot +
    fg(C.text) + hm(r.activeMin) + RST + fg(C.sub) + " active" + RST + fg(C.dim) + " (" + hm(r.agentMin) + (iw >= 100 ? " agent-hours)" : " agents)") + RST + dot + fg(C.text) + grp(r.calls) + RST + fg(C.sub) + (iw >= 100 ? " tool calls" : " calls") + RST + dot + (r.calls < 10 ? fg(C.dim) + "err% · (< 10 calls)" + RST : errCell(r.err, r.calls, 0) + fg(C.sub) + " errors" + RST);
  const pc = perCommit(r.cost - r.spendNoCommit, 0, r.commits, single(r.modes));
  const l4 = fg(r.commits ? C.green : C.dim) + grp(r.commits) + RST + fg(C.sub) + (r.commits === 1 ? " commit" : " commits") + RST + (pc ? dot + fg(C.yellow) + pc + RST : "") +
    (r.spendNoCommit > 0 ? dot + fg(C.yellow) + money(r.spendNoCommit, single(r.modes)) + RST + fg(C.sub) + " without commits" + RST : "") + (r.prs.length ? dot + fg(C.accent) + String(r.prs.length) + (r.prs.length === 1 ? " PR" : " PRs") + RST + fg(C.sub) + " created" + RST : "");
  line(1, 2, W - 2, " " + l1 + dot + l4); line(1, 3, W - 2, " " + l2); line(1, 4, W - 2, " " + l3);
  // boxes: sessions (left) | files, tools, branches (right)
  const y0 = 6; const bh = Ht - 1 - y0; if (bh < 4) return;
  const lw = Math.max(40, Math.floor(W * 0.56)); const rw2 = W - lw;
  if (RV.focus === 3 && !r.branches.size) RV.focus = 0;
  const ss = detailSessions(r, RV.file); let heads = 0;
  box(0, y0, lw, bh, "sessions", String(ss.length) + (RV.file ? " touched it" : "") + " · ↵ transcript · c calls · V git", RV.focus === 0);
  // row = cursor 1 + mark 2 + title + gap 1 + where + branch + cost + active + err%
  const sw = lw - 2; const showBr = sw >= 78; const cW = 10; const aW = 7; const eW = 6; const brW = showBr ? 14 : 0; const whW = sw >= 56 ? 15 : 0;
  const tW = Math.max(8, sw - 4 - whW - brW - cW - aW - eW);
  listIn(0, 1, y0 + 1, sw, bh - 2, ss.length, (k: number, on: boolean): string => {
    const s = sessions.get(ss[k] ?? ""); if (!s) return "";
    if (!s.headDone && heads < 40) { loadHead(s); heads++; S.dirty = true; } // titles of visible rows (Claude/Codex: from the head)
    const x = sessRow(s, rr.days); const ad = isHarness(s.h) ? harnessOf(s.h) : null; const b = on ? bg(C.sel) : "";
    const mk = ad ? fg(ad.color()) + ad.mark + RST + b + " " : "  ";
    return mk + (on ? fg(C.text) + CSI + "1m" : fg(C.sub)) + fit(clean(titleOf(s)), tW) + RST + b + " " + (whW ? fg(C.dim) + fitTail(whereOf(s, rr.worktrees.size > 1), whW - 1) + " " + RST + b : "") +
      (brW ? fg(C.purple) + fit(clean(s.branch), brW - 1) + " " + RST + b : "") + rjs(costCell(x, money(x.cost, asBill(s.bill))), cW) + b + fg(C.text) + rj(x.act > 0 ? hm(x.act) : "·", aW) + RST + b + errCell(x.err, x.calls, eW);
  }, RV.file ? "no session of this period changed it" : "no sessions");
  // right column heights
  const nb = r.branches.size ? 3 : 2; const avail = bh;
  const hF = nb === 3 ? Math.max(3, Math.floor(avail * 0.45)) : Math.max(3, Math.floor(avail * 0.6));
  const hT = nb === 3 ? Math.max(3, Math.floor(avail * 0.3)) : avail - hF; const hB = avail - hF - hT;
  const fs = topFiles(r, 20);
  box(lw, y0, rw2, hF, "files", String(r.files.size) + " changed · ↵ narrows", RV.focus === 1);
  const fw = rw2 - 3; const eW2 = 5; const dW = fw >= 34 ? 12 : 0; const mW = fw >= 28 ? 4 : 0; const pW = Math.max(6, fw - 2 - eW2 - dW - mW);
  listIn(1, lw + 1, y0 + 1, fw, hF - 2, fs.length, (k: number, on: boolean): string => {
    const e = fs[k]; if (!e) return ""; const b = on ? bg(C.sel) : ""; const fa = e[1];
    const name = e[0] ? clean(display("file", e[0], null)) : "(outside the repo)";
    const lines = fg(C.green) + "+" + kfmt(fa.add) + RST + b + " " + fg(C.red) + "−" + kfmt(fa.del) + RST + b;
    return (on ? fg(C.text) + CSI + "1m" : e[0] ? fg(C.sub) : fg(C.dim)) + fitTail(name, pW) + RST + b + fg(C.text) + rj(grp(fa.n), eW2) + RST + b + (dW ? rjs(lines, dW) + b : "") + (mW ? " " + fitStyled(marks([...fa.by]), mW - 1) : "");
  }, "no changed files");
  const ts = topErrTools(r, 8);
  box(lw, y0 + hF, rw2, hT, "tools", "by errors", RV.focus === 2);
  const progs = worstProgs(r, 3); const tRows = Math.max(0, hT - 2 - (progs && hT - 2 > ts.length ? 1 : 0));
  listIn(2, lw + 1, y0 + hF + 1, fw, tRows, ts.length, (k: number, on: boolean): string => {
    const e = ts[k]; if (!e) return ""; const b = on ? bg(C.sel) : "";
    return (on ? fg(C.text) + CSI + "1m" : fg(C.sub)) + fit(display("tool", e[0], null), Math.max(6, fw - 2 - 7 - 7)) + RST + b + fg(C.text) + rj(grp(e[1].n), 7) + RST + b + errCell(e[1].err, e[1].n, 7);
  }, "no tool calls");
  if (progs && hT - 2 > tRows) line(lw + 1, y0 + hF + 1 + tRows, fw, " " + fg(C.dim) + "failing: " + RST + progs);
  if (nb === 3 && hB >= 3) {
    const bs = branchRows(r);
    const prs = rr.prs.length ? " · " + String(rr.prs.length) + (rr.prs.length === 1 ? " PR" : " PRs") : "";
    box(lw, y0 + hF + hT, rw2, hB, "branches", String(bs.length) + " · " + grp(rr.commits) + " ✓ · $/c" + prs, RV.focus === 3);
    const gW = fw >= 44 ? 6 : 0; const pW2 = fw >= 52 ? 12 : 0; const room = hB - 2 - (rr.prs.length && hB - 2 > bs.length ? 1 : 0);
    listIn(3, lw + 1, y0 + hF + hT + 1, fw, room, bs.length, (k: number, on: boolean): string => {
      const e = bs[k]; if (!e) return ""; const b = on ? bg(C.sel) : ""; const ba = e[1];
      return fg(C.purple) + (on ? CSI + "1m" : "") + fit(clean(display("branch", e[0], null)), Math.max(6, fw - 2 - 5 - gW - pW2 - 10)) + RST + b + fg(C.text) + rj(String(ba.sess), 5) + RST + b +
        (gW ? (ba.commits ? fg(C.green) : fg(C.dim)) + rj(ba.commits ? String(ba.commits) + "✓" : "·", gW) + RST + b : "") +
        (pW2 ? fg(C.sub) + rj(perCommit(ba.cost, ba.unk, ba.commits, single(rr.modes)).replace(/\/commit$/, "/c"), pW2) + RST + b : "") + rjs(costCell(ba, money(ba.cost, single(rr.modes))), 10);
    }, "");
    if (rr.prs.length && hB - 2 > bs.length) line(lw + 1, y0 + hF + hT + 1 + room, fw, " " + fg(C.dim) + "created " + RST + rr.prs.map((u: string) => fg(C.accent) + (u.indexOf("merge_requests") >= 0 ? "!" : "#") + u.slice(u.lastIndexOf("/") + 1) + RST).join(" "));
  }
}
function branchRows(r: RepoAgg): [string, BranchAgg][] { const xs = [...r.branches.entries()]; xs.sort((x: [string, BranchAgg], y: [string, BranchAgg]) => y[1].cost - x[1].cost || y[1].sess - x[1].sess || (x[0] < y[0] ? -1 : 1)); return xs; }
function worstProgs(r: RepoAgg, n: number): string {
  const xs = [...r.progErr.entries()]; xs.sort((x: [string, Cnt], y: [string, Cnt]) => y[1].err - x[1].err || y[1].n - x[1].n);
  return xs.slice(0, n).map((e: [string, Cnt]) => fg(C.text) + display("prog", e[0], null) + RST + fg(C.dim) + " " + String(e[1].err) + "/" + String(e[1].n) + RST).join(dot);
}

// ── keys / mouse ──
function curDetailSess(): Sess | null { const r = lastDetail; if (!r) return null; const ss = detailSessions(r, RV.file); const p = ss[selOf(0)]; return p ? sessions.get(p) ?? null : null; }
function activate(): void {
  const r = lastDetail; if (!r) return;
  if (RV.focus === 0) { const s = curDetailSess(); if (s) openTranscript(s); }
  else if (RV.focus === 1) { const e = topFiles(r, 20)[selOf(1)]; if (e && e[0]) { RV.file = e[0]; RV.focus = 0; setSel(0, 0); setTop(0, 0); } else if (e) say("info", "files outside the repo have no sessions filter"); }
}
function period(k: string): boolean { if (k === "d" || k === "w" || k === "m" || k === "a") { RV.period = k; return true; } return false; }
function key(k: string): boolean {
  if (period(k)) return true;
  if (RV.detail) {
    const r = lastDetail; const fl = r ? focusList(r) : [0];
    if (k === "esc") { if (RV.file) RV.file = ""; else RV.detail = ""; return true; }
    if (k === "bs" || k === "backspace") { RV.file = ""; RV.detail = ""; return true; }
    if (k === "left" || k === "right") { const i = fl.indexOf(RV.focus); const n = fl.length; RV.focus = fl[((i < 0 ? 0 : i) + (k === "right" ? 1 : n - 1)) % n] ?? 0; return true; }
    const n = r ? itemsOf(RV.focus, r) : 0; const f = RV.focus; const page = Math.max(1, (areas[f]?.n ?? 10) - 1);
    if (k === "up" || k === "k" || k === "wheelup") setSel(f, Math.max(0, selOf(f) - 1));
    else if (k === "down" || k === "j" || k === "wheeldown") setSel(f, Math.min(Math.max(0, n - 1), selOf(f) + 1));
    else if (k === "pgup") setSel(f, Math.max(0, selOf(f) - page));
    else if (k === "pgdn") setSel(f, Math.min(Math.max(0, n - 1), selOf(f) + page));
    else if (k === "g" || k === "home") setSel(f, 0);
    else if (k === "G" || k === "end") setSel(f, Math.max(0, n - 1));
    else if (k === "enter") activate();
    else if (k === "c") { if (RV.focus === 0) { const s = curDetailSess(); if (s) openGraph(s); } }
    else if (k === "V") { if (RV.focus === 0) { const s = curDetailSess(); if (s) openGit(s); } }
    else return false;
    return true;
  }
  const n = lastRows.length; const page = Math.max(1, listN - 1);
  if (k === "up" || k === "k" || k === "wheelup") RV.sel = Math.max(0, RV.sel - 1);
  else if (k === "down" || k === "j" || k === "wheeldown") RV.sel = Math.min(Math.max(0, n - 1), RV.sel + 1);
  else if (k === "pgup") RV.sel = Math.max(0, RV.sel - page);
  else if (k === "pgdn") RV.sel = Math.min(Math.max(0, n - 1), RV.sel + page);
  else if (k === "g" || k === "home") RV.sel = 0;
  else if (k === "G" || k === "end") RV.sel = Math.max(0, n - 1);
  else if (k === "s") { RV.sort = SORTS[(SORTS.indexOf(RV.sort) + 1) % SORTS.length] ?? "cost"; RV.sel = 0; RV.top = 0; RV.selKey = ""; say("info", "repos sorted by " + RV.sort); return true; }
  else if (k === "enter" || k === "right") { const r = lastRows[RV.sel]; if (r) openDetail(r.key); }
  else return false;
  RV.selKey = lastRows[RV.sel]?.key ?? "";
  return true;
}
function mouse(x: number, y: number, dbl: boolean): void {
  if (!RV.detail) {
    if (y === 2 && x >= 2 && x < 44) { // the period chips
      const ks = ["d", "w", "m", "a"]; let at = 2;
      for (const [i, w] of [9, 10, 11, 7].entries()) { if (x >= at && x < at + w) { RV.period = ks[i] ?? "w"; return; } at += w + 1; }
      return;
    }
    if (y < listY0 || y >= listY0 + listN) return;
    const i = RV.top + (y - listY0); const r = lastRows[i]; if (!r) return;
    if (i === RV.sel || dbl) { RV.sel = i; openDetail(r.key); } else RV.sel = i;
    RV.selKey = r.key;
    return;
  }
  for (let i = 0; i < areas.length; i++) {
    const ar = areas[i]; if (!ar || x < ar.x0 || x >= ar.x1 || y < ar.y0 || y >= ar.y0 + ar.n) continue;
    const k = ar.top + (y - ar.y0);
    if (RV.focus === i && (k === selOf(i) || dbl)) { setSel(i, k); activate(); } else { RV.focus = i; setSel(i, k); }
    return;
  }
}
const tab: Tab = { name: "Repos", render: () => { if (RV.detail) renderDetail(); else renderList(); }, key, mouse };
H.tabs.push(tab);
function mine(): boolean { return S.tab - 2 === H.tabs.indexOf(tab); }
// head reads ride on the tick while the tab is shown (40 ms a slice); the backlog keeps the burst cadence until all are placed
H.onTick.push(() => { if (mine() && S.mode === "list") placeTick(periodDays(), RV.period === "a", 40); });
H.backlog.push(() => PL.left > 0 && mine() && S.mode === "list");

// @ in the Sessions list: the selected session's project detail (a period that holds its activity)
export function jumpToProject(s: Sess | null): boolean {
  if (!s) return false;
  const top = s.parent ? parentOf(s) ?? s : s;
  const id = identSync(s); if (!id) { say("info", "project not resolved yet — try again in a moment"); return false; }
  S.tab = 2 + H.tabs.indexOf(tab); S.mode = "list";
  openDetail(id.key);
  let found = false; for (const r of rows()) if (r.key === id.key) found = true;
  if (!found) RV.period = "a";
  const ss = (() => { for (const r of rows()) if (r.key === id.key) return detailSessions(r, ""); return [] as string[]; })();
  const i = ss.indexOf(top.path); if (i >= 0) setSel(0, i);
  return true;
}
H.keys.push((mode: string, k: string): boolean => {
  if (mode !== "list" || S.tab !== 0 || k !== "@") return false;
  if (!remoteOnly(current(), "the project view")) jumpToProject(current());
  return true;
});
H.footerHints.push((mode: string): string[][] => {
  if (mode !== "list") return [];
  if (S.tab === 0) return [["@", "project"]];
  if (!mine()) return [];
  if (RV.detail) return RV.focus === 0 ? [["←→", "box"], ["↑↓", "session"], ["↵", "transcript"], ["c", "calls"], ["V", "git"], ["esc", RV.file ? "clear file" : "back"], ["d/w/m/a", "period"], ["/", "filter"]]
    : [["←→", "box"], ["↑↓", "select"], ["↵", RV.focus === 1 ? "sessions that changed it" : "—"], ["esc", RV.file ? "clear file" : "back"], ["d/w/m/a", "period"], ["/", "filter"]];
  return [["↑↓", "project"], ["↵", "details"], ["d/w/m/a", "period"], ["s", "sort"], ["/", "filter"], ["p", "pin"], ["P", "pins"]];
});
H.helpSections.push({ name: "repos", ctx: "Repos", keys: [["d w m a", "period: today, 7 days, 30 days, all time"], ["s", "sort: cost, active, sessions, err%, last"],
  ["↵  click", "project detail: sessions, files, tools, branches"], ["← →", "detail: move between the boxes"], ["↵", "detail: open the transcript · on a file: only sessions that changed it"],
  ["c  V", "detail: call graph · git view (commits, PRs) of the selected session"], ["esc  ⌫", "clear the file chip, then back to the list"], ["@", "Sessions list: open the selected session's project"],
  ["/  p  P", "filter the sessions before grouping (harness is codex = each project's Codex share) · pin · pins"],
  ["", "commits = the sessions' own (✓) commits in the period; $/commit = cost of the sessions that committed ÷ commits;"],
  ["", "  without commits = cost of sessions that made none; a branch's cost is split by its sessions' commits"],
  ["", "one project = worktrees and clones of one remote (origin, else upstream, else the first); forks are separate"],
  ["", "active = union of the sessions' active minutes (lines ≤ repo.idleGapMin apart, default 5, plus tool runs);"],
  ["", "  agent-hours = their sum; a changed gap applies to newly indexed lines; differs from the call graph's span-based active"],
  ["", "files are approximate on very busy days (per-day top-k); err% shows from 10 calls"]] });
