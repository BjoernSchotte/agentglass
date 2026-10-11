// the one serve child (agentglass serve --stdio): request multiplexing over its own id space, one upstream
// subscription per topic + params shared by every client, each topic's state and a ring of its last events so a client
// resumes (or gets a snapshot) without a new upstream sub; restart policy: at once, then at most once a minute,
// 3 strikes in a row → down (the API answers 503).
export type Obj = Record<string, unknown>;
export interface Ev { sub: string; ev: string; k: "snapshot" | "patch" | "hb"; d?: Obj }
export interface Reply { ok?: Obj; err?: { code: string; msg: string; hint?: string } }
export type Listener = (e: Ev) => void;
const RING_MAX = 1000; const RING_MS = 600_000;

interface Topic { key: string; params: Obj; up: string; indexing: unknown; rows: Map<string, Obj>; order: string[]; gen: number; ring: { e: Ev; at: number }[]; last: string; ready: boolean; ls: Set<Listener>; waiting: Listener[] }
export interface Child { write(line: string): void; lines(on: (l: string) => void): void; exited: Promise<number>; kill(): void }
export type Spawn = () => Child;
export function spawnServe(bin: string, args: string[]): Spawn {
  return () => {
    const p = Bun.spawn([bin, "serve", "--stdio", ...args], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    return {
      write: (l: string) => { p.stdin.write(l + "\n"); p.stdin.flush(); },
      lines: (on) => { void (async () => { const dec = new TextDecoder(); let buf = ""; for await (const c of p.stdout) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) on(l); } } })(); },
      exited: p.exited, kill: () => p.kill(),
    };
  };
}
function seqOf(ev: string): { epoch: string; seq: number } { const i = ev.lastIndexOf("-"); return { epoch: ev.slice(0, i), seq: Number(ev.slice(i + 1)) }; }
export function topicKey(p: Obj): string { const o: Obj = {}; for (const k of Object.keys(p).sort()) if (k !== "from") o[k] = p[k]; return JSON.stringify(o); }

