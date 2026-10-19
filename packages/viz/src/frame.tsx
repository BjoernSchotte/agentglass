// every chart sits in a ChartFrame (local-web-api §12, accessibility): a title, a text summary a screen reader gets
// (the canvas itself is opaque), a "view as table" toggle with the same numbers, and keyboard focus on the chart
// (its own keys — arrows, [ ] — act while it is focused). A chart that throws shows its error in place; the page and
// the table view stay.
import { Component, useState, type ReactNode, type KeyboardEvent } from "react";
import { Button, cn } from "@agentglass/ui";

export interface Col { key: string; label: string; num?: boolean }
export interface FrameProps {
  title: string; summary: string; cols: Col[]; rows: Record<string, ReactNode>[]; children: ReactNode;
  actions?: ReactNode; onKey?: (e: KeyboardEvent<HTMLDivElement>) => void; className?: string; height?: number;
}
export function ChartFrame({ title, summary, cols, rows, children, actions, onKey, className, height = 180 }: FrameProps) {
  const [table, setTable] = useState(false);
  return (
    <section aria-label={title} className={cn("rounded border border-border-subtle bg-surface p-3", className)}>
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-[11px] uppercase tracking-wide text-muted">{title}</h2>
        <p className="text-[12px] text-muted">{summary}</p>
        <span className="ml-auto flex items-center gap-1">{actions}<Button variant="ghost" aria-pressed={table} onClick={() => setTable(!table)}>{table ? "chart" : "table"}</Button></span>
      </div>
      {table ? (
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0 bg-surface text-left text-[11px] uppercase tracking-wide text-muted"><tr>{cols.map((c) => <th key={c.key} className={cn("py-1 font-medium", c.num && "num")}>{c.label}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-border-subtle">{cols.map((c) => <td key={c.key} className={cn("py-0.5", c.num && "num")}>{r[c.key]}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div role="img" aria-label={title + ": " + summary} tabIndex={0} onKeyDown={onKey} className="mt-2 outline-none focus-visible:ring-1 focus-visible:ring-focus" style={{ height }}><Boundary>{children}</Boundary></div>
      )}
    </section>
  );
}
class Boundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { err: e instanceof Error ? e.message : String(e) }; }
  render() { return this.state.err !== null ? <p role="alert" className="text-[12px] text-error">The chart failed to draw: {this.state.err}. The table view has the numbers.</p> : this.props.children; }
}
// min · p50 · p95 · max of a series, for a summary line
export function stats(xs: number[]): { min: number; p50: number; p95: number; max: number } {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { min: 0, p50: 0, p95: 0, max: 0 };
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1) + 0.5))]!;
  return { min: v[0]!, p50: q(0.5), p95: q(0.95), max: v[v.length - 1]! };
}
