// the Stats trend (W9.1): cost per day as bars and tokens per day (in, out, cache read) as lines over the period, cursors
// synced; dragging over either selects a range of days → ?from=&to= → the tables and the model drill-down count only it
import { useMemo, useRef, useState } from "react";
import type { CostRows } from "@agentglass/api-contract";
import { ChartFrame, TimeSeries, stats, type TsHandle } from "@agentglass/viz";

const DAY = 86400;
// YYYY-MM-DD ↔ local midnight in seconds (the x of the charts)
export function daySec(k: string): number { const [y, m, d] = k.split("-").map(Number); return new Date(y!, m! - 1, d!).getTime() / 1000; }
export function secDay(s: number): string { const d = new Date(s * 1000); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
export function dayLabel(k: string): string { return new Date(daySec(k) * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
// every day from since to today, the rows' figures on their day (0 where none)
export function daySeries(rows: CostRows["rows"], since: string, today = secDay(Date.now() / 1000)) {
  const by = new Map(rows.filter((r) => r.key !== "total").map((r) => [r.key, r]));
  const x: number[] = []; const cost: number[] = []; const inT: number[] = []; const outT: number[] = []; const cr: number[] = []; const keys: string[] = [];
  for (let t = daySec(since); t <= daySec(today) + 3600; t += DAY) {
    const k = secDay(t + 3 * 3600); if (keys.at(-1) === k) continue; // DST: one entry per calendar day
    const r = by.get(k); keys.push(k); x.push(daySec(k)); cost.push(r?.costUsd ?? 0); inT.push(r?.in ?? 0); outT.push(r?.out ?? 0); cr.push(r?.cacheRead ?? 0);
  }
  return { x, keys, cost, inT, outT, cr };
}
const usd = (v: number) => "$" + (v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 10 ? v.toFixed(0) : v.toFixed(2));
const tok = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(0) + "k" : String(Math.round(n)));
const xl = (s: number) => new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function Trend({ data, since, range, onRange }: { data: CostRows | undefined; since: string; range: { since: string; until: string } | null; onRange: (r: [string, string] | null) => void }) {
  const d = useMemo(() => daySeries(data?.rows ?? [], since), [data, since]);
  const hc = useRef<TsHandle>(null); const ht = useRef<TsHandle>(null); const [at, setAt] = useState<number | null>(null);
  const r: [number, number] | null = range ? [daySec(range.since), daySec(range.until)] : null;
  const sel = (x: [number, number] | null) => onRange(x ? [secDay(x[0] + 3600), secDay(x[1] + 3600)] : null);
  if (!data) return <div className="h-[220px] rounded border border-border-subtle bg-surface" aria-busy="true" />;
  const sc = stats(d.cost); const total = d.cost.reduce((a, b) => a + b, 0); const imax = d.cost.indexOf(sc.max);
  const cur = at !== null && at >= 0 && at < d.keys.length ? at : null;
  const rows = d.keys.map((k, i) => ({ day: k, cost: usd(d.cost[i]!), in: tok(d.inT[i]!), out: tok(d.outT[i]!), cr: tok(d.cr[i]!) })).reverse();
  const cols = [{ key: "day", label: "Day" }, { key: "cost", label: "Cost", num: true }, { key: "in", label: "In", num: true }, { key: "out", label: "Out", num: true }, { key: "cr", label: "Cache read", num: true }];
  const hint = cur !== null ? <span className="num text-[12px]">{dayLabel(d.keys[cur]!)}: <span className="text-cost">{usd(d.cost[cur]!)}</span> · in {tok(d.inT[cur]!)} · out {tok(d.outT[cur]!)} · cache read {tok(d.cr[cur]!)}</span> : <span className="text-[12px] text-muted">drag to pick days</span>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ChartFrame title="Cost per day" summary={d.keys.length + " days · " + usd(total) + " · median " + usd(sc.p50) + " · max " + usd(sc.max) + (imax >= 0 && sc.max > 0 ? " on " + dayLabel(d.keys[imax]!) : "")} cols={cols} rows={rows} onKey={(e) => hc.current?.key(e)} actions={hint}>
        <TimeSeries x={d.x} series={[{ label: "cost", values: d.cost, color: "cost", bars: true }]} syncKey="stats-days" fmt={usd} xfmt={xl} range={r} onSelect={sel} onCursor={setAt} handle={hc} />
      </ChartFrame>
      <ChartFrame title="Tokens per day" summary={"in " + tok(d.inT.reduce((a, b) => a + b, 0)) + " · out " + tok(d.outT.reduce((a, b) => a + b, 0)) + " · cache read " + tok(d.cr.reduce((a, b) => a + b, 0))} cols={cols} rows={rows} onKey={(e) => ht.current?.key(e)}
        actions={<span className="flex gap-2 text-[11px]"><span style={{ color: "var(--accent)" }}>— in</span><span style={{ color: "var(--live)" }}>— out</span><span style={{ color: "var(--attention)" }}>— cache read</span></span>}>
        <TimeSeries x={d.x} series={[{ label: "in", values: d.inT, color: "accent" }, { label: "out", values: d.outT, color: "live" }, { label: "cache read", values: d.cr, color: "attention", fill: true }]} syncKey="stats-days" fmt={tok} xfmt={xl} range={r} onSelect={sel} onCursor={setAt} handle={ht} />
      </ChartFrame>
    </div>
  );
}
