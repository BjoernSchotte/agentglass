// agentglass — session discovery, lazy log loading, and the filtered subagent tree shown in the list
// SPDX-License-Identifier: Apache-2.0
import { firstLine } from "../util/text.ts";
import { own } from "../util/own.ts";
import { type Ev, type Sess, type Harness, newSess } from "./types.ts";
import { HARNESSES, harnessOf, sourceOf, window, parseEvents, busy, epochOf } from "../harness/index.ts";
import { readBytes, KNOWN, LISTING } from "../util/fs.ts";
import { S } from "../state.ts";
import { H, applyMeta, remoteRows } from "../hooks.ts";

export const sessions = new Map<string, Sess>();
KNOWN.mtime = (path: string): number => { const s = sessions.get(path); return s ? s.mtime : 0; };
export const SG = { gen: 0 }; // bumped whenever a session is added or removed (caches over the session set key on it with sessions.size)
// fleet: a remote row is live while its host's report said so and that report is fresh (features/fleet/hosts.ts sets ok);
// RG.gen moves whenever remote rows or their freshness change (buildView's signature)
export const FRESH = { ok: (host: string): boolean => true };
export const RG = { gen: 0 };
export function isLive(s: Sess): boolean { return s.pid > 0 || (s.host !== "" && s.rlive && FRESH.ok(s.host)); }

