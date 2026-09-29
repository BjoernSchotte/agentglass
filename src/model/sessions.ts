// agentglass — session discovery, lazy log loading, and the filtered subagent tree shown in the list
// SPDX-License-Identifier: Apache-2.0
import { firstLine } from "../util/text.ts";
import { type Ev, type Sess, type Harness, newSess } from "./types.ts";
import { HARNESSES, harnessOf, sourceOf, window, parseEvents, busy } from "../harness/index.ts";
import { S } from "../state.ts";
import { applyMeta } from "../hooks.ts";

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
  s.mtime = st.mtime; s.size = st.size;
  applyMeta(s);
  seen.add(path);
}
export function scan(): void {
  const seen = new Set<string>();
  for (const ad of HARNESSES) ad.scan((path: string, id: string, parent: string, archived: boolean) => addFile(ad.id, path, id, archived, seen, parent));
  for (const k of [...sessions.keys()]) if (!seen.has(k)) sessions.delete(k);
}
export function loadHead(s: Sess): void {
  s.headDone = true;
  const evs: Ev[] = [];
  const src = sourceOf(s.h);
  for (const l of src.lines(s, 0, window(src, harnessOf(s.h).headBytes)).lines) {
    parseEvents(s.h, l, evs, s);
    if (!s.prompt) for (const e of evs) if (e.kind === "user") { s.prompt = firstLine(e.text, 200); break; }
  }
}
export function loadTail(s: Sess): void {
  if (s.tailSize === s.size) return;
  s.tailSize = s.size;
  const rf = harnessOf(s.h).refresh; if (rf) { rf(s); applyMeta(s); }
  const src = sourceOf(s.h);
  const r = src.lines(s, src.align(s, Math.max(0, s.size - window(src, 98304))), s.size);
  const evs: Ev[] = [];
  for (const l of r.lines) parseEvents(s.h, l, evs, s);
  s.evs = evs.slice(-60);
  if (!s.prompt) for (const e of evs) if (e.kind === "user") { s.prompt = firstLine(e.text, 200); break; } // head was read before the first prompt
}
export function titleOf(s: Sess): string {
  if (s.title) return s.title; // an H.meta override wins over the harness's out-of-band title
  const tf = harnessOf(s.h).title; if (tf) { const t = tf(s); if (t) return t; }
  return s.prompt || "(no prompt yet)";
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
function matches(s: Sess, q: string): boolean {
  if (S.useFull && !S.fulltext.has(s.path)) return false;
  if (!q) return true;
  return (titleOf(s) + " " + s.cwd + " " + s.id + " " + s.h + " " + s.name + " " + s.branch + " " + s.kind).toLowerCase().indexOf(q) >= 0;
}
export function parentOf(s: Sess): Sess | null {
  if (!s.parent) return null;
  for (const p of sessions.values()) if (!p.parent && p.h === s.h && p.id === s.parent) return p;
  return null;
}
export function buildView(): void {
  const q = S.filter.toLowerCase();
  const filtering = q !== "" || S.useFull;
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
    if (S.hfilter && s.h !== S.hfilter) continue;
    if (S.liveOnly && !s.pid && activeSubs(s) === 0) continue;
    if (!matches(s, q) && !(filtering && s.subs.some((c) => matches(c, q)))) continue;
    tops.push(s);
  }
  tops.sort((a, b) => (b.pid ? 1 : 0) - (a.pid ? 1 : 0) || b.last - a.last);
  const out: Sess[] = [];
  for (const t of tops) {
    out.push(t);
    if (!t.subs.length || collapsed.has(t.path) || !(filtering || isOpen(t))) continue;
    const kids = filtering ? t.subs.filter((c) => matches(c, q)) : t.subs.slice();
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
