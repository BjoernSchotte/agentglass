// a socket that answers like agentglass-web: meta (with the given teams), the sessions topic, and any method or topic
// the test adds (answers: method → ok object, or a function of the params; topics: topic → snapshot rows)
import { Live } from "../src/live/socket.ts";
export const ROW = { key: "claude:s1", id: "s1", harness: "claude", title: "fix the flaky test", cwd: "/w", live: true, pid: 1, status: "", state: "busy", costUsd: 1.2, twins: 0, attention: false, stuck: null, alerts: [], mux: null, updated: new Date().toISOString() };
// push(topic, d): a patch event to that topic's open sub
export function fakeLive(teams: { id: string; name: string }[] = [], answers: Record<string, unknown> = {}, topics: Record<string, unknown[]> = {}): Live & { push: (topic: string, d: unknown) => void } {
  let n = 0; const sids = new Map<string, string>(); let send: (o: unknown) => void = () => {};
  const live = new Live(() => {
    const w = { readyState: 0, onopen: null as (() => void) | null, onclose: null as (() => void) | null, onmessage: null as ((e: { data: unknown }) => void) | null,
      send(s: string) {
        const q = JSON.parse(s); const reply = (o: unknown) => queueMicrotask(() => w.onmessage?.({ data: JSON.stringify(o) })); send = reply;
        if (q.m === "meta") reply({ id: q.id, ok: { version: "test", contract: 1, proto: 1, caps: [], readOnly: true, redact: false, harnesses: ["claude"], teams } });
        else if (q.m === "sub") { const sid = "c" + ++n; sids.set(q.p.topic, sid); const rows = q.p.topic === "sessions" ? [ROW] : topics[q.p.topic] ?? []; reply({ id: q.id, ok: { sub: sid, resumed: false } }); reply({ sub: sid, ev: "e-" + n, k: "snapshot", d: { data: rows, at: Date.now(), gen: 1, next: null } }); }
        else if (q.m in answers) { const a = answers[q.m]; reply({ id: q.id, ok: typeof a === "function" ? (a as (p: Record<string, unknown>) => unknown)(q.p ?? {}) : a }); }
        else reply({ id: q.id, ok: {} });
      },
      close() {} };
    queueMicrotask(() => { w.readyState = 1; w.onopen?.(); });
    return w;
  }, false, async () => true);
  return Object.assign(live, { push: (topic: string, d: unknown) => { const sid = sids.get(topic); if (sid) send({ sub: sid, ev: "e-p" + ++n, k: "patch", d }); } });
}
