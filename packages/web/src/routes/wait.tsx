// the Wait page (local-web-api §7, W8.4): what agents wait on — wall time per command family, kind or tool, its share
// of agent time, p50/p95, failures, trend against the period before, heavy commands at once — and what runs now
// (wait.get = `agentglass wait --json`). Period, grouping and filter live in the URL; it refreshes every 30 s.
import { useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { Wait } from "@agentglass/api-contract";
import { Button, Kbd, cn } from "@agentglass/ui";
import { useLive } from "../app.tsx";
import type { ApiFail } from "../live/socket.ts";

export interface WaitSearch { p?: string; by?: string; f?: string }
const PERIODS: [string, string, string][] = [["d", "today", "today"], ["w", "7 days", "7d"], ["m", "30 days", "30d"]];
const BYS: [string, string][] = [["family", "command"], ["kind", "kind"], ["tool", "tool"]];
export function validateWait(s: Record<string, unknown>): WaitSearch {
  const o: WaitSearch = {};
  if (typeof s.p === "string" && PERIODS.some(([k]) => k === s.p)) o.p = s.p;
  if (typeof s.by === "string" && BYS.some(([k]) => k === s.by)) o.by = s.by;
  if (typeof s.f === "string" && s.f) o.f = s.f;
  return o;
}
// 3,723,000 ms → "1h 2m"; 42,000 → "42s"; 900 → "0.9s"
export function dur(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "·";
  const s = ms / 1000; if (s < 10) return s.toFixed(1) + "s"; if (s < 60) return Math.round(s) + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m " + Math.round(s - m * 60) + "s";
  const h = Math.floor(m / 60); return h + "h " + (m - h * 60) + "m";
}
const pct = (x: number | null | undefined) => (x === null || x === undefined ? "·" : Math.round(x * 100) + "%");
function trend(t: number | null): React.ReactNode {
  if (t === null) return <span className="text-muted">·</span>;
  const p = Math.round(t * 100); return <span className={p > 10 ? "text-error" : p < -10 ? "text-live" : "text-muted"}>{p > 0 ? "+" : ""}{p}%</span>;
}

export function WaitView() {
  const live = useLive(); const nav = useNavigate(); const search = useSearch({ strict: false }) as WaitSearch;
  const period = search.p ?? "w"; const by = search.by ?? "family"; const filter = search.f ?? "";
  const since = PERIODS.find(([k]) => k === period)?.[2] ?? "7d";
  const [text, setText] = useState(filter); useEffect(() => setText(filter), [filter]);
  const set = (p: WaitSearch) => void nav({ to: "/wait", search: { ...search, ...p } as never, replace: true });
  const q = useQuery({ queryKey: ["wait", since, by, filter], retry: false, refetchInterval: 30_000,
    queryFn: () => live.request<Wait>("wait.get", { since, by, limit: 30, ...(filter ? { filter } : {}) }) });
  useEffect(() => { // d w m: the period (not while typing)
    const keys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && ["d", "w", "m"].includes(e.key)) set({ p: e.key });
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  });
  const w = q.data; const err = q.error as ApiFail | null; const at = w?.agentTime;
  const split = at && at.activeMs > 0 ? [["tools", at.toolMs, "bg-attention"], ["you", at.userMs, "bg-accent"], ["model", at.modelMs, "bg-live"], ["polling", at.pollingMs, "bg-muted"]] as [string, number, string][] : [];
  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[14px] font-semibold">Wait</h1>
        <div role="radiogroup" aria-label="Period" className="flex gap-0.5">
          {PERIODS.map(([k, l]) => <Button key={k} role="radio" aria-checked={period === k} variant={period === k ? "outline" : "ghost"} onClick={() => set({ p: k })}>{l} <Kbd>{k}</Kbd></Button>)}
        </div>
        <div role="radiogroup" aria-label="Group by" className="flex gap-0.5">
          {BYS.map(([k, l]) => <Button key={k} role="radio" aria-checked={by === k} variant={by === k ? "outline" : "ghost"} onClick={() => set({ by: k })}>{l}</Button>)}
        </div>
        <form className="ml-auto" onSubmit={(e) => { e.preventDefault(); set({ f: text.trim() || undefined }); }}>
          <input aria-label="Filter" placeholder="filter, e.g. harness is claude" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setText(""); set({ f: undefined }); } }} className="mono h-7 w-72 rounded border border-border bg-surface px-2 text-[12px]" />
        </form>
      </div>
      {err ? <pre role="alert" className="mono whitespace-pre-wrap text-[12px] text-error">{err.err?.msg ?? err.message}{err.err?.hint ? "\n" + err.err.hint : ""}</pre>
        : !w ? <p className="flex items-center gap-2 text-muted" aria-live="polite"><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />Working out the wait report…</p> : <>
        {w.pending > 0 && <p role="status" className="text-muted">⟳ {w.pending} {w.pending === 1 ? "log is" : "logs are"} still being indexed — their calls count as booked so far</p>}
        <section aria-label="Agent time" className="rounded border border-border-subtle bg-surface p-3">
          <div className="flex items-baseline gap-2"><h2 className="text-[11px] uppercase tracking-wide text-muted">Agent time</h2><span className="ml-auto num">{dur(at?.activeMs)} active</span></div>
          {split.length > 0 && <div role="img" aria-label={split.map(([l, v]) => l + " " + pct(v / (at?.activeMs || 1))).join(", ")} className="mt-2 flex h-2 overflow-hidden rounded bg-surface-2">{split.map(([l, v, c]) => <div key={l} className={c} style={{ width: (100 * v / (at?.activeMs || 1)) + "%" }} />)}</div>}
          <p className="mt-1 text-[12px] text-muted">{split.map(([l, v]) => l + " " + dur(v)).join(" · ")}</p>
        </section>
        <section aria-label="Now" className="rounded border border-border-subtle bg-surface p-3">
          <div className="flex items-baseline gap-2"><h2 className="text-[11px] uppercase tracking-wide text-muted">Now</h2>
            <span className="ml-auto text-[12px] text-muted">{w.now ? (w.now.load1 !== null ? "load " + w.now.load1.toFixed(1) : "") + (w.now.cpus ? " / " + w.now.cpus + " cpus" : "") + (w.now.memAvailPct !== null ? " · " + Math.round(w.now.memAvailPct) + "% memory free" : "") : ""}</span></div>
          {!w.now?.running.length ? <p className="mt-1 text-muted">No command running.</p> : <ul className="mt-1">{w.now.running.map((r, i) => <li key={i} className="flex h-6 items-center gap-2 text-[12px]"><span className={r.heavy ? "text-attention" : "text-muted"} aria-label={r.heavy ? "heavy" : "light"}>{r.heavy ? "◆" : "·"}</span><span className="mono">{r.family}</span><span className="text-muted">{r.kind}</span><span className="ml-auto num text-muted">{dur(r.ageSec * 1000)}{r.rssMb !== null ? " · " + r.rssMb + " MB" : ""}{r.bg ? " · background" : ""}</span></li>)}</ul>}
          <p className="mt-1 text-[12px] text-muted">heavy at once in the period: {w.heavy.peak > 1 ? "peak " + w.heavy.peak + " · ≥2 for " + dur(w.heavy.atLeastMs[0] ?? 0) + (w.heavy.slowdown !== null ? " · p50 ×" + w.heavy.slowdown.toFixed(1) + " when overlapped" : "") : "never"}</p>
        </section>
        {w.guard === "retention" && <p className="text-attention">Call rows are kept {w.retention.days} days: the older part of this period is missing.</p>}
        <section aria-label="Wait rows">
          {!w.rows.length ? <p className="text-muted">No {by === "tool" ? "tool calls" : "shell calls"} in this period{filter ? " matching the filter" : ""}.</p> : (
            <table className="w-full table-fixed border-collapse">
              <colgroup><col /><col className="w-24" /><col className="w-16" /><col className="w-20" /><col className="w-16" /><col className="w-16" /><col className="w-16" /><col className="w-14" /><col className="w-16" /><col className="w-12" /></colgroup>
              <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr><th className="py-1 pl-2 font-medium">{BYS.find(([k]) => k === by)?.[1]}</th><th className="font-medium">Kind</th><th className="num font-medium">Share</th><th className="num font-medium">Total</th><th className="num font-medium">Calls</th><th className="num font-medium">p50</th><th className="num font-medium">p95</th><th className="num font-medium">Err</th><th className="num font-medium">Trend</th><th className="num pr-2 font-medium">Peak</th></tr></thead>
              <tbody>{w.rows.map((r) => (
                <tr key={r.key + "\t" + r.kind} className="h-7 border-b border-border-subtle">
                  <td className="mono truncate pl-2 text-[12px]" title={r.key}>{r.heavy && <span className="text-attention" aria-label="heavy">◆ </span>}{r.key}</td>
                  <td className="text-muted">{r.kind}</td><td className="num">{pct(r.share)}</td><td className="num">{dur(r.totalMs)}</td><td className="num">{r.calls}</td>
                  <td className="num">{dur(r.p50Ms)}</td><td className="num">{dur(r.p95Ms)}</td><td className={cn("num", (r.errorRate ?? 0) > 0.2 && "text-error")}>{pct(r.errorRate)}</td>
                  <td className="num">{trend(r.trend)}</td><td className="num pr-2">{r.peak && r.peak > 1 ? r.peak : "·"}</td>
                </tr>))}</tbody>
            </table>)}
        </section>
        <p className="text-[12px] text-muted">Tool time includes approval dialogs; background runs are not timed.</p>
      </>}
    </div>
  );
}
