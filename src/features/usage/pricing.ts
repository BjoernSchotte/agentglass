// agentglass — API-equivalent token prices ($ per million tokens) by model-id prefix
// layers, first hit wins: prices.json price > prices.json alias > gateway config (per provider) > community list > built-in
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { type Obj, obj, str } from "../../util/json.ts";
import { HOME, readWhole } from "../../util/fs.ts";
import { type Remote, remoteCfg, loadCached } from "./remote.ts";

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
// Tier rows: the Gemini adapter books "<id>>200k" for prompts over 200k tokens and "<id>@2027" from 2027-01-01; resolve() picks them.
for (const v of ["3.8", "3.7", "3.6"]) { add("gemini-" + v + "-flash", 0.75, 3.75, 0.075, 0, 0); add("gemini-" + v + "-flash@2027", 1.5, 7.5, 0.15, 0, 0); }
add("gemini-3.5-flash", 1.5, 9, 0.15, 0, 0); add("gemini-3.5-flash-lite", 0.3, 2.5, 0.03, 0, 0); add("gemini-3.1-flash-lite", 0.25, 1.5, 0.025, 0, 0);
add("gemini-3.1-pro", 2, 12, 0.2, 0, 0); add("gemini-3.1-pro>200k", 4, 18, 0.4, 0, 0); add("gemini-3-flash", 0.5, 3, 0.05, 0, 0);
add("gemini-2.5-pro", 1.25, 10, 0.125, 0, 0); add("gemini-2.5-pro>200k", 2.5, 15, 0.25, 0, 0);
add("gemini-2.5-flash", 0.3, 2.5, 0.03, 0, 0); add("gemini-2.5-flash-lite", 0.1, 0.4, 0.01, 0, 0);

function num(v: unknown, d: number): number { return typeof v === "number" ? (v as number) : d; }
const BUILTIN: Price[] = P.map((x: Price) => ({ p: x.p, i: x.i, o: x.o, cr: x.cr, cw: x.cw, cw1: x.cw1 }));
function hash(s: string): string { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return String(h); }
function two(n: number): string { return (n < 10 ? "0" : "") + n; }
function day(ms: number): string { const d = new Date(ms); return d.getFullYear() + "-" + two(d.getMonth() + 1) + "-" + two(d.getDate()); }
function byLen(a: Price, b: Price): number { return b.p.length - a.p.length; } // longest prefix first (opus-4-1 before opus-4)
function cp(x: Price): Price { return { p: x.p, i: x.i, o: x.o, cr: x.cr, cw: x.cw, cw1: x.cw1 }; }

// ── layers (resolve(): first hit wins) ──
// user prices (prices.json entries with "input"), user aliases ({"alias": "<model>"}: priced like the target, one hop,
// always an estimate), gateway rows per provider key (pi models.json, OpenCode config: ./gwprices.ts; exact ids),
// then the base table: built-ins overlaid by the opt-in community list, longest key first across both as before (a
// community row replaces the built-in row of the same key; a longer built-in key still beats a shorter community one)
export type PSrc = "user" | "alias" | "gateway" | "community" | "built-in";
// key = the matched row (with its tier tag); via = alias target | gateway provider | community source
export interface Resolved { p: Price; src: PSrc; key: string; via: string }
interface Alias { p: string; target: string }
let userP: Price[] = []; let userA: Alias[] = []; let userSig = ""; let kiroUser = 0;
let gw = new Map<string, Price[]>(); let gwSig = "";
let base: Price[] = []; let comm = new Set<string>(); let remote: Remote | null = null;
const memo = new Map<string, Resolved | null>();
export const PGEN = { n: 0 }; // bumped on every layer change: memos (here and in callers) are stale
function changed(): void { memo.clear(); PGEN.n++; }

