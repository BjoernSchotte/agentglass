// agentglass — agent-wait overlap: heavy calls running at the same time (peak, time at ≥ k, overlapped calls, slowdown)
// SPDX-License-Identifier: Apache-2.0
// Pure (spec agent-wait §3). One sweep over the sorted endpoints (ends before starts at equal times: [t0, t1) spans that
// touch do not overlap) keeps per group the open calls; an elementary interval adds its length to every open call of a
// group that has ≥ 2 open (covered by another call of the group) — O(n log n + n · peak). Concurrency counts calls, not
// agents: two parallel calls of one agent contend as much as two agents.

// one heavy call: [t0, t1) epoch ms, group = family id, agent = session index (the "agents at peak" figure)
export interface CallSpan { t0: number; t1: number; group: number; agent: number }
export interface GroupOverlap {
  group: number; n: number; peak: number; peakAt: number; peakAgents: number;
  atLeast: number[]; // ms with ≥ k concurrent calls: index 0 → k = 2 … index 6 → k = 8+
  over: number; // calls ≥ 50 % covered by another call of the group
  overAny: number; // … by another heavy call of any group
  slowdown: number; slowdownAny: number; // p50(over) / p50(alone), -1 when either side has < 10 calls
  aloneP50: number; overP50: number; // exact medians (ms) of the group split, -1 when empty
  timeline: number[]; // max concurrency per bucket of [from, to)
}
export const ALL = -2; // the group id of "all heavy calls"
export const MIN_SIDE = 10;
const KS = 7;
export function bucketFor(days: number): number { return days <= 7 ? 3600000 : days <= 30 ? 21600000 : 86400000; }
function median(v: number[]): number {
  const n = v.length; if (!n) return -1;
  v.sort((a: number, b: number) => a - b);
  return ((v[(n - 1) >> 1] ?? 0) + (v[n >> 1] ?? 0)) / 2;
}
function ratio(o: number[], a: number[]): number {
  if (o.length < MIN_SIDE || a.length < MIN_SIDE) return -1;
  const mo = median(o); const ma = median(a); return ma > 0 ? mo / ma : -1;
}
interface G { id: number; n: number; cnt: number; peak: number; peakAt: number; peakAgents: number; at: number[]; open: number[]; tl: number[] }
function newG(id: number, nb: number): G { const tl: number[] = []; for (let i = 0; i < nb; i++) tl.push(0); return { id, n: 0, cnt: 0, peak: 0, peakAt: 0, peakAgents: 0, at: [0, 0, 0, 0, 0, 0, 0], open: [], tl }; }
function drop(open: number[], i: number): void { const k = open.indexOf(i); if (k < 0) return; open[k] = open[open.length - 1] ?? i; open.pop(); }

export function overlap(spans: CallSpan[], from: number, to: number, bucketMs: number): GroupOverlap[] {
  const xs: CallSpan[] = []; for (const s of spans) if (s.t1 > s.t0) xs.push(s);
  const n = xs.length; if (!n) return [];
  const nb = bucketMs > 0 && to > from ? Math.ceil((to - from) / bucketMs) : 0;
  const gx = new Map<number, number>(); const gs: G[] = [newG(ALL, nb)];
  const gi = new Float64Array(n);
  for (let i = 0; i < n; i++) { const s = xs[i]; if (!s) continue; let k = gx.get(s.group); if (k === undefined) { k = gs.length; gx.set(s.group, k); gs.push(newG(s.group, nb)); } const kk = k + 0; gi[i] = kk; const gg = gs[kk]; if (gg) gg.n++; }
  const all = gs[0] ?? newG(ALL, nb); all.n = n;
  const cov = new Float64Array(n); const covAny = new Float64Array(n);
  // events: e < n = start of e, e ≥ n = end of e − n; by time, ends first
  const ev: number[] = []; for (let i = 0; i < 2 * n; i++) ev.push(i);
  const tOf = (e: number): number => { const s = xs[e < n ? e : e - n]; return s ? (e < n ? s.t0 : s.t1) : 0; };
  ev.sort((a: number, b: number) => tOf(a) - tOf(b) || (a >= n ? 0 : 1) - (b >= n ? 0 : 1));
  let prev = tOf(ev[0] ?? 0);
  for (const e of ev) {
    const t = tOf(e);
    if (t > prev) { // the elementary interval [prev, t): concurrency is constant
      const len = t - prev;
      for (const g of gs) {
        if (g.cnt <= 0) continue;
        for (let k = 2; k <= 8; k++) if (g.cnt >= k) g.at[k - 2] = (g.at[k - 2] ?? 0) + len;
        if (g.cnt >= 2) for (let q = 0; q < g.open.length; q++) { const i = (g.open[q] ?? 0) + 0; if (g === all) covAny[i] = covAny[i] + len; else cov[i] = cov[i] + len; }
        if (nb > 0) { // timeline buckets this interval touches
          const a = Math.max(prev, from); const b = Math.min(t, to);
          if (b > a) for (let k = Math.floor((a - from) / bucketMs); k < nb && from + k * bucketMs < b; k++) if (g.cnt > (g.tl[k] ?? 0)) g.tl[k] = g.cnt;
        }
      }
      prev = t;
    }
    const i = e < n ? e : e - n; const g = gs[gi[i] + 0] ?? all;
    if (e < n) {
      for (const x of [all, g]) {
        x.cnt++; x.open.push(i);
        if (x.cnt > x.peak) { x.peak = x.cnt; x.peakAt = t; const ag: number[] = []; for (let q = 0; q < x.open.length; q++) { const a = xs[(x.open[q] ?? 0) + 0]?.agent ?? -1; if (ag.indexOf(a) < 0) ag.push(a); } x.peakAgents = ag.length; }
      }
    } else { for (const x of [all, g]) { x.cnt--; drop(x.open, i); } }
  }
  const out: GroupOverlap[] = [];
  for (let k = 0; k < gs.length; k++) {
    const g = gs[k]; if (!g) continue;
    let over = 0; let overAny = 0; const dO: number[] = []; const dA: number[] = []; const aO: number[] = []; const aA: number[] = [];
    for (let i = 0; i < n; i++) {
      if (k > 0 && gi[i] + 0 !== k) continue;
      const s = xs[i]; if (!s) continue; const d = s.t1 - s.t0;
      const c = (k === 0 ? covAny[i] + 0 : cov[i] + 0) * 2 >= d; const ca = covAny[i] * 2 >= d;
      if (c) { over++; dO.push(d); } else dA.push(d);
      if (ca) { overAny++; aO.push(d); } else aA.push(d);
    }
    const sd = ratio(dO, dA); const sa = ratio(aO, aA);
    out.push({ group: g.id, n: g.n, peak: g.peak, peakAt: g.peakAt, peakAgents: g.peakAgents, atLeast: g.at.slice(0, KS), over, overAny, slowdown: sd, slowdownAny: sa,
      aloneP50: median(dA), overP50: median(dO), timeline: g.tl });
  }
  out.sort((a: GroupOverlap, b: GroupOverlap) => b.n - a.n || (a.group === ALL ? -1 : b.group === ALL ? 1 : a.group - b.group));
  return out;
}
