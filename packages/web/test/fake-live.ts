// a socket that answers like agentglass-web: meta (with the given teams), the sessions topic, and any method or topic
// the test adds (answers: method → ok object; topics: topic → snapshot rows)
import { Live } from "../src/live/socket.ts";
export const ROW = { key: "claude:s1", id: "s1", harness: "claude", title: "fix the flaky test", cwd: "/w", live: true, pid: 1, status: "", state: "busy", costUsd: 1.2, twins: 0, attention: false, stuck: null, alerts: [], mux: null, updated: new Date().toISOString() };
export function fakeLive(teams: { id: string; name: string }[] = [], answers: Record<string, unknown> = {}, topics: Record<string, unknown[]> = {}): Live {
  let n = 0;
  return new Live(() => {
    const w = { readyState: 0, onopen: null as (() => void) | null, onclose: null as (() => void) | null, onmessage: null as ((e: { data: unknown }) => void) | null,
      send(s: string) {
        const q = JSON.parse(s); const reply = (o: unknown) => queueMicrotask(() => w.onmessage?.({ data: JSON.stringify(o) }));
        if (q.m === "meta") reply({ id: q.id, ok: { version: "test", contract: 1, proto: 1, caps: [], readOnly: true, redact: false, harnesses: ["claude"], teams } });
        else if (q.m === "sub") { const sid = "c" + ++n; const rows = q.p.topic === "sessions" ? [ROW] : topics[q.p.topic] ?? []; reply({ id: q.id, ok: { sub: sid, resumed: false } }); reply({ sub: sid, ev: "e-" + n, k: "snapshot", d: { data: rows, at: Date.now(), gen: 1, next: null } }); }
        else if (q.m in answers) reply({ id: q.id, ok: answers[q.m] });
        else reply({ id: q.id, ok: {} });
      },
      close() {} };
    queueMicrotask(() => { w.readyState = 1; w.onopen?.(); });
    return w;
  }, false, async () => true);
}
