// agentglass — exact-size copies of strings that are kept for long (scriptc runtime workaround)
// SPDX-License-Identifier: Apache-2.0
// scriptc 0.1.7 builds some strings in a growable buffer and hands that buffer over as the result: String.replace,
// toLowerCase/toUpperCase, RegExp exec/match/split captures, JSON.parse of a string with an escape, JSON.stringify. The
// buffer starts at the size of the largest such result so far (capped at 64 KB) and is never shrunk, so once one large
// line went through, every short capture kept in a map holds 64 KB. On a long history that was GBs of RSS.
// slice() copies into an exact-size block: call own() where such a string is stored beyond the current line or tick.
export function own(s: string): string { return s.slice(0); }
// own() for values few in kind but kept many times over (skill names, triggers, models, hashes, listings): one copy per
// distinct value. The pool stops growing at POOL_MAX values (later ones are plain copies)
const POOL = new Map<string, string>(); const POOL_MAX = 16384;
export function pooled(s: string): string { const h = POOL.get(s); if (h !== undefined) return h; const o = s.slice(0); if (POOL.size < POOL_MAX) POOL.set(o, o); return o; }
// a list kept as is by many records (a log's skill listing names): one shared array per distinct list; never mutate it
const LISTS = new Map<string, string[]>();
export function pooledList(xs: string[]): string[] { return pooledText(xs.join("\n")); }
// the same for a list stored as its lines (a cache's "a\nb\nc"): split only the first time it is seen
export function pooledText(k: string): string[] {
  const h = LISTS.get(k); if (h) return h;
  const o: string[] = []; if (k) for (const x of k.split("\n")) o.push(pooled(x));
  if (LISTS.size < 1024) LISTS.set(pooled(k), o);
  return o;
}