// a known log is stat'ed every scan when it is pid-linked or written within 10 min, every 4th when within a day; the rest
// in turns, 1/ROT of them per scan (~every 2 min at the hot scan interval): a history of old logs was most of a scan
const ROT = 40; const RECENT_MS = 86400000; const WARM_MS = 600000; // written within 10 min: every scan; within a day: every 4th
const SCAN = { no: 0, now: 0, seen: 0, gone: [] as string[], gen: -1, n: -1 };
// a log's turn: from the characters before its extension (ids, random enough), no lookup per log and scan
function rotOf(path: string): number { const n = path.length; let h = 0; for (let i = Math.max(0, n - 14); i < n - 6; i++) h = h * 7 + path.charCodeAt(i); return h % ROT; }
// a known session at its turn: stat, new size/mtime; false = its log is gone
function refresh(h: Harness, s: Sess, turn: number): boolean {
  const age = SCAN.now - s.mtime;
  if (s.pid <= 0 && (age >= RECENT_MS ? turn !== SCAN.no % ROT : age >= WARM_MS && turn % 4 !== SCAN.no % 4)) { SCAN.seen++; if (H.meta.length) applyMeta(s); return true; } // not its turn
  const st = sourceOf(h).stat(s);
  if (!st) { SCAN.gone.push(s.path); return false; }
  if (restat(s, st.size, st.mtime, epochOf(s)) || H.meta.length) applyMeta(s); // head and tail reads apply it after they change fields; --redact (H.meta) fakes every scanned session as before: a writer path that skips it must not leak
  SCAN.seen++; return true;
}
// counts what it saw (scan() finds what went from the count; no set of paths per scan); the session, null = none
function addFile(h: Harness, path: string, id: string, archived: boolean, parent: string): Sess | null {
  const known = sessions.get(path);
  if (known) return refresh(h, known, rotOf(path)) ? known : null;
  let s: Sess | undefined = known; // typed as the map's (a fresh record bound to a const was copied into the map by scriptc 0.1.7: updates after set were lost)
  if (!s) { s = newSess(h, id, path, archived); s.parent = parent; }
  const st = sourceOf(h).stat(s);
  if (!st) return null; // gone (a new session is not in the map yet)
  sessions.set(path, s); SG.gen++; adds++;
  const m = harnessOf(h).meta; if (m) m(s);
  restat(s, st.size, st.mtime, epochOf(s)); applyMeta(s);
  SCAN.seen++; return s;
}
// per harness: what its last scan listed and the sessions those were. A scan that lists the same paths (no directory
// was listed again: the listings are the cached ones, no log came) walks those sessions instead: no lookup per log
interface Listed { paths: string[]; ids: string[]; pars: string[]; arch: boolean[]; sess: (Sess | null)[]; live: number; hot: number[] | null; isHot: boolean[] }
const NOPATHS: string[] = [];
const LISTED = new Map<string, Listed>();
// new size/mtime; another cursor epoch (the source switched transport) invalidates what was read: like a rewritten file.
// true = something changed
export function restat(s: Sess, size: number, mtime: number, ep: string): boolean {
  const moved = s.mtime !== mtime || s.size !== size;
  s.mtime = mtime; s.size = size;
  if (ep === s.ep) return moved;
  s.ep = ep; s.tailSize = -1; s.headDone = false; s.evs = [];
  return true;
}
// live probe: stat only pid-linked sessions (no spawn, no directory listing) so a streaming agent is seen within the probe
// interval and its tail follows without waiting for scan(); unlinked sessions are left to scan(). true = one grew
export function probeLive(): boolean {
  let changed = false;
  for (const s of sessions.values()) {
    if (s.pid <= 0) continue;
    const st = sourceOf(s.h).stat(s);
    if (!st || (st.size === s.size && st.mtime === s.mtime)) continue;
    restat(s, st.size, st.mtime, epochOf(s)); changed = true;
  }
  return changed;
}
let scanned = false;
// told after a scan that added sessions (procs.ts: link live processes to them now, not on the next process pass)
export const SCANNED: (() => void)[] = [];
let adds = 0;
export function scan(): void {
  if (!scanned) { scanned = true; for (const f of H.firstScan) f(); }
  const a0 = adds;
  scanOnce();
  if (adds !== a0) for (const f of SCANNED) f();
}
function scanOnce(): void {
  SCAN.no++; SCAN.now = Date.now(); SCAN.seen = 0; SCAN.gone = [];
  if (SG.gen !== SCAN.gen || sessions.size !== SCAN.n) LISTED.clear(); // sessions came or went outside a scan (trash, checks)
  for (const ad of HARNESSES) {
    const m = LISTED.get(ad.id); const prev = m ? m.paths : NOPATHS;
    // while the walk repeats the last listing path by path nothing is copied; at the first difference the arrays start
    const paths: string[] = []; const ids: string[] = []; const pars: string[] = []; const arch: boolean[] = [];
    let same = m !== undefined; let n = 0;
    LISTING.want = m !== undefined; LISTING.same = false;
    ad.scan((path: string, id: string, parent: string, archived: boolean) => {
      if (same && n < prev.length && prev[n] === path) { n++; return; }
      if (same) { same = false; for (let i = 0; i < n; i++) { paths.push(prev[i] ?? ""); ids.push(m ? m.ids[i] ?? "" : ""); pars.push(m ? m.pars[i] ?? "" : ""); arch.push(m ? m.arch[i] ?? false : false); } }
      paths.push(path); ids.push(id); pars.push(parent); arch.push(archived);
    });
    const short = LISTING.same; LISTING.want = false; LISTING.same = false;
    if (m && ((short && n === 0) || (same && n === prev.length))) { // the same listing: its sessions, in turns
      // only the hot ones (live, written within a day) and this scan's rotation turn are looked at; the hot list is
      // made again once per rotation round (a log turning old; a live one is stat'ed by probeLive meanwhile)
      if (!m.hot || SCAN.no % ROT === 0) { m.hot = []; m.isHot = []; for (let i = 0; i < m.sess.length; i++) { const s = m.sess[i]; const h = s !== null && (s.pid > 0 || SCAN.now - s.mtime < RECENT_MS); m.isHot.push(h); if (h) m.hot.push(i); } }
      let seen = 0; const turn = SCAN.no % ROT; const s0 = SCAN.seen;
      for (const i of m.hot) { const s = m.sess[i + 0]; if (!s) continue; seen++; if (!refresh(ad.id, s, i % ROT)) { m.sess[i + 0] = null; m.live--; } }
      for (let i = turn; i < m.sess.length; i += ROT) { const s = m.sess[i]; if (!s || (m.isHot[i] ?? false)) continue; seen++; if (!refresh(ad.id, s, turn)) { m.sess[i] = null; m.live--; } }
      SCAN.seen = s0 + (SCAN.seen - s0) + (m.live - seen); // the ones not looked at count as listed
      continue;
    }
    if (same && m) for (let i = 0; i < n; i++) { paths.push(prev[i] ?? ""); ids.push(m.ids[i] ?? ""); pars.push(m.pars[i] ?? ""); arch.push(m.arch[i] ?? false); } // a shorter listing
    const sess: (Sess | null)[] = [];
    for (let i = 0; i < paths.length; i++) sess.push(addFile(ad.id, paths[i] ?? "", ids[i] ?? "", arch[i] ?? false, pars[i] ?? ""));
    let live = 0; for (const x of sess) if (x) live++;
    LISTED.set(ad.id, { paths, ids, pars, arch, sess, live, hot: null, isHot: [] });
  }
  if (SCAN.gone.length) LISTED.clear(); // the walks above hold sessions that go now
  for (const p of SCAN.gone) if (sessions.delete(p)) SG.gen++; // listed but no longer there
  if (SCAN.seen === sessions.size) { SCAN.gen = SG.gen; SCAN.n = sessions.size; return; } // every known log listed once: nothing else went
  LISTED.clear();
  const seen = new Set<string>(); // something went (or a path was listed twice): list again by name
  for (const ad of HARNESSES) ad.scan((path: string, id: string, parent: string, archived: boolean) => { seen.add(path); });
  for (const p of SCAN.gone) seen.delete(p);
  for (const k of [...sessions.keys()]) if (!seen.has(k)) { sessions.delete(k); SG.gen++; }
  SCAN.gen = SG.gen; SCAN.n = sessions.size;
}
// A log only grows: once it reaches past the head window, what reading the head did is final (a shorter log: until it
// grows; a record source counts records). That outcome — the session fields it changed, the first prompt and the
// adapter's own head state (Claude's rename) — is kept as a memo (the ledger cache stores it) and replayed instead of
// parsing up to 512 KB again. A log rewritten in place must not replay a stale head: the first and the last 4 KB of the
// window must still hash the same (h), the log must not have shrunk below its size then (z), and a log shorter than its
// window must still have that mtime (t; it may change anywhere). w = the window, or the log's size when shorter.
// f = [field, value, …]: the HEAD_FIELDS the read changed, and "prompt" (the head's first one; set only while the
// session has none, like a real read).
export interface HeadMemo { w: number; h: number; z: number; t: number; x: string; f: string[] }
export const HEADS = { get: (s: Sess): HeadMemo | null => null, put: (s: Sess, m: HeadMemo): void => {} }; // cache.ts; off under --redact
const HEAD_FIELDS = ["cwd", "title", "branch", "model", "remote", "name", "kind", "parent"];
function fieldsOf(s: Sess): string[] { return [s.cwd, s.title, s.branch, s.model, s.remote, s.name, s.kind, s.parent]; }
function setField(s: Sess, k: string, v: string): void {
  if (k === "cwd") s.cwd = v; else if (k === "title") s.title = v; else if (k === "branch") s.branch = v; else if (k === "model") s.model = v;
  else if (k === "remote") s.remote = v; else if (k === "name") s.name = v; else if (k === "kind") s.kind = v; else if (k === "parent") s.parent = v;
  else if (k === "prompt") { if (!s.prompt) s.prompt = v; }
}
// the first and the last 4 KB of the log's first w bytes (a record source's pseudo path reads nothing: its memo is keyed
// by the source epoch and the record counts)
function fnvOf(h: number, b: Uint8Array): number { for (let i = 0; i < b.length; i++) { h ^= b[i] ?? 0; h = Math.imul(h, 16777619) >>> 0; } return h; }
function headHash(path: string, w: number): number {
  const h = fnvOf(2166136261, readBytes(path, 0, Math.min(4096, w)));
  return w > 4096 ? fnvOf(h, readBytes(path, Math.max(4096, w - 4096), Math.min(4096, w - 4096))) : h;
}
function mtimeOf(s: Sess): number { return Math.floor(s.mtime); } // whole ms: survives the cache's JSON round trip
export function loadHead(s: Sess): void {
  s.headDone = true;
  if (s.host) return; // a remote row: its path is no file
  const src = sourceOf(s.h); const ad = harnessOf(s.h);
  const w = window(src, ad.headBytes);
  const m = HEADS.get(s);
  if (m && (s.size >= w ? m.w === w && s.size >= m.z : m.w === s.size && m.t === mtimeOf(s)) && m.h === headHash(s.path, m.w)) {
    const sh = ad.setHeadState; if (m.x && sh) sh(s, m.x);
    for (let i = 0; i + 1 < m.f.length; i += 2) setField(s, m.f[i] ?? "", m.f[i + 1] ?? "");
    applyMeta(s);
    return;
  }
  const f0 = fieldsOf(s);
  const evs: Ev[] = []; let hp = ""; // the head's first prompt
  for (const l of src.lines(s, 0, w).lines) {
    parseEvents(s.h, l, evs, s);
    if (!hp) for (const e of evs) if (e.kind === "user") { hp = firstLine(e.text, 200); if (!s.prompt) s.prompt = hp; break; }
  }
  const f: string[] = []; const f1 = fieldsOf(s);
  for (let i = 0; i < HEAD_FIELDS.length; i++) if (f1[i] !== f0[i]) { f.push(HEAD_FIELDS[i] ?? ""); f.push(own(f1[i] ?? "")); }
  if (hp) { f.push("prompt"); f.push(own(hp)); }
  const hs = ad.headState;
  const hw = Math.min(w, s.size);
  HEADS.put(s, { w: hw, h: headHash(s.path, hw), z: s.size, t: mtimeOf(s), x: hs ? hs(s) : "", f });
}
// the last events stay on the session until its next tail read: exact-size copies of their strings (util/own.ts)
function keepEv(e: Ev): Ev { return { kind: e.kind, text: own(e.text), ts: own(e.ts), id: own(e.id), full: own(e.full) }; }
// The tail's outcome is kept too, for a log of the same size and mtime: the fields it changed, a prompt it found (the head had
// none), the adapter's state and the last event — enough for a one-shot list (lite: --json, sessions), which then reads no
// tail of a log that has not grown. Never for a live session (its alarms need the recent events).
export interface TailMemo { size: number; t: number; x: string; ev: Ev | null; f: string[] }
export const TAILS = { get: (s: Sess): TailMemo | null => null, put: (s: Sess, m: TailMemo): void => {} }; // cache.ts; off under --redact
export function loadTail(s: Sess, lite = false): void {
  if (s.tailSize === s.size || s.host) return;
  s.tailSize = s.size;
  const ad = harnessOf(s.h); const rf = ad.refresh; if (rf) { rf(s); applyMeta(s); }
  const src = sourceOf(s.h);
  const m = lite && s.pid <= 0 ? TAILS.get(s) : null;
  if (m && m.size === s.size && m.t === mtimeOf(s)) {
    const sh = ad.setHeadState; if (m.x && sh) sh(s, m.x);
    for (let i = 0; i + 1 < m.f.length; i += 2) setField(s, m.f[i] ?? "", m.f[i + 1] ?? "");
    s.evs = m.ev ? [m.ev] : [];
    applyMeta(s);
    return;
  }
  const f0 = fieldsOf(s); const p0 = s.prompt;
  const r = src.lines(s, src.align(s, Math.max(0, s.size - window(src, 98304))), s.size);
  const evs: Ev[] = [];
  for (const l of r.lines) parseEvents(s.h, l, evs, s);
  s.evs = evs.slice(-60).map(keepEv);
  if (!s.prompt) for (const e of evs) if (e.kind === "user") { s.prompt = firstLine(e.text, 200); break; } // head was read before the first prompt
  const f: string[] = []; const f1 = fieldsOf(s);
  for (let i = 0; i < HEAD_FIELDS.length; i++) if (f1[i] !== f0[i]) { f.push(HEAD_FIELDS[i] ?? ""); f.push(own(f1[i] ?? "")); }
  if (!p0 && s.prompt) { f.push("prompt"); f.push(own(s.prompt)); }
  const last = s.evs.length ? s.evs[s.evs.length - 1] : null; const hs = ad.headState;
  TAILS.put(s, { size: s.size, t: mtimeOf(s), x: hs ? hs(s) : "", ev: last ? { kind: last.kind, text: last.text, ts: last.ts, id: last.id, full: "" } : null, f });
}
export function titleOf(s: Sess): string { return titleFrom(s, s.title, s.prompt); }
// the title from these title/prompt values (realMeta()'s under --redact: what filters match)
export function titleFrom(s: Sess, title: string, prompt: string): string {
  if (title) return title; // an H.meta override wins over the harness's out-of-band title
  const tf = harnessOf(s.h).title; if (tf) { const t = tf(s); if (t) return t; }
  return prompt || "(no prompt yet)";
}
// mid-turn right now (the harness adapter decides how to tell)
export function working(s: Sess): boolean { return busy(s); }
export function activity(s: Sess): string {
  const e = s.evs.length ? s.evs[s.evs.length - 1] : null;
  if (!e) return "";
  if (e.kind === "tool") { const i = e.text.indexOf("\u0000"); return "⚒ " + e.text.slice(0, i) + " " + firstLine(e.text.slice(i + 1), 80); }
  if (e.kind === "result") return "⎿ tool result";
  if (e.kind === "thinking") return "∴ thinking";
  if (e.kind === "user") return "❯ " + firstLine(e.text, 80);
  if (e.kind === "assistant") return "⏺ " + firstLine(e.text, 80);
  return e.text;
}

