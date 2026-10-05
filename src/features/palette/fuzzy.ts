// agentglass — the palette's fuzzy matcher (fzf style): AND over space-separated terms, smart case, boundary bonuses
// that carry through a run, a backward pass that tightens each window, the best of several windows; pure
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
// the start of the text is a word start worth a little more (fzf: 10 vs 9 after a delimiter); runs carry only a word
// start's 10, so "agentgl" at the start of "agentglass-x-review" does not outscore it after the "/" of "acme/agentglass" by 6 per character
const WORD = 10;
function bonusAt(hay: string, i: number): number {
  if (i === 0) return 12;
  const p = hay.charAt(i - 1);
  if (SEPS.indexOf(p) >= 0) return WORD;
  const c = hay.charCodeAt(i); const pc = hay.charCodeAt(i - 1);
  return c >= 65 && c <= 90 && pc >= 97 && pc <= 122 ? 8 : 0; // camelCase hump
}
// scores can be negative (gaps, long haystacks): no match is this sentinel, never a sign test
export const NO_MATCH = -1e9;
// one term against one haystack (low = hay lower-cased, used unless the term is case-sensitive); NO_MATCH = no match;
// pos receives the matched positions. fzf v1 scores only the first window; this scores the windows that start at the
// first TRIES occurrences of the term's first character and keeps the best ("pi" as a word beats an earlier p…i)
const TRIES = 6;
const tryPos: number[] = [];
export function scoreTerm(hay: string, low: string, t: string, cs: boolean, pos: number[]): number {
  const h = cs ? hay : low; const n = t.length;
  pos.length = 0;
  if (!n) return 0;
  // indexOf/lastIndexOf: native scans, several times faster than a charCodeAt loop in the native build
  let best = NO_MATCH; let st = h.indexOf(t.charAt(0));
  for (let k = 0; k < TRIES && st >= 0; k++) {
    let e = st;
    for (let j = 1; j < n && e >= 0; j++) e = h.indexOf(t.charAt(j), e + 1);
    if (e < 0) break; // no later start can hold the whole term either
    let s = e + 1; // backward from the end: the latest start that still holds the whole term
    for (let j = n - 1; j >= 0; j--) s = h.lastIndexOf(t.charAt(j), s - 1);
    let score = 0; let last = -2; let i = s - 1; let run = 0; tryPos.length = 0;
    for (let j = 0; j < n; j++) {
      i = h.indexOf(t.charAt(j), i + 1);
      let b = bonusAt(hay, i);
      if (i === last + 1) b = Math.max(b, run, 4); else run = Math.min(b, WORD); // a run keeps its first character's boundary bonus (fzf)
      tryPos.push(i); score += b; last = i;
    }
    const v = score - Math.min(80, e - s + 1 - n); // 1 per skipped column: letters scattered far apart rank low
    if (v > best) { best = v; pos.length = 0; for (const x of tryPos) pos.push(x); }
    st = h.indexOf(t.charAt(0), s + 1);
  }
  if (best === NO_MATCH) return NO_MATCH;
  return best - 0.1 * Math.min(40, hay.length); // short items win ties; beyond 40 columns length says nothing (a
  // session's text carries project, harness and id) and the natural order (recency) decides
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
