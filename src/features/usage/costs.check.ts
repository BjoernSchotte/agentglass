// agentglass — self-check for cost sums by billing mode, money format, unpriced line, projection and budget: scriptc build src/features/usage/costs.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { type Bill } from "./billing.ts";
import { newDay, isoMs, newAcc, bucket, tokens } from "./record.ts";
import { loadUser } from "./pricing.ts";
import { estOf, newSum, addDay, total, single, money, moneyTag, split, unpricedLine, type DayCost, projectToday, projectMonth, daysLeftInMonth, monthStart, parseBudget, budgetState, notifyOnce, projText } from "./costs.ts";

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

// ── budget ──
const b1 = parseBudget({ monthlyUsd: 200 });
ok("defaults", b1.usd === 200 && b1.counts.join() === "api,metered,gateway" && b1.warnAt === 0.8 && b1.bad === "", JSON.stringify(b1));
ok("string usd ignored", parseBudget({ monthlyUsd: "200" }).usd === 0 && parseBudget({ monthlyUsd: "200" }).bad === "monthlyUsd", "");
ok("negative usd ignored", parseBudget({ monthlyUsd: -5 }).usd === 0 && parseBudget({ monthlyUsd: -5 }).bad === "monthlyUsd", "");
ok("warnAt 1.5 ignored", parseBudget({ monthlyUsd: 10, warnAt: 1.5 }).warnAt === 0.8 && parseBudget({ monthlyUsd: 10, warnAt: 1.5 }).bad === "warnAt", "");
ok("all", parseBudget({ monthlyUsd: 10, counts: ["all"] }).counts.length === 5, "");
ok("bad counts", parseBudget({ monthlyUsd: 10, counts: ["api", "cash"] }).counts.join() === "api,metered,gateway" && parseBudget({ monthlyUsd: 10, counts: ["api", "cash"] }).bad === "counts", "");
ok("no budget", parseBudget({}).usd === 0 && parseBudget({}).bad === "", "");
const mo = newSum(); mo.by[0] = 165; mo.by[1] = 900; // api 165, plan 900 (not counted)
const st1 = budgetState(b1, mo, [170, 1000, 0, 0, 0]);
ok("watch by warnAt", st1.state === "watch" && st1.used === 165 && !st1.approx && st1.projected === 170, JSON.stringify(st1));
const st0 = budgetState(b1, (() => { const x = newSum(); x.by[0] = 10; return x; })(), [250, 0, 0, 0, 0]);
ok("watch by projection", st0.state === "watch", JSON.stringify(st0));
mo.by[2] = 60; // metered counted
const st2 = budgetState(b1, mo, [170, 1000, 70, 0, 0]);
ok("over + approx", st2.state === "over" && st2.approx && st2.used === 225, JSON.stringify(st2));
ok("ok", budgetState(parseBudget({ monthlyUsd: 1000 }), mo, [170, 0, 70, 0, 0]).state === "ok", "");
ok("unknown projection", budgetState(b1, mo, [-1, 0, 70, 0, 0]).projected === -1, "");
ok("plan counted = approx", budgetState(parseBudget({ monthlyUsd: 5000, counts: ["plan"] }), mo, [0, 0, 0, 0, 0]).approx, "");
ok("no budget state", budgetState(parseBudget({}), mo, [0, 0, 0, 0, 0]).state === "", "");
let sent = 0; const snd = (m: string): void => { sent++; };
const over = budgetState(b1, mo, [0, 0, 0, 0, 0]);
notifyOnce(over, "2026-10-01", snd); notifyOnce(over, "2026-10-01", snd);
ok("once a day", sent === 1, String(sent));
notifyOnce(over, "2026-10-02", snd);
ok("next day again", sent === 2, String(sent));
notifyOnce(st1, "2026-10-03", snd);
ok("not over: never", sent === 2, String(sent));
// ── projection text ──
const wb = { state: "watch", used: 0, projected: 310, approx: false };
ok("proj text", projText(14.2, 310, b1, wb, true) === "→ today $14 · month $310 of $200 (155%)", projText(14.2, 310, b1, wb, true));
ok("proj text approx", projText(14.2, 310, b1, { state: "watch", used: 0, projected: 310, approx: true }, true) === "→ today ≈$14 · month ≈$310 of $200 (155%)", "");
ok("proj text plan", projText(4.25, 31, parseBudget({}), { state: "", used: 0, projected: -1, approx: false }, false) === "→ today ≈$4.25 · month ≈$31", projText(4.25, 31, parseBudget({}), { state: "", used: 0, projected: -1, approx: false }, false));
ok("proj none", projText(-1, -1, b1, wb, true) === "→ — not enough history", projText(-1, -1, b1, wb, true));


// ── alias-priced cost is an estimate: ≈ even on an API key ──
ok("money est", money(3, "api", true) === "≈$3.00" && money(3, "api") === "$3.00" && moneyTag(3, "api", true) === "≈$3.00 spend", money(3, "api", true));
{
  loadUser(JSON.parse('{"gpt-x-unknown":{"alias":"claude-sonnet-4-5"}}'));
  const a = newAcc(); const dd = bucket(a, 0, "2026-10-01T09:30:00.000Z");
  tokens(a, dd, "gpt-x-unknown", 1000000, 0, 0, 0, 0); tokens(a, dd, "claude-sonnet-4-5", 1000000, 0, 0, 0, 0);
  const ms = newSum(); addDay(ms, dd, (p: string): Bill => "api");
  ok("addDay est", Math.abs(ms.est - 3) < 1e-9 && Math.abs(total(ms) - 6) < 1e-9, ms.est + "/" + total(ms));
  ok("split marks the estimate", split(ms, false) === "≈$6.00 spend", split(ms, false));
  const mx = newSum(); addDay(mx, dd, (p: string): Bill => "api"); const d2 = newDay(); d2.cp.set("gemini", 2); d2.cost = 2; addDay(mx, d2, (p: string): Bill => "plan");
  ok("only the mode holding the alias share gets ≈", split(mx, false) === "≈$6.00 spend + ≈$2.00 plan" && (mx.estBy[0] ?? 0) > 2.9 && (mx.estBy[1] ?? 0) === 0, split(mx, false));
  const my = newSum(); addDay(my, d2, (p: string): Bill => "api"); addDay(my, dd, (p: string): Bill => "plan");
  ok("an api part without alias share stays exact", split(my, false) === "$2.00 spend + ≈$6.00 plan", split(my, false));
  ok("estOf session", Math.abs(estOf(a) - 3) < 1e-9, String(estOf(a)));
  loadUser(null);
  const m2 = newSum(); addDay(m2, dd, (p: string): Bill => "api");
  ok("alias gone: no estimate", m2.est === 0, String(m2.est));
}
console.log(bad ? bad + " failed" : "costs: all checks passed");
if (bad) process.exit(1);
