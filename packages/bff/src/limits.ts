// limits of local-web-api §4: bodies, frames, streams, rates, per-client queues
export const BODY_MAX = 64 * 1024;
export const FRAME_MAX = 64 * 1024;
export const STREAMS_MAX = 16;
export const REQ_PER_S = 50; // per socket and per HTTP session
export const CMD_PER_S = 20;
export const QUEUE_MAX = 2 * 1024 * 1024; // a client's unsent bytes; over it the socket closes 1013 / the SSE stream ends
export const TOKEN_MS = 120_000;
export const HB_MS = 25_000;

// a one-second window counter per key
export class Rate {
  private w = new Map<string, { s: number; n: number }>();
  constructor(private max: number) {}
  hit(key: string, now = Date.now()): boolean {
    const s = Math.floor(now / 1000); const c = this.w.get(key);
    if (!c || c.s !== s) { this.w.set(key, { s, n: 1 }); if (this.w.size > 4096) this.w.clear(); return true; }
    c.n++; return c.n <= this.max;
  }
}
