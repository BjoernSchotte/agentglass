// the live Sessions view: one subscription (the filter in the URL's f), rows newest first with ● ◆ ⚠ ○, an "N new"
// pill while the reader is away from the top, j/k/↵ and a detail drawer (sessions.get) for the selected row (sel)
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
function Detail({ row, onClose }: { row: SessionRow | undefined; onClose: () => void }) {
  const live = useLive(); const [d, setD] = useState<SessionDetail | null>(null); const [err, setErr] = useState("");
  useEffect(() => { setD(null); setErr(""); if (row) live.request<SessionDetail>("sessions.get", { ref: row.harness + ":" + row.id }).then(setD, (e: ApiFail) => setErr(e.message)); }, [live, row?.harness, row?.id]);
  const fields: [string, string][] = d ? [["Harness", d.harness], ["State", d.state], ["Model", d.model ?? ""], ["Repo", d.repo?.label ?? ""], ["Branch", d.branch ?? ""], ["Directory", d.cwd], ["Cost", money(d.costUsd)], ["Tokens in / out", d.tokens ? d.tokens.in + " / " + d.tokens.out : ""], ["Updated", d.updated], ["Alerts", d.alerts.map((a) => a.message).join("; ") || "none"]] : [];
  return (
    <Dialog open={!!row} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent title={row?.title || "Session"} side className="overflow-auto p-4">
        <h2 className="mb-1 text-[15px] font-semibold">{row?.title || row?.id}</h2>
        <p className="mb-3 text-muted">{row && <Badge>{row.harness}:{row.id.slice(0, 8)}</Badge>}</p>
        {err && <p role="alert" className="text-error">{err}</p>}
        <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5">{fields.map(([k, v]) => <><dt key={k + "k"} className="text-muted">{k}</dt><dd key={k + "v"} className="mono break-all text-[12px]">{v || "—"}</dd></>)}</dl>
      </DialogContent>
    </Dialog>
  );
}
