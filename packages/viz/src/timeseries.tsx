// TimeSeries (local-web-api §12, W9.1): uPlot 1.6.32 behind an imperative wrapper — created once per theme, data
// through setData, size through a ResizeObserver, destroyed on unmount. Dragging selects a range (onSelect with the
// first and last x inside it); the current range is drawn as a band; charts with the same syncKey share their cursor.
// Keys while the frame is focused (ChartFrame onKey → handle.key): ← → move the cursor, Esc clears the range.
import { useEffect, useImperativeHandle, useRef, type Ref, type KeyboardEvent } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { type Token, useTokens, rgba } from "@agentglass/ui";

export interface Series { label: string; values: (number | null)[]; color: Token; bars?: boolean; fill?: boolean }
export interface TsHandle { key: (e: KeyboardEvent<HTMLElement>) => void }
export interface TsProps {
  x: number[]; series: Series[]; height?: number; syncKey?: string; fmt?: (v: number) => string; xfmt?: (x: number) => string;
  range?: [number, number] | null; onSelect?: (r: [number, number] | null) => void; onCursor?: (i: number | null) => void; handle?: Ref<TsHandle>;
}
// the x values inside [a, b] (positions): the first and last, or null when none
export function xRange(x: number[], a: number, b: number): [number, number] | null {
  let lo = -1; let hi = -1;
  for (let i = 0; i < x.length; i++) { const v = x[i]!; if (v >= a && v <= b) { if (lo < 0) lo = i; hi = i; } }
  return lo < 0 ? null : [x[lo]!, x[hi]!];
}
export function TimeSeries({ x, series, height = 160, syncKey, fmt = (v) => String(v), xfmt, range = null, onSelect, onCursor, handle }: TsProps) {
  const box = useRef<HTMLDivElement>(null); const plot = useRef<uPlot | null>(null);
  const tk = useTokens();
  const cb = useRef({ onSelect, onCursor, range, fmt, xfmt }); cb.current = { onSelect, onCursor, range, fmt, xfmt };
  const data = (): uPlot.AlignedData => [x, ...series.map((s) => s.values)] as uPlot.AlignedData;
  // created per theme and series shape; data changes below
  const shape = series.map((s) => s.label + (s.bars ? "|b" : "") + s.color).join(",");
  useEffect(() => {
    const el = box.current; if (!el) return;
    const bw = Math.max(0.2, Math.min(0.8, 1 - 2 / Math.max(2, x.length)));
    const opts: uPlot.Options = {
      width: Math.max(100, el.clientWidth), height,
      legend: { show: false }, padding: [8, 8, 0, 0],
      cursor: { sync: syncKey ? { key: syncKey, setSeries: false } : undefined, drag: { x: true, y: false, setScale: false }, points: { size: 6 } },
      select: { show: true, left: 0, top: 0, width: 0, height: 0 },
      scales: { x: { time: false } },
      axes: [
        { stroke: tk["text-muted"], grid: { show: false }, ticks: { stroke: tk.border }, values: (_u, vs) => vs.map((v) => (cb.current.xfmt ? cb.current.xfmt(v) : String(v))), font: "11px IBM Plex Sans, sans-serif" },
        { stroke: tk["text-muted"], grid: { stroke: tk["border-subtle"], width: 1 }, ticks: { show: false }, size: 56, values: (_u, vs) => vs.map((v) => cb.current.fmt(v)), font: "11px IBM Plex Sans, sans-serif" },
      ],
      series: [{}, ...series.map((s) => ({
        label: s.label, stroke: tk[s.color], width: s.bars ? 0 : 1.5,
        fill: s.bars || s.fill ? rgba(tk[s.color], s.bars ? 0.75 : 0.15) : undefined,
        paths: s.bars ? uPlot.paths.bars!({ size: [bw, 48] }) : undefined, points: { show: false },
      }))],
      hooks: {
        setSelect: [(u) => { // a drag: the x values under it, then the drag box goes (the range band shows it)
          const s = u.select; if (s.width < 2) return;
          const r = xRange(x, u.posToVal(s.left, "x"), u.posToVal(s.left + s.width, "x"));
          u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          cb.current.onSelect?.(r);
        }],
        setCursor: [(u) => cb.current.onCursor?.(u.cursor.idx ?? null)],
        drawClear: [(u) => { // the current range as a band under the series
          const r = cb.current.range; if (!r) return;
          const a = u.valToPos(r[0], "x", true); const b = u.valToPos(r[1], "x", true); const half = (u.bbox.width / Math.max(1, x.length)) / 2;
          u.ctx.save(); u.ctx.fillStyle = rgba(tk.accent, 0.12); u.ctx.fillRect(a - half, u.bbox.top, b - a + 2 * half, u.bbox.height); u.ctx.restore();
        }],
      },
    };
    const u = new uPlot(opts, data(), el); plot.current = u;
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => u.setSize({ width: Math.max(100, el.clientWidth), height })) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); u.destroy(); plot.current = null; };
  }, [tk, shape, height, syncKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { plot.current?.setData(data()); }, [x, series]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { plot.current?.redraw(false); }, [range?.[0], range?.[1]]);
  useImperativeHandle(handle, () => ({
    key: (e) => {
      const u = plot.current; if (!u) return;
      if (e.key === "Escape") { if (cb.current.range) { e.preventDefault(); cb.current.onSelect?.(null); } return; }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const n = x.length; if (!n) return;
      const cur = u.cursor.idx ?? (e.key === "ArrowLeft" ? n : -1);
      const i = Math.max(0, Math.min(n - 1, cur + (e.key === "ArrowLeft" ? -1 : 1)));
      const v = series[0]?.values[i] ?? 0;
      u.setCursor({ left: u.valToPos(x[i]!, "x"), top: u.valToPos(v ?? 0, "y") });
    },
  }), [x, series]);
  return <div ref={box} className="ag-ts w-full" style={{ height }} />;
}
