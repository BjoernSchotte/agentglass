// agentglass — API-equivalent token prices ($ per million tokens) by model-id prefix
// layers, later wins: built-in table < opt-in community list (./remote.ts, cached) < ~/.agentglass/prices.json
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { type Obj, obj } from "../../util/json.ts";
import { HOME, readText } from "../../util/fs.ts";
import { remoteCfg, loadCached } from "./remote.ts";

// cr/cw/cw1 < 0 = derive from input (cache read 0.1×, cache write 5m 1.25×, 1h 2×)
export interface Price { p: string; i: number; o: number; cr: number; cw: number; cw1: number }
let P: Price[] = [];
function add(p: string, i: number, o: number, cr: number, cw: number, cw1: number = -1): void {
  for (const x of P) if (x.p === p) { x.i = i; x.o = o; x.cr = cr; x.cw = cw; x.cw1 = cw1; return; }
  P.push({ p, i, o, cr, cw, cw1 });
}
add("claude-fable-5-1", 10, 50, 0.25, -1); add("claude-fable-5", 10, 50, -1, -1); add("claude-mythos-5-1", 10, 50, -1, -1);
add("claude-opus-5-5", 4, 20, 0.2, -1); add("claude-opus-5", 5, 25, -1, -1);
for (const v of ["4-8", "4-7", "4-6", "4-5"]) add("claude-opus-" + v, 5, 25, -1, -1);
add("claude-opus-4-1", 15, 75, -1, -1); add("claude-opus-4", 15, 75, -1, -1);
add("claude-sonnet-5", 2, 10, -1, -1);
for (const v of ["4-6", "4-5", "4"]) add("claude-sonnet-" + v, 3, 15, -1, -1);
add("claude-3-7-sonnet", 3, 15, -1, -1); add("claude-haiku-4-5", 1, 5, -1, -1); add("claude-3-5-haiku", 0.8, 4, -1, -1);
// Gemini, paid tier, text input (ai.google.dev/gemini-api/docs/pricing, 2026-10-01); implicit caching has no write charge.
// Suffixed keys are looked up by the Gemini adapter: ">200k" = prompts over 200k tokens, "@2027" = from 2027-01-01.
for (const v of ["3.8", "3.7", "3.6"]) { add("gemini-" + v + "-flash", 0.75, 3.75, 0.075, 0, 0); add("gemini-" + v + "-flash@2027", 1.5, 7.5, 0.15, 0, 0); }
add("gemini-3.5-flash", 1.5, 9, 0.15, 0, 0); add("gemini-3.5-flash-lite", 0.3, 2.5, 0.03, 0, 0); add("gemini-3.1-flash-lite", 0.25, 1.5, 0.025, 0, 0);
add("gemini-3.1-pro", 2, 12, 0.2, 0, 0); add("gemini-3.1-pro>200k", 4, 18, 0.4, 0, 0); add("gemini-3-flash", 0.5, 3, 0.05, 0, 0);
add("gemini-2.5-pro", 1.25, 10, 0.125, 0, 0); add("gemini-2.5-pro>200k", 2.5, 15, 0.25, 0, 0);
add("gemini-2.5-flash", 0.3, 2.5, 0.03, 0, 0); add("gemini-2.5-flash-lite", 0.1, 0.4, 0.01, 0, 0);

