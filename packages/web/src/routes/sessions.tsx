// the live Sessions view: one subscription (the filter in the URL's f), rows newest first with ● ◆ ⚠ ○, an "N new"
// pill while the reader is away from the top, j/k/↵ and a detail drawer (sessions.get) for the selected row (sel)
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import type { SessionDetail, SessionRow } from "@agentglass/api-contract";
import { Badge, Button, Dialog, DialogContent, Kbd, cn } from "@agentglass/ui";
import { Rows } from "../live/store.ts";
import { type Live, ApiFail } from "../live/socket.ts";
import { useLive, useNow, useStatus, ago, money } from "../app.tsx";

export const SESSIONS = new Rows();
// the sessions subscription, kept while the app runs; a new filter replaces it (a bad one: err, the old rows stay)
const FEED = { filter: null as string | null, live: null as Live | null, stop: () => {} };
export function feed(live: Live, filter: string, onErr: (msg: string) => void): void {
  if (FEED.filter === filter && FEED.live === live) return;
  FEED.stop(); if (FEED.live !== live) SESSIONS.reset(); FEED.filter = filter; FEED.live = live;
  FEED.stop = live.subscribe({ topic: "sessions", ...(filter ? { filter } : {}), limit: 500 }, (e) => SESSIONS.apply(e), (e: ApiFail) => { FEED.filter = null; onErr(e.err.msg + (e.err.hint ? "\n" + e.err.hint : "")); });
}
// the status line and the palette need rows on every page: the unfiltered feed unless the Sessions view set one
export function ensureFeed(live: Live): void { if (FEED.filter === null || FEED.live !== live) feed(live, FEED.live === live ? "" : FEED.filter ?? "", () => {}); }
export interface SessionsSearch { f?: string; sel?: string; s?: string }
export const SORTS = ["harness", "title", "repo", "cost", "updated"] as const;
export function validateSessions(s: Record<string, unknown>): SessionsSearch {
  const o: SessionsSearch = {}; if (typeof s.f === "string" && s.f) o.f = s.f; if (typeof s.sel === "string" && s.sel) o.sel = s.sel;
  if (typeof s.s === "string" && (SORTS as readonly string[]).includes(s.s.replace(/^-/, ""))) o.s = s.s;
  return o;
}
// the sort of the URL's s ("cost" ascending, "-cost" descending; default: updated, newest first); stable, the list's
// order breaks ties. A pending row's cost sorts as unknown (last).
export function sortKeys(keys: string[], rows: Map<string, SessionRow>, s: string | undefined): string[] {
  if (!s || s === "-updated") return keys;
  const desc = s.startsWith("-"); const k = s.replace(/^-/, "");
  const val = (r: SessionRow): string | number | null => k === "cost" ? (r.pending || r.costUsd === null ? null : r.costUsd) : k === "updated" ? r.updated : k === "repo" ? (r.repo?.label ?? "").toLowerCase() : k === "title" ? (r.title || r.id).toLowerCase() : r.harness;
  const idx = new Map(keys.map((x, i) => [x, i]));
  return [...keys].sort((a, b) => {
    const x = val(rows.get(a)!); const y = val(rows.get(b)!);
    if (x === null || y === null) return x === y ? idx.get(a)! - idx.get(b)! : x === null ? 1 : -1; // unknown last, both ways
    const c = x < y ? -1 : x > y ? 1 : 0; return (desc ? -c : c) || idx.get(a)! - idx.get(b)!;
  });
}
// "⟳ indexing 34% · 1.2 GB left · ~3 min" — the TUI's gauge
function bytes(n: number): string { return n >= 1e9 ? (n / 1e9).toFixed(1) + " GB" : n >= 1e6 ? Math.round(n / 1e6) + " MB" : Math.round(n / 1e3) + " KB"; }
export function gauge(ix: { done: number; total: number; bps: number }): { pct: number; text: string } {
  const pct = ix.total > 0 ? Math.min(99, Math.floor((ix.done / ix.total) * 100)) : 0; const left = Math.max(0, ix.total - ix.done);
  const s = ix.bps > 0 ? left / ix.bps : -1;
  const eta = s < 0 ? "estimating time" : s < 90 ? "~" + Math.max(1, Math.round(s)) + " s" : s < 5400 ? "~" + Math.round(s / 60) + " min" : "~" + Math.round(s / 3600) + " h";
  return { pct, text: "Indexing your history: " + pct + "% · " + bytes(left) + " left · " + eta };
}
export function glyph(r: SessionRow): { g: string; c: string; label: string } {
  if (r.state === "stuck") return { g: "⚠", c: "text-stuck", label: "stuck" };
  if (r.state === "attention" || r.attention) return { g: "◆", c: "text-attention", label: "waiting for you" };
  if (r.live) return { g: "●", c: "text-live", label: r.state === "busy" ? "working" : "live, idle" };
  return { g: "○", c: "text-muted", label: "ended" };
}

