// a session's events in the drawer (W8.3): events.list (= `agentglass events <ref> --json`, no text) with the K bar's
// presets as chips or a filter expression; hidden runs as "┄ 12 hidden · reply 8 · edit 4 ┄", a big log's unread head as
// one line. [ and ] move to the previous / next event (the TUI's keys); the newest are shown (the last 500 matches).
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EventsList } from "@agentglass/api-contract";
import { Button, cn } from "@agentglass/ui";
import { useLive } from "../app.tsx";
import type { ApiFail } from "../live/socket.ts";
import { hhmm } from "./team.tsx";

export const PRESETS = ["all", "skills", "mcp", "shell", "errors", "prompts"] as const;
type Item = EventsList["events"][number];
function mb(n: number): string { return n >= 1e6 ? Math.round(n / 1e6) + " MB" : Math.round(n / 1e3) + " KB"; }
const KIND_TONE: Record<string, string> = { error: "text-error", prompt: "text-accent", "skill:load": "text-attention" };

export function Events({ refId }: { refId: string }) {
  const live = useLive(); const [preset, setPreset] = useState<string>("all"); const [filter, setFilter] = useState(""); const [text, setText] = useState("");
  const [cur, setCur] = useState(-1); const list = useRef<HTMLOListElement>(null);
  const q = useQuery({ queryKey: ["events", refId, preset, filter], retry: false, staleTime: 5000,
    queryFn: () => live.request<EventsList>("events.list", { ref: refId, limit: 500, ...(filter ? { filter } : preset !== "all" ? { preset } : {}) }) });
  const items = q.data?.events ?? [];
  const evIdx = items.map((x, i) => ("kind" in x ? i : -1)).filter((i) => i >= 0);
  useEffect(() => { setCur(-1); }, [q.data]);
  useEffect(() => { // [ ] previous / next event (not while typing)
    const keys = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.key !== "[" && e.key !== "]") return;
      e.preventDefault(); e.stopPropagation();
      setCur((c) => { const p = evIdx.indexOf(c); const n = e.key === "]" ? (p < 0 ? evIdx[0] : evIdx[Math.min(evIdx.length - 1, p + 1)]) : (p < 0 ? evIdx[evIdx.length - 1] : evIdx[Math.max(0, p - 1)]); return n ?? -1; });
    };
    window.addEventListener("keydown", keys, true); return () => window.removeEventListener("keydown", keys, true);
  });
  useEffect(() => { if (cur >= 0) (list.current?.querySelector("[data-i=\"" + cur + "\"]") as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" }); }, [cur]);
  const err = q.error as ApiFail | null;
  return (
    <div className="mt-3">
      <div role="radiogroup" aria-label="Event kinds" className="flex flex-wrap gap-0.5">
        {PRESETS.map((p) => <Button key={p} role="radio" aria-checked={!filter && preset === p} variant={!filter && preset === p ? "outline" : "ghost"} onClick={() => { setFilter(""); setText(""); setPreset(p); }}>{p}</Button>)}
      </div>
      <form className="mt-2" onSubmit={(e) => { e.preventDefault(); setFilter(text.trim()); }}>
        <input aria-label="Event filter" placeholder="event.kind is_one_of mcp, error · shell.family ~ test" value={text} onChange={(e) => setText(e.target.value)} className="mono h-7 w-full rounded border border-border bg-surface px-2 text-[12px]" />
      </form>
      {err ? <pre role="alert" className="mono mt-2 whitespace-pre-wrap text-[12px] text-error">{err.err?.msg ?? err.message}{err.err?.hint ? "\n" + err.err.hint : ""}</pre>
        : !q.data ? <p className="mt-3 flex items-center gap-2 text-muted" aria-live="polite"><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />reading the events…</p> : <>
          <p className="mt-2 text-[12px] text-muted">{q.data.matched} of {q.data.total} events{q.data.filter ? " · " + q.data.filter : ""} · <kbd className="mono">[</kbd> <kbd className="mono">]</kbd> previous / next</p>
          <ol ref={list} aria-label="Events" className="mt-1">
            {items.map((x: Item, i) => {
              if ("unread" in x) return <li key={i} className="py-1 text-center text-[12px] text-muted">┄ earlier events not read ({mb(x.unread)} of a big log) ┄</li>;
              if ("gap" in x) return <li key={i} className="py-0.5 text-center text-[12px] text-muted">┄ {x.gap} hidden{Object.keys(x.kinds).length ? " · " + Object.entries(x.kinds).slice(0, 4).map(([k, n]) => k + " " + n).join(" · ") : ""} ┄</li>;
              return (
                <li key={i} data-i={i} aria-current={cur === i ? "true" : undefined} className={cn("flex h-6 items-center gap-2 rounded px-1 text-[12px]", cur === i && "bg-surface-2 ring-1 ring-focus")}>
                  <span className="num w-10 shrink-0 text-muted">{x.ts ? hhmm(x.ts) : ""}</span>
                  <span className="w-28 shrink-0 truncate">{x.kinds.map((k, j) => <span key={k} className={KIND_TONE[k] ?? KIND_TONE[k.split(":")[0] ?? ""] ?? "text-muted"}>{j ? "," : ""}{k}</span>)}</span>
                  <span className="mono truncate" title={x.target ?? undefined}>{x.tool ?? x.kind}{x.target ? " " + x.target : ""}</span>
                </li>);
            })}
          </ol>
        </>}
    </div>
  );
}
