// the timeline model: per-row index answers the visible range like a scan; sub-pixel runs merge, wide spans stay;
// hit-testing, box-select, [ ] stepping, zoom around a point; 50 k spans index fast enough for the main thread
import { clock } from "../src/timeline/Timeline.tsx";
import { columns, buildIndex, eachVisible, lod, hit, boxSelect, step, zoomAt, panBy, synthetic, type Cmd } from "../src/timeline/model.ts";

const S = columns({ // row 0: one long turn; row 1: three calls, the middle one failed; row 2: a tiny burst
  t0: [0, 10, 40, 70, 50, 50.1, 50.2, 80], t1: [100, 30, 60, 90, 50.05, 50.15, 50.25, 80.01],
  row: [0, 1, 1, 1, 2, 2, 2, 2], cat: [6, 0, 1, 0, 2, 2, 2, 3], kind: [0, 1, 1, 1, 1, 1, 1, 1], name: [0, 1, 2, 1, 3, 3, 3, 4], err: [0, 0, 1, 0, 0, 0, 1, 0], open: [0, 0, 0, 0, 0, 0, 0, 0],
});
const ix = buildIndex(S);
const vis = (row: number, a: number, b: number) => { const o: number[] = []; eachVisible(ix, S, row, a, b, (i) => o.push(i)); return o; };
test("index: rows, range, the visible spans of a row", () => {
  expect(ix.rows).toBe(3); expect([ix.t0, ix.t1]).toEqual([0, 100]);
  expect(vis(1, 35, 65)).toEqual([2]); expect(vis(1, 25, 45)).toEqual([1, 2]); expect(vis(1, 95, 99)).toEqual([]); expect(vis(0, 99, 200)).toEqual([0]);
});
test("index = a plain scan on 5 000 random spans and windows", () => {
  const s = synthetic(5000, 7); const x = buildIndex(s);
  for (let k = 0; k < 200; k++) {
    const a = Math.random() * x.t1; const b = a + Math.random() * 20000; const r = Math.floor(Math.random() * x.rows);
    const got: number[] = []; eachVisible(x, s, r, a, b, (i) => got.push(i));
    const want: number[] = []; for (let i = 0; i < s.n; i++) if (s.row[i] === r && s.t1[i]! >= a && s.t0[i]! <= b) want.push(i);
    expect(got.sort((p, q) => p - q)).toEqual(want);
  }
});
test("lod: wide spans as they are, a touching sub-pixel run as one block that knows it failed", () => {
  const out: Cmd[] = [];
  lod(ix, S, 2, 0, 100, 1, out); // 1 px per ms: the three 0.05 ms calls are one block; the one at 80 another
  expect(out.map((c) => [c.i, c.n, c.err])).toEqual([[-1, 3, true], [-1, 1, false]]);
  expect(out[0]!.errs).toEqual([50.2]); expect(out[1]!.errs).toEqual([]); // where the failed call sits, for its red mark
  lod(ix, S, 2, 49, 51, 1000, out); // zoomed in: each is 50 px
  expect(out.map((c) => c.i)).toEqual([4, 5, 6]); expect(out[2]!.err).toBe(true);
});
test("hit: the span under a time, else the nearest within the tolerance, then the shortest", () => {
  expect(hit(ix, S, 1, 45, 0.5)).toBe(2); expect(hit(ix, S, 1, 35, 0.5)).toBe(-1);
  expect(hit(ix, S, 1, 37, 8)).toBe(2); expect(hit(ix, S, 1, 32, 8)).toBe(1); // 3 ms from 2 vs 7 from 1; 2 from 1 vs 8 from 2
  expect(hit(ix, S, 0, 45, 0)).toBe(0); expect(hit(ix, S, 2, 50.12, 0.1)).toBe(5); // inside beats near
});
test("box-select across rows, in start order", () => { expect(boxSelect(ix, S, 1, 2, 45, 75)).toEqual([2, 4, 5, 6, 3]); });
test("[ ] step in start order; from none the first or the last", () => {
  expect(step(ix, -1, 1)).toBe(0); expect(step(ix, -1, -1)).toBe(7); expect(step(ix, 1, 1)).toBe(2); expect(step(ix, 0, -1)).toBe(0);
});
test("zoom keeps the point under the cursor; pan stays within the data", () => {
  const v = zoomAt({ a: 0, b: 100, y: 0 }, 0.25, 0.5, 0, 100);
  expect(v.b - v.a).toBeCloseTo(50); expect(v.a + (v.b - v.a) * 0.25).toBeCloseTo(25);
  expect(zoomAt({ a: 0, b: 100, y: 0 }, 0.5, 1e-9, 0, 100).b - zoomAt({ a: 0, b: 100, y: 0 }, 0.5, 1e-9, 0, 100).a).toBeCloseTo(1); // ≥ 1 ms
  expect(panBy({ a: 0, b: 50, y: 0 }, 1e6, 0, 100)).toEqual({ a: 55, b: 105, y: 0 }); // 5 % room past the end
});
test("50 k spans: index and a full-width frame's LOD fast enough for the main thread", () => {
  const s = synthetic(50_000, 3);
  const t0 = performance.now(); const x = buildIndex(s); const tb = performance.now() - t0;
  const out: Cmd[] = []; const t1 = performance.now(); let cmds = 0;
  for (let r = 0; r < x.rows; r++) cmds += lod(x, s, r, x.t0, x.t1, 1600 / (x.t1 - x.t0), out).length;
  const tl = performance.now() - t1;
  console.log("timeline 50k: index " + tb.toFixed(1) + " ms, full-width lod " + tl.toFixed(1) + " ms, " + cmds + " draw commands");
  expect(tb).toBeLessThan(100); expect(tl).toBeLessThan(16); expect(cmds).toBeLessThan(20_000);
});
test("axis labels: seconds, minutes, the date at midnight and for day steps", () => {
  const t = new Date(2026, 9, 3, 14, 5, 9).getTime(); const mid = new Date(2026, 9, 3).getTime();
  expect(clock(t, 1000)).toBe("14:05:09"); expect(clock(t, 6e4)).toBe("14:05"); expect(clock(mid, 36e5)).toBe("Oct 3"); expect(clock(t, 864e5)).toBe("Oct 3");
});
