// agentglass — session discovery, lazy log loading, and the filtered subagent tree shown in the list
// SPDX-License-Identifier: Apache-2.0
import { firstLine } from "../util/text.ts";
import { own } from "../util/own.ts";
import { type Ev, type Sess, type Harness, newSess } from "./types.ts";
import { HARNESSES, harnessOf, sourceOf, window, parseEvents, busy, epochOf } from "../harness/index.ts";
import { readBytes } from "../util/fs.ts";
import { S } from "../state.ts";
import { H, applyMeta } from "../hooks.ts";

export const sessions = new Map<string, Sess>();

function addFile(h: Harness, path: string, id: string, archived: boolean, seen: Set<string>, parent: string): void {
  let s = sessions.get(path);
  const fresh = !s;
  if (!s) { s = newSess(h, id, path, archived); s.parent = parent; }
  const st = sourceOf(h).stat(s);
  if (!st) return; // gone (a new session is not in the map yet)
  if (fresh) {
    sessions.set(path, s);
    const m = harnessOf(h).meta; if (m) m(s);
  }
  restat(s, st.size, st.mtime, epochOf(s));
  applyMeta(s);
  seen.add(path);
}
// new size/mtime; another cursor epoch (the source switched transport) invalidates what was read: like a rewritten file
export function restat(s: Sess, size: number, mtime: number, ep: string): void {
  s.mtime = mtime; s.size = size;
  if (ep === s.ep) return;
  s.ep = ep; s.tailSize = -1; s.headDone = false; s.evs = [];
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
export function scan(): void {
  if (!scanned) { scanned = true; for (const f of H.firstScan) f(); }
  const seen = new Set<string>();
  for (const ad of HARNESSES) ad.scan((path: string, id: string, parent: string, archived: boolean) => addFile(ad.id, path, id, archived, seen, parent));
  for (const k of [...sessions.keys()]) if (!seen.has(k)) sessions.delete(k);
}
// A log only grows: once it reaches past the head window, what reading the head did is final (a shorter log: until it
// grows; a record source counts records). That outcome — the session fields it changed, the first prompt and the
// adapter's own head state (Claude's rename) — is kept as a memo (the ledger cache stores it) and replayed instead of
// parsing up to 512 KB again; the first 4 KB must still hash the same. w = the window, or the log's size when shorter.
// f = [field, value, …]: the HEAD_FIELDS the read changed, and "prompt" (the head's first one; set only while the
// session has none, like a real read).
export interface HeadMemo { w: number; h: number; x: string; f: string[] }
export const HEADS = { get: (s: Sess): HeadMemo | null => null, put: (s: Sess, m: HeadMemo): void => {} }; // cache.ts; off under --redact
const HEAD_FIELDS = ["cwd", "title", "branch", "model", "remote", "name", "kind", "parent"];
function fieldsOf(s: Sess): string[] { return [s.cwd, s.title, s.branch, s.model, s.remote, s.name, s.kind, s.parent]; }
function setField(s: Sess, k: string, v: string): void {
  if (k === "cwd") s.cwd = v; else if (k === "title") s.title = v; else if (k === "branch") s.branch = v; else if (k === "model") s.model = v;
  else if (k === "remote") s.remote = v; else if (k === "name") s.name = v; else if (k === "kind") s.kind = v; else if (k === "parent") s.parent = v;
  else if (k === "prompt") { if (!s.prompt) s.prompt = v; }
}
// the first 4 KB of the log (a record source's pseudo path reads nothing: its memo is keyed by the source epoch alone)
function headHash(path: string): number { const b = readBytes(path, 0, 4096); let h = 2166136261; for (let i = 0; i < b.length; i++) { h ^= b[i] ?? 0; h = Math.imul(h, 16777619) >>> 0; } return h; }
export function loadHead(s: Sess): void {
  s.headDone = true;
  const src = sourceOf(s.h); const ad = harnessOf(s.h);
  const w = window(src, ad.headBytes);
  const m = HEADS.get(s);
  if (m && (s.size >= w ? m.w === w : m.w === s.size) && m.h === headHash(s.path)) {
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
  HEADS.put(s, { w: Math.min(w, s.size), h: headHash(s.path), x: hs ? hs(s) : "", f });
}
// the last events stay on the session until its next tail read: exact-size copies of their strings (util/own.ts)
function keepEv(e: Ev): Ev { return { kind: e.kind, text: own(e.text), ts: own(e.ts), id: own(e.id), full: own(e.full) }; }
// The tail's outcome is kept too, for a log of the same size: the fields it changed, a prompt it found (the head had
// none), the adapter's state and the last event — enough for a one-shot list (lite: --json, sessions), which then reads no
// tail of a log that has not grown. Never for a live session (its alarms need the recent events).
export interface TailMemo { size: number; x: string; ev: Ev | null; f: string[] }
export const TAILS = { get: (s: Sess): TailMemo | null => null, put: (s: Sess, m: TailMemo): void => {} }; // cache.ts; off under --redact
export function loadTail(s: Sess, lite = false): void {
  if (s.tailSize === s.size) return;
  s.tailSize = s.size;
  const ad = harnessOf(s.h); const rf = ad.refresh; if (rf) { rf(s); applyMeta(s); }
  const src = sourceOf(s.h);
  const m = lite && s.pid <= 0 ? TAILS.get(s) : null;
  if (m && m.size === s.size) {
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
  TAILS.put(s, { size: s.size, x: hs ? hs(s) : "", ev: last ? { kind: last.kind, text: last.text, ts: last.ts, id: last.id, full: "" } : null, f });
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
// every H.listFilter passes (the filter language's Sessions filter)
function matches(s: Sess): boolean { for (const f of H.listFilter) if (!f(s)) return false; return true; }
export function parentOf(s: Sess): Sess | null {
  if (!s.parent) return null;
  for (const p of sessions.values()) if (!p.parent && p.h === s.h && p.id === s.parent) return p;
  return null;
}
export function buildView(): void {
  let filtering = false; for (const f of H.listFiltering) if (f()) filtering = true;
  const roots = new Map<string, Sess>();
  for (const s of sessions.values()) { s.subs = []; s.last = s.mtime; s.depth = 0; if (!s.parent) roots.set(s.h + ":" + s.id, s); }
  for (const s of sessions.values()) {
    if (!s.parent) continue;
    const p = roots.get(s.h + ":" + s.parent);
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
  tops.sort((a, b) => (b.pid ? 1 : 0) - (a.pid ? 1 : 0) || b.last - a.last);
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
}
// bounds-checked reads: in scriptc an out-of-range object read traps instead of yielding undefined
export function sessAt(i: number): Sess | null { return i >= 0 && i < S.view.length ? S.view[i] : null; }
export function current(): Sess | null { return sessAt(S.sel); }
