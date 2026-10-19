// the Wait distribution (W9.3): per row (command family, kind or tool) a box of its call durations — whiskers p5 and
// p95, box p25–p75, the median — read from the row's duration histogram (wait.get rows[].hist, edges histEdgesMs) the
// way the CLI reads p50/p95: the geometric middle of the bucket a quantile falls in, never above the row's max. On a
// log axis: seconds and half hours side by side. Its own lazy chunk (ECharts).
import { useMemo } from "react";
import type { Wait } from "@agentglass/api-contract";
import { ChartFrame } from "@agentglass/viz";
import { Boxplot } from "@agentglass/viz/echarts";
import { dur } from "./wait.tsx";

export type Box = [number, number, number, number, number];
// q-quantile of a histogram: null when it holds no call
export function histQ(hist: number[], edges: number[], q: number, max: number): number | null {
  let tot = 0; for (const v of hist) tot += v;
  if (!tot) return null;
  let acc = 0; let b = 0;
  for (const v of hist) { acc += v; if (acc >= q * tot) break; b++; }
  if (b >= edges.length) return max;
  const mid = b === 0 ? edges[0]! / 2 : Math.sqrt(edges[b - 1]! * edges[b]!);
  return Math.min(max, mid);
}
export function boxOf(hist: number[], edges: number[], max: number): Box | null {
  const qs = [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => histQ(hist, edges, q, max));
  return qs.some((x) => x === null) ? null : (qs as Box);
}
const TOP = 12;
// the axis and tips reach down to milliseconds (dur stops at tenths of a second)
export const dms = (ms: number): string => (ms < 1000 ? (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + "ms" : dur(ms));

// label: what a row is (command, kind, tool)
export function WaitBox({ w, label }: { w: Wait; label: string }) {
  const d = useMemo(() => {
    const rows = w.rows.map((r) => ({ r, b: boxOf(r.hist, w.histEdgesMs, r.maxMs ?? 0) })).filter((x): x is { r: Wait["rows"][number]; b: Box } => x.b !== null).slice(0, TOP);
    return { rows, cats: rows.map((x) => (x.r.heavy ? "◆ " : "") + x.r.key), boxes: rows.map((x) => x.b) };
  }, [w]);
  if (!d.rows.length) return null;
  const slow = d.rows.reduce((a, x) => (x.b[2] > a.b[2] ? x : a), d.rows[0]!);
  const wide = d.rows.reduce((a, x) => (x.b[4] - x.b[2] > a.b[4] - a.b[2] ? x : a), d.rows[0]!);
  const summary = d.rows.length + " " + label + (d.rows.length === 1 ? "" : "s") + " with the most time · slowest median " + slow.r.key + " " + dms(slow.b[2]) + " · widest " + wide.r.key + " p95 " + dms(wide.b[4]);
  const rows = d.rows.map(({ r, b }) => ({ key: r.key, calls: r.timedCalls, p5: dms(b[0]), p25: dms(b[1]), p50: dms(b[2]), p75: dms(b[3]), p95: dms(b[4]) }));
  const cols = [{ key: "key", label: label[0]!.toUpperCase() + label.slice(1) }, { key: "calls", label: "Timed", num: true }, { key: "p5", label: "p5", num: true }, { key: "p25", label: "p25", num: true }, { key: "p50", label: "p50", num: true }, { key: "p75", label: "p75", num: true }, { key: "p95", label: "p95", num: true }];
  const h = 32 + 22 * d.cats.length;
  return (
    <ChartFrame title="Call durations" summary={summary} cols={cols} rows={rows} height={h} actions={<span className="text-[11px] text-muted">whiskers p5–p95 · box p25–p75 · log scale</span>}>
      <Boxplot cats={d.cats} boxes={d.boxes} color="attention" fmt={dms} log height={h}
        tip={(i) => { const x = d.rows[i]; return x ? x.r.key + "\np5 " + dms(x.b[0]) + " · p25 " + dms(x.b[1]) + " · p50 " + dms(x.b[2]) + " · p75 " + dms(x.b[3]) + " · p95 " + dms(x.b[4]) + "\n" + x.r.timedCalls + " timed calls" : ""; }} />
    </ChartFrame>
  );
}
