// the Repos page (local-web-api §7, W8.7): one row per project (worktrees and clones of one remote merged) — sessions,
// live, cost, commits and cost per commit, active and agent time, error rate, last activity; a row opens its top files,
// branches and harnesses (repos.list = `agentglass --json --repos`). Period and filter live in the URL.
import { Fragment, useEffect, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReposList } from "@agentglass/api-contract";
import { Button, Kbd, cn } from "@agentglass/ui";
import { useLive, useNow, ago, money } from "../app.tsx";
import type { ApiFail } from "../live/socket.ts";

export interface ReposSearch { p?: string; f?: string; sel?: string }
const PERIODS: [string, string, number][] = [["d", "today", 1], ["w", "7 days", 7], ["m", "30 days", 30], ["a", "all", 0]];
export function validateRepos(s: Record<string, unknown>): ReposSearch {
  const o: ReposSearch = {};
  if (typeof s.p === "string" && PERIODS.some(([k]) => k === s.p)) o.p = s.p;
  if (typeof s.f === "string" && s.f) o.f = s.f; if (typeof s.sel === "string" && s.sel) o.sel = s.sel;
  return o;
}
type Repo = ReposList["rows"][number];
function mins(m: number): string { return m < 60 ? Math.round(m) + "m" : Math.floor(m / 60) + "h " + Math.round(m % 60) + "m"; }

function Detail({ r }: { r: Repo }) {
  return (
    <div className="grid gap-4 px-2 pb-3 pt-1 text-[12px] md:grid-cols-3">
      <section aria-label={"Files of " + r.label}><h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Top files{r.outsideFiles ? " · " + r.outsideFiles + " outside" : ""}</h3>
        <ul>{r.files.slice(0, 10).map((f) => <li key={f.path} className="mono flex justify-between gap-2"><span className="truncate" title={f.path}>{f.path}</span><span className="shrink-0 text-muted">{f.edits}× <span className="text-live">+{f.add}</span> <span className="text-error">−{f.del}</span></span></li>)}</ul></section>
      <section aria-label={"Branches of " + r.label}><h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Branches</h3>
        <ul>{r.branches.slice(0, 8).map((b) => <li key={b.branch} className="mono flex justify-between gap-2"><span className="truncate">{b.branch}</span><span className="shrink-0 text-muted">{b.commits} commits · {money(b.costUsd)}</span></li>)}</ul></section>
      <section aria-label={"Harnesses of " + r.label}><h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">Harnesses</h3>
        <ul>{r.byHarness.map((h) => <li key={h.harness} className="flex justify-between"><span style={{ color: "var(--h-" + h.harness + ", var(--text))" }}>{h.harness}</span><span className="text-muted">{h.sessions} sessions · {money(h.costUsd)}</span></li>)}</ul>
        {r.prs.length > 0 && <p className="mt-2 text-muted">{r.prs.length} pull request{r.prs.length === 1 ? "" : "s"}</p>}</section>
    </div>
  );
}

export function ReposView() {
  const live = useLive(); const nav = useNavigate(); const search = useSearch({ strict: false }) as ReposSearch; const now = useNow(30_000);
  const period = search.p ?? "w"; const filter = search.f ?? ""; const days = PERIODS.find(([k]) => k === period)?.[2] ?? 7;
  const [text, setText] = useState(filter); useEffect(() => setText(filter), [filter]);
  const set = (p: ReposSearch) => void nav({ to: "/repos", search: { ...search, ...p } as never, replace: true });
  const q = useQuery({ queryKey: ["repos", days, filter], retry: false, refetchInterval: 60_000, queryFn: () => live.request<ReposList>("repos.list", { days, ...(filter ? { filter } : {}) }) });
  useEffect(() => { // d w m a: the period (not while typing)
    const keys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && ["d", "w", "m", "a"].includes(e.key)) set({ p: e.key });
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  });
  const d = q.data; const err = q.error as ApiFail | null;
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[14px] font-semibold">Repos</h1>
        <div role="radiogroup" aria-label="Period" className="flex gap-0.5">
          {PERIODS.map(([k, l]) => <Button key={k} role="radio" aria-checked={period === k} variant={period === k ? "outline" : "ghost"} onClick={() => set({ p: k })}>{l} <Kbd>{k}</Kbd></Button>)}
        </div>
        <form className="ml-auto" onSubmit={(e) => { e.preventDefault(); set({ f: text.trim() || undefined }); }}>
          <input aria-label="Filter" placeholder="filter, e.g. harness is claude" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setText(""); set({ f: undefined }); } }} className="mono h-7 w-72 rounded border border-border bg-surface px-2 text-[12px]" />
        </form>
      </div>
      {err ? <pre role="alert" className="mono whitespace-pre-wrap text-[12px] text-error">{err.err?.msg ?? err.message}{err.err?.hint ? "\n" + err.err.hint : ""}</pre>
        : !d ? <p className="flex items-center gap-2 text-muted" aria-live="polite"><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />Reading your projects…</p> : <>
        {d.pending > 0 && <p role="status" className="text-muted">⟳ {d.pending} {d.pending === 1 ? "log is" : "logs are"} still being indexed — their figures grow until then</p>}
        {!d.rows.length ? <p className="text-muted">No project with activity in this period{filter ? " matching the filter" : ""}.</p> : (
          <table aria-label="Projects" className="w-full table-fixed border-collapse">
            <colgroup><col /><col className="w-20" /><col className="w-14" /><col className="w-24" /><col className="w-20" /><col className="w-24" /><col className="w-24" /><col className="w-16" /><col className="w-20" /></colgroup>
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr><th className="py-1 pl-2 font-medium">Project</th><th className="num font-medium">Sessions</th><th className="num font-medium">Live</th><th className="num font-medium">Cost</th><th className="num font-medium">Commits</th><th className="num font-medium">$/commit</th><th className="num font-medium">Active</th><th className="num font-medium">Err</th><th className="num pr-2 font-medium">Last</th></tr></thead>
            <tbody>{d.rows.map((r) => { const open = search.sel === r.key; return (<Fragment key={r.key}>
              <tr aria-expanded={open} onClick={() => set({ sel: open ? undefined : r.key })} className={cn("h-7 cursor-pointer border-b border-border-subtle hover:bg-surface-2", open && "bg-surface-2")}>
                <td className="truncate pl-2" title={r.key}><span className="font-medium">{r.label}</span>{r.worktrees.length > 1 && <span className="text-muted"> · {r.worktrees.length} worktrees</span>}</td>
                <td className="num">{r.sessions}</td><td className="num">{r.live > 0 ? <span className="text-live">●{r.live}</span> : "·"}</td>
                <td className="num text-cost">{money(r.costUsd)}{r.unpricedTokens > 0 ? "+" : ""}</td><td className="num">{r.commits}</td><td className="num">{money(r.costPerCommit)}</td>
                <td className="num">{mins(r.activeMin)}</td><td className={cn("num", (r.errorRate ?? 0) > 0.2 && "text-error")}>{r.errorRate === null ? "·" : Math.round(r.errorRate * 100) + "%"}</td>
                <td className="num pr-2 text-muted">{r.last ? ago(now - Date.parse(r.last)) : "·"}</td>
              </tr>
              {open && <tr className="border-b border-border-subtle bg-surface-2"><td colSpan={9}><Detail r={r} /></td></tr>}
            </Fragment>); })}</tbody>
          </table>)}
      </>}
    </div>
  );
}
