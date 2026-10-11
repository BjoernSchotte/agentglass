// the Stats page (local-web-api §7, W8.1): cost today / 7 days / month by billing mode with the projection and the
// budget (cost.get = `agentglass cost --json`), and per harness and per model for the period (cost.get by = the
// `cost --by` rows). The period and the filter live in the URL. While the background index still counts logs, the
// figures show what is booked so far with "counting…" and refresh every 2 s until it is done.
// A By-model row opens that model's drill-down (W8.8, ?model= in the URL): one cost.get {by: session, model} — only
// the model's tokens and cost — grouped here by project, each project's sessions below it; a session opens its drawer.
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { Cost, CostRows } from "@agentglass/api-contract";
import { Button, Kbd, cn } from "@agentglass/ui";
import { useLive, useNow, ago } from "../app.tsx";
import type { ApiFail } from "../live/socket.ts";

export interface StatsSearch { p?: string; f?: string; model?: string; sort?: string; proj?: string }
const PERIODS: [string, string, string][] = [["d", "today", "today"], ["w", "7 days", "7d"], ["m", "this month", ""]];
export function validateStats(s: Record<string, unknown>): StatsSearch {
  const o: StatsSearch = {}; if (typeof s.p === "string" && PERIODS.some(([k]) => k === s.p)) o.p = s.p; if (typeof s.f === "string" && s.f) o.f = s.f;
  if (typeof s.model === "string" && s.model) o.model = s.model; if (s.sort === "cache") o.sort = "cache"; if (typeof s.proj === "string") o.proj = s.proj;
  return o;
}
// the period's since for cost.get: this month = its first day (local), as the TUI counts a month
export function sinceOf(p: string, now = new Date()): string {
  const x = PERIODS.find(([k]) => k === p); if (x && x[2]) return x[2];
  return now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
}
// the TUI's money: ≈ when part of it is priced through an alias, + when some usage has no price
export function usd(u: number | null | undefined, est = false, unpriced = false): string {
  if (u === null || u === undefined) return unpriced ? "?" : "—";
  return (est ? "≈" : "") + "$" + (u >= 1000 ? Math.round(u).toLocaleString("en-US") : u.toFixed(2)) + (unpriced ? "+" : "");
}
const WORDS: Record<string, string> = { api: "spend", plan: "plan", metered: "cloud", gateway: "gateway", unknown: "unknown" };
const sum = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
function tok(n: number): string { return n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n); }