// prices.json: AGENTGLASS_PRICES (tests, scratch runs) or ~/.agentglass/prices.json
export const PRICES_FILE = process.env.AGENTGLASS_PRICES || join(HOME, ".agentglass", "prices.json");
// the parsed file (null: missing, blank or unusable); bad = why it is unusable ("" = fine, missing or blank): a file that
// exists but cannot be read (a directory, no permission, over 1 MiB) is reported like invalid JSON, never taken as empty
export function readUserFile(path: string): { o: Obj | null; bad: string } {
  const r = readWhole(path, 1048576);
  if (r.err) return { o: null, bad: "cannot be read (" + r.err + ")" };
  if (!r.text.trim()) return { o: null, bad: "" };
  try { const o = obj(JSON.parse(r.text)); return o ? { o, bad: "" } : { o: null, bad: "not a JSON object" }; } catch (e) { return { o: null, bad: "not valid JSON (" + String(e) + ")" }; }
}
// the user layer from prices.json's object (null = none); returns one warning per entry it skipped
// {"<model-prefix>": {"input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"} | {"alias": "<model>"}, "kiroCreditUsd": n}
export function loadUser(u: Obj | null): string[] {
  const warn: string[] = []; const ps: Price[] = []; const as: Alias[] = []; kiroUser = 0;
  if (u) for (const k0 of Object.keys(u)) {
    const v = u[k0]; const k = k0.toLowerCase();
    if (k0 === "kiroCreditUsd") { if (typeof v === "number" && (v as number) > 0) kiroUser = v as number; continue; }
    const r = obj(v);
    const fin = (x: unknown): boolean => typeof x === "number" && isFinite(x as number) && (x as number) >= 0;
    if (r && fin(r["input"])) {
      if (typeof r["alias"] === "string") warn.push(k0 + ": has input and alias — using the price");
      ps.push({ p: k, i: num(r["input"], 0), o: fin(r["output"]) ? num(r["output"], 0) : 0, cr: fin(r["cacheRead"]) ? num(r["cacheRead"], -1) : -1,
        cw: fin(r["cacheWrite"]) ? num(r["cacheWrite"], -1) : -1, cw1: fin(r["cacheWrite1h"]) ? num(r["cacheWrite1h"], -1) : -1 });
    } else if (r && str(r["alias"])) as.push({ p: k, target: str(r["alias"]) });
    else warn.push(k0 + ": needs input+output or alias");
  }
  ps.sort(byLen); as.sort((a, b) => b.p.length - a.p.length);
  userP = ps; userA = as; userSig = u ? JSON.stringify(u) : "";
  changed();
  return warn;
}
// gateway rows per provider key (./gwprices.ts builds them)
export function setGateway(g: Map<string, Price[]>): void {
  gw = new Map<string, Price[]>(); let t = "";
  for (const prov of [...g.keys()].sort()) {
    const rs = (g.get(prov) ?? []).map(cp); rs.sort(byLen); gw.set(prov, rs);
    for (const r of rs) t += "|" + prov + "/" + r.p + ":" + r.i + "," + r.o + "," + r.cr + "," + r.cw + "," + r.cw1;
  }
  gwSig = t ? hash(t) : "";
  changed();
}
// the opt-in community list as cached by its last refresh (null = off): replaceable at runtime, a refresh applies at once
export function setRemote(r: Remote | null): void {
  remote = r; comm = new Set<string>();
  const t = BUILTIN.map(cp);
  if (r) for (const [k, x] of r.prices) {
    comm.add(k); let hit = false;
    for (const y of t) if (y.p === k) { y.i = x.i; y.o = x.o; y.cr = x.cr; y.cw = x.cw; y.cw1 = x.cw1; hit = true; }
    if (!hit) t.push({ p: k, i: x.i, o: x.o, cr: x.cr, cw: x.cw, cw1: x.cw1 });
  }
  t.sort(byLen); base = t;
  changed();
}
// where the base table comes from, for the UI: "built-in" or "litellm 2026-09-29"
export function pricesFrom(): string { return remote ? remote.source + " " + day(remote.fetchedAt) : "built-in"; }
export function communitySource(): string { return remote ? remote.source : ""; }
export function communityFetched(): string { return remote ? day(remote.fetchedAt) : ""; }
// $ per kiro credit: AGENTGLASS_KIRO_CREDIT_USD, else prices.json "kiroCreditUsd"; 0 = not configured
export function kiroRate(): number { const e = Number(process.env.AGENTGLASS_KIRO_CREDIT_USD ?? ""); return e > 0 ? e : kiroUser; }
// fingerprint of every price that differs from the built-ins (user, gateway, community list); content-hashed, so a
// refresh that changes nothing changes nothing. The ledger cache re-prices (not re-indexes) when it differs.
function remoteSig(): string {
  if (!remote) return "";
  const ks = [...remote.prices.keys()].sort();
  let t = remote.source;
  for (const k of ks) { const r = remote.prices.get(k); if (r) t += "|" + k + ":" + r.i + "," + r.o + "," + r.cr + "," + r.cw + "," + r.cw1; }
  return remote.source + ":" + hash(t);
}
export function pricesSig(): string { return (userSig ? "u:" + hash(userSig) : "") + (gwSig ? " g:" + gwSig : "") + (remote ? " c:" + remoteSig() : ""); }

