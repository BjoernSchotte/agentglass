// ECharts 6.1.0, modular (local-web-api §12, W9.3): only the heatmap, boxplot and bar charts with grid, tooltip,
// visualMap, legend and aria are registered, so the viz-echarts chunk carries no more. An imperative wrapper: one instance per
// mount (init → dispose, StrictMode-safe), options through setOption (notMerge), size through a ResizeObserver; theme
// colours from the tokens (re-read on a theme change), aria decals (patterns besides colour), no transitions under
// prefers-reduced-motion. A separate entry (@agentglass/viz/echarts): echarts.use() is a side effect, and the shell
// imports the package index.
import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts/core";
import { HeatmapChart, BoxplotChart, BarChart } from "echarts/charts";
import { GridComponent, TooltipComponent, VisualMapComponent, LegendComponent, AriaComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { type Token, type Tokens, useTokens, reducedMotion } from "@agentglass/ui";

echarts.use([HeatmapChart, BoxplotChart, BarChart, GridComponent, TooltipComponent, VisualMapComponent, LegendComponent, AriaComponent, CanvasRenderer]);
type Opt = Record<string, unknown>;
const FONT = "IBM Plex Sans, sans-serif";
// tooltips are HTML in ECharts: a caller's text (command names, skill names from logs) is escaped, "\n" breaks the line
export const tipHtml = (t: string): string => t.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";").replace(/\n/g, "<br>");

// the options every chart shares: text, tooltip and axis colours from the theme, decals, motion
export function baseOption(tk: Tokens): Opt {
  return {
    animation: !reducedMotion(), textStyle: { color: tk["text-muted"], fontFamily: FONT, fontSize: 11 },
    aria: { enabled: true, label: { enabled: false }, decal: { show: true } }, // the frame names the chart; decals stay
    tooltip: { backgroundColor: tk.surface, borderColor: tk.border, textStyle: { color: tk.text, fontFamily: FONT, fontSize: 12 }, confine: true },
  };
}
const axis = (tk: Tokens, o: Opt): Opt => ({ axisLine: { lineStyle: { color: tk.border } }, axisTick: { show: false }, axisLabel: { color: tk["text-muted"] }, splitLine: { lineStyle: { color: tk["border-subtle"] } }, ...o });

export interface EChartProps { option: Opt; height?: number }
export function EChart({ option, height = 220 }: EChartProps) {
  const box = useRef<HTMLDivElement>(null); const chart = useRef<echarts.ECharts | null>(null);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const c = echarts.init(el, null, { renderer: "canvas" }); chart.current = c;
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => c.resize()) : null; ro?.observe(el);
    return () => { ro?.disconnect(); c.dispose(); chart.current = null; };
  }, []);
  useEffect(() => { chart.current?.setOption(option, { notMerge: true }); }, [option]); // after the init above, and on each change
  return <div ref={box} style={{ height, width: "100%" }} />;
}

// cells [x, y, value] on two category axes, the colour from the surface to `color` by value
export interface HeatmapProps { x: string[]; y: string[]; cells: [number, number, number][]; color: Token; fmt: (v: number) => string; tip?: (x: string, y: string, v: number) => string; height?: number }
export function heatmapOption({ x, y, cells, color, fmt, tip }: HeatmapProps, tk: Tokens): Opt {
  let max = 0; for (const c of cells) if (c[2] > max) max = c[2];
  return { ...baseOption(tk),
    grid: { left: 36, right: 8, top: 4, bottom: 44 },
    tooltip: { ...(baseOption(tk).tooltip as Opt), formatter: (p: { value: [number, number, number] }) => { const [i, j, v] = p.value; return tipHtml(tip ? tip(x[i] ?? "", y[j] ?? "", v) : (y[j] ?? "") + " " + (x[i] ?? "") + ": " + fmt(v)); } },
    xAxis: axis(tk, { type: "category", data: x, splitArea: { show: false } }), yAxis: axis(tk, { type: "category", data: y, inverse: true }),
    visualMap: { min: 0, max: max || 1, orient: "horizontal", left: "center", bottom: 0, itemHeight: 120, itemWidth: 10, calculable: false, text: [fmt(max), fmt(0)], textStyle: { color: tk["text-muted"] }, inRange: { color: [tk["surface-2"], tk[color]] } },
    series: [{ type: "heatmap", data: cells, itemStyle: { borderColor: tk.surface, borderWidth: 1 }, emphasis: { itemStyle: { borderColor: tk.text } } }] };
}
// options rebuilt when the data or the theme change (fmt and tip are taken as stable)
export function Heatmap(p: HeatmapProps) { const tk = useTokens(); const o = useMemo(() => heatmapOption(p, tk), [p.x, p.y, p.cells, p.color, tk]); return <EChart option={o} height={p.height} />; }

