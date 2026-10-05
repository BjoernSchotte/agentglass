// agentglass — price changes reach history in place: re-price every ledger session's table-priced rows (record.ts reprice)
// SPDX-License-Identifier: Apache-2.0
// Triggers: a write through the price panel or CLI in this process, prices.json / pi models.json / OpenCode config
// changing on disk (stat every 5 s on the tick), a community list refresh, a cache saved under other prices (cache.ts).
import { statSync } from "node:fs";
import { H } from "../../hooks.ts";
import { say } from "../../state.ts";
import { HOME } from "../../util/fs.ts";
import { ledger, reapplyAll } from "./ledger.ts";
import { L, reprice } from "./record.ts";
import { PRICES_FILE, USER_WARN, readUserFile, loadUser, setGateway, setRemote, pricesSig } from "./pricing.ts";
import { loadGateway, gatewayEnv, gatewayFiles } from "./gwprices.ts";
import { remoteCfg, loadCached, pricesFile } from "./remote.ts";

// the price signature the ledger's numbers are booked under (cache.ts saves it; a mismatch re-prices before a save)
export const PRICED = { sig: "" };
// every ledger session under the current table; the Stats/cost caches rebuild (L.ver), the cache saves (L.idx)
export function repriceAll(): { usd: number; ms: number } {
  const t0 = Date.now(); let usd = 0;
  for (const a of ledger.values()) usd += reprice(a);
  L.ver++; L.idx++; PRICED.sig = pricesSig();
  reapplyAll(); // costs changed in place: the tick puts them on every session again (it skips unchanged entries)
  return { usd, ms: Date.now() - t0 };
}
// warnings (invalid prices.json entries) are told once per distinct text
const told = new Set<string>();
function warn(ws: string[]): void { for (const w of ws) if (!told.has(w)) { told.add(w); say("warn", "prices: " + w); } }
// re-read prices.json, the gateway configs and the cached community list; re-price when the table really changed.
// why: "editor" | "cli" | "community" | "watch" | "load"; returns the cost delta (0 = nothing changed)
export function reloadPrices(why: string): number {
  const before = pricesSig();
  const u = readUserFile(PRICES_FILE);
  const ws = loadUser(u.o); if (u.bad) ws.unshift(PRICES_FILE + ": " + u.bad + " — ignored");
  warn(ws);
  setGateway(loadGateway(HOME, gatewayEnv()).rows);
  const rc = remoteCfg(); setRemote(rc.source ? loadCached(rc.source) : null);
  if (pricesSig() === before && why !== "load") return 0;
  return repriceAll().usd;
}
// the gateway layer at startup, before anything is booked (pricing.ts cannot import gwprices.ts: it would be a cycle)
setGateway(loadGateway(HOME, gatewayEnv()).rows);
PRICED.sig = pricesSig();

// the files a price can come from; their stat (mtime + size) changing on disk triggers reloadPrices("watch")
function watched(): string[] {
  const fs = [PRICES_FILE].concat(gatewayFiles(HOME, gatewayEnv()));
  const rc = remoteCfg(); if (rc.source) fs.push(pricesFile(rc.source));
  return fs;
}
function statKey(): string { let k = ""; for (const f of watched()) { try { const s = statSync(f); k += s.mtimeMs + ":" + s.size + "|"; } catch (e) { k += "-|"; } } return k; }
let lastKey = ""; let lastAt = 0;
H.firstScan.push(() => { warn(USER_WARN); lastKey = statKey(); lastAt = Date.now(); }); // a CLI run prints them on stderr
H.onTick.push(() => {
  if (Date.now() - lastAt < 5000) return;
  lastAt = Date.now();
  const k = statKey(); if (k === lastKey) return;
  lastKey = k;
  const usd = reloadPrices("watch");
  if (Math.abs(usd) >= 0.005) say("ok", "prices changed on disk — history re-priced (" + (usd >= 0 ? "+" : "−") + "$" + Math.abs(usd).toFixed(2) + ")");
});
// a write through this process: the watcher must not report it a second time
export function pricesWritten(): void { lastKey = statKey(); lastAt = Date.now(); }
