// one WebSocket per tab (local-web-api §5): requests {id, m, p} → answers by id, subscriptions with their events;
// on a reconnect every subscription is sent again with `from` = its last event id (the server replays or snapshots)
import type { ApiError, ApiEvent } from "@agentglass/api-contract";
export type Params = Record<string, unknown>;
export type OnEvent = (e: ApiEvent) => void;
export type Status = "connecting" | "open" | "closed" | "ended";
interface WsLike { readyState: number; send(s: string): void; close(): void; onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((e: { data: unknown }) => void) | null }
interface SubRec { params: Params; on: OnEvent; last: string; sid: string; err?: (e: ApiFail) => void }
export class ApiFail extends Error { constructor(public err: ApiError) { super(err.msg); } }

export class Live {
  private ws: WsLike | null = null; private n = 0; private wait = 500;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: ApiFail) => void; m: string; p: Params }>();
  private subs = new Map<number, SubRec>(); private bySid = new Map<string, SubRec>(); private early = new Map<string, ApiEvent[]>();
  status: Status = "connecting"; lastEventAt = 0;
  private ls = new Set<() => void>();
  // alive: is this tab's session still valid? (after agentglass web restarted it is not: no endless 401 retries)
  constructor(private make: () => WsLike = () => new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/v1/ws") as unknown as WsLike, private retry = true,
    private alive: () => Promise<boolean> = async () => { try { return (await fetch("/api/v1/session")).status !== 401; } catch { return true; } }) {}
  onStatus(f: () => void): () => void { this.ls.add(f); return () => this.ls.delete(f); }
  private set(s: Status): void { this.status = s; for (const f of this.ls) f(); }
  connect(): void {
    const w = this.make(); this.ws = w; this.set("connecting");
    w.onopen = () => { this.wait = 500; this.set("open"); for (const [id, s] of this.subs) this.sendSub(id, s); for (const [id, q] of this.pending) w.send(JSON.stringify({ id, m: q.m, p: q.p })); };
    w.onclose = () => {
      this.ws = null; this.bySid.clear(); this.early.clear(); this.set("closed");
      if (!this.retry) return;
      const wait = this.wait; this.wait = Math.min(this.wait * 2, 10_000);
      setTimeout(() => { void this.alive().then((ok) => { if (!this.retry) return; if (ok) this.connect(); else { this.retry = false; this.set("ended"); } }); }, wait);
    };
    w.onmessage = (e) => this.message(String(e.data));
  }
  close(): void { this.retry = false; this.ws?.close(); }
  private message(text: string): void {
    let o: Record<string, unknown>; try { o = JSON.parse(text); } catch { return; }
    if (typeof o.sub === "string" && typeof o.k === "string") {
      const s = this.bySid.get(o.sub);
      if (!s) { const q = this.early.get(o.sub) ?? []; if (q.length < 64) q.push(o as unknown as ApiEvent); this.early.set(o.sub, q); return; } // before its sub's answer was handled
      if (typeof o.ev === "string" && o.ev) s.last = o.ev;
      this.lastEventAt = Date.now(); s.on(o as unknown as ApiEvent); return;
    }
    const q = this.pending.get(Number(o.id)); if (!q) return;
    this.pending.delete(Number(o.id));
    if (o.err) q.rej(new ApiFail(o.err as ApiError)); else q.res(o.ok);
  }
  request<T = unknown>(m: string, p: Params = {}): Promise<T> {
    const id = ++this.n;
    return new Promise<T>((res, rej) => { this.pending.set(id, { res: res as (v: unknown) => void, rej, m, p }); if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ id, m, p })); });
  }
  private sendSub(id: number, s: SubRec): void {
    const p: Params = { ...s.params, ...(s.last ? { from: s.last } : {}) };
    void this.request<{ sub: string }>("sub", p).then((r) => { if (!this.subs.has(id)) { void this.request("unsub", { sub: r.sub }); return; } s.sid = r.sub; this.bySid.set(r.sub, s); const q = this.early.get(r.sub) ?? []; this.early.delete(r.sub); for (const e of q) { if (e.ev) s.last = e.ev; s.on(e); } }).catch((e: ApiFail) => { this.subs.delete(id); s.err?.(e); });
  }
  // a subscription; err: the server refused it (a bad filter) — it is dropped, not retried
  subscribe(params: Params, on: OnEvent, err?: (e: ApiFail) => void): () => void {
    const id = ++this.n; const s: SubRec = { params, on, last: "", sid: "", err }; this.subs.set(id, s);
    if (this.ws && this.ws.readyState === 1) this.sendSub(id, s);
    return () => { this.subs.delete(id); if (s.sid) { this.bySid.delete(s.sid); if (this.ws?.readyState === 1) void this.request("unsub", { sub: s.sid }).catch(() => {}); } };
  }
}
