// the timeline's model (W9.2): spans in columns (graph.get), an index per row for the visible range and hit-testing,
// level-of-detail merging of sub-pixel spans, box-select and previous/next — pure, no DOM; draw.ts paints from it
export interface Spans {
  n: number; t0: Float64Array; t1: Float64Array; row: Int32Array; cat: Int32Array; kind: Int32Array; name: Int32Array; err: Int8Array; open: Uint8Array;
}
// per row: its spans by start time and the running maximum of their ends (monotone: binary search for "ends after a");
// order: every span by start time (then row), pos: a span's place in order — for [ and ]
export interface Index { rows: number; byRow: Int32Array[]; maxEnd: Float64Array[]; order: Int32Array; pos: Int32Array; t0: number; t1: number }

export function columns(c: { t0: number[]; t1: number[]; row: number[]; cat: number[]; kind: number[]; name: number[]; err: number[]; open: number[] }): Spans {
  return { n: c.t0.length, t0: Float64Array.from(c.t0), t1: Float64Array.from(c.t1), row: Int32Array.from(c.row), cat: Int32Array.from(c.cat), kind: Int32Array.from(c.kind),
    name: Int32Array.from(c.name), err: Int8Array.from(c.err), open: Uint8Array.from(c.open) };
}
export function buildIndex(s: Spans): Index {
  let rows = 0; let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < s.n; i++) { rows = Math.max(rows, s.row[i]! + 1); lo = Math.min(lo, s.t0[i]!); hi = Math.max(hi, s.t1[i]!); }
  const order = new Int32Array(s.n); for (let i = 0; i < s.n; i++) order[i] = i;
  order.sort((a, b) => s.t0[a]! - s.t0[b]! || s.row[a]! - s.row[b]! || a - b);
  const pos = new Int32Array(s.n); for (let k = 0; k < s.n; k++) pos[order[k]!] = k;
  const counts = new Int32Array(rows); for (let i = 0; i < s.n; i++) counts[s.row[i]!]!++;
  const byRow = Array.from({ length: rows }, (_, r) => new Int32Array(counts[r]!)); const fill = new Int32Array(rows);
  for (let k = 0; k < s.n; k++) { const i = order[k]!; const r = s.row[i]!; byRow[r]![fill[r]!++] = i; } // in start order already
  const maxEnd = byRow.map((ids) => { const m = new Float64Array(ids.length); let x = -Infinity; for (let k = 0; k < ids.length; k++) { x = Math.max(x, s.t1[ids[k]!]!); m[k] = x; } return m; });
  return { rows, byRow, maxEnd, order, pos, t0: s.n ? lo : 0, t1: s.n ? hi : 1 };
}
// the spans of a row that overlap [a, b], in start order
export function eachVisible(ix: Index, s: Spans, row: number, a: number, b: number, f: (i: number) => void): void {
  const ids = ix.byRow[row]; const me = ix.maxEnd[row]; if (!ids || !me) return;
  let lo = 0; let hi = ids.length; while (lo < hi) { const m = (lo + hi) >> 1; if (me[m]! < a) lo = m + 1; else hi = m; } // first whose running end reaches a
  for (let k = lo; k < ids.length; k++) { const i = ids[k]!; if (s.t0[i]! > b) break; if (s.t1[i]! >= a) f(i); }
}
// draw commands of one row at k px per ms from a: spans at least 1 px wide as they are (i ≥ 0), runs of thinner ones
// that touch merged into one block (i = -1, n = how many); errs: where failed calls sit (x, at most 64 per block) — a
// block is drawn in its colour with red marks there, not red as a whole (3 % failures would paint every block red)
export interface Cmd { i: number; x0: number; x1: number; n: number; err: boolean; cat: number; errs: number[] }
export function lod(ix: Index, s: Spans, row: number, a: number, b: number, k: number, out: Cmd[]): Cmd[] {
  out.length = 0; let blk: Cmd | null = null;
  eachVisible(ix, s, row, a, b, (i) => {
    const x0 = (s.t0[i]! - a) * k; const x1 = Math.max(x0, (s.t1[i]! - a) * k);
    const e = s.err[i]! > 0;
    if (x1 - x0 >= 1) { if (blk) { out.push(blk); blk = null; } out.push({ i, x0, x1, n: 1, err: e, cat: s.cat[i]!, errs: [] }); return; }
    if (blk && x0 <= blk.x1 + 1) { blk.x1 = Math.max(blk.x1, x1, blk.x0 + 1); blk.n++; if (e) { blk.err = true; if (blk.errs.length < 64) blk.errs.push(x0); } return; }
    if (blk) out.push(blk);
    blk = { i: -1, x0, x1: Math.max(x1, x0 + 1), n: 1, err: e, cat: s.cat[i]!, errs: e ? [x0] : [] };
  });
  if (blk) out.push(blk);
  return out;
}
// the span under time t in a row (within tol ms either side): the nearest, then the shortest (the most specific)
export function hit(ix: Index, s: Spans, row: number, t: number, tol: number): number {
  let best = -1; let bd = Infinity; let bw = Infinity;
  eachVisible(ix, s, row, t - tol, t + tol, (i) => {
    const d = t < s.t0[i]! ? s.t0[i]! - t : t > s.t1[i]! ? t - s.t1[i]! : 0; const w = s.t1[i]! - s.t0[i]!;
    if (d < bd || (d === bd && w < bw)) { best = i; bd = d; bw = w; }
  });
  return best;
}
// every span in rows r0..r1 overlapping [a, b]
export function boxSelect(ix: Index, s: Spans, r0: number, r1: number, a: number, b: number): number[] {
  const o: number[] = []; for (let r = Math.max(0, r0); r <= Math.min(ix.rows - 1, r1); r++) eachVisible(ix, s, r, a, b, (i) => o.push(i));
  return o.sort((x, y) => ix.pos[x]! - ix.pos[y]!);
}
// the span before / after cur in start order ([ and ]); from nothing: the first or the last
export function step(ix: Index, cur: number, dir: 1 | -1): number {
  if (!ix.order.length) return -1;
  if (cur < 0) return dir > 0 ? ix.order[0]! : ix.order[ix.order.length - 1]!;
  const k = ix.pos[cur]! + dir; return k >= 0 && k < ix.order.length ? ix.order[k]! : cur;
}
// the view: [a, b] ms on the x axis, y px scrolled; zoom by f around the point at x01 (0..1 across), kept inside the
// data with some room, never narrower than 1 ms
export interface View { a: number; b: number; y: number }
export function zoomAt(v: View, x01: number, f: number, lo: number, hi: number): View {
  const at = v.a + (v.b - v.a) * x01; const pad = (hi - lo) * 0.05; const full = hi - lo + 2 * pad;
  const w = Math.min(full, Math.max(1, (v.b - v.a) * f));
  return clampX({ a: at - w * x01, b: at + w * (1 - x01), y: v.y }, lo - pad, hi + pad);
}
export function panBy(v: View, dms: number, lo: number, hi: number): View { const pad = (hi - lo) * 0.05; return clampX({ a: v.a + dms, b: v.b + dms, y: v.y }, lo - pad, hi + pad); }
function clampX(v: View, lo: number, hi: number): View {
  const w = v.b - v.a; if (w >= hi - lo) return { a: lo, b: hi, y: v.y };
  if (v.a < lo) return { a: lo, b: lo + w, y: v.y }; if (v.b > hi) return { a: hi - w, b: hi, y: v.y };
  return v;
}
// a synthetic graph of n spans (perf tests, the bench page): turns on row 0, calls under them, subagents below
export function synthetic(n: number, seed = 1): Spans {
  let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const c = { t0: [] as number[], t1: [] as number[], row: [] as number[], cat: [] as number[], kind: [] as number[], name: [] as number[], err: [] as number[], open: [] as number[] };
  let t = 0; let i = 0;
  while (i < n) {
    const turn = 2000 + rnd() * 60000; const start = t; c.t0.push(start); c.t1.push(start + turn); c.row.push(0); c.cat.push(6); c.kind.push(0); c.name.push(0); c.err.push(0); c.open.push(0); i++;
    let u = start + 50;
    while (u < start + turn && i < n) {
      const d = rnd() < 0.9 ? rnd() * 400 : rnd() * 8000; const r = 1 + Math.floor(rnd() * 6);
      c.t0.push(u); c.t1.push(Math.min(start + turn, u + d)); c.row.push(r); c.cat.push(Math.floor(rnd() * 7)); c.kind.push(1); c.name.push(1 + Math.floor(rnd() * 20)); c.err.push(rnd() < 0.03 ? 1 : 0); c.open.push(0); i++;
      u += d * 0.5 + rnd() * 200;
    }
    t = start + turn + rnd() * 5000;
  }
  return columns(c);
}
