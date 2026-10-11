// the socket and the row store: snapshot then patch; after a reconnect the sub is sent again with from = the last id
import { Live } from "../src/live/socket.ts";
import { Rows } from "../src/live/store.ts";
class FakeWs { static all: FakeWs[] = []; readyState = 0; sent: Record<string, unknown>[] = []; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor() { FakeWs.all.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  push(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
}
const row = (key: string, title: string, updated: string) => ({ key, id: key, harness: "claude", title, cwd: "/w", live: true, pid: 1, status: "", state: "busy", costUsd: 1, twins: 0, attention: false, stuck: null, alerts: [], mux: null, updated });
const tick = () => new Promise((r) => setTimeout(r, 0));
test("snapshot, patch, resume with from after a reconnect", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  FakeWs.all = []; const live = new Live(() => new FakeWs() as never, true, async () => true); live.connect();
  const rows = new Rows(); live.subscribe({ topic: "sessions" }, (e) => rows.apply(e));
  const w = FakeWs.all[0]!; w.open();
  const sub = w.sent.find((m) => m.m === "sub")!; expect(sub.p).toEqual({ topic: "sessions" });
  w.push({ id: sub.id, ok: { sub: "c1", resumed: false } }); await Promise.resolve(); await Promise.resolve();
  w.push({ sub: "c1", ev: "e-1", k: "snapshot", d: { data: [row("a", "first", "2026-01-01T00:00:00Z")], at: 1, gen: 1, next: null } });
  w.push({ sub: "c1", ev: "e-2", k: "patch", d: { upsert: [row("b", "second", "2026-01-02T00:00:00Z")], remove: [] } });
  expect(rows.order).toEqual(["b", "a"]);
  w.close(); vi.advanceTimersByTime(600); vi.useRealTimers(); await tick(); await tick();
  const w2 = FakeWs.all[1]!; w2.open();
  expect(w2.sent.find((m) => m.m === "sub")!.p).toEqual({ topic: "sessions", from: "e-2" });
  live.close(); await tick();
});
test("frozen: new rows are counted, not shown, until unfrozen", () => {
  const rows = new Rows();
  rows.apply({ sub: "c", ev: "e-1", k: "snapshot", d: { data: [row("a", "x", "2026-01-01T00:00:00Z")], at: 1, gen: 1, next: null } });
  rows.freeze(true);
  rows.apply({ sub: "c", ev: "e-2", k: "patch", d: { upsert: [row("b", "y", "2026-01-02T00:00:00Z")], remove: [] } });
  expect(rows.visible()).toEqual(["a"]); expect(rows.fresh).toBe(1);
  rows.freeze(false); expect(rows.visible()).toEqual(["b", "a"]); expect(rows.fresh).toBe(0);
});
test("a refused sub (bad filter) reports its error", async () => {
  FakeWs.all = []; const live = new Live(() => new FakeWs() as never, false); live.connect(); const w = FakeWs.all[0]!; w.open();
  let msg = ""; live.subscribe({ topic: "sessions", filter: "cost >" }, () => {}, (e) => { msg = e.err.code; });
  const sub = w.sent.find((m) => m.m === "sub")!; w.push({ id: sub.id, err: { code: "bad_filter", msg: "x" } }); await tick();
  expect(msg).toBe("bad_filter");
});
test("a session the server no longer knows: no endless retries, status ended", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  FakeWs.all = []; const live = new Live(() => new FakeWs() as never, true, async () => false); live.connect(); FakeWs.all[0]!.open();
  FakeWs.all[0]!.close(); vi.advanceTimersByTime(600); vi.useRealTimers(); await tick(); await tick();
  expect(live.status).toBe("ended"); expect(FakeWs.all.length).toBe(1);
});
