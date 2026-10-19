// the Stats heatmap (W9.3): cost by weekday × local hour over the tables' days (cost.get {by: hour}, from the ledger's
// cost per hour) — when the money goes. Its own lazy chunk (ECharts): the page renders first, the chart follows.
import { useMemo } from "react";
import type { CostRows } from "@agentglass/api-contract";
import { ChartFrame } from "@agentglass/viz";
import { Heatmap } from "@agentglass/viz/echarts";

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
// all 168 cells [hour, weekday, cost] (0 where none), the peak cell and the total; keys "Mon 09"
export function weekGrid(rows: CostRows["rows"]) {
  const v = new Float64Array(168); const n = new Int32Array(168); let total = 0;
  for (const r of rows) {
    if (r.key === "total") continue;
    const d = DAYS.indexOf(r.key.slice(0, 3)); const h = Number(r.key.slice(4)); if (d < 0 || !(h >= 0 && h < 24)) continue;
    v[d * 24 + h] = r.costUsd ?? 0; n[d * 24 + h] = r.sessions; total += r.costUsd ?? 0;
  }
  const cells: [number, number, number][] = []; let peak = -1;
  for (let i = 0; i < 168; i++) { cells.push([i % 24, Math.floor(i / 24), v[i]!]); if (v[i]! > 0 && (peak < 0 || v[i]! > v[peak]!)) peak = i; }
  return { cells, total, peak: peak < 0 ? null : { day: DAYS[Math.floor(peak / 24)]!, hour: HOURS[peak % 24]!, usd: v[peak]! }, sessions: n };
}
const usd = (v: number) => "$" + (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 10 ? v.toFixed(0) : v.toFixed(2));

export function HourHeat({ data, label }: { data: CostRows | undefined; label: string }) {
  const g = useMemo(() => weekGrid(data?.rows ?? []), [data]);
  if (!data) return <div className="h-[260px] rounded border border-border-subtle bg-surface" aria-busy="true" />;
  const rows = g.cells.filter((c) => c[2] > 0).sort((a, b) => b[2] - a[2]).map(([h, d, v]) => ({ when: DAYS[d] + " " + HOURS[h] + ":00", cost: usd(v), sessions: g.sessions[d * 24 + h] }));
  const summary = !g.peak ? "no cost booked " + label : usd(g.total) + " " + label + " · peak " + g.peak.day + " " + g.peak.hour + ":00 " + usd(g.peak.usd) + " · " + rows.length + " of 168 hours with cost";
  return (
    <ChartFrame title="Cost by weekday and hour" summary={summary} height={260} cols={[{ key: "when", label: "When" }, { key: "cost", label: "Cost", num: true }, { key: "sessions", label: "Sessions", num: true }]} rows={rows}>
      <Heatmap x={HOURS} y={DAYS} cells={g.cells} color="cost" fmt={usd} height={260} tip={(h, d, v) => d + " " + h + ":00–" + h + ":59 · " + usd(v)} />
    </ChartFrame>
  );
}