type Period = Cost["today"];
function Card({ title, p, extra }: { title: string; p: Period; extra?: React.ReactNode }) {
  const modes = Object.entries(p.byMode).filter(([, v]) => v > 0);
  return (
    <section aria-label={title} className="rounded border border-border-subtle bg-surface p-3">
      <h2 className="text-[11px] uppercase tracking-wide text-muted">{title}</h2>
      <p className="num mt-1 text-[22px] font-semibold text-cost">{usd(sum(p.byMode), p.estimatedUsd > 0, p.unpriced.tokens > 0 || p.unpriced.credits > 0)}</p>
      <p className="mt-0.5 truncate text-[12px] text-muted">{modes.length ? modes.map(([k, v]) => WORDS[k] + " " + usd(v)).join(" · ") : "nothing yet"}</p>
      {p.unpriced.tokens > 0 && <p className="truncate text-[12px] text-muted">unpriced: {tok(p.unpriced.tokens)} tokens</p>}
      {extra}
    </section>
  );
}
function Budget({ b }: { b: NonNullable<Cost["budget"]> }) {
  const pct = Math.min(100, Math.round((b.used / b.monthlyUsd) * 100)); const ap = b.approx ? "≈" : "";
  const tone = b.state === "over" ? "bg-error" : b.state === "watch" ? "bg-attention" : "bg-cost";
  return (
    <section aria-label="Budget" className="rounded border border-border-subtle bg-surface p-3">
      <div className="flex items-baseline gap-2"><h2 className="text-[11px] uppercase tracking-wide text-muted">Budget</h2><span className="ml-auto num">{ap}{usd(b.used)} of {usd(b.monthlyUsd)} · {b.state}</span></div>
      <div role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-2 h-1.5 rounded bg-surface-2"><div className={cn("h-full rounded", tone)} style={{ width: pct + "%" }} /></div>
      <p className="mt-1 text-[12px] text-muted">{pct}% used{b.projected !== null ? " · projected " + ap + usd(b.projected) : ""} · counts {b.counts.join(", ")}</p>
    </section>
  );
}
function Table({ label, data, model, open, onOpen }: { label: string; data: CostRows | undefined; model?: boolean; open?: string; onOpen?: (k: string) => void }) {
  const rows = data?.rows ?? [];
  return (
    <section aria-label={label}>
      <h2 className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">{label}</h2>
      {!rows.length ? <p className="text-muted">{data ? "No usage in this period." : "Loading…"}</p> : (
        <table className="w-full table-fixed border-collapse">
          <colgroup><col /><col className="w-24" /><col className="w-20" /><col className="w-20" /><col className="w-24" /><col className="w-20" /></colgroup>
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr><th className="py-1 pl-2 font-medium">{model ? "Model" : "Harness"}</th><th className="num font-medium">Cost</th><th className="num font-medium">In</th><th className="num font-medium">Out</th><th className="num font-medium">Cache read</th><th className="num pr-2 font-medium">Sessions</th></tr></thead>
          <tbody>{rows.map((r) => { const can = !!onOpen && r.key !== "total"; const on = open === r.key; return (
            <tr key={r.key} aria-expanded={can ? on : undefined} tabIndex={can ? 0 : undefined} title={can ? "where " + r.key + "'s cost came from" : undefined}
              onClick={can ? () => onOpen(r.key) : undefined} onKeyDown={can ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(r.key); } } : undefined}
              className={cn("h-7 border-b border-border-subtle", r.key === "total" && "font-semibold", can && "cursor-pointer hover:bg-surface-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent", on && "bg-surface-2")}>
              <td className="truncate pl-2" style={!model && r.key !== "total" ? { color: "var(--h-" + r.key + ", var(--text))" } : undefined}>{r.key}{model && r.priceSource && r.priceSource !== "unpriced" && r.key !== "total" && <span className="text-muted"> · {r.priceSource}</span>}</td>
              <td className="num text-cost">{usd(r.costUsd, !!r.estimated, r.unpricedTokens > 0)}</td>
              <td className="num">{tok(r.in)}</td><td className="num">{tok(r.out)}</td><td className="num">{tok(r.cacheRead)}</td><td className="num pr-2">{r.sessions}{can && <span className="text-muted" aria-hidden> {on ? "▾" : "›"}</span>}</td>
            </tr>); })}</tbody>
        </table>)}
    </section>
  );
}

