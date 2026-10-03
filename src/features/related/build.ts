// agentglass — related events builder: candidate sessions of the anchor's project, read by time window across ticks
// under a byte and time budget (spec related-events 2–3); nothing is persisted
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../../model/types.ts";
import { H, realCwd, display } from "../../hooks.ts";
import { sessions, parentOf, loadHead } from "../../model/sessions.ts";
import { harnessOf, sourceOf, window, parseRaw, hookedCopy } from "../../harness/index.ts";
import { seekTime } from "../../harness/source.ts";
import { type Ident, labelOf } from "../../model/project.ts";
import { identOf, identSync } from "../query/project.ts";
import { livePid } from "../query/eval.ts";
import { ledger, pending } from "../usage/ledger.ts";
import { dayKey } from "../usage/record.ts";
import { LOG, severityOf } from "../rules/engine.ts";
import { ms } from "../callgraph/model.ts";
import { type RelEv, type RelSt, type Spawn, newSt, row, toRel, toRelShown, markConflicts } from "./model.ts";
import { reflogCommits, worktreeGitdirs } from "./reflog.ts";
import { REDACT } from "../redact-on.ts";

export const CAP_BYTES = 16777216; // read budget per build
export const MAX_CANDS = 40;
const WIN_BYTES = 65536; const TAIL_BYTES = 6291456;
// anchor: the row the view centres on (a copy; rows hold the anchor's own row too); key/label/scope: the project
// (scope "cwd" = no project, same cwd); cands: session paths, anchor first; next: the candidate being read;
// cur/end: per-session cursor and stop cursor (end -1 = not seeked yet); all: rows in read order (call rows fold
// their results by index), refl: reflog commits no session observed, rows: all sorted by time and marked; capped: the byte budget ended reading early
export interface Build {
  anchor: RelEv; key: string; label: string; scope: string; t0: number; t1: number; cMs: number; cands: string[]; more: number; next: number;
  rows: RelEv[]; all: RelEv[]; flagged: number; bytes: number; cur: Map<string, number>; end: Map<string, number>; last: Map<string, number>;
  refl: RelEv[]; st: RelSt; live: boolean; tsMissing: boolean; capped: boolean; spawns: Spawn[]; common: string; tops: Map<string, string>;
}

