// the Team page (local-web-api W7, fleet-teams spec 10): members with presence (the presence topic, live), cost and
// sessions per member for the period and room (team.report, refreshed when presence moves), the team's rooms with their
// budgets, and the activity log. Read-only, as the TUI's Team tab: teammates' sessions are shown as they shared them.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TeamActivity, TeamReport, TeamStatus, PresenceRow } from "@agentglass/api-contract";
import { Button, Kbd, cn } from "@agentglass/ui";
import { useLive, useMeta, money } from "../app.tsx";

const PERIODS: [string, string][] = [["d", "today"], ["w", "7 days"], ["m", "this month"], ["a", "all kept days"]];
export function hhmm(iso: string): string { const d = new Date(iso); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
// the presence topic's rows, kept by key (snapshot replaces, patch upserts/removes)
function usePresence(team: string): PresenceRow[] {
  const live = useLive(); const [rows, setRows] = useState<Map<string, PresenceRow>>(new Map()); const qc = useQueryClient();
  useEffect(() => {
    if (!team) return;
    return live.subscribe({ topic: "presence", team }, (e) => {
      const d = (e.d ?? {}) as { data?: PresenceRow[]; upsert?: PresenceRow[]; remove?: string[] };
      setRows((old) => {
        const m = e.k === "snapshot" ? new Map<string, PresenceRow>() : new Map(old);
        for (const r of d.data ?? d.upsert ?? []) m.set(r.key, r);
        for (const k of d.remove ?? []) m.delete(k);
        return m;
      });
      if (e.k === "patch") void qc.invalidateQueries({ queryKey: ["team"] }); // costs and activity follow a sync
    });
  }, [live, team, qc]);
  return [...rows.values()];
}

export function TeamView() {
  const live = useLive(); const meta = useMeta(); const team = meta?.teams[0]?.id ?? "";
  const [room, setRoom] = useState(""); const [period, setPeriod] = useState("w");
  const status = useQuery({ queryKey: ["team", "status"], queryFn: () => live.request<TeamStatus>("team.status"), enabled: !!team });
  const report = useQuery({ queryKey: ["team", "report", team, room, period], queryFn: () => live.request<TeamReport>("team.report", { team, by: "member", period, ...(room ? { room } : {}) }), enabled: !!team });
  const activity = useQuery({ queryKey: ["team", "activity", team], queryFn: () => live.request<TeamActivity>("team.activity", { team, since: Date.now() - 7 * 86400000 }), enabled: !!team });
  const presence = usePresence(team);
  useEffect(() => { // d w m a: the period, as in the TUI (not while typing)
    const keys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && ["d", "w", "m", "a"].includes(e.key)) setPeriod(e.key);
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  }, []);
  if (!meta) return <p className="p-4 text-muted">Loading…</p>;
  if (!team) return <p className="p-4 text-muted">No team on this machine. Create one with <code className="mono">agentglass team create &lt;name&gt;</code> or join with <code className="mono">agentglass team join &lt;code&gt;</code>.</p>;
  const st = status.data?.teams.find((t) => t.id === team);
  const byName = new Map((report.data?.rows ?? []).map((r) => [r.key, r]));
  const rows = [...presence].sort((a, b) => (byName.get(b.name)?.costUsd ?? 0) - (byName.get(a.name)?.costUsd ?? 0) || a.name.localeCompare(b.name));
  const online = presence.filter((p) => p.online > 0).length;
  const budgets = Array.isArray(report.data?.budget) ? report.data.budget : [];
  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[14px] font-semibold">Team {st?.name ?? meta.teams[0]?.name}</h1>
        <label className="flex items-center gap-1.5 text-muted">room
          <select aria-label="Room" value={room} onChange={(e) => setRoom(e.target.value)} className="h-7 rounded border border-border bg-surface px-1.5 text-text">
            <option value="">all rooms</option>
            {st?.rooms.map((r) => <option key={r.id} value={r.name}>{r.name}</option>)}
          </select>
        </label>
        <div role="radiogroup" aria-label="Period" className="flex gap-0.5">
          {PERIODS.map(([k, l]) => <Button key={k} role="radio" aria-checked={period === k} variant={period === k ? "outline" : "ghost"} onClick={() => setPeriod(k)}>{l} <Kbd>{k}</Kbd></Button>)}
        </div>
        <span className="ml-auto text-muted">{online} of {presence.length} members online</span>
      </div>
      <section aria-label="Members">
        <table className="w-full table-fixed border-collapse">
          <colgroup><col className="w-24" /><col /><col className="w-24" /><col className="w-24" /><col className="w-20" /><col className="w-40" /></colgroup>
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted">
            <tr><th className="py-1 pl-2 font-medium">Live</th><th className="font-medium">Member</th><th className="font-medium">Devices</th><th className="num font-medium">Cost</th><th className="num font-medium">Sessions</th><th className="pl-4 font-medium">Top harness</th></tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const r = byName.get(p.name); const top = r?.harnesses?.[0];
              return (
                <tr key={p.key} className="h-7 border-b border-border-subtle">
                  <td className="pl-2">
                    {p.live || p.attention || p.stuck ? <>
                      {p.live > 0 && <span className="text-live" aria-label={p.live + " live"}>●{p.live} </span>}
                      {p.attention > 0 && <span className="text-attention" aria-label={p.attention + " waiting"}>◆{p.attention} </span>}
                      {p.stuck > 0 && <span className="text-stuck" aria-label={p.stuck + " stuck"}>⚠{p.stuck}</span>}
                    </> : <span className="text-muted" aria-label="no agent running">○</span>}
                  </td>
                  <td className="truncate">{p.name}{p.mine && <span className="text-muted"> (me)</span>}</td>
                  <td className={cn(!p.online && "text-muted")}>{p.online}/{p.devices}</td>
                  <td className="num text-cost">{r ? money(r.costUsd) : "—"}</td>
                  <td className="num">{r?.sessions ?? 0}</td>
                  <td className="truncate pl-4" style={top ? { color: "var(--h-" + top + ", var(--text-muted))" } : undefined}>{top ?? "—"}</td>
                </tr>);
            })}
          </tbody>
        </table>
      </section>
      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-label="Rooms">
          <h2 className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Rooms</h2>
          <ul>{st?.rooms.map((r) => {
            const b = budgets.find((x) => x.room === r.name); const sh = r.share as { on?: boolean } | null;
            return (
              <li key={r.id} className="flex h-7 items-center gap-2 border-b border-border-subtle">
                <span className="font-medium">{r.name}</span><span className="mono truncate text-[12px] text-muted">{r.scope.join(", ")}</span>
                <span className="ml-auto text-muted">{r.level}{sh ? (sh.on ? " · I share" : " · I do not share") : ""}</span>
                {b && <span className={cn("num", b.state === "over" ? "text-error" : b.state === "watch" ? "text-attention" : "text-cost")}>{money(b.spentUsd)} of {money(b.usd)}</span>}
              </li>);
          })}</ul>
        </section>
        <section aria-label="Activity">
          <h2 className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Activity</h2>
          {activity.data?.events.length
            ? <ul>{activity.data.events.slice(0, 50).map((e, i) => <li key={i} className="flex h-7 items-center gap-2 border-b border-border-subtle"><span className="truncate">{e.text}</span><span className="ml-auto text-muted">{hhmm(e.at)}</span></li>)}</ul>
            : <p className="text-muted">Nothing in the last 7 days.</p>}
        </section>
      </div>
    </div>
  );
}
