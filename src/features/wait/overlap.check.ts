// agentglass — agent-wait overlap sweep against an O(n²) brute force on seeded random call sets, plus edge cases
// SPDX-License-Identifier: Apache-2.0
import { type CallSpan, type GroupOverlap, ALL, overlap, bucketFor } from "./overlap.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; if (bad < 30) console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
let x = 12345;
function next(): number { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }
function rint(lo: number, hi: number): number { return lo + Math.floor(next() * (hi - lo + 1)); }

// ── brute force ──
function inG(s: CallSpan, g: number): boolean { return g === ALL || s.group === g; }
function live(xs: CallSpan[]): CallSpan[] { return xs.filter((s: CallSpan) => s.t1 > s.t0); }
function countAt(xs: CallSpan[], g: number, t: number): number { let n = 0; for (const s of xs) if (inG(s, g) && s.t0 <= t && t < s.t1) n++; return n; }
function brutePeak(xs: CallSpan[], g: number): number { let p = 0; for (const s of xs) if (inG(s, g)) p = Math.max(p, countAt(xs, g, s.t0)); return p; }
function bruteAtLeast(xs: CallSpan[], g: number): number[] {
  const ts: number[] = []; for (const s of xs) if (inG(s, g)) { ts.push(s.t0); ts.push(s.t1); }
  ts.sort((a: number, b: number) => a - b);
  const o = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i] ?? 0; const b = ts[i + 1] ?? 0; if (b <= a) continue;
    const c = countAt(xs, g, a);
    for (let k = 2; k <= 8; k++) if (c >= k) o[k - 2] = (o[k - 2] ?? 0) + (b - a);
  }
  return o;
}
// covered: the union of the other spans (of the group) inside s ≥ 50 % of its length
function covered(xs: CallSpan[], s: CallSpan, idx: number, g: number): boolean {
  const iv: number[][] = [];
  for (let j = 0; j < xs.length; j++) {
    const o = xs[j]; if (!o || j === idx || !inG(o, g)) continue;
    const a = Math.max(s.t0, o.t0); const b = Math.min(s.t1, o.t1); if (b > a) iv.push([a, b]);
  }
  iv.sort((p: number[], q: number[]) => (p[0] ?? 0) - (q[0] ?? 0));
  let tot = 0; let cs = -1; let ce = -1;
  for (const v of iv) { const a = v[0] ?? 0; const b = v[1] ?? 0; if (a > ce) { if (ce > cs) tot += ce - cs; cs = a; ce = b; } else if (b > ce) ce = b; }
  if (ce > cs) tot += ce - cs;
  return tot * 2 >= s.t1 - s.t0;
}
function median(v: number[]): number { const a = v.slice().sort((p: number, q: number) => p - q); const n = a.length; return n ? ((a[(n - 1) >> 1] ?? 0) + (a[n >> 1] ?? 0)) / 2 : -1; }
function check(name: string, xs0: CallSpan[]): void {
  const xs = live(xs0);
  const res = overlap(xs0, 0, 6 * 3600000, 3600000);
  const groups: number[] = [ALL]; for (const s of xs) if (groups.indexOf(s.group) < 0) groups.push(s.group);
  eq(name + " groups", String(res.length), String(xs.length ? groups.length : 0));
  for (const r of res) {
    const g = r.group; const w = name + " g" + String(g);
    const mine: number[] = []; for (let i = 0; i < xs.length; i++) if (inG(xs[i] ?? xs[0], g)) mine.push(i);
    eq(w + " n", String(r.n), String(mine.length));
    eq(w + " peak", String(r.peak), String(brutePeak(xs, g)));
    eq(w + " atLeast", r.atLeast.join(","), bruteAtLeast(xs, g).join(","));
    let ov = 0; let ova = 0; const dOver: number[] = []; const dAlone: number[] = []; const aOver: number[] = []; const aAlone: number[] = [];
    for (let q = 0; q < mine.length; q++) {
      const i = (mine[q] ?? 0) + 0; const s = xs[i]; if (!s) continue; const d = s.t1 - s.t0;
      const c = covered(xs, s, i, g); const ca = covered(xs, s, i, ALL);
      if (c) { ov++; dOver.push(d); } else dAlone.push(d);
      if (ca) { ova++; aOver.push(d); } else aAlone.push(d);
    }
    eq(w + " over", String(r.over), String(ov));
    eq(w + " overAny", String(r.overAny), String(ova));
    const sd = dOver.length >= 10 && dAlone.length >= 10 ? median(dOver) / median(dAlone) : -1;
    const sa = aOver.length >= 10 && aAlone.length >= 10 ? median(aOver) / median(aAlone) : -1;
    eq(w + " slowdown", sd.toFixed(6), r.slowdown.toFixed(6));
    eq(w + " slowdownAny", sa.toFixed(6), r.slowdownAny.toFixed(6));
    eq(w + " p50s", String(median(dAlone)) + "/" + String(median(dOver)), String(r.aloneP50) + "/" + String(r.overP50));
    // timeline: max concurrency at any instant of each hour bucket
    const tl: number[] = [];
    for (let b = 0; b < 6; b++) {
      const lo = b * 3600000; const hi = lo + 3600000; let m = countAt(xs, g, lo);
      for (let q = 0; q < mine.length; q++) { const s = xs[(mine[q] ?? 0) + 0]; if (s && s.t0 >= lo && s.t0 < hi) m = Math.max(m, countAt(xs, g, s.t0)); }
      tl.push(m);
    }
    eq(w + " timeline", r.timeline.join(","), tl.join(","));
  }
}

