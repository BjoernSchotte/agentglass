// the Alerts page (local-web-api §7, W8.2): the live log of the rules engine's transitions — fire, escalate,
// deescalate, resolve — newest first, from the alerts topic (snapshot, then one patch per transition). Severity as in
// the TUI: ⚠ critical, ◆ degraded, ✓ resolved; never by colour alone. A row opens its session.
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { AlertRow } from "@agentglass/api-contract";
import { cn } from "@agentglass/ui";
import { useLive, useNow, ago, hhmm } from "../app.tsx";

// the alerts topic's rows by key; newest (highest key) first
export function useAlerts(): AlertRow[] | null {
  const live = useLive(); const [rows, setRows] = useState<Map<string, AlertRow> | null>(null);
  useEffect(() => live.subscribe({ topic: "alerts" }, (e) => {
    const d = (e.d ?? {}) as { data?: AlertRow[]; upsert?: AlertRow[]; remove?: string[] };
    setRows((old) => {
      const m = e.k === "snapshot" || !old ? new Map<string, AlertRow>() : new Map(old);
      for (const r of d.data ?? d.upsert ?? []) m.set(r.key, r);
      for (const k of d.remove ?? []) m.delete(k);
      return m;
    });
  }), [live]);
  return rows ? [...rows.values()].sort((a, b) => Number(b.key) - Number(a.key)) : null;
}
export function sev(r: AlertRow): { g: string; c: string; label: string } {
  if (r.state === "resolve") return { g: "✓", c: "text-muted", label: "resolved" };
  return r.severity === "critical" ? { g: "⚠", c: "text-stuck", label: "critical" } : { g: "◆", c: "text-attention", label: "degraded" };
}
function val(r: AlertRow): string { const v = Number.isInteger(r.value) ? String(r.value) : r.value.toFixed(2); return v + (r.unit ? " " + r.unit : ""); }

export function AlertsView() {
  const rows = useAlerts(); const now = useNow(5000);
  const firing = rows ? new Set<string>() : null;
  if (rows && firing) { // an alert fires while its newest transition for (session, rule) is not a resolve
    const seen = new Set<string>();
    for (const r of rows) { const k = r.harness + ":" + r.session + "\t" + r.rule; if (seen.has(k)) continue; seen.add(k); if (r.state !== "resolve") firing.add(r.key); }
  }
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-[14px] font-semibold">Alerts</h1>
        {firing && <span className="text-muted">{firing.size ? firing.size + " firing" : "nothing firing"}</span>}
        <span className="ml-auto text-[12px] text-muted">rules from ~/.agentglass/rules · built-ins: waiting ◆, approval ◆, stuck ⚠</span>
      </div>
      {!rows ? <p className="text-muted">Loading…</p> : !rows.length ? <p className="text-muted">No alert since agentglass-web started. Alerts appear here live when a rule fires on a running agent.</p> : (
        <table aria-label="Alert log" className="w-full table-fixed border-collapse">
          <colgroup><col className="w-16" /><col className="w-28" /><col className="w-36" /><col /><col className="w-64" /></colgroup>
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr><th className="py-1 pl-2 font-medium">Time</th><th className="font-medium">State</th><th className="font-medium">Rule</th><th className="font-medium">Message</th><th className="font-medium">Session</th></tr></thead>
          <tbody aria-live="polite">{rows.map((r) => { const s = sev(r); return (
            <tr key={r.key} className={cn("h-7 border-b border-border-subtle", firing?.has(r.key) && "font-medium")}>
              <td className="num pl-2 text-muted" title={new Date(r.at).toLocaleString() + " · " + ago(now - Date.parse(r.at)) + " ago"}>{hhmm(r.at)}</td>
              <td><span className={s.c} aria-label={s.label}>{s.g}</span> {r.state}</td>
              <td className="truncate mono text-[12px]" title={"value " + val(r) + " · threshold " + r.threshold + (r.unit ? " " + r.unit : "")}>{r.rule}</td>
              <td className="truncate" title={r.message}>{r.message}</td>
              <td className="truncate"><Link to="/sessions" search={{ sel: r.harness + ":" + r.session }} className="hover:underline"><span style={{ color: "var(--h-" + r.harness + ", var(--text-muted))" }}>{r.harness}</span> {r.title || r.session}</Link>{r.project && <span className="text-muted"> · {r.project}</span>}</td>
            </tr>); })}</tbody>
        </table>)}
    </div>
  );
}
