// an in-process fake of `agentglass serve --stdio`: hello, meta, sessions.list, sub/unsub with snapshot and patch
// events; counts upstream subs; patch() pushes a change to every open sub
import type { Child, Spawn, Obj } from "../src/stdio.ts";
export interface Fake { spawn: Spawn; subs: number; patch: (title: string) => void; crash: () => void; started: number }
export function fake(): Fake {
  const f: Fake = { spawn: () => null as unknown as Child, subs: 0, patch: () => {}, crash: () => {}, started: 0 };
  f.spawn = () => {
    f.started++;
    let on: (l: string) => void = () => {}; let die: (n: number) => void = () => {};
    const open = new Map<string, number>(); let seq = 0; const epoch = "e" + f.started;
    const row = (title: string): Obj => ({ key: "claude:a1", id: "a1", harness: "claude", title, cwd: "/w", live: true, pid: 1, status: "", state: "busy", costUsd: 1, twins: 0, attention: false, stuck: null, alerts: [], mux: null, updated: new Date().toISOString() });
    const emit = (sub: string, k: string, d?: Obj) => on(JSON.stringify({ sub, ev: epoch + "-" + ++seq, k, ...(d ? { d } : {}) }));
    f.patch = (title: string) => { for (const s of open.keys()) emit(s, "patch", { upsert: [row(title)], remove: [] }); };
    f.crash = () => die(1);
    let n = 0;
    return {
      write: (l: string) => {
        const q = JSON.parse(l) as { id: string; m: string; p: Obj };
        const ok = (o: Obj) => queueMicrotask(() => on(JSON.stringify({ id: q.id, ok: o })));
        if (q.m === "hello") ok({ proto: 1, contract: 1, version: "fake", readOnly: true, redact: false, caps: ["sessions"] });
        else if (q.m === "meta") ok({ version: "fake", contract: 1, proto: 1, caps: [], readOnly: true, redact: false, harnesses: ["claude"], teams: [], fleetHosts: 0 });
        else if (q.m === "sessions.list") ok({ data: [row("hello")], at: Date.now(), gen: 1, next: null });
        else if (q.m === "sessions.get") ok({ ...row("big"), files: Array.from({ length: 3000 }, (_, i) => ({ path: "/w/src/file-" + i + ".ts", add: i, del: 0 })) }); // ~150 KB
        else if (q.m === "cost.get" || q.m === "alerts.list" || q.m === "events.list" || q.m === "wait.get" || q.m === "fleet.hosts" || q.m === "repos.list" || q.m === "graph.get") ok({ params: q.p ?? null }); // echoes what reached the child
        else if (q.m === "sub") { const s = "s" + ++n; open.set(s, 1); f.subs++; ok({ sub: s, resumed: false }); queueMicrotask(() => emit(s, "snapshot", { data: [row("hello")], at: Date.now(), gen: 1, next: null })); }
        else if (q.m === "unsub") { open.delete(String(q.p.sub)); ok({}); }
        else queueMicrotask(() => on(JSON.stringify({ id: q.id, err: { code: "unknown_method", msg: "no " + q.m } })));
      },
      lines: (cb) => { on = cb; },
      exited: new Promise<number>((r) => { die = r; }),
      kill: () => die(0),
    };
  };
  return f;
}
