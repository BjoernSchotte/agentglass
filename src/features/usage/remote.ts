// agentglass — opt-in community price lists (LiteLLM, models.dev): fetched at most every refreshHours, cached locally
// SPDX-License-Identifier: Apache-2.0
// Off unless ~/.agentglass/config.json has {"prices": {"source": "litellm" | "models.dev", "refreshHours": 24}};
// AGENTGLASS_OFFLINE=1 stops fetching (an already cached list still applies). The request is a plain GET of a public file: no ids, usage or paths are sent.
// Only the first-party model prices are kept (a few KB); a new list applies from the next start, so every cost in one
// run comes from one table (and the ledger cache, keyed on the prices, re-indexes once when they really changed).
import { openSync, writeSync, closeSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str } from "../../util/json.ts";
import { HOME, readText } from "../../util/fs.ts";
import { section } from "../../util/config.ts";

// $ per million tokens; cw1 = 1-hour cache write; -1 = not in the list (derived from input like the built-in table)
export interface RPrice { i: number; o: number; cr: number; cw: number; cw1: number }
export interface Remote { source: string; fetchedAt: number; etag: string; prices: Map<string, RPrice> }

const URLS = new Map<string, string>([
  ["litellm", "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"],
  ["models.dev", "https://models.dev/api.json"],
]);
export const SOURCES = [...URLS.keys()];
const TIMEOUT_MS = 20000;
const MIN_MODELS = 10; // a list with fewer first-party models is broken: keep the previous one

export interface RemoteCfg { source: string; hours: number; offline: boolean; error: string }
// the opted-in source, or source "" (off); error = config present but invalid
export function remoteCfg(): RemoteCfg {
  const c = section("prices");
  const src = str(c["source"]);
  const offline = process.env.AGENTGLASS_OFFLINE === "1";
  if (!src || src === "off") return { source: "", hours: 0, offline, error: "" };
  if (!URLS.has(src)) return { source: "", hours: 0, offline, error: "prices.source must be one of " + SOURCES.join(", ") + " or off" };
  const h = typeof c["refreshHours"] === "number" ? (c["refreshHours"] as number) : 24;
  return { source: src, hours: Math.max(1, h), offline, error: "" };
}
// beside the ledger: AGENTGLASS_CACHE_DIR moves both (read per call: the env may change after import, e.g. in checks)
function dir(): string { const e = process.env.AGENTGLASS_CACHE_DIR; return e ? e : join(HOME, ".agentglass", "cache"); }
export function pricesFile(source: string): string { return join(dir(), "prices-" + source + ".json"); }

// ── normalize: a raw list → first-party model id → $/Mtok ──
function n(v: unknown, scale: number): number { return typeof v === "number" && isFinite(v as number) && (v as number) >= 0 ? (v as number) * scale : -1; }
function ok(p: RPrice): boolean { return p.i >= 0 && p.o >= 0 && p.i + p.o > 0 && p.i < 1000 && p.o < 1000; }
const LITELLM_PROVIDERS = ["anthropic", "openai", "gemini", "vertex_ai-language-models", "xai", "deepseek", "mistral"];
// LiteLLM: {"<id>": {litellm_provider, mode, input_cost_per_token, …}} in $/token; ids may carry "provider/"
export function fromLitellm(o: Obj): Map<string, RPrice> {
  const out = new Map<string, RPrice>();
  for (const k of Object.keys(o)) {
    const e = obj(o[k]); if (!e) continue;
    if (LITELLM_PROVIDERS.indexOf(str(e["litellm_provider"])) < 0) continue;
    const mode = str(e["mode"]); if (mode && mode !== "chat" && mode !== "responses") continue;
    const id = k.slice(k.lastIndexOf("/") + 1).toLowerCase();
    if (!id || id.indexOf(":") >= 0 || id.indexOf("@") >= 0 || out.has(id)) continue; // bedrock/vertex version pins
    const p: RPrice = { i: n(e["input_cost_per_token"], 1e6), o: n(e["output_cost_per_token"], 1e6), cr: n(e["cache_read_input_token_cost"], 1e6),
      cw: n(e["cache_creation_input_token_cost"], 1e6), cw1: n(e["cache_creation_input_token_cost_above_1hr"], 1e6) };
    if (ok(p)) out.set(id, p);
  }
  return out;
}
// models.dev: {"<provider>": {models: {"<id>": {cost: {input, output, cache_read, cache_write}}}}} in $/Mtok
export function fromModelsDev(o: Obj): Map<string, RPrice> {
  const out = new Map<string, RPrice>();
  for (const prov of ["anthropic", "openai", "google", "xai", "deepseek", "mistral"]) {
    const pv = obj(o[prov]); const ms = pv ? obj(pv["models"]) : null; if (!ms) continue;
    for (const id of Object.keys(ms)) {
      const m = obj(ms[id]); const c = m ? obj(m["cost"]) : null; if (!c) continue;
      const p: RPrice = { i: n(c["input"], 1), o: n(c["output"], 1), cr: n(c["cache_read"], 1), cw: n(c["cache_write"], 1), cw1: -1 };
      if (ok(p) && !out.has(id.toLowerCase())) out.set(id.toLowerCase(), p);
    }
  }
  return out;
}

