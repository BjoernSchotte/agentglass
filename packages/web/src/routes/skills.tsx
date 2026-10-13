// the Skills page (local-web-api §7, W8.5): which skills the period's sessions loaded and what each cost — loads (you /
// the model / after compaction), median size, load and carry tokens, the tail after the skill's turn, $ and $ per
// session, share of all request tokens, tier marks (≈ inferred, ? unknown size) — and the advice list (skills.get =
// `agentglass skills --json`). Period, sort and filter live in the URL; a column header sorts as `--sort` does.
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { Skills } from "@agentglass/api-contract";
import { Button, Kbd, cn } from "@agentglass/ui";
import { useLive } from "../app.tsx";
import type { ApiFail } from "../live/socket.ts";
import { type SkillsSearch, SKILLS_PERIODS as PERIODS, SKILLS_SORTS as SORTS } from "./search.ts";

// the advice ids' names, as the CLI prints them (skills/advise.ts ADVICE_NAMES)
const ADVICE: Record<string, string> = { A1: "carried too long", A2: "never auto-loaded", A3: "loaded twice in one context", A4: "lost to compaction", A5: "version changed",
  A6: "listed, never loaded", A7: "loaded, then nothing", A8: "overlap", A9: "outcome (correlation, not cause)", A10: "versions differ across hosts" };
type Row = Skills["rows"][number];
export function tk(n: number): string { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)); }
// the CLI's money: ≈ for an inferred size, ? for an unknown one (not priced), + when part of it has no price
export function skUsd(x: number, tier: string, unpriced: boolean): string {
  if (tier === "?" && x <= 0) return "?";
  return (tier === "≈" ? "≈" : "") + "$" + (x >= 100 ? x.toFixed(0) : x.toFixed(2)) + (unpriced ? "+" : "");
}
const COLS: [string, string, string | null][] = [["Loads", "you / model / compact", "loads"], ["Sessions", "", null], ["Size", "median loaded size (tokens)", "size"], ["Load", "tokens of the loading requests", null],
  ["Carry", "tokens carried in later requests", null], ["Tail", "carry after the skill's own turn", "tail"], ["Cost", "", "cost"], ["$/session", "", "persess"], ["Share", "of all request tokens", "share"]];

