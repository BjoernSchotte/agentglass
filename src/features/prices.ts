// agentglass — opt-in price list refresh: in the background once the TUI runs, or now with --update-prices
// SPDX-License-Identifier: Apache-2.0
import { say } from "../state.ts";
import { H } from "../hooks.ts";
import { home } from "../util/text.ts";
import { CONFIG_FILE } from "../util/config.ts";
import { remoteCfg, loadCached, stale, refresh, SOURCES } from "./usage/remote.ts";
import { pricesFrom } from "./usage/pricing.ts";
import { reloadPrices } from "./usage/repricer.ts";

const OPT_IN = "opt in: " + home(CONFIG_FILE) + ' → {"prices": {"source": "' + SOURCES.join('" | "') + '", "refreshHours": 24}}';

let started = false;
H.onTick.push(() => {
  if (started) return;
  started = true;
  const c = remoteCfg();
  if (c.error) { say("warn", c.error); return; }
  if (!c.source || c.offline || !stale(c, loadCached(c.source))) return;
  refresh(c).then((msg: string) => {
    const good = msg.indexOf("updated") >= 0; // applies at once: the ledger re-prices in place
    if (good) { const usd = reloadPrices("community"); say("ok", msg + " — applied" + (Math.abs(usd) >= 0.005 ? ", history re-priced (" + (usd >= 0 ? "+" : "−") + "$" + Math.abs(usd).toFixed(2) + ")" : "")); return; }
    say(msg.indexOf("failed") >= 0 || msg.indexOf("HTTP") >= 0 || msg.indexOf("timed out") >= 0 ? "warn" : "ok", msg);
  });
});

H.cli.push((args: string[]): boolean => {
  if (args.indexOf("--update-prices") < 0 && !(args[0] === "prices" && args[1] === "update")) return false; // prices update = --update-prices
  const c = remoteCfg();
  if (c.error) { console.error("agentglass: " + c.error); process.exit(2); }
  if (!c.source) { console.log("prices: " + pricesFrom() + " (community lists are off; " + OPT_IN + ")"); return true; }
  if (c.offline) { console.log("prices: " + pricesFrom() + " (AGENTGLASS_OFFLINE=1: not fetching)"); return true; }
  refresh(c).then((msg: string) => { console.log(msg); process.exit(msg.indexOf("updated") >= 0 || msg.indexOf("unchanged") >= 0 ? 0 : 1); });
  return true;
});

H.helpSections.push({ name: "prices", ctx: "", keys: [
  ["now", pricesFrom()], ["--update-prices", "fetch the opted-in list now"], ["config.json", '"prices": {"source": …} opts in'],
  ["OFFLINE=1", "AGENTGLASS_OFFLINE=1: never fetch (cache still used)"] ] });