// the anchor's time: its own ts, else the nearest earlier one, else the next later one; 0 = none
export function anchorTime(evs: Ev[], i: number): number {
  if (i < 0 || i >= evs.length) return 0;
  for (let j = i; j >= 0; j--) { const t = ms(evs[j].ts); if (t) return t; }
  for (let j = i + 1; j < evs.length; j++) { const t = ms(evs[j].ts); if (t) return t; }
  return 0;
}
// epoch ms of the first event with a timestamp in one raw line (0 none); no event hooks: only the time is read
function tsOfLine(s: Sess): (l: string) => number {
  return (l: string): number => { const evs: Ev[] = []; parseRaw(s.h, l, evs, s); for (const e of evs) { const t = ms(e.ts); if (t) return t; } return 0; };
}
// local [minute, minute) of the window inside one day starting at local midnight d0
function minutesIn(a: number[], m0: number, m1: number): number {
  let n = 0;
  for (let j = 0; j + 1 < a.length; j += 2) { const s0 = Math.max(m0, a[j] ?? 0); const e0 = Math.min(m1, a[j + 1] ?? 0); if (e0 > s0) n += e0 - s0; }
  return n;
}
function localMin(t: number): number { const d = new Date(t); return d.getHours() * 60 + d.getMinutes(); }
// active minutes of an indexed session inside [t0, t1] from its Day.act intervals (window day keys → intervals);
// -1 = no evidence (not indexed, or no activity booked on any of the window's days: the caller estimates from the head)
function activeIn(s: Sess, t0: number, t1: number): number {
  const a = ledger.get(s.path); if (!a) return -1;
  if (pending(s, a)) return -1;
  let n = 0; let t = t0; let booked = false;
  for (let g = 0; g < 3 && t <= t1; g++) {
    const k = dayKey(new Date(t)); const m0 = localMin(t);
    const mid = t + (1440 - m0) * 60000 - (t % 60000); // the next local midnight (± a DST hour)
    const m1 = t1 < mid ? localMin(t1) + 1 : 1440;
    const d = a.days.get(k); if (d && d.act.length) { booked = true; n += minutesIn(d.act, m0, m1); }
    t = mid;
  }
  return booked ? n : -1;
}
// not indexed yet: written since t0, and its first timestamp (head) not after t1; the estimate = minutes of overlap
function headTs(s: Sess): number {
  const src = sourceOf(s.h); const f = tsOfLine(s);
  for (const l of src.lines(s, 0, Math.min(s.size, window(src, WIN_BYTES))).lines) { const t = f(l); if (t) return t; }
  return 0;
}
function sameProject(s: Sess, key: string, scope: string, cwd: string): boolean {
  if (scope === "cwd") return realCwd(s) === cwd;
  const id = identOf(s) ?? identSync(s);
  return id !== null && id.key === key;
}
// the anchor's project, the window's sessions of it ranked by active minutes, the anchor first, capped
export function candidates(anchor: Sess, t0: number, t1: number, cap: number): { paths: string[]; more: number; scope: string } {
  const id = identSync(anchor);
  const scope = !id || id.kind === "none" ? "cwd" : "project";
  const key = id ? id.key : ""; const cwd = realCwd(anchor);
  const ranked: { p: string; n: number }[] = [];
  for (const s of sessions.values()) {
    if (s === anchor || s.mtime < t0) continue; // nothing written since before the window
    let n = activeIn(s, t0, t1);
    if (n < 0) { const h = headTs(s); if (!h || h > t1) continue; n = Math.max(1, Math.round((Math.min(t1, s.mtime) - Math.max(t0, h)) / 60000)); }
    if (n <= 0 || !sameProject(s, key, scope, cwd)) continue;
    ranked.push({ p: s.path, n });
  }
  ranked.sort((a, b) => b.n - a.n || (a.p < b.p ? -1 : 1));
  const paths = [anchor.path];
  for (const r of ranked.slice(0, Math.max(0, cap - 1))) paths.push(r.p);
  return { paths, more: Math.max(0, ranked.length - (cap - 1)), scope };
}
// the row an anchor event stands for: a result folds into its call; an event that is no row kind (assistant text,
// thinking) gets a row of its own
function anchorRow(s: Sess, e: Ev, t: number, top: string): RelEv {
  const k = e.kind === "result" ? "tool" : e.kind;
  const r = row(t, e.ts, s.path, s.h, top, k === "user" ? "prompt" : k === "tool" ? "tool" : e.kind, "", e.text.replace(/\u0000/g, " ").split("\n")[0] ?? "", true);
  r.evKind = k; r.evId = k === "tool" ? e.id : ""; r.evText = e.text; r.mark = "anchor";
  return r;
}
export function isAnchor(b: Build, r: RelEv): boolean {
  const a = b.anchor;
  if (r.sess !== a.sess || r.kind === "alert" || r.kind === "commit") return false;
  if (a.evId) return r.evId === a.evId && r.evKind === a.evKind;
  return r.evKind === a.evKind && r.evText === a.evText && (r.ts === a.ts || a.ts === "");
}
function topOf(s: Sess): string { const id = identOf(s) ?? identSync(s); return id && id.top ? id.top : realCwd(s); }