// ── matching ──
// a gemini-* row prices only its own -preview/-latest/-exp/-<version> ids: -lite, -image, -tts variants are other models
const GEMINI_SAME = /^-(preview|latest|exp|\d)/;
function fits(m: string, k: string): boolean {
  if (!m.startsWith(k)) return false;
  if (!k.startsWith("gemini-")) return true;
  const rest = m.slice(k.length);
  return rest === "" || GEMINI_SAME.test(rest);
}
function isTier(k: string): boolean { return k.indexOf(">") >= 0 || k.indexOf("@") >= 0; }
function inList(xs: Price[], k: string): Price | null { for (const x of xs) if (x.p === k) return x; return null; }
// the tier row of a matched key: "<k>@2027" from 2027 on, then "<k>>200k" for long prompts; a tier the user names
// wins over the matched layer's own (a user base price alone drops the layer's tiers: it is meant for every prompt)
function tier(xs: Price[], x: Price, y2027: boolean, big: boolean, mine: boolean): Price {
  let r = x; let k = x.p;
  const step = (tag: string): void => {
    const u = mine ? null : inList(userP, k + tag); const t = u ?? inList(xs, k + tag);
    if (t) { r = t; k = t.p; }
  };
  if (y2027) step("@2027");
  if (big) step(">200k");
  return r;
}
function walk(xs: Price[], m: string, exact: boolean): Price | null {
  for (const x of xs) { if (isTier(x.p)) continue; if (exact ? m === x.p : fits(m, x.p)) return x; }
  return null;
}
// layers below the aliases: user price, gateway (the booking's provider), base
function direct(m: string, prov: string, y2027: boolean, big: boolean): Resolved | null {
  const u = walk(userP, m, false);
  if (u) { const r = tier(userP, u, y2027, big, true); return { p: r, src: "user", key: r.p, via: "" }; }
  const g = prov ? gw.get(prov) : undefined;
  if (g) { const x = walk(g, m, true); if (x) { const r = tier(g, x, y2027, big, false); return userP.indexOf(r) >= 0 ? { p: r, src: "user", key: r.p, via: "" } : { p: r, src: "gateway", key: r.p, via: prov }; } }
  const b = walk(base, m, false);
  if (b) {
    const r = tier(base, b, y2027, big, false); const c = comm.has(r.p);
    if (userP.indexOf(r) >= 0) return { p: r, src: "user", key: r.p, via: "" }; // a tier row only the user names
    return { p: r, src: c ? "community" : "built-in", key: r.p, via: c && remote ? remote.source : "" };
  }
  return null;
}
// tags a booked key may carry (gemini): "@2027", ">200k", in that order; a leading "?" is an old unpriced marker
export function stripTiers(model: string): string {
  let m = model.startsWith("?") ? model.slice(1) : model;
  const g = m.indexOf(">200k"); if (g >= 0) m = m.slice(0, g);
  const y = m.indexOf("@2027"); if (y >= 0) m = m.slice(0, y);
  return m;
}
// the price of a booked model key for the booking's provider key ("" = none); null = unpriced
export function resolve(model: string, prov: string): Resolved | null {
  const mk = model + "\t" + prov;
  const hit = memo.get(mk);
  if (hit !== undefined) return hit;
  let r: Resolved | null = null;
  if (!model.startsWith("?")) { // old ledgers' gemini "?<id>": a variant no row may price
    const m = normModel(stripTiers(model));
    const y2027 = model.indexOf("@2027") >= 0; const big = model.indexOf(">200k") >= 0;
    const al = userAlias(m);
    if (!al) r = direct(m, prov, y2027, big);
    else { // one hop: the target never resolves through another alias
      const t = direct(normModel(stripTiers(al.target)), prov, y2027, big);
      r = t ? { p: t.p, src: "alias", key: al.p, via: al.target } : null;
    }
  }
  memo.set(mk, r);
  return r;
}
// the user alias that applies to a normalised id: the longest matching prices.json key wins, a price on the same key
// beats an alias (the more specific statement); null = a user price or nothing
function userAlias(m: string): Alias | null {
  const u = walk(userP, m, false);
  for (const x of userA) if (fits(m, x.p)) return u && u.p.length >= x.p.length ? null : x;
  return null;
}
// the target an alias entry names for a model ("" = none), for display of dead aliases
export function aliasOf(model: string): string { const a = userAlias(normModel(stripTiers(model))); return a ? a.target : ""; }
// opt-in community list, as cached by the last refresh; prices.json, read once here (repricer.ts reloads it)
const RC = remoteCfg();
setRemote(RC.source ? loadCached(RC.source) : null);
const UF = readUserFile(PRICES_FILE);
// startup warnings (invalid prices.json, skipped entries): shown once by whoever runs first (repricer.ts, prices CLI)
export const USER_WARN: string[] = (UF.bad ? [PRICES_FILE + ": " + UF.bad + " — ignored"] : []).concat(loadUser(UF.o));