export function SessionsView() {
  const live = useLive(); const nav = useNavigate(); const search = useSearch({ strict: false }) as SessionsSearch; const now = useNow();
  useSyncExternalStore(SESSIONS.subscribe, SESSIONS.snapshot);
  const [err, setErr] = useState(""); const [text, setText] = useState(search.f ?? ""); const [cur, setCur] = useState(0);
  const input = useRef<HTMLInputElement>(null); const list = useRef<HTMLDivElement>(null);
  useEffect(() => { setErr(""); feed(live, search.f ?? "", setErr); }, [live, search.f]);
  const keys = sortKeys(SESSIONS.visible(), SESSIONS.rows, search.s); const status = useStatus();
  const sortBy = (k: string) => { const cur = search.s ?? "-updated"; const next = cur === "-" + k ? k : cur === k ? "-" + k : k === "title" || k === "harness" || k === "repo" ? k : "-" + k; setSearch({ ...search, s: next === "-updated" ? undefined : next }); };
  const setSearch = (s: SessionsSearch) => void nav({ to: "/sessions", search: s, replace: true });
  useEffect(() => {
    const on = (e: Event) => {
      const a = (e as CustomEvent<string>).detail;
      if (a === "filter") { input.current?.focus(); input.current?.select(); }
      else if (a === "down") setCur((c) => Math.min(keys.length - 1, c + 1));
      else if (a === "up") setCur((c) => Math.max(0, c - 1));
      else if (a === "open") { const k = keys[cur]; if (k) setSearch({ ...search, sel: k }); }
      else if (a === "fresh") { list.current?.scrollTo({ top: 0 }); SESSIONS.freeze(false); }
      else if (a === "back") { if (document.activeElement === input.current) input.current?.blur(); else if (search.f) { setText(""); setSearch({}); } }
    };
    window.addEventListener("ag:key", on); return () => window.removeEventListener("ag:key", on);
  });
  const onScroll = () => { const top = (list.current?.scrollTop ?? 0) < 8; if (top === SESSIONS.frozen) SESSIONS.freeze(!top); };
  const sel = search.sel ? SESSIONS.rows.get(search.sel) : undefined;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2">
        <h1 className="text-[14px] font-semibold">Sessions</h1>
        <form className="ml-4 flex flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); setSearch({ ...(text.trim() ? { f: text.trim() } : {}) }); }}>
          <input ref={input} value={text} onChange={(e) => setText(e.target.value)} aria-label="Filter" placeholder="filter: live is true and harness is codex — or a word" className={cn("mono h-7 flex-1 rounded border bg-surface px-2 text-[12px] outline-none", err ? "border-error" : "border-border")} />
          <Kbd>/</Kbd>
        </form>
      </div>
      {err && <pre role="alert" className="mono whitespace-pre-wrap border-b border-border-subtle px-4 py-1.5 text-[12px] text-error">{err}</pre>}
      {SESSIONS.indexing && (() => { const g = gauge(SESSIONS.indexing); return (
        <div className="border-b border-border-subtle px-4 py-1.5 text-[12px] text-muted" title="agentglass reads each session log once and keeps the result in its cache (~/.agentglass/cache), shared with the TUI; it uses at most a fifth of one core, newest sessions first. Costs marked … are still being counted.">
          <div className="mb-1 flex items-center gap-2"><span className="text-attention">⟳</span><span>{g.text}</span><span className="ml-auto">costs marked … are still being counted</span></div>
          <div role="progressbar" aria-label="Indexing your history" aria-valuemin={0} aria-valuemax={100} aria-valuenow={g.pct} className="h-1 overflow-hidden rounded bg-surface-2"><div className="h-full bg-accent transition-[width] duration-500" style={{ width: g.pct + "%" }} /></div>
        </div>); })()}
      {SESSIONS.fresh > 0 && <Button variant="outline" className="mx-auto my-1" onClick={() => { list.current?.scrollTo({ top: 0 }); SESSIONS.freeze(false); }}>{SESSIONS.fresh} new <Kbd>.</Kbd></Button>}
      <div ref={list} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
        {!SESSIONS.ready ? <Phase status={status} /> : keys.length === 0 ? <p className="p-4 text-muted">{search.f ? "No session matches the filter." : "No sessions yet."}</p> : (
          <table className="w-full table-fixed border-collapse">
            <colgroup><col className="w-7" /><col className="w-24" /><col /><col className="w-[28%]" /><col className="w-20" /><col className="w-20" /></colgroup>
            <thead className="sticky top-0 bg-bg text-left text-[11px] uppercase tracking-wide text-muted">
              <tr><th className="w-6" /><Th k="harness" label="Harness" s={search.s} on={sortBy} /><Th k="title" label="Title" s={search.s} on={sortBy} /><Th k="repo" label="Repo" s={search.s} on={sortBy} /><Th k="cost" label="Cost" s={search.s} on={sortBy} num /><Th k="updated" label="Updated" s={search.s} on={sortBy} num /></tr>
            </thead>
            <tbody>
              {keys.map((k, i) => { const r = SESSIONS.rows.get(k)!; const gl = glyph(r); return (
                <tr key={k} aria-selected={i === cur} onClick={() => { setCur(i); setSearch({ ...search, sel: k }); }} className={cn("h-7 cursor-default border-b border-border-subtle hover:bg-surface-2", i === cur && "bg-surface-2")}>
                  <td className={cn("pl-3", gl.c)} title={gl.label} aria-label={gl.label}>{gl.g}</td>
                  <td className="px-2" style={{ color: "var(--h-" + r.harness + ", var(--text-muted))" }}>{r.harness}</td>
                  <td className="truncate px-2">{r.title || <span className="text-muted">{r.id.slice(0, 8)}</span>}</td>
                  <td className="truncate px-2 text-muted">{r.repo?.label ?? ""}</td>
                  <td className="num px-2 text-cost">{r.pending ? <span className="text-muted" title="still being counted">…</span> : money(r.costUsd)}</td>
                  <td className="num px-3 text-muted">{ago(now - Date.parse(r.updated))}</td>
                </tr>); })}
            </tbody>
          </table>)}
      </div>
      <Detail row={sel} onClose={() => setSearch({ ...(search.f ? { f: search.f } : {}) })} />
    </div>
  );
}
// a sortable column header: click sorts, a second click reverses (aria-sort for screen readers)
function Th({ k, label, s, on, num }: { k: string; label: string; s: string | undefined; on: (k: string) => void; num?: boolean }) {
  const cur = s ?? "-updated"; const dir = cur === k ? "ascending" : cur === "-" + k ? "descending" : "none";
  return (
    <th aria-sort={dir} className={cn("px-2 py-1 font-medium", num && "num", k === "updated" && "pr-3")}>
      <button type="button" onClick={() => on(k)} className={cn("inline-flex items-center gap-1 uppercase tracking-wide hover:text-text", dir !== "none" && "text-text")}>
        {label}<span aria-hidden className="w-2">{dir === "ascending" ? "↑" : dir === "descending" ? "↓" : ""}</span>
      </button>
    </th>
  );
}
// what the list waits for, instead of a bare "Loading…"
function Phase({ status }: { status: string }) {
  const t = status === "open" ? "Reading your sessions…" : status === "ended" ? "This tab's session ended — run agentglass web for a new link." : status === "closed" ? "Reconnecting to agentglass…" : "Connecting to agentglass…";
  return (
    <div className="p-4" aria-live="polite">
      <p className="mb-3 flex items-center gap-2 text-muted"><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />{t}</p>
      {status !== "ended" && <div aria-hidden className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-5 animate-pulse rounded bg-surface-2" style={{ width: 90 - i * 9 + "%" }} />)}</div>}
    </div>
  );
}
// the drawer: what the list row knows at once, then the session's detail (sessions.get: turns, models, tools, files,
// errors, subagents, skills, commits) — a big or busy session may take a few seconds, so that part says it is loading
type Detail = Omit<SessionDetail, "tools" | "subagents" | "skills" | "git"> & { turns?: number | null; activeMs?: number | null; wallMs?: number | null; models?: { model: string; in: number; out: number }[];
  tools?: { name: string; calls: number; errors: number }[]; files?: { path: string; add: number; del: number }[]; errors?: { ts: string; tool: string; arg: string }[];
  subagents?: { id: string; kind: string; costUsd: number | null }[]; skills?: { name: string }[]; git?: { commits?: unknown[] } | null };
function dur(ms: number): string { const m = Math.round(ms / 60000); return m < 60 ? m + " min" : m < 1440 ? (m / 60).toFixed(1) + " h" : (m / 1440).toFixed(1) + " d"; }
function n(x: number): string { return x >= 1e9 ? (x / 1e9).toFixed(1) + "B" : x >= 1e6 ? (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? (x / 1e3).toFixed(1) + "k" : String(x); }
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="mt-4"><h3 className="mb-1 text-[11px] uppercase tracking-wide text-muted">{title}</h3>{children}</section>;
}
function Detail({ row, onClose }: { row: SessionRow | undefined; onClose: () => void }) {
  const live = useLive(); const now = useNow(); const [d, setD] = useState<Detail | null>(null); const [err, setErr] = useState("");
  const [full, setFull] = useState(false);
  // two answers: the index's at once (detail: fast), then the full one (turns, timing, repeats: a pass over the transcript)
  useEffect(() => {
    setD(null); setErr(""); setFull(false); if (!row) return;
    let gone = false; const ref = row.harness + ":" + row.id;
    live.request<Detail>("sessions.get", { ref, detail: "fast" }).then((x) => { if (!gone) setD((cur) => cur ?? x); }, (e: ApiFail) => { if (!gone) setErr(e.message); });
    live.request<Detail>("sessions.get", { ref }).then((x) => { if (!gone) { setD(x); setFull(true); } }, () => {});
    return () => { gone = true; };
  }, [live, row?.harness, row?.id]);
  if (!row) return <Dialog open={false} onOpenChange={() => {}}><span /></Dialog>;
  const gl = glyph(row); const tk = row.tokens;
  const facts: [string, React.ReactNode][] = [
    ["State", <span className={gl.c}>{gl.g} {row.state}{row.stuck ? " · " + row.stuck : ""}</span>], ["Harness", row.harness], ["Model", row.model ?? ""],
    ["Repo", row.repo?.label ?? ""], ["Branch", row.branch ?? ""], ["Directory", row.cwd],
    ["Cost", row.pending ? "… still being counted" : money(row.costUsd)],
    ["Tokens", tk ? n(tk.in) + " in · " + n(tk.out) + " out · " + n(tk.cacheRead) + " cache read" : ""],
    ["Updated", ago(now - Date.parse(row.updated)) + " ago"],
  ];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={row.title || "Session"} side className="overflow-auto p-4">
        <h2 className="mb-1 pr-6 text-[15px] font-semibold">{row.title || row.id}</h2>
        <p className="mb-3"><Badge>{row.harness}:{row.id.slice(0, 8)}</Badge></p>
        <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">{facts.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="mono break-all text-[12px]">{v || "—"}</dd></div>)}</dl>
        {row.alerts.length > 0 && <Block title="Alerts"><ul>{row.alerts.map((a, i) => <li key={i} className={a.severity === "critical" ? "text-stuck" : "text-attention"}>{a.message}</li>)}</ul></Block>}
        {err ? <p role="alert" className="mt-4 text-error">{err}</p> : !d ? (
          <p className="mt-4 flex items-center gap-2 text-muted" aria-live="polite"><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />Loading details…</p>
        ) : <>
          <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-y-1.5">
            {!full ? <div className="contents"><dt className="text-muted">Turns</dt><dd className="flex items-center gap-1.5 text-[12px] text-muted"><span className="inline-block h-2.5 w-2.5 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />reading the transcript…</dd></div> : <>
              {d.turns != null && <div className="contents"><dt className="text-muted">Turns</dt><dd className="mono text-[12px]">{d.turns}{(d as { stale?: boolean }).stale && <span className="text-muted" title="the session moved on since these were read; reopen for the latest"> · as of a moment ago</span>}</dd></div>}
              {d.activeMs != null && <div className="contents"><dt className="text-muted">Active</dt><dd className="mono text-[12px]">{dur(d.activeMs)}{d.wallMs ? " of " + dur(d.wallMs) : ""}</dd></div>}
            </>}
            {d.git?.commits && <div className="contents"><dt className="text-muted">Commits</dt><dd className="mono text-[12px]">{d.git.commits.length}</dd></div>}
          </dl>
          {!!d.models?.length && <Block title="Models"><ul>{d.models.map((m) => <li key={m.model} className="mono flex justify-between text-[12px]"><span>{m.model}</span><span className="text-muted">{n(m.in)} in · {n(m.out)} out</span></li>)}</ul></Block>}
          {!!d.tools?.length && <Block title="Tools"><ul>{[...d.tools].sort((a, b) => b.calls - a.calls).slice(0, 8).map((t) => <li key={t.name} className="mono flex justify-between text-[12px]"><span>{t.name}</span><span className="text-muted">{t.calls} calls{t.errors ? <span className="text-error"> · {t.errors} errors</span> : null}</span></li>)}</ul></Block>}
          {!!d.files?.length && <Block title={"Files changed (" + d.files.length + ")"}><ul>{d.files.slice(0, 10).map((f) => <li key={f.path} className="mono flex justify-between gap-2 text-[12px]"><span className="truncate" title={f.path}>{f.path.split("/").slice(-2).join("/")}</span><span className="shrink-0"><span className="text-live">+{f.add}</span> <span className="text-error">−{f.del}</span></span></li>)}</ul></Block>}
          {!!d.errors?.length && <Block title="Last errors"><ul>{d.errors.slice(-5).reverse().map((e, i) => <li key={i} className="mono truncate text-[12px]" title={e.arg}><span className="text-error">{e.tool}</span> <span className="text-muted">{e.arg}</span></li>)}</ul></Block>}
          {!!d.subagents?.length && <Block title={"Subagents (" + d.subagents.length + ")"}><ul>{d.subagents.slice(0, 8).map((x) => <li key={x.id} className="mono flex justify-between text-[12px]"><span className="truncate">{x.kind || x.id}</span><span className="text-cost">{money(x.costUsd)}</span></li>)}</ul></Block>}
          {!!d.skills?.length && <Block title="Skills"><p className="mono text-[12px]">{d.skills.map((x) => x.name).join(", ")}</p></Block>}
        </>}
      </DialogContent>
    </Dialog>
  );
}