// scriptc: a Build built as a literal inside startBuild would be handed to helpers by value; built here it is shared
function newBuild(anchor: RelEv, id: Ident | null, label: string, scope: string, t0: number, t1: number, cMs: number, cands: string[], more: number): Build {
  return {
    anchor, key: id ? id.key : "", label, scope, t0, t1, cMs, cands, more, next: 0, rows: [], all: [], refl: [], flagged: 0, bytes: 0,
    cur: new Map<string, number>(), end: new Map<string, number>(), last: new Map<string, number>(),
    st: newSt(), live: false, tsMissing: false, capped: false, spawns: [], common: id ? id.common || id.gitdir : "", tops: new Map<string, string>(),
  };
}
// null = the event has no time at all (the caller says so)
export function startBuild(anchor: Sess, evs: Ev[], i: number, minutes: number, conflictMinutes: number): Build | null {
  const t = anchorTime(evs, i); if (!t) return null;
  const t0 = t - minutes * 60000; const t1 = t + minutes * 60000;
  const c = candidates(anchor, t0, t1, MAX_CANDS);
  const id: Ident | null = identSync(anchor);
  const top = topOf(anchor);
  const b = newBuild(anchorRow(anchor, evs[i], t, top), id, id ? display("repo", labelOf(id), anchor) : "", c.scope, t0, t1, conflictMinutes * 60000, c.paths, c.more);
  // the open transcript already holds the window when it reaches back past t0: no re-read. Not when event hooks rewrite
  // content (--redact): its events are the fakes, and files and commands must be matched on the real ones
  let first = 0; for (const x of evs) { first = ms(x.ts); if (first) break; }
  if (first && first <= t0 && !H.events.length) {
    b.tops.set(anchor.path, top); b.st.last = 0;
    toRel(evs, anchor.path, anchor.h, realCwd(anchor), top, true, t0, t1, b.st, b.all);
    b.last.set(anchor.path, b.st.last); b.cur.set(anchor.path, anchor.size); b.end.set(anchor.path, anchor.size);
    b.next = 1;
  }
  extras(b); settle(b);
  return b;
}
// alert rows from the rules log (this agentglass run), and reflog commits of the project's worktrees no session observed
function extras(b: Build): void {
  for (const tr of LOG) {
    if ((tr.state !== "fire" && tr.state !== "escalate") || tr.at < b.t0 || tr.at > b.t1 || b.cands.indexOf(tr.path) < 0) continue;
    const key = tr.path + "\u0001alert\u0001" + String(tr.at) + "\u0001" + tr.rule;
    if (b.st.seen.has(key)) continue;
    b.st.seen.add(key);
    const s = sessions.get(tr.path);
    b.all.push(row(tr.at, new Date(tr.at).toISOString(), tr.path, s ? s.h : "", s ? b.tops.get(tr.path) ?? "" : "", "alert", "", tr.rule + " alert (" + severityOf(tr.to) + (tr.state === "escalate" ? ", escalated" : "") + ")", b.anchor.sess === tr.path));
  }
}
function reflogRows(b: Build): void {
  b.refl = [];
  const seen = new Set<string>(); for (const r of b.all) if (r.sha) seen.add(r.sha);
  for (const gd of worktreeGitdirs(b.common)) for (const c of reflogCommits(gd)) {
    if (c.at < b.t0 || c.at > b.t1) continue;
    const sha = c.sha.slice(0, 7); if (seen.has(sha)) continue;
    seen.add(sha);
    const r = row(c.at, new Date(c.at).toISOString(), "", "", "", "commit", "", "commit (no session) " + sha + (REDACT ? "" : " " + c.subj), false); // the subject is real content: hidden under --redact
    r.sha = sha; b.refl.push(r);
  }
}
// subagent intervals: the parent's spawning call start → its result, else the child's first → last row
function spawns(b: Build): void {
  b.spawns = [];
  for (const p of b.cands) {
    const s = sessions.get(p); if (!s || !s.parent) continue;
    const par = parentOf(s); if (!par || b.cands.indexOf(par.path) < 0) continue;
    const f = harnessOf(s.h).spawnOf; const cid = f ? f(s) : "";
    let t0 = 0; let t1 = 0;
    if (cid) for (const r of b.all) if (r.sess === par.path && r.evId === cid && r.evKind === "tool") { t0 = r.t; t1 = r.rt; break; }
    if (!t0 || !t1) { t0 = 0; t1 = 0; for (const r of b.all) if (r.sess === p) { if (!t0 || r.t < t0) t0 = r.t; if (r.t > t1) t1 = r.t; } }
    if (t0) b.spawns.push({ parent: par.path, child: p, t0, t1 });
  }
}
// rows = all by time, marked
function settle(b: Build): void {
  if (b.next >= b.cands.length) reflogRows(b);
  spawns(b);
  const rows = b.all.slice(); for (const r of b.refl) rows.push(r);
  let found = false;
  for (const r of rows) if (isAnchor(b, r)) { found = true; b.anchor.t = r.t; b.anchor.ts = r.ts; b.anchor.kind = r.kind; b.anchor.tool = r.tool; b.anchor.text = r.text; b.anchor.files = r.files; b.anchor.cat = r.cat; b.anchor.top = r.top; break; } // the anchor as its row shows it
  if (!found) rows.push(b.anchor); // assistant text, thinking: no row kind of its own
  rows.sort((x: RelEv, y: RelEv) => x.t - y.t);
  b.flagged = markConflicts(rows, b.cMs, b.spawns);
  b.rows = rows;
  let live = false; for (const p of b.cands) { const s = sessions.get(p); if (s && livePid(s) > 0) live = true; }
  b.live = live;
}
// first touch of a session: seek to the window (or the tail when no timestamp is found anywhere)
function seek(b: Build, s: Sess): void {
  const src = sourceOf(s.h); const st = src.stat(s); const size = st ? st.size : s.size;
  const win = window(src, WIN_BYTES);
  if (!s.headDone) { loadHead(s); b.bytes += Math.min(size, window(src, harnessOf(s.h).headBytes)) * src.unit; } // title and cwd of a session the list has not shown yet
  const k = seekTime(s, src, size, b.t0, win, tsOfLine(s));
  b.bytes += k.reads * win * src.unit;
  let at = k.at;
  if (!k.found) { b.tsMissing = true; at = src.align(s, Math.max(0, size - window(src, TAIL_BYTES))); }
  b.cur.set(s.path, at); b.end.set(s.path, size); b.tops.set(s.path, topOf(s));
}
// one window of one session; true = this session is done
function readWindow(b: Build, s: Sess): boolean {
  const src = sourceOf(s.h); const win = window(src, WIN_BYTES);
  const at = b.cur.get(s.path) ?? 0; const end = b.end.get(s.path) ?? 0;
  if (at >= end) return true;
  const r = src.lines(s, at, Math.min(end, at + win));
  const next = r.next > at ? r.next : Math.min(end, at + win); // a record longer than a window: skip it
  b.bytes += (next - at) * src.unit; b.cur.set(s.path, next);
  const evs: Ev[] = [];
  for (const l of r.lines) parseRaw(s.h, l, evs, s);
  const red = H.events.length > 0; // --redact: rows match the real events, show the hooked copies
  b.st.last = b.last.get(s.path) ?? 0;
  toRelShown(evs, red ? hookedCopy(s, evs) : evs, red, s.path, s.h, realCwd(s), b.tops.get(s.path) ?? "", s.path === b.anchor.sess, b.t0, b.t1, b.st, b.all);
  b.last.set(s.path, b.st.last);
  let past = false; for (const e of evs) if (ms(e.ts) > b.t1) { past = true; break; }
  return past || next >= end;
}
// reads windows until budgetMs (by now()) or the byte cap; true while candidates remain
export function stepBuild(b: Build, budgetMs: number, now: () => number): boolean {
  const start = now(); let changed = false;
  while (b.next < b.cands.length) {
    if (now() - start >= budgetMs) break;
    const s = sessions.get(b.cands[b.next] ?? "");
    if (!s) { b.next++; continue; }
    const src = sourceOf(s.h); const fresh = b.end.get(s.path) === undefined; // a seek reads ≤ 19 windows, plus the head once
    const need = (fresh ? 20 : 1) * window(src, WIN_BYTES) * src.unit + (fresh && !s.headDone ? harnessOf(s.h).headBytes : 0);
    if (b.bytes + need > CAP_BYTES) { b.capped = true; b.next = b.cands.length; changed = true; break; }
    if (b.end.get(s.path) === undefined) seek(b, s);
    if (readWindow(b, s)) { b.next++; changed = true; }
  }
  if (changed) settle(b);
  return b.next < b.cands.length;
}
// live: the window reaches into the future and a candidate runs — append from each session's cursor (no seek), re-mark
export function repoll(b: Build): boolean {
  if (b.next < b.cands.length || b.t1 <= Date.now() || !b.live) return false;
  const n0 = b.all.length;
  for (const p of b.cands) {
    const s = sessions.get(p); if (!s) continue;
    const st = sourceOf(s.h).stat(s); if (!st) continue;
    const at = b.cur.get(p) ?? st.size; if (st.size <= at) continue;
    b.end.set(p, st.size);
    for (let g = 0; g < 64 && !readWindow(b, s); g++) { /* up to 4 MB per session and poll */ }
  }
  extras(b);
  if (b.all.length === n0) return false;
  settle(b); return true;
}