function num(v: unknown, d: number): number { return typeof v === "number" ? (v as number) : d; }
const BUILTIN: Price[] = P.map((x: Price) => ({ p: x.p, i: x.i, o: x.o, cr: x.cr, cw: x.cw, cw1: x.cw1 }));
// opt-in community list, as cached by the last refresh (a refresh during this run applies from the next start)
const RC = remoteCfg();
const remote = RC.source ? loadCached(RC.source) : null;
function hash(s: string): string { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return String(h); }
function two(n: number): string { return (n < 10 ? "0" : "") + n; }
function day(ms: number): string { const d = new Date(ms); return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()); }
// where prices come from, for the UI: "built-in" or "litellm 2026-09-29"
export const PRICES_FROM = remote ? remote.source + " " + day(remote.fetchedAt) : "built-in";
// user table: {"<model-prefix>": {"input": n, "output": n, "cacheRead": n, "cacheWrite": n, "cacheWrite1h": n}} — read once, ignored if missing/invalid
const user = obj((() => { try { return JSON.parse(readText(join(HOME, ".agentglass", "prices.json"), 0, 262144)); } catch (e) { return null; } })());
const memo = new Map<string, Price | null>();
// the table: built-ins < community list < user table. A user price for a model also replaces the built-in tiers of that
// key ("<model>>200k", "<model>@2027") it does not name itself: the user's rate is meant for all of its prompts.
export function applyUserPrices(u: Obj | null): void {
  P = BUILTIN.map((x: Price) => ({ p: x.p, i: x.i, o: x.o, cr: x.cr, cw: x.cw, cw1: x.cw1 }));
  if (remote) for (const [k, r] of remote.prices) add(k, r.i, r.o, r.cr, r.cw, r.cw1);
  if (u) {
    const mine = new Set<string>();
    for (const k0 of Object.keys(u)) {
      const r = obj(u[k0]); const k = k0.toLowerCase();
      if (r && typeof r["input"] === "number") { add(k, num(r["input"], 0), num(r["output"], 0), num(r["cacheRead"], -1), num(r["cacheWrite"], -1), num(r["cacheWrite1h"], -1)); mine.add(k); }
    }
    P = P.filter((x: Price) => { for (const k of mine) if (!mine.has(x.p) && x.p.length > k.length && x.p.startsWith(k) && (x.p.charAt(k.length) === ">" || x.p.charAt(k.length) === "@")) return false; return true; });
  }
  P.sort((a, b) => b.p.length - a.p.length); // longest prefix wins (opus-4-1 before opus-4)
  memo.clear();
}
applyUserPrices(user);
// a flat unit rate from prices.json ("kiroCreditUsd": 0.04 → $ per kiro credit), 0 = not configured
export function userRate(key: string): number { const v = user ? user[key] : undefined; return typeof v === "number" && (v as number) > 0 ? (v as number) : 0; }
// fingerprint of every price that differs from the built-ins: cached costs are only valid for the prices they were
// computed with. Content-hashed, so a daily refresh that changes nothing does not re-index.
function remoteSig(): string {
  if (!remote) return "";
  const ks = [...remote.prices.keys()].sort();
  let t = remote.source;
  for (const k of ks) { const r = remote.prices.get(k); if (r) t += "|" + k + ":" + r.i + "," + r.o + "," + r.cr + "," + r.cw + "," + r.cw1; }
  return remote.source + ":" + hash(t);
}
export const PRICES_SIG = (user ? JSON.stringify(user) : "") + remoteSig();

export function price(model: string): Price | null {
  const hit = memo.get(model);
  if (hit !== undefined) return hit;
  let m = model.toLowerCase();
  const sl = m.lastIndexOf("/"); if (sl >= 0) m = m.slice(sl + 1); // provider/model ids from proxies
  m = m.replace(/-\d{8}$/, "");
  let r: Price | null = null;
  for (const x of P) if (m.startsWith(x.p)) { r = x; break; }
  memo.set(model, r);
  return r;
}
// ≈USD for one usage record; w5/w1 = cache writes with 5-minute / 1-hour TTL
export function cost(p: Price, inp: number, out: number, cr: number, w5: number, w1: number): number {
  const rr = p.cr >= 0 ? p.cr : p.i * 0.1;
  const r5 = p.cw >= 0 ? p.cw : p.i * 1.25;
  const r1 = p.cw1 >= 0 ? p.cw1 : p.i * 2; // not cw: a 5-minute rate for 1-hour writes undercharges them
  return (inp * p.i + out * p.o + cr * rr + w5 * r5 + w1 * r1) / 1e6;
}