export function SkillsView() {
  const live = useLive(); const nav = useNavigate(); const search = useSearch({ strict: false }) as SkillsSearch;
  const period = search.p ?? "m"; const sort = search.sort ?? "cost"; const filter = search.f ?? "";
  const per = PERIODS.find(([k]) => k === period)?.[2] ?? "30d";
  const [text, setText] = useState(filter); useEffect(() => setText(filter), [filter]);
  const set = (p: SkillsSearch) => void nav({ to: "/skills", search: { ...search, ...p } as never, replace: true });
  const q = useQuery({ queryKey: ["skills", per, sort, filter], retry: false,
    refetchInterval: (x: { state: { data?: { pending: number } } }) => (x.state.data && x.state.data.pending > 0 ? 2000 : 60_000),
    queryFn: () => live.request<Skills>("skills.get", { period: per, sort, advice: 10, ...(filter ? { filter } : {}) }) });
  useEffect(() => { // d w m a: the period (not while typing)
    const keys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && ["d", "w", "m", "a"].includes(e.key)) set({ p: e.key });
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  });
  const d = q.data; const err = q.error as ApiFail | null;
  const total = d ? d.rows.reduce((a, r) => a + r.usd, 0) : 0; const est = d?.rows.some((r) => r.tier !== "exact") ?? false;
  const name = (r: Row) => (r.name === "(hidden)" ? "(hidden: " + d!.hidden + " skill" + (d!.hidden === 1 ? "" : "s") + ")" : r.name);
  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-[14px] font-semibold">Skills</h1>
        <div role="radiogroup" aria-label="Period" className="flex gap-0.5">
          {PERIODS.map(([k, l]) => <Button key={k} role="radio" aria-checked={period === k} variant={period === k ? "outline" : "ghost"} onClick={() => set({ p: k })}>{l} <Kbd>{k}</Kbd></Button>)}
        </div>
        <form className="ml-auto" onSubmit={(e) => { e.preventDefault(); set({ f: text.trim() || undefined }); }}>
          <input aria-label="Filter" placeholder="filter, e.g. repo is api" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setText(""); set({ f: undefined }); } }} className="mono h-7 w-72 rounded border border-border bg-surface px-2 text-[12px]" />
        </form>
      </div>
      {err ? <pre role="alert" className="mono whitespace-pre-wrap text-[12px] text-error">{err.err?.msg ?? err.message}{err.err?.hint ? "\n" + err.err.hint : ""}</pre>
        : !d ? <p className="flex items-center gap-2 text-muted" aria-live="polite"><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />Counting skill loads…</p> : <>
        {d.pending > 0 && <p role="status" className="text-muted">⟳ {d.pending} {d.pending === 1 ? "log is" : "logs are"} still being indexed — their loads count as booked so far</p>}
        {!d.rows.length ? <p className="text-muted">No skill loads in this period{filter ? " matching the filter" : ""}. Skills are counted from Claude, Codex, pi, OpenCode and Gemini logs.</p> : <>
          <p className="text-[12px] text-muted">{d.rows.length} skills · <span className="text-cost">{est ? "≈" : ""}${total.toFixed(2)}</span> in the period · tokens are measured request tokens; ≈ inferred or cut, ? unknown size (not priced); $ at current list prices</p>
          <table aria-label="Skills" className="w-full table-fixed border-collapse">
            <colgroup><col /><col className="w-28" /><col className="w-20" /><col className="w-16" /><col className="w-16" /><col className="w-16" /><col className="w-16" /><col className="w-20" /><col className="w-20" /><col className="w-28" /></colgroup>
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr><th className="py-1 pl-2 font-medium">Skill</th>
              {COLS.map(([l, tip, k]) => <th key={l} title={tip || undefined} aria-sort={k && sort === k ? "descending" : undefined} className={cn("num font-medium", l === "Share" && "pr-2")}>
                {k ? <button type="button" onClick={() => set({ sort: k === "cost" ? undefined : k })} className={cn("uppercase tracking-wide hover:text-text", sort === k && "text-text")}>{l}{sort === k ? " ▾" : ""}</button> : l}</th>)}</tr></thead>
            <tbody>{d.rows.map((r) => (
              <tr key={r.name} className="h-7 border-b border-border-subtle">
                <td className={cn("mono truncate pl-2 text-[12px]", r.name === "(hidden)" && "text-muted")} title={r.scope ? r.name + " · " + r.scope : r.name}>{name(r)}{r.tier !== "exact" && <span className="text-muted" title={r.tier === "≈" ? "size inferred or cut" : "size unknown: not priced"}> {r.tier}</span>}</td>
                <td className="num" title={r.loadsUser + " by you (/command), " + r.loadsModel + " by the model, " + r.loadsCompact + " after compaction"}>{r.loadsUser} / {r.loadsModel}{r.loadsCompact ? " / " + r.loadsCompact : ""}</td>
                <td className="num">{r.sessions}</td><td className="num">{r.sizeP50 === null ? "?" : tk(r.sizeP50)}</td>
                <td className="num">{tk(r.load)}</td><td className="num">{tk(r.carry)}</td><td className="num">{tk(r.tail)}</td>
                <td className="num text-cost">{skUsd(r.usd, r.tier, r.unpriced)}</td><td className="num">{skUsd(r.perSess, r.tier, r.unpriced)}</td>
                <td className="num pr-2"><span className="inline-flex items-center gap-1.5"><span aria-hidden className="inline-block h-1.5 w-12 overflow-hidden rounded bg-surface-2"><span className="block h-full bg-accent" style={{ width: Math.min(100, r.share * 100 * 4) + "%" }} /></span>{(r.share * 100).toFixed(1)}%</span></td>
              </tr>))}</tbody>
          </table>
        </>}
        <section aria-label="Advice">
          <h2 className="mb-1.5 text-[11px] uppercase tracking-wide text-muted">Advice</h2>
          {!d.advice.length ? <p className="text-muted">No skill crossed a threshold in this period (config skills.advise.*).</p> : (
            <ol className="flex flex-col gap-2">{d.advice.map((a, i) => (
              <li key={a.id + a.skill + (a.pair ?? "") + i} className="rounded border border-border-subtle bg-surface p-3">
                <p className="text-[13px]"><span className="mono text-muted">{a.id}</span> <span className="font-medium">{ADVICE[a.id] ?? a.id}</span> · <span className="mono">{a.skill}{a.pair ? " + " + a.pair : ""}</span>
                  {a.severityUsd > 0 && <span className="text-cost"> · ≈${a.severityUsd.toFixed(2)}/30 d{a.basisDays ? <span className="text-muted">, from {a.basisDays} {a.basisDays === 1 ? "day" : "days"}</span> : null}</span>}</p>
                {a.evidence.length > 0 && <ul className="mt-1 text-[12px] text-muted">{a.evidence.map((e, j) => <li key={j}>{e}</li>)}</ul>}
                <p className="mt-1 text-[12px]">→ {a.suggestion}</p>
                {a.sessions.length > 0 && <p className="mt-1 flex flex-wrap gap-x-2 text-[12px] text-muted">sessions: {a.sessions.slice(0, 6).map((k) => <Link key={k} to="/sessions" search={{ sel: k } as never} className="mono hover:underline">{k.slice(k.indexOf(":") + 1, k.indexOf(":") + 9)}</Link>)}{a.sessions.length > 6 ? " +" + (a.sessions.length - 6) : ""}</p>}
              </li>))}</ol>)}
        </section>
      </>}
    </div>
  );
}