type Row = CostRows["rows"][number];
interface Proj { name: string; cost: number; unpriced: number; est: boolean; cacheRead: number; tokens: number; rows: Row[] }
// the model's session rows by project (cost or cache read first); each project's sessions in the same order
export function byProject(rows: Row[], sort: string): Proj[] {
  const m = new Map<string, Proj>(); const val = (r: { cost: number; cacheRead: number }) => (sort === "cache" ? r.cacheRead : r.cost);
  for (const r of rows) {
    if (r.key === "total") continue;
    const n = r.project || "(no project)"; let p = m.get(n);
    if (!p) { p = { name: n, cost: 0, unpriced: 0, est: false, cacheRead: 0, tokens: 0, rows: [] }; m.set(n, p); }
    p.cost += r.costUsd ?? 0; p.unpriced += r.unpricedTokens; p.cacheRead += r.cacheRead; p.tokens += r.in + r.out + r.cacheRead + r.cacheWrite; p.rows.push(r);
  }
  const ps = [...m.values()]; const rv = (r: Row) => (sort === "cache" ? r.cacheRead : r.costUsd ?? 0);
  for (const p of ps) p.rows.sort((a, b) => rv(b) - rv(a));
  return ps.sort((a, b) => val(b) - val(a) || a.name.localeCompare(b.name));
}
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) + "%" : "·");
function Drill({ model, since, filter, label, sort, proj, set, onClose }: { model: string; since: string; filter: string; label: string; sort: string; proj: string | undefined; set: (p: StatsSearch) => void; onClose: () => void }) {
  const live = useLive(); const now = useNow(30_000);
  const q = useQuery({ queryKey: ["cost", "session", since, filter, model], retry: false, refetchInterval: (x: { state: { data?: { pending: number } } }) => (x.state.data && x.state.data.pending > 0 ? 2000 : 60_000),
    queryFn: () => live.request<CostRows>("cost.get", { by: "session", since, model, ...(filter ? { filter } : {}) }) });
  const d = q.data; const err = q.error as ApiFail | null; const tot = d?.rows.find((r) => r.key === "total");
  const ps = useMemo(() => byProject(d?.rows ?? [], sort), [d, sort]);
  const all = tot ? tot.in + tot.out + tot.cacheRead + tot.cacheWrite : 0;
  const top = ps[0]?.name; const open = (n: string) => (proj === undefined ? n === top : proj === n);
  useEffect(() => { const k = (e: KeyboardEvent) => { const t = e.target as HTMLElement | null; if (e.key === "Escape" && !(t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"))) onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); });
  const th = (k: string, l: string) => <th aria-sort={sort === k || (k === "cost" && sort !== "cache") ? "descending" : "none"} className="num font-medium"><button type="button" className="uppercase tracking-wide hover:text-text" onClick={() => set({ sort: k === "cache" ? "cache" : undefined })}>{l}</button></th>;
  return (
    <section aria-label={"Where " + model + "'s cost came from"} className="rounded border border-border-subtle bg-surface p-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-[13px] font-semibold"><span className="mono">{model}</span> <span className="font-normal text-muted">· {label}</span></h2>
        {tot && <span className="text-[12px] text-muted"><span className="text-cost">{usd(tot.costUsd, false, tot.unpricedTokens > 0)}</span> · {tot.sessions} sessions · {ps.length} projects · cache read {tok(tot.cacheRead)} ({pct(tot.cacheRead, all)} of its tokens)</span>}
        <Button className="ml-auto" variant="ghost" onClick={onClose} aria-label="Close the drill-down">close <Kbd>esc</Kbd></Button>
      </div>
      {err ? <pre role="alert" className="mono mt-2 whitespace-pre-wrap text-[12px] text-error">{err.err?.msg ?? err.message}</pre>
        : !d ? <p className="mt-2 text-muted" aria-live="polite">Reading the sessions…</p>
        : !ps.length ? <p className="mt-2 text-muted">No session used {model} in this period{filter ? " matching the filter" : ""}.</p> : (
        <table aria-label={"Projects using " + model} className="mt-2 w-full table-fixed border-collapse">
          <colgroup><col /><col className="w-28" /><col className="w-24" /><col className="w-28" /><col className="w-20" /></colgroup>
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr><th className="py-1 pl-2 font-medium">Project · session</th>{th("cost", "Cost")}{th("cache", "Cache read")}<th className="num font-medium">Share</th><th className="num pr-2 font-medium">Last</th></tr></thead>
          <tbody>{ps.map((p) => { const o = open(p.name); const share = sort === "cache" ? pct(p.cacheRead, tot?.cacheRead ?? 0) : pct(p.cost, tot?.costUsd ?? 0); return (<Fragment key={p.name}>
            <tr aria-expanded={o} tabIndex={0} onClick={() => set({ proj: o ? "" : p.name })} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set({ proj: o ? "" : p.name }); } }}
              className="h-7 cursor-pointer border-b border-border-subtle font-medium hover:bg-surface-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent">
              <td className="truncate pl-2"><span className="text-muted" aria-hidden>{o ? "▾ " : "› "}</span>{p.name} <span className="font-normal text-muted">· {p.rows.length} {p.rows.length === 1 ? "session" : "sessions"}</span></td>
              <td className="num text-cost">{usd(p.cost, false, p.unpriced > 0)}</td><td className="num">{tok(p.cacheRead)}</td><td className="num">{share}</td><td className="num pr-2" />
            </tr>
            {o && p.rows.map((r) => { const h = r.key.slice(0, r.key.indexOf(":")); return (
              <tr key={r.key} className="h-7 border-b border-border-subtle text-[12px]">
                <td className="truncate pl-6" title={(r.cwd ?? "") + (r.root ? " · subagent of " + r.root : "")}>
                  <Link to="/sessions" search={{ sel: r.key } as never} className="hover:underline"><span style={{ color: "var(--h-" + h + ", var(--text-muted))" }}>{h}</span> {r.title || r.key.slice(h.length + 1, h.length + 9)}</Link>
                  {r.root && <span className="text-muted"> · subagent</span>}<span className="mono text-muted"> · {r.cwd}</span></td>
                <td className="num text-cost">{usd(r.costUsd, false, r.unpricedTokens > 0)}</td><td className="num">{tok(r.cacheRead)}</td>
                <td className="num text-muted">{sort === "cache" ? pct(r.cacheRead, tot?.cacheRead ?? 0) : pct(r.costUsd ?? 0, tot?.costUsd ?? 0)}</td>
                <td className="num pr-2 text-muted">{r.last ? ago(now - Date.parse(r.last)) : "·"}</td>
              </tr>); })}
          </Fragment>); })}</tbody>
        </table>)}
      {d && d.pending > 0 && <p role="status" className="mt-1 text-[12px] text-muted">⟳ {d.pending} {d.pending === 1 ? "log is" : "logs are"} still being counted</p>}
    </section>
  );
}

export function StatsView() {
  const live = useLive(); const nav = useNavigate(); const search = useSearch({ strict: false }) as StatsSearch;
  const period = search.p ?? "w"; const filter = search.f ?? ""; const since = sinceOf(period); const model = search.model;
  const [text, setText] = useState(filter); useEffect(() => setText(filter), [filter]);
  const set = (p: StatsSearch) => void nav({ to: "/stats", search: { ...search, ...p } as never, replace: true });
  // counting: the background index has logs left; ask again every 2 s until every log is counted
  const every = (q: { state: { data?: { pending: number } } }) => (q.state.data && q.state.data.pending > 0 ? 2000 : false);
  const sumQ = useQuery({ queryKey: ["cost"], queryFn: () => live.request<Cost>("cost.get"), refetchInterval: every });
  const rowsQ = (by: string) => ({ queryKey: ["cost", by, since, filter], queryFn: () => live.request<CostRows>("cost.get", { by, since, ...(filter ? { filter } : {}) }), refetchInterval: every, retry: false });
  const byH = useQuery(rowsQ("harness")); const byM = useQuery(rowsQ("model"));
  useEffect(() => { // d w m: the period, as in the TUI (not while typing)
    const keys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && ["d", "w", "m"].includes(e.key)) set({ p: e.key });
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  });
  const c = sumQ.data; const ferr = (byH.error ?? byM.error) as ApiFail | null;
  const pending = Math.max(c?.pending ?? 0, byH.data?.pending ?? 0, byM.data?.pending ?? 0); const ix = c?.indexing ?? byH.data?.indexing;
  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[14px] font-semibold">Stats</h1>
        <div role="radiogroup" aria-label="Period" className="flex gap-0.5">
          {PERIODS.map(([k, l]) => <Button key={k} role="radio" aria-checked={period === k} variant={period === k ? "outline" : "ghost"} onClick={() => set({ p: k })}>{l} <Kbd>{k}</Kbd></Button>)}
        </div>
        <form className="ml-auto flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); set({ f: text.trim() || undefined }); }}>
          <input aria-label="Filter" placeholder="filter, e.g. harness is claude" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setText(""); set({ f: undefined }); } }} className="mono h-7 w-72 rounded border border-border bg-surface px-2 text-[12px]" />
        </form>
      </div>
      {pending > 0 && <p role="status" className="text-muted">⟳ counting… {pending} {pending === 1 ? "log is" : "logs are"} still being indexed{ix && ix.total > 0 ? " (" + Math.min(99, Math.floor((ix.done / ix.total) * 100)) + "%)" : ""} — the figures grow until then</p>}
      {sumQ.error ? <p role="alert" className="text-error">{(sumQ.error as ApiFail).err?.msg ?? String(sumQ.error)}</p> : !c ? <p className="text-muted">Loading…</p> : (
        <div className="grid gap-3 md:grid-cols-3">
          <Card title="Today" p={c.today} />
          <Card title="7 days" p={c.week} />
          <Card title="This month" p={c.month} extra={<p className="text-[12px] text-muted">{c.month.projected ? "projected " + usd(c.month.projected.total, c.month.estimatedUsd > 0) : "projection needs 3+ days of history"}</p>} />
          {c.budget && <div className="md:col-span-3"><Budget b={c.budget} /></div>}
        </div>)}
      {ferr && <pre role="alert" className="mono whitespace-pre-wrap text-[12px] text-error">{ferr.err?.msg}{ferr.err?.hint ? "\n" + ferr.err.hint : ""}</pre>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Table label="By harness" data={byH.data} />
        <Table label="By model" data={byM.data} model open={model} onOpen={(k) => set({ model: model === k ? undefined : k, proj: undefined })} />
      </div>
      {model && <Drill model={model} since={since} filter={filter} label={PERIODS.find(([k]) => k === period)?.[1] ?? ""} sort={search.sort ?? "cost"} proj={search.proj} set={set} onClose={() => set({ model: undefined, proj: undefined, sort: undefined })} />}
    </div>
  );
}