// a box per category: [low, q1, median, q3, high] (the caller says what the whiskers are); log: a log value axis; tip:
// plain text
export interface BoxplotProps { cats: string[]; boxes: [number, number, number, number, number][]; color: Token; fmt: (v: number) => string; log?: boolean; tip?: (i: number) => string; height?: number }
export function boxplotOption({ cats, boxes, color, fmt, log, tip }: BoxplotProps, tk: Tokens): Opt {
  return { ...baseOption(tk),
    grid: { left: 8, right: 16, top: 4, bottom: 24, containLabel: true },
    tooltip: { ...(baseOption(tk).tooltip as Opt), trigger: "item", formatter: (p: { dataIndex: number }) => tipHtml(tip ? tip(p.dataIndex) : cats[p.dataIndex] ?? "") },
    xAxis: axis(tk, { type: log ? "log" : "value", axisLabel: { color: tk["text-muted"], formatter: (v: number) => fmt(v) } }),
    yAxis: axis(tk, { type: "category", data: cats, inverse: true, axisLabel: { color: tk.text, fontFamily: "IBM Plex Mono, monospace", width: 160, overflow: "truncate" } }),
    series: [{ type: "boxplot", data: boxes, itemStyle: { color: tk["surface-2"], borderColor: tk[color], borderWidth: 1.5 }, boxWidth: [6, 14] }] };
}
export function Boxplot(p: BoxplotProps) { const tk = useTokens(); const o = useMemo(() => boxplotOption(p, tk), [p.cats, p.boxes, p.color, p.log, tk]); return <EChart option={o} height={p.height ?? 32 + 22 * p.cats.length} />; }

// horizontal bars per category, the series stacked
export interface BarSeries { label: string; values: number[]; color: Token }
export interface BarsProps { cats: string[]; series: BarSeries[]; fmt: (v: number) => string; height?: number }
export function barsOption({ cats, series, fmt }: BarsProps, tk: Tokens): Opt {
  return { ...baseOption(tk),
    grid: { left: 8, right: 16, top: 24, bottom: 20, containLabel: true },
    legend: { top: 0, left: 0, icon: "rect", itemWidth: 10, itemHeight: 10, textStyle: { color: tk["text-muted"], fontFamily: FONT, fontSize: 11 } },
    tooltip: { ...(baseOption(tk).tooltip as Opt), trigger: "axis", axisPointer: { type: "shadow" },
      formatter: (ps: { name: string; seriesName: string; value: number }[]) => tipHtml((ps[0]?.name ?? "") + ps.map((p) => "\n" + p.seriesName + " " + fmt(p.value)).join("")) },
    xAxis: axis(tk, { type: "value", axisLabel: { color: tk["text-muted"], formatter: (v: number) => fmt(v) } }),
    yAxis: axis(tk, { type: "category", data: cats, inverse: true, axisLabel: { color: tk.text, fontFamily: "IBM Plex Mono, monospace", width: 160, overflow: "truncate" } }),
    series: series.map((s) => ({ type: "bar", name: s.label, stack: "a", data: s.values, barMaxWidth: 14, itemStyle: { color: tk[s.color] } })) };
}
export function Bars(p: BarsProps) { const tk = useTokens(); const o = useMemo(() => barsOption(p, tk), [p.cats, p.series, tk]); return <EChart option={o} height={p.height ?? 44 + 22 * p.cats.length} />; }
