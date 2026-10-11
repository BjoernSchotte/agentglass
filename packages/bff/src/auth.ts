// per-run auth (local-web-api §4): a one-time token (fragment → POST /api/v1/session, single use, 2 min) → an
// HttpOnly SameSite=Strict cookie and a CSRF token; more tokens arrive as hashes in run/web.tokens (another
// `agentglass web`); Host and Origin checks against DNS rebinding and cross-site requests. Constant-time compares.
import { readFileSync } from "node:fs";
import { TOKEN_MS } from "./limits.ts";

export function rand(bytes = 32): string { const b = new Uint8Array(bytes); crypto.getRandomValues(b); return Buffer.from(b).toString("base64url"); }
export function sha256(s: string): string { return new Bun.CryptoHasher("sha256").update(s).digest("hex"); }
export function same(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!; return d === 0;
}
export interface Sess { id: string; csrf: string; at: number }
export class Auth {
  private tokens = new Map<string, number>(); // hash → expiry
  private used = new Set<string>();
  readonly sessions = new Map<string, Sess>();
  constructor(private tokensFile = "", private now: () => number = Date.now) {}
  mint(): string { const t = rand(); this.tokens.set(sha256(t), this.now() + TOKEN_MS); return t; }
  // a token → a session (once); "" when unknown, used or expired
  exchange(token: string): Sess | null {
    if (!token || token.length > 256) return null;
    const h = sha256(token); if (this.used.has(h)) return null;
    let exp = this.tokens.get(h) ?? 0;
    if (!exp && this.tokensFile) exp = this.fromFile(h);
    if (!exp || this.now() > exp) return null;
    this.used.add(h); this.tokens.delete(h);
    const s: Sess = { id: rand(), csrf: rand(), at: this.now() }; this.sessions.set(s.id, s); return s;
  }
  // run/web.tokens: lines "<sha256 hex> <expiry ms>" written by `agentglass web` (0600, hashes only)
  private fromFile(h: string): number {
    let text = ""; try { text = readFileSync(this.tokensFile, "utf8"); } catch { return 0; }
    for (const l of text.split("\n")) { const [x, e] = l.trim().split(/\s+/); if (x && same(x, h)) return Number(e) || 0; }
    return 0;
  }
  session(cookie: string | null): Sess | null {
    const m = /(?:^|;\s*)agw=([A-Za-z0-9_-]+)/.exec(cookie ?? ""); if (!m) return null;
    for (const [id, s] of this.sessions) if (same(id, m[1]!)) return s;
    return null;
  }
}
// the names this server answers to: loopback always; bound to all interfaces (--host 0.0.0.0 / ::) also this machine's
// addresses and hostname — any other Host is DNS rebinding (421), any other Origin a foreign page (403)
export function namesOf(bind: string, ifaces: Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>, hostname: string): string[] {
  const o = ["127.0.0.1", "localhost", "[::1]"];
  if (bind !== "0.0.0.0" && bind !== "::") return o;
  for (const list of Object.values(ifaces)) for (const i of list ?? []) {
    if (i.internal) continue;
    const v6 = i.family === "IPv6" || i.family === 6; if (v6 && bind !== "::") continue;
    o.push(v6 ? "[" + i.address.split("%")[0] + "]" : i.address);
  }
  if (hostname) { o.push(hostname.toLowerCase()); if (!hostname.includes(".")) o.push(hostname.toLowerCase() + ".local"); }
  return o;
}
export function hostOk(host: string | null, port: number, names: string[] = namesOf("127.0.0.1", {}, "")): boolean {
  if (!host) return false; const h = host.toLowerCase();
  return names.some((n) => h === n + ":" + port);
}
export function originOk(origin: string | null, port: number, names: string[] = namesOf("127.0.0.1", {}, "")): boolean {
  if (!origin) return false; const h = origin.toLowerCase();
  return names.some((n) => h === "http://" + n + ":" + port);
}