// ── cache ──
function toObj(r: Remote): Obj {
  const ps: Obj = {};
  for (const [k, p] of r.prices) ps[k] = [p.i, p.o, p.cr, p.cw, p.cw1];
  return { source: r.source, fetchedAt: r.fetchedAt, etag: r.etag, prices: ps };
}
export function loadCached(source: string): Remote | null {
  const o = obj((() => { try { return JSON.parse(readText(pricesFile(source), 0, 4194304)); } catch (e) { return null; } })());
  const ps = o ? obj(o["prices"]) : null;
  if (!o || !ps || str(o["source"]) !== source) return null;
  const prices = new Map<string, RPrice>();
  for (const k of Object.keys(ps)) {
    const a = ps[k];
    if (!Array.isArray(a)) continue;
    const v = (i: number): number => { const x = (a as unknown[])[i]; return typeof x === "number" ? (x as number) : -1; };
    prices.set(k, { i: v(0), o: v(1), cr: v(2), cw: v(3), cw1: v(4) });
  }
  return { source, fetchedAt: typeof o["fetchedAt"] === "number" ? (o["fetchedAt"] as number) : 0, etag: str(o["etag"]), prices };
}
function save(r: Remote): void {
  mkdirSync(dir(), { recursive: true });
  const f = pricesFile(r.source); const tmp = f + ".tmp";
  const fd = openSync(tmp, "w"); writeSync(fd, JSON.stringify(toObj(r))); closeSync(fd);
  renameSync(tmp, f); // atomic: never a torn cache
}
export function stale(c: RemoteCfg, r: Remote | null): boolean { return !r || Date.now() - r.fetchedAt > c.hours * 3600000; }

// fetch (conditional on the cached ETag), normalize, validate, cache. Resolves to a one-line status; never throws.
export async function refresh(c: RemoteCfg): Promise<string> {
  const url = URLS.get(c.source) ?? "";
  const old = loadCached(c.source);
  try {
    const headers: Record<string, string> = { "user-agent": "agentglass" };
    if (old && old.etag) headers["if-none-match"] = old.etag;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 304 && old) { old.fetchedAt = Date.now(); save(old); return "prices: " + c.source + " unchanged"; }
    if (res.status !== 200) return "prices: " + c.source + " HTTP " + res.status;
    const raw = obj(JSON.parse(await res.text()));
    if (!raw) return "prices: " + c.source + " sent no JSON object";
    const prices = c.source === "litellm" ? fromLitellm(raw) : fromModelsDev(raw);
    if (prices.size < MIN_MODELS) return "prices: " + c.source + " list looks broken (" + prices.size + " models) — kept the old one";
    save({ source: c.source, fetchedAt: Date.now(), etag: res.headers.get("etag") ?? "", prices });
    return "prices: " + c.source + " updated (" + prices.size + " models) — applies on next start";
  } catch (e) {
    return "prices: " + c.source + " failed: " + String(e);
  }
}
