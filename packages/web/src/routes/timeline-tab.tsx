// the session drawer's Timeline tab (W9.2): graph.get (columns, no content) → the viz Timeline. Its own chunk: the
// drawer is in the shell, the timeline loads when the tab is first opened.
import { useQuery } from "@tanstack/react-query";
import type { CallGraph } from "@agentglass/api-contract";
import { Timeline, columns, fmtDur } from "@agentglass/viz";
import { useLive } from "../app.tsx";
import type { ApiFail } from "../live/socket.ts";

export default function TimelineTab({ refId }: { refId: string }) {
  const live = useLive();
  const q = useQuery({ queryKey: ["graph", refId], retry: false, staleTime: 30_000, queryFn: () => live.request<CallGraph>("graph.get", { ref: refId }) });
  const g = q.data; const err = q.error as ApiFail | null;
  if (err) return <p role="alert" className="text-error">{err.err?.msg ?? err.message}</p>;
  if (!g) return <p className="flex items-center gap-2 text-muted" aria-live="polite"><span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-accent" aria-hidden />Reading the session's calls…</p>;
  if (!g.n) return <p className="text-muted">No turns or calls in this session{g.noTiming ? " with timing" : ""}.</p>;
  const spans = columns(g.spans);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted">{g.n} spans · {g.rows} lanes · {fmtDur(g.t1 - g.t0)}{g.sources.length > 1 ? " · " + (g.sources.length - 1) + " subagents" : ""}{g.truncated ? " · " + g.truncated + " long logs from their last 8 MB" : ""}{g.noTiming ? " · some times estimated (no timing in the log)" : ""}</p>
      <Timeline spans={spans} names={g.names} cats={g.cats} kinds={g.kinds} label={"Timeline of " + refId} />
    </div>
  );
}
