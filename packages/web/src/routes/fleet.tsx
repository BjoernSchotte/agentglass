// the Fleet page (local-web-api §7, W8.6): per configured host what works — state, last report, sessions and live
// agents, version, OS, time zone, exactness, live stream, the problem in words (fleet.hosts = `agentglass fleet status
// --json` from the cached reports: the web never pulls; `agentglass fleet --refresh` or the TUI do). Problems first.
import { useQuery } from "@tanstack/react-query";
import type { FleetStatus } from "@agentglass/api-contract";
import { cn } from "@agentglass/ui";
import { useLive, ago } from "../app.tsx";
import type { ApiFail } from "../live/socket.ts";

type Host = FleetStatus["hosts"][number];
// ok · stale · problem · off — never colour alone: a glyph and a word
export function stateOf(h: Host): { g: string; word: string; c: string } {
  if (!h.enabled || h.code === "disabled") return { g: "○", word: "disabled", c: "text-muted" };
  if (h.feedOf) return { g: "↳", word: "feed of " + h.feedOf, c: "text-muted" };
  if (h.code !== "ok") return { g: "⚠", word: h.code === "none" ? "no report yet" : h.code, c: "text-error" };
  if (h.okAgeSec !== null && h.okAgeSec > 3600) return { g: "◆", word: "stale", c: "text-attention" };
  return { g: "●", word: "ok", c: "text-live" };
}
function tz(min: number): string { const a = Math.abs(min); return "UTC" + (min < 0 ? "−" : "+") + Math.floor(a / 60) + (a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""); }
const rank = (h: Host) => { const w = stateOf(h).word; return w === "ok" ? 3 : w === "stale" ? 1 : w.startsWith("feed") || w === "disabled" ? 4 : 0; };

export function FleetView() {
  const live = useLive();
  const q = useQuery({ queryKey: ["fleet"], queryFn: () => live.request<FleetStatus>("fleet.hosts"), refetchInterval: 30_000 });
  const f = q.data; const err = q.error as ApiFail | null;
  const hosts = f ? [...f.hosts].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)) : [];
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[14px] font-semibold">Fleet</h1>
        {f && <span className="text-muted">this machine: {f.localName} · host id <span className="mono">{f.hostId}</span></span>}
        <span className="ml-auto text-[12px] text-muted">from the cached reports · <code className="mono">agentglass fleet --refresh</code> pulls now</span>
      </div>
      {err ? <p role="alert" className="text-error">{err.err?.msg ?? err.message}</p> : !f ? <p className="text-muted">Loading…</p>
        : !hosts.length ? <p className="text-muted">No fleet hosts configured. Add <code className="mono">"fleet": {"{"}"hosts": [{"{"}"name": "ws", "ssh": "…"{"}"}]{"}"}</code> to ~/.agentglass/config.json.</p> : (
        <table aria-label="Hosts" className="w-full table-fixed border-collapse">
          <colgroup><col className="w-40" /><col className="w-36" /><col className="w-28" /><col className="w-24" /><col className="w-24" /><col /></colgroup>
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted"><tr><th className="py-1 pl-2 font-medium">Host</th><th className="font-medium">State</th><th className="font-medium">Last report</th><th className="num font-medium">Sessions</th><th className="num font-medium">Live</th><th className="pl-4 font-medium">Details</th></tr></thead>
          <tbody>{hosts.map((h) => { const st = stateOf(h); const notes = [h.version && "agentglass " + h.version, h.os, h.version && tz(h.tzOffsetMin), h.exact ? "exact" : h.version ? "not exact" : "", h.redact && "redacted", h.liveAgeSec !== null && (h.liveAgeSec <= 90 ? "live stream on" : "live stream stale"), Math.abs(h.skewSec) > 120 && "clock skew " + h.skewSec + " s"].filter(Boolean).join(" · ");
            return (
              <tr key={h.name} className="border-b border-border-subtle align-top">
                <td className="py-1.5 pl-2"><div className="font-medium">{h.name}</div><div className="mono truncate text-[11px] text-muted" title={h.target}>{h.kind} {h.target}</div></td>
                <td className="py-1.5"><span className={st.c} aria-hidden>{st.g}</span> <span className={cn(st.word !== "ok" && st.c)}>{st.word}</span></td>
                <td className="py-1.5 text-muted">{h.okAgeSec === null ? "never" : ago(h.okAgeSec * 1000) + " ago"}</td>
                <td className="num py-1.5">{h.sessions}{h.overlap ? <span className="text-muted" title="also on another host"> (≈{h.overlap})</span> : null}</td>
                <td className="num py-1.5">{h.live > 0 ? <span className="text-live">●{h.live}</span> : "·"}</td>
                <td className="py-1.5 pl-4 text-[12px]">{h.err && <div className={st.word === "ok" ? "text-muted" : "text-error"}>{h.err}</div>}{h.dupOf && <div className="text-error">the same machine as {h.dupOf}: not merged</div>}<div className="text-muted">{notes}</div></td>
              </tr>); })}</tbody>
        </table>)}
    </div>
  );
}
