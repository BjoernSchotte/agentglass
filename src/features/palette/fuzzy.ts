// agentglass — the palette's fuzzy matcher (fzf v1 style): AND over space-separated terms, smart case, boundary and
// run bonuses, a backward pass that tightens the window; pure
// SPDX-License-Identifier: Apache-2.0

// i = item index, pos = matched character positions in the haystack (for highlighting)
export interface Hit { i: number; score: number; pos: number[] }
export interface Term { t: string; cs: boolean }
export function terms(q: string): Term[] {
  const o: Term[] = [];
  for (const t of q.split(" ")) if (t) o.push({ t: t, cs: t !== t.toLowerCase() });
  return o;
}
const SEPS = " /-_.:·";
function bonusAt(hay: string, i: number): number {
  if (i === 0) return 16;
  const p = hay.charAt(i - 1);
  if (SEPS.indexOf(p) >= 0) return 10;
  const c = hay.charCodeAt(i); const pc = hay.charCodeAt(i - 1);
  return c >= 65 && c <= 90 && pc >= 97 && pc <= 122 ? 8 : 0; // camelCase hump
}
// scores can be negative (gaps, long haystacks): no match is this sentinel, never a sign test
export const NO_MATCH = -1e9;
// one term against one haystack (low = hay lower-cased, used unless the term is case-sensitive); NO_MATCH = no match;
// pos receives the matched positions
export function scoreTerm(hay: string, low: string, t: string, cs: boolean, pos: number[]): number {
  const h = cs ? hay : low; const n = t.length;
  pos.length = 0;
  if (!n) return 0;
  // indexOf/lastIndexOf: native scans, several times faster than a charCodeAt loop in the native build
  let e = -1;
  for (let j = 0; j < n; j++) { e = h.indexOf(t.charAt(j), e + 1); if (e < 0) return NO_MATCH; }
  let s = e + 1; // backward from the end: the latest start that still holds the whole term
  for (let j = n - 1; j >= 0; j--) s = h.lastIndexOf(t.charAt(j), s - 1);
  let score = 0; let last = -2; let i = s - 1;
  for (let j = 0; j < n; j++) {
    i = h.indexOf(t.charAt(j), i + 1);
    pos.push(i); score += bonusAt(hay, i) + (i === last + 1 ? 4 : 0); last = i;
  }
  return score - Math.min(30, e - s + 1 - n) - 0.1 * hay.length;
}
const scratch: number[] = [];
// every term must match; the item's score is the sum (bonus[i], MRU …, is added by match); NO_MATCH = no match
function scoreItem(hay: string, low: string, ts: Term[], pos: number[] | null): number {
  let s = 0;
  for (const t of ts) {
    const v = scoreTerm(hay, low, t.t, t.cs, scratch);
    if (v === NO_MATCH) return NO_MATCH;
    s += v;
    if (pos) for (const p of scratch) pos.push(p);
  }
  return s;
}
const sc: number[] = []; // score by item index, reused across calls
// hits = the best max matches (score desc, then index); all = every matching index, so a query that extends this one
// can rescore only those (prev, incremental narrowing) without losing matches beyond max
export function match(hays: string[], lows: string[], q: string, prev: number[] | null, max: number, bonus: number[] | null): { hits: Hit[]; all: number[] } {
  const ts = terms(q);
  while (sc.length < hays.length) sc.push(0);
  const all: number[] = [];
  const one = (i: number): void => {
    const v = ts.length ? scoreItem(hays[i] ?? "", lows[i] ?? "", ts, null) : 0;
    if (v === NO_MATCH) return;
    all.push(i); sc[i] = v + (bonus && i < bonus.length ? bonus[i] : 0);
  };
  if (prev) for (const i of prev) one(i); else for (let i = 0; i < hays.length; i++) one(i);
  const order = all.slice().sort((a: number, b: number) => sc[b] - sc[a] || a - b);
  const hits: Hit[] = [];
  const keep = (i: number): void => { const pos: number[] = []; scoreItem(hays[i] ?? "", lows[i] ?? "", ts, pos); hits.push({ i, score: sc[i], pos: pos.sort((a: number, b: number) => a - b) }); };
  for (const i of order.slice(0, max)) keep(i);
  return { hits, all };
}