// ── random sets ──
for (let k = 0; k < 200; k++) {
  const n = rint(1, 400); const ng = rint(1, 4); const coarse = k % 3 === 0; const xs: CallSpan[] = [];
  for (let i = 0; i < n; i++) {
    let t0 = rint(0, 6 * 3600 - 1) * 1000; let d = rint(1, 1200) * 1000;
    if (coarse) { t0 = Math.floor(t0 / 600000) * 600000; d = Math.max(0, Math.floor(d / 300000) * 300000); } // equal endpoints, some zero-length
    xs.push({ t0, t1: Math.min(t0 + d, 6 * 3600000), group: rint(1, ng), agent: rint(0, 5) });
  }
  check("set" + String(k), xs);
}

// ── edge cases ──
function sp(t0: number, t1: number, group: number, agent: number): CallSpan { return { t0: t0 * 1000, t1: t1 * 1000, group, agent }; }
function g(rs: GroupOverlap[], id: number): GroupOverlap | null { for (const r of rs) if (r.group === id) return r; return null; }
// touching spans do not overlap
const touch = overlap([sp(0, 10, 1, 0), sp(10, 20, 1, 1)], 0, 3600000, 3600000);
eq("touch peak", String(g(touch, 1)?.peak ?? -9), "1");
eq("touch over", String(g(touch, 1)?.over ?? -9), "0");
// zero-length spans are ignored
const zero = overlap([sp(5, 5, 1, 0), sp(0, 10, 1, 1)], 0, 3600000, 3600000);
eq("zero n", String(g(zero, 1)?.n ?? -9), "1");
// one agent's two parallel calls contend
const par = overlap([sp(0, 100, 1, 7), sp(10, 90, 1, 7)], 0, 3600000, 3600000);
const pg = g(par, 1);
eq("one agent peak", String(pg?.peak ?? -9) + " agents " + String(pg?.peakAgents ?? -9), "2 agents 1");
eq("one agent over", String(pg?.over ?? -9), "2");
eq("one agent atLeast2", String(pg?.atLeast[0] ?? -9), "80000");
eq("peakAt", String(pg?.peakAt ?? -9), "10000");
// a single span
const one = overlap([sp(0, 100, 3, 0)], 0, 3600000, 3600000); const og = g(one, 3);
eq("single", String(og?.peak ?? -9) + " " + (og?.atLeast.join(",") ?? "") + " " + String(og?.slowdown ?? -9), "1 0,0,0,0,0,0,0 -1");
// slowdown needs 10 calls each side: 9 overlapped pairs → -1, 10 → a ratio
function pairs(k: number, alone: number): CallSpan[] {
  const o: CallSpan[] = []; let t = 0;
  for (let i = 0; i < k; i++) { o.push(sp(t, t + 200, 1, 0)); o.push(sp(t, t + 200, 1, 1)); t += 1000; }
  for (let i = 0; i < alone; i++) { o.push(sp(t, t + 100, 1, 0)); t += 1000; }
  return o;
}
eq("slowdown 8 vs 20", String(g(overlap(pairs(4, 20), 0, 3600000, 3600000), 1)?.slowdown ?? -9), "-1"); // 8 overlapped calls
eq("slowdown 10 vs 10", String(g(overlap(pairs(5, 10), 0, 3600000, 3600000), 1)?.slowdown ?? -9), "2");
eq("slowdown 10 vs 9", String(g(overlap(pairs(5, 9), 0, 3600000, 3600000), 1)?.slowdown ?? -9), "-1");
// groups ordered by n, ALL first
const ord = overlap([sp(0, 10, 5, 0), sp(0, 10, 6, 0), sp(20, 30, 6, 0)], 0, 3600000, 3600000);
eq("order", ord.map((r: GroupOverlap): string => String(r.group)).join(","), "-2,6,5");
eq("empty", String(overlap([], 0, 1, 1).length), "0");
// timeline buckets: a span over a boundary counts in both
const tlr = g(overlap([sp(3500, 3700, 1, 0), sp(3600, 3650, 1, 1)], 0, 7200000, 3600000), 1);
eq("timeline boundary", tlr?.timeline.join(",") ?? "", "1,2");
eq("bucketFor", String(bucketFor(1)) + " " + String(bucketFor(7)) + " " + String(bucketFor(30)) + " " + String(bucketFor(90)), "3600000 3600000 21600000 86400000");

console.log(bad ? bad + " failed" : "overlap: all checks passed");
if (bad) process.exit(1);
