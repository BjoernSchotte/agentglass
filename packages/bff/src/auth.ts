// per-run auth (local-web-api §4): a one-time token (fragment → POST /api/v1/session, single use, 10 min) → an
// HttpOnly SameSite=Strict cookie and a CSRF token; more tokens arrive as hashes in run/web.tokens (another
// `agentglass web`); Host and Origin checks against DNS rebinding and cross-site requests. Constant-time compares.
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { TOKEN_MS } from "./limits.ts";

export function rand(bytes = 32): string { const b = new Uint8Array(bytes); crypto.getRandomValues(b); return Buffer.from(b).toString("base64url"); }
export function sha256(s: string): string { return new Bun.CryptoHasher("sha256").update(s).digest("hex"); }
export function same(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i]! ^ y[i]!; return d === 0;
}
export interface Sess { id: string; csrf: string; at: number }
export const SESSION_MS = 30 * 86400000; // a browser stays signed in 30 days after its last visit (the cookie's Max-Age too)
// tokens: run/web.tokens (lines "<sha256> <expiry>", from `agentglass web`; a used one is removed, so it stays used
// across restarts); sessions: run/web.sessions (lines "<sha256 of the cookie> <csrf> <last seen>", 0600), so a restart
// of agentglass-web does not sign the browser out. Only hashes of tokens and cookies are written.
export class Auth {
  private tokens = new Map<string, number>(); // hash → expiry
  private used = new Set<string>();
  readonly sessions = new Map<string, Sess>(); // by the cookie's sha256
  constructor(private tokensFile = "", private now: () => number = Date.now, private sessionsFile = "") { this.load(); }
  mint(): string { const t = rand(); this.tokens.set(sha256(t), this.now() + TOKEN_MS); return t; }
  // a token → a session (once); null when unknown, used or expired
  exchange(token: string): Sess | null {
    if (!token || token.length > 256) return null;
    const h = sha256(token); if (this.used.has(h)) return null;
    let exp = this.tokens.get(h) ?? 0;
    if (!exp && this.tokensFile) exp = this.fromFile(h, true);
    if (!exp || this.now() > exp) return null;
    this.used.add(h); this.tokens.delete(h);
    const s: Sess = { id: rand(), csrf: rand(), at: this.now() }; this.sessions.set(sha256(s.id), s); this.save(); return s;
  }
  // run/web.tokens: the line of h (its expiry), removed when take (single use, also for the next process)
  private fromFile(h: string, take: boolean): number {
    let text = ""; try { text = readFileSync(this.tokensFile, "utf8"); } catch { return 0; }
    let exp = 0; const keep: string[] = [];
    for (const l of text.split("\n")) { const [x, e] = l.trim().split(/\s+/); if (!x) continue; if (same(x, h)) exp = Number(e) || 0; else keep.push(l.trim()); }
    if (exp && take) try { writeFileSync(this.tokensFile, keep.length ? keep.join("\n") + "\n" : "", { mode: 0o600 }); } catch { /* read-only run dir: in memory only */ }
    return exp;
  }
  private load(): void {
    if (!this.sessionsFile) return;
    let text = ""; try { text = readFileSync(this.sessionsFile, "utf8"); } catch { return; }
    for (const l of text.split("\n")) { const [h, csrf, at] = l.trim().split(/\s+/); const t = Number(at); if (h && csrf && t && this.now() - t < SESSION_MS) this.sessions.set(h, { id: "", csrf, at: t }); }
  }
  private save(): void {
    if (!this.sessionsFile) return;
    const ls: string[] = []; for (const [h, s] of this.sessions) if (this.now() - s.at < SESSION_MS) ls.push(h + " " + s.csrf + " " + s.at);
    try { writeFileSync(this.sessionsFile, ls.join("\n") + "\n", { mode: 0o600 }); chmodSync(this.sessionsFile, 0o600); } catch { /* in memory only */ }
  }
  session(cookie: string | null): Sess | null {
    const m = /(?:^|;\s*)agw=([A-Za-z0-9_-]+)/.exec(cookie ?? ""); if (!m) return null;
    const s = this.sessions.get(sha256(m[1]!)); if (!s || this.now() - s.at >= SESSION_MS) return null;
    if (this.now() - s.at > 3600000) { s.at = this.now(); this.save(); } // sliding: last seen, written at most hourly
    return s;
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
