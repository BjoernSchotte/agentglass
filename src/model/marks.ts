// agentglass — shared session marks: harness- and view-neutral points and spans on a session's timeline (skill loads,
// debug episodes …) that the transcript, call graph, replay, filters, --json and MCP read the same way
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "./types.ts";

// kind = "<family>:<name>" (skill:load, debug:episode, debug:probe …); t0/t1 epoch ms: t1 = t0 a point, -1 open, else the
// end; t0 0 = unknown (Kiro: ordered by turn, then seq); ev = index in s.evs, -1 none (cached by markEv); anchor =
// "call=<cid>" | "ts=<iso>" | "" (neither known); tok/usd the mark's own figures, est = ≈; ref = the provider's own key
export interface Mark {
  kind: string; t0: number; t1: number; seq: number; turn: number; ev: number;
  anchor: string; label: string; sub: string; tok: number; usd: number; est: boolean; ref: string;
}
// kind = the family; gen(s) changes when the family's marks change at the same log size (0 = never)
export interface MarkKind { kind: string; glyph: string; color: () => string; of: (s: Sess) => Mark[]; gen: (s: Sess) => number }

const KINDS: MarkKind[] = [];
// a family registered twice replaces the first (in place: the order of families stays)
export function registerMarks(k: MarkKind): void {
  for (let i = 0; i < KINDS.length; i++) if ((KINDS[i] as MarkKind).kind === k.kind) { KINDS[i] = k; MEMO.clear(); return; }
  KINDS.push(k); MEMO.clear();
}
export function markKinds(): MarkKind[] { return KINDS.slice(); }
export function markKind(family: string): MarkKind | null { for (const k of KINDS) if (k.kind === family) return k; return null; }

export function famOf(kind: string): string { const i = kind.indexOf(":"); return i < 0 ? kind : kind.slice(0, i); }
// a filter entry matches a mark kind: a family ("skill") matches all its kinds, anything else only itself
export function kindIn(kind: string, kinds: string[] | null): boolean {
  if (!kinds) return true;
  for (const w of kinds) if (w === kind || (w.indexOf(":") < 0 && famOf(kind) === w)) return true;
  return false;
}

// dated before undated within a turn; dated by time, undated by turn then seq; then kind, then ref (stable for views)
function cmp(x: Mark, y: Mark): number {
  if (x.t0 > 0 && y.t0 > 0) { if (x.t0 !== y.t0) return x.t0 - y.t0; }
  else if (x.t0 > 0 || y.t0 > 0) { if (x.turn !== y.turn) return x.turn - y.turn; return x.t0 > 0 ? -1 : 1; }
  else { if (x.turn !== y.turn) return x.turn - y.turn; if (x.seq !== y.seq) return x.seq - y.seq; }
  if (x.kind !== y.kind) return x.kind < y.kind ? -1 : 1;
  return x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0;
}

// memo per (s.id, s.size, Σ gen, kinds): marks are lazy (built when a view asks), at most MEMO_MAX sessions kept
const MEMO = new Map<string, Mark[]>(); const MEMO_MAX = 64;
export function marksOf(s: Sess, kinds: string[] | null): Mark[] {
  let g = 0; const use: MarkKind[] = [];
  for (const k of KINDS) {
    if (kinds) { let hit = false; for (const w of kinds) if (famOf(w) === k.kind) { hit = true; break; } if (!hit) continue; }
    use.push(k); g += k.gen(s);
  }
  const key = s.h + "\t" + s.id + "\t" + s.path + "\t" + String(s.size) + "\t" + String(g) + "\t" + (kinds ? kinds.join(",") : "*");
  const hit = MEMO.get(key); if (hit) return hit;
  const out: Mark[] = [];
  for (const k of use) for (const m of k.of(s)) if (kindIn(m.kind, kinds)) out.push(m);
  out.sort(cmp);
  if (MEMO.size >= MEMO_MAX) { for (const k of MEMO.keys()) { MEMO.delete(k); break; } } // drop the oldest
  MEMO.set(key, out);
  return out;
}

function tsMs(iso: string): number {
  if (!iso) return 0;
  const t = new Date(iso.replace(/(\.\d{3})\d+/, "$1")).getTime(); // the runtime's Date rejects more than 3 fraction digits
  return t > 0 ? t : 0;
}
// the event a mark points at: the call it anchors on, else the first event at or after its start (binary search over
// the loaded events; untimed events count as earlier); -1 none. Cached into m.ev
export function markEv(s: Sess, m: Mark): number {
  if (m.ev >= 0 && m.ev < s.evs.length) return m.ev;
  let r = -1;
  if (m.anchor.startsWith("call=")) {
    const id = m.anchor.slice(5);
    for (let i = 0; i < s.evs.length; i++) { const e = s.evs[i]; if (e && e.id === id) { r = i; break; } }
  }
  const t0 = m.t0 > 0 ? m.t0 : m.anchor.startsWith("ts=") ? tsMs(m.anchor.slice(3)) : 0;
  if (r < 0 && t0 > 0) {
    let lo = 0; let hi = s.evs.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; const e = s.evs[mid]; if (tsMs(e ? e.ts : "") < t0) lo = mid + 1; else hi = mid; }
    r = lo < s.evs.length ? lo : -1;
  }
  m.ev = r;
  return r;
}
// the event index of the next (dir 1) or previous (dir -1) mark strictly past fromEv; -1 none
export function nextMark(s: Sess, fromEv: number, dir: number, kinds: string[] | null): number {
  let best = -1;
  for (const m of marksOf(s, kinds)) {
    const e = markEv(s, m); if (e < 0) continue;
    if (dir > 0 ? e > fromEv && (best < 0 || e < best) : e < fromEv && e > best) best = e;
  }
  return best;
}
