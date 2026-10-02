// agentglass — self-check for cost sums by billing mode, money format, unpriced line, projection and budget: scriptc build src/features/usage/costs.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { type Bill } from "./billing.ts";
import { newDay } from "./record.ts";
import { newSum, addDay, total, single, money, moneyTag, split, unpricedLine } from "./costs.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

// ── mode sums, money, unpriced line ──
ok("api no approx", money(4.2, "api") === "$4.20" && money(4.2, "plan") === "≈$4.20" && money(1234, "metered") === "≈$1,234", money(4.2, "api"));
ok("money tag", moneyTag(3.1, "api") === "$3.10 spend" && moneyTag(9.2, "gateway") === "≈$9.20 gw" && moneyTag(1, "unknown") === "≈$1.00 ?", moneyTag(3.1, "api"));
const mkDay = () => {
  const d = newDay();
  d.cp.set("", 3.1); d.cp.set("anthropic", 9.2); d.cost = 12.3; d.unk = 1200004; d.uc = 120;
  for (const [k, v] of [["gpt-x", 900000], ["custom", 300000], ["m3", 1], ["m4", 1], ["m5", 1], ["m6", 1]]) d.um.set(String(k), Number(v));
  return d;
};
const m = newSum(); const d = mkDay();
addDay(m, d, (p: string): Bill => (p === "anthropic" ? "plan" : "api"));
ok("by mode", Math.abs((m.by[0] ?? 0) - 3.1) < 1e-9 && Math.abs((m.by[1] ?? 0) - 9.2) < 1e-9, m.by.join(","));
ok("total", Math.abs(total(m) - 12.3) < 1e-9 && single(m) === "", String(total(m)));
ok("split mixed", split(m, false) === "$3.10 spend + ≈$9.20 plan", split(m, false));
ok("split narrow", split(m, true) === "≈$12.30", split(m, true));
ok("unpriced line", unpricedLine(m, 2) === "gpt-x 900K · custom 300K · +4 models · kiro 120 credits (set kiroCreditUsd)", unpricedLine(m, 2));
ok("nothing unpriced", unpricedLine(newSum(), 5) === "", "");
const one = newSum(); const d1 = newDay(); d1.cp.set("", 2); addDay(one, d1, (p: string): Bill => "api");
ok("single api", single(one) === "api" && split(one, false) === "$2.00 spend" && split(one, true) === "$2.00", split(one, true));
ok("empty", split(newSum(), false) === "≈$0.00" && single(newSum()) === "", split(newSum(), false));

console.log(bad ? bad + " failed" : "costs: all checks passed");
if (bad) process.exit(1);
