// agentglass — self-check for cost sums by billing mode, money format, unpriced line, projection and budget: scriptc build src/features/usage/costs.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { type Bill } from "./billing.ts";
import { newDay, isoMs } from "./record.ts";
import { newSum, addDay, total, single, money, moneyTag, split, unpricedLine, type DayCost, projectToday, projectMonth, daysLeftInMonth, monthStart } from "./costs.ts";

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

// ── projection ──
const dc = (k: string, c: number, hrs: number[]): DayCost => { const hc: number[] = []; for (let i = 0; i < 24; i++) hc.push(hrs.indexOf(i) >= 0 ? c / hrs.length : 0); return { key: k, cost: c, hc }; };
const two = [dc("a", 10, [9, 10]), dc("b", 10, [9, 10])];
ok("2 days → none", projectToday(two, dc("t", 0, []), 8) === -1, "");
ok("0 days → none", projectToday([], dc("t", 0, []), 8) === -1 && projectMonth([], 0, -1, 0, 10) === -1, "");
const three = [dc("a", 10, [9, 10]), dc("b", 0, []), dc("c", 10, [9, 10]), dc("d", 10, [9, 10])];
ok("profile skips zero days", Math.abs(projectToday(three, dc("t", 0, []), 8) - 10) < 1e-9, String(projectToday(three, dc("t", 0, []), 8)));
const spentMore = dc("t", 8, [9]); // 8 spent at 09h, profile 5 at 09h, 5 at 10h
ok("overspent hour adds 0", Math.abs(projectToday(three, spentMore, 9) - 13) < 1e-9, String(projectToday(three, spentMore, 9)));
ok("late in the day = spent", Math.abs(projectToday(three, dc("t", 4, [3]), 23) - 4) < 1e-9, String(projectToday(three, dc("t", 4, [3]), 23)));
ok("month", Math.abs(projectMonth(three, 50, 10, 0, 10) - (50 + 10 + 10 * 7.5)) < 1e-9, String(projectMonth(three, 50, 10, 0, 10))); // mean over a..d = 30/4
ok("month without today's projection", Math.abs(projectMonth(three, 50, -1, 0, 10) - (50 + 75)) < 1e-9, "");
const lead = [dc("z1", 0, []), dc("z2", 0, []), dc("a", 10, [9]), dc("b", 0, []), dc("c", 10, [9]), dc("d", 10, [9])];
ok("leading empty days don't dilute", Math.abs(projectMonth(lead, 0, -1, 0, 1) - 7.5) < 1e-9, String(projectMonth(lead, 0, -1, 0, 1)));
ok("month none", projectMonth(two, 50, -1, 0, 10) === -1, "");
// noon UTC is the same local date in zones -11..+11 (scriptc parses no local-time ISO strings); daysLeft = days in month − 1; last day: 0
ok("days left last day", daysLeftInMonth(isoMs("2026-10-31T12:00:00Z")) === 0, String(daysLeftInMonth(isoMs("2026-10-31T12:00:00Z"))));
ok("days left first", daysLeftInMonth(isoMs("2026-10-01T12:00:00Z")) === 30, String(daysLeftInMonth(isoMs("2026-10-01T12:00:00Z"))));
ok("days left feb", daysLeftInMonth(isoMs("2026-02-10T12:00:00Z")) === 18, String(daysLeftInMonth(isoMs("2026-02-10T12:00:00Z"))));
ok("month start on the 1st", monthStart(isoMs("2026-10-01T12:00:00Z")).join() === "2026-10-01", monthStart(isoMs("2026-10-01T12:00:00Z")).join());
ok("month start mid-month", monthStart(isoMs("2026-10-03T12:00:00Z")).join() === "2026-10-01,2026-10-02,2026-10-03", monthStart(isoMs("2026-10-03T12:00:00Z")).join());
// DST: 2026-10-25 (Europe) has 25 local hours — must not throw, no hour index ≥ 24
ok("dst", projectToday(three, dc("2026-10-25", 1, [2]), 23) >= 1, "");
ok("dst month start", monthStart(isoMs("2026-10-26T12:00:00Z")).length === 26, String(monthStart(isoMs("2026-10-26T12:00:00Z")).length));

console.log(bad ? bad + " failed" : "costs: all checks passed");
if (bad) process.exit(1);