// ── subagent tree ───────────────────────────────────────────────────────────
export const expanded = new Set<string>(); export const collapsed = new Set<string>();
const AUTO_KIDS = 8; // auto-expanded parents show this many children; an explicit expand shows all
export function subActive(s: Sess): boolean { return Date.now() - s.mtime < 45000; }
export function activeSubs(s: Sess): number { let n = 0; for (const c of s.subs) if (subActive(c)) n++; return n; }
export function isOpen(s: Sess): boolean {
  if (collapsed.has(s.path)) return false;
  return expanded.has(s.path) || activeSubs(s) > 0; // auto-expand while subagents work
}
// every active H.listFilter predicate passes (the filter language's Sessions filter)
function matchesAll(ps: ((s: Sess) => boolean)[], s: Sess): boolean { for (const f of ps) if (!f(s)) return false; return true; }
// root sessions by harness:id, rebuilt when the session set changed (SG.gen, size) or a hit is no longer a root (a head read
// set its parent): parentOf was a scan of every session, per subagent and per caller (git attribution: per pass)
// A session with copies (Claude: one session under two project dirs) has a root per copy: a subagent's is the one whose
// directory holds its log (each copy keeps its own subagents dir), else the first
const ROOTS = { gen: -1, n: -1, m: new Map<string, Sess>(), more: new Map<string, Sess[]>() };
function indexRoots(): void {
  ROOTS.gen = SG.gen; ROOTS.n = sessions.size; ROOTS.m.clear(); ROOTS.more.clear();
  for (const p of sessions.values()) {
    if (p.parent) continue;
    const k = p.h + ":" + p.id; const f = ROOTS.m.get(k);
    if (!f) { ROOTS.m.set(k, p); continue; } // the first wins, as the scan did
    const v = ROOTS.more.get(k); if (v) v.push(p); else ROOTS.more.set(k, [f, p]);
  }
}
function nearest(s: Sess, ps: Sess[]): Sess | null {
  let best: Sess | null = ps.length ? ps[0] : null; let n = -1;
  for (const p of ps) { const d = p.path.slice(0, p.path.lastIndexOf("/") + 1); if (d.length > n && s.path.startsWith(d)) { best = p; n = d.length; } }
  return best;
}
export function parentOf(s: Sess): Sess | null {
  if (!s.parent) return null;
  if (ROOTS.gen !== SG.gen || ROOTS.n !== sessions.size) indexRoots(); // size: callers (checks) that set sessions directly
  const k = s.h + ":" + s.parent;
  let p = ROOTS.m.get(k);
  if (p && (p.parent || sessions.get(p.path) !== p)) { indexRoots(); p = ROOTS.m.get(k); }
  const more = ROOTS.more.get(k); if (more) return nearest(s, more);
  return p ?? null;
}
// everything buildView reads, as one cheap pass of number adds: the session set, each session's mtime, pid and parent,
// which subagents are active (time-based auto-expand), the expanded/collapsed sets, the active filters' matches and the
// selection. Equal signatures build equal views. ps = the active filters' predicates
function sigOf(ps: ((s: Sess) => boolean)[], rem: Sess[]): string {
  const now = Date.now(); let mt = 0; let pid = 0; let par = 0; let act = 0; let hit = 0; let n = 0;
  for (const s of sessions.values()) {
    mt += s.mtime; pid += s.pid; par += s.parent.length;
    if (s.parent && now - s.mtime < 45000) act += 1 + (s.mtime % 1000003); // subActive
    if (ps.length && matchesAll(ps, s)) { n++; hit += 1 + (s.mtime % 1000003) + s.parent.length; }
  }
  if (rem.length) { pid += RG.gen * 7919; for (const s of rem) if (ps.length && matchesAll(ps, s)) { n++; hit += 1 + (s.mtime % 1000003); } } // remote rows: their generation (rows, freshness) and filter hits
  let ex = ""; for (const k of expanded) ex += k + "\n"; ex += "|"; for (const k of collapsed) ex += k + "\n";
  return String(SG.gen) + "|" + String(sessions.size) + "+" + String(rem.length) + "|" + String(mt) + "|" + String(pid) + "|" + String(par) + "|" + String(act) + "|" +
    String(ps.length) + ":" + String(n) + ":" + String(hit) + "|" + String(S.sel) + "|" + ex;
}
function activePreds(): ((s: Sess) => boolean)[] { const ps: ((s: Sess) => boolean)[] = []; for (const f of H.listFilter) { const p = f(); if (p) ps.push(p); } return ps; }
export function viewSig(): string { return sigOf(activePreds(), remoteRows()); }
let lastSig = ""; let lastView: Sess[] = [];
export function buildView(): void {
  // the predicates once per build: a filter's matching set is computed once, not per session (n² with 2k sessions)
  const ps = activePreds(); const rem = remoteRows();
  const sig = sigOf(ps, rem); if (sig === lastSig && S.view === lastView) return; // nothing it reads changed: S.view stays the same array
  const filtering = ps.length > 0; const matches = (s: Sess): boolean => matchesAll(ps, s);
  for (const s of sessions.values()) { s.subs = []; s.last = s.mtime; s.depth = 0; }
  for (const s of sessions.values()) {
    if (!s.parent) continue;
    const p = parentOf(s);
    if (!p) continue; // orphan subagent: listed as its own root
    p.subs.push(s); s.depth = 1;
    if (s.mtime > p.last) p.last = s.mtime;
  }
  const tops: Sess[] = [];
  for (const s of sessions.values()) {
    if (s.depth !== 0) continue;
    if (!matches(s) && !(filtering && s.subs.some((c: Sess) => matches(c)))) continue;
    tops.push(s);
  }
  for (const s of rem) { s.subs = []; s.depth = 0; s.last = s.mtime; if (matches(s)) tops.push(s); } // other hosts' rows: top-level, never in sessions
  tops.sort((a, b) => (isLive(b) ? 1 : 0) - (isLive(a) ? 1 : 0) || b.last - a.last);
  const out: Sess[] = [];
  for (const t of tops) {
    out.push(t);
    if (!t.subs.length || collapsed.has(t.path) || !(filtering || isOpen(t))) continue;
    const kids = filtering ? t.subs.filter((c: Sess) => matches(c)) : t.subs.slice();
    kids.sort((a, b) => (subActive(b) ? 1 : 0) - (subActive(a) ? 1 : 0) || b.mtime - a.mtime);
    const n = filtering || expanded.has(t.path) ? kids.length : Math.max(AUTO_KIDS, activeSubs(t));
    for (const c of kids.slice(0, n)) out.push(c);
  }
  const cur = sessAt(S.sel);
  S.view = out;
  if (cur) { const i = S.view.indexOf(cur); if (i >= 0) S.sel = i; }
  S.sel = Math.max(0, Math.min(S.sel, S.view.length - 1));
  lastSig = sigOf(ps, rem); lastView = S.view; // after the selection moved with its session
}
// bounds-checked reads: in scriptc an out-of-range object read traps instead of yielding undefined
export function sessAt(i: number): Sess | null { return i >= 0 && i < S.view.length ? S.view[i] : null; }
export function current(): Sess | null { return sessAt(S.sel); }