// the list-price row's key for a model id: provider/ prefixes (proxies, Bedrock ARNs), Bedrock's [region.]anthropic. prefix
// with its -vN[:M] suffix, Vertex's @YYYYMMDD and the -YYYYMMDD snapshot suffix are dropped
export function normModel(model: string): string {
  let m = model.toLowerCase();
  const sl = m.lastIndexOf("/"); if (sl >= 0) m = m.slice(sl + 1);
  const br = m.replace(/^(?:[a-z]{2,4}\.)?anthropic\./, "");
  if (br !== m) m = br.replace(/-v\d+(?::\d+)?$/, ""); // only Bedrock ids: deepseek-v3 & co. keep their -vN
  return m.replace(/@\d{8}$/, "").replace(/-\d{8}$/, "");
}
export function price(model: string): Price | null { const r = resolve(model, ""); return r ? r.p : null; }
// ≈USD for one usage record; w5/w1 = cache writes with 5-minute / 1-hour TTL
export function cost(p: Price, inp: number, out: number, cr: number, w5: number, w1: number): number {
  const rr = p.cr >= 0 ? p.cr : p.i * 0.1;
  const r5 = p.cw >= 0 ? p.cw : p.i * 1.25;
  const r1 = p.cw1 >= 0 ? p.cw1 : p.i * 2; // not cw: a 5-minute rate for 1-hour writes undercharges them
  return (inp * p.i + out * p.o + cr * rr + w5 * r5 + w1 * r1) / 1e6;
}
