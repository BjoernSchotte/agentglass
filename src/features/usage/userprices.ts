// agentglass — writes prices.json (user prices and aliases) for the TUI price panel and `agentglass prices`
// SPDX-License-Identifier: Apache-2.0
// Entries are stored under normModel(model) (lower case, provider prefix and date suffix dropped) so the resolver's
// prefix match finds them; unknown keys (kiroCreditUsd, future fields) are kept as they are (util/config.ts writeJsonAt).
import { type Obj, obj } from "../../util/json.ts";
import { writeJsonAt, parseConfig } from "../../util/config.ts";
import { readWhole } from "../../util/fs.ts";
import { normModel } from "./pricing.ts";

// $/Mtok as typed; -1 = not given (derived from input like the built-in rows)
export interface PriceIn { i: number; o: number; cr: number; cw: number; cw1: number }
const MAX_RATE = 10000;
// "" = fine, else why not
export function checkPrice(p: PriceIn): string {
  for (const v of [p.i, p.o, p.cr, p.cw, p.cw1]) if (v !== -1 && (!Number.isFinite(v) || v < 0)) return "prices must be ≥ 0";
  if (p.i < 0 || p.o < 0) return "prices must be ≥ 0";
  for (const v of [p.i, p.o, p.cr, p.cw, p.cw1]) if (v >= MAX_RATE) return "price over $10000/Mtok";
  return "";
}
// "1.25 10 [cacheRead [cacheWrite [cacheWrite1h]]]": separators spaces, "/" or ","; a "$" before a number is fine
export function parsePriceLine(text: string): { p: PriceIn | null; err: string } {
  const toks = text.split("/").join(" ").split(",").join(" ").split(" ").filter((t: string) => t !== "");
  if (toks.length < 2) return { p: null, err: "in and out are needed" };
  if (toks.length > 5) return { p: null, err: "too many values (max 5)" };
  const v: number[] = [];
  for (const t of toks) {
    const s = t.startsWith("$") ? t.slice(1) : t;
    const n = Number(s);
    if (!s || !Number.isFinite(n) || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return { p: null, err: "\"" + t + "\" is not a number" };
    v.push(n);
  }
  const at = (i: number): number => i < v.length ? v[i] + 0 : -1;
  const p: PriceIn = { i: at(0), o: at(1), cr: at(2), cw: at(3), cw1: at(4) };
  const bad = checkPrice(p);
  return bad ? { p: null, err: bad } : { p, err: "" };
}
// the prices.json entry: {"input", "output"[, "cacheRead"[, "cacheWrite"[, "cacheWrite1h"]]]} (only the values given)
export function entryOf(p: PriceIn): Obj {
  const e: Obj = { input: p.i, output: p.o };
  if (p.cr >= 0) e["cacheRead"] = p.cr;
  if (p.cw >= 0) e["cacheWrite"] = p.cw;
  if (p.cw1 >= 0) e["cacheWrite1h"] = p.cw1;
  return e;
}
// the key an entry for this model is stored under
export function storedKey(model: string): string { return normModel(model); }
// set (e) or remove (null) the user entry of a model; throws, leaving the file as it is, when it is unreadable or not JSON
export function setUserEntry(path: string, model: string, e: Obj | null): void {
  const k = storedKey(model);
  writeJsonAt(path, (root: Obj): void => {
    for (const k0 of Object.keys(root)) if (k0 !== k && k0.toLowerCase() === k) delete root[k0]; // "GPT-X" written by hand: one entry per model
    if (e) root[k] = e; else delete root[k];
  });
}
// the user's current entry for a model (null = none, or the file is missing/invalid)
export function userEntry(path: string, model: string): Obj | null {
  const r = readWhole(path, 1048576); if (r.err) return null;
  const p = parseConfig(r.text); if (!p.root) return null;
  const k = storedKey(model);
  for (const k0 of Object.keys(p.root)) if (k0.toLowerCase() === k) return obj(p.root[k0]);
  return null;
}