export class Upstream {
  private child: Child | null = null; private next = 0;
  private pending = new Map<string, (r: Reply) => void>();
  private topics = new Map<string, Topic>(); private bySub = new Map<string, Topic>(); private early = new Map<string, Ev[]>();
  hello: Obj | null = null; down = false; strikes = 0; private lastStart = 0; upSubs = 0;
  constructor(private spawn: Spawn, private now: () => number = Date.now) {}
  async start(): Promise<void> {
    this.lastStart = this.now(); const c = this.spawn(); this.child = c;
    c.lines((l) => this.line(l));
    void c.exited.then(() => { if (this.child === c) this.died(); });
    const h = await this.request("hello", { client: "agentglass-web", want: 1 });
    if (!h.ok) throw new Error("serve: " + (h.err?.msg ?? "no hello"));
    this.hello = h.ok; this.strikes = 0;
    for (const t of this.topics.values()) void this.resub(t); // after a restart: the client ids stay, upstream ids change
  }
  private died(): void {
    this.child = null; this.hello = null;
    for (const [, f] of this.pending) f({ err: { code: "internal", msg: "agentglass serve stopped; restarting" } }); this.pending.clear();
    this.bySub.clear(); this.early.clear();
    if (++this.strikes > 3) { this.down = true; return; }
    const wait = this.strikes === 1 ? 0 : Math.max(0, 60_000 - (this.now() - this.lastStart));
    setTimeout(() => { void this.start().catch(() => this.died()); }, wait);
  }
  stop(): void { const c = this.child; this.child = null; c?.kill(); }
  request(m: string, p: Obj = {}): Promise<Reply> {
    const c = this.child; if (!c) return Promise.resolve({ err: { code: "internal", msg: this.down ? "agentglass serve is down" : "agentglass serve is restarting" } });
    const id = "b" + ++this.next;
    return new Promise((res) => { this.pending.set(id, res); c.write(JSON.stringify({ id, m, p })); });
  }
  private line(l: string): void {
    let o: Obj; try { o = JSON.parse(l) as Obj; } catch { return; }
    if (typeof o.sub === "string") {
      const t = this.bySub.get(o.sub); if (t) { this.event(t, o as unknown as Ev); return; }
      // the sub's answer and its snapshot arrive in one read: held until the answer's continuation names the topic
      const q = this.early.get(o.sub) ?? []; if (q.length < 64) q.push(o as unknown as Ev); this.early.set(o.sub, q); return;
    }
    const f = this.pending.get(String(o.id)); if (f) { this.pending.delete(String(o.id)); f(o.err ? { err: o.err as Reply["err"] } : { ok: (o.ok ?? {}) as Obj }); }
  }
  private event(t: Topic, e: Ev): void {
    if (e.k === "snapshot") { const d = e.d ?? {}; t.rows.clear(); t.order = []; for (const r of (d.data as Obj[]) ?? []) { const k = String(r.key); t.rows.set(k, r); t.order.push(k); } t.gen = Number(d.gen) || 0; t.ring = []; }
    else if (e.k === "patch") {
      const d = e.d ?? {}; const rm = new Set((d.remove as string[]) ?? []);
      for (const r of (d.upsert as Obj[]) ?? []) { const k = String(r.key); if (!t.rows.has(k)) t.order.push(k); t.rows.set(k, r); }
      if (rm.size) { for (const k of rm) t.rows.delete(k); t.order = t.order.filter((k) => !rm.has(k)); }
      t.order.sort((a, b) => String(t.rows.get(b)?.updated ?? "").localeCompare(String(t.rows.get(a)?.updated ?? "")));
    }
    if (e.k !== "hb") t.indexing = e.d?.indexing; // a cold start's progress, for snapshots of later clients
    t.last = e.ev;
    if (e.k !== "hb") { const now = this.now(); t.ring.push({ e, at: now }); while (t.ring.length > RING_MAX || (t.ring.length && now - t.ring[0]!.at > RING_MS)) t.ring.shift(); }
    if (!t.ready) { t.ready = true; for (const f of t.waiting) this.replay(t, "", f); t.waiting = []; return; }
    for (const f of t.ls) f(e);
  }
  // a client's sub: shared topic; from inside the ring → the missed events, else the topic's state as a snapshot
  async subscribe(params: Obj, from: string, f: Listener): Promise<Reply & { resumed?: boolean }> {
    const key = topicKey(params); let t = this.topics.get(key);
    if (!t) {
      t = { key, params, up: "", indexing: undefined, rows: new Map(), order: [], gen: 0, ring: [], last: "", ready: false, ls: new Set(), waiting: [] };
      this.topics.set(key, t);
      const r = await this.resub(t); if (r.err) { this.topics.delete(key); return r; }
    }
    t.ls.add(f);
    if (!t.ready) { t.waiting.push(f); return { ok: {}, resumed: false }; }
    return { ok: {}, resumed: this.replay(t, from, f) };
  }
  private async resub(t: Topic): Promise<Reply> {
    const r = await this.request("sub", { ...t.params, ...(t.last ? { from: t.last } : {}) });
    if (r.ok) { t.up = String(r.ok.sub); this.bySub.set(t.up, t); this.upSubs++; const q = this.early.get(t.up); this.early.delete(t.up); for (const e of q ?? []) this.event(t, e); }
    return r;
  }
  private replay(t: Topic, from: string, f: Listener): boolean {
    if (from && t.ring.length) {
      const a = seqOf(from); const first = seqOf(t.ring[0]!.e.ev);
      if (a.epoch === first.epoch && a.seq >= first.seq - 1) { for (const x of t.ring) if (seqOf(x.e.ev).seq > a.seq) f(x.e); return true; }
    }
    const data: Obj[] = []; for (const k of t.order) { const r = t.rows.get(k); if (r) data.push(r); }
    f({ sub: "", ev: t.last, k: "snapshot", d: { data, at: this.now(), gen: t.gen, next: null, ...(t.indexing ? { indexing: t.indexing } : {}) } });
    return false;
  }
  unsubscribe(params: Obj, f: Listener): void {
    const t = this.topics.get(topicKey(params)); if (!t) return;
    t.ls.delete(f); t.waiting = t.waiting.filter((x) => x !== f);
    if (t.ls.size) return;
    this.topics.delete(t.key); this.bySub.delete(t.up); if (t.up) void this.request("unsub", { sub: t.up });
  }
  get topicCount(): number { return this.topics.size; }
}
