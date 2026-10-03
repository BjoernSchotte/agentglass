// agentglass — self-check for the ledger's active-time intervals (Day.act): scriptc build src/features/usage/act.check.ts -o ac && ./ac
// SPDX-License-Identifier: Apache-2.0
import { type Acc, type Day, ACT, newAcc, bucket, tool, pend, addSpan, actSpan, flushSpans, spanMin, unionMin, startOfDay, dayKey } from "./record.ts";
import { done } from "./calls.ts";
import { accOut, accIn } from "./codec.ts";
import { intOf } from "../../util/config.ts";
import { MQ_MSG } from "./facts.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
// local wall time daysAgo back (TZ-independent: built from local midnight)
const SOD = startOfDay();
function ms(daysAgo: number, hh: number, mm: number): number { return SOD - daysAgo * 86400000 + (hh * 60 + mm) * 60000; }
function iso(daysAgo: number, hh: number, mm: number): string { return new Date(ms(daysAgo, hh, mm)).toISOString(); }
function line(a: Acc, daysAgo: number, hh: number, mm: number): Day { return bucket(a, 0, iso(daysAgo, hh, mm)); }
function actOf(a: Acc, daysAgo: number): string { const d = a.days.get(dayKey(new Date(ms(daysAgo, 12, 0)))); return d ? d.act.join(",") : "-"; }

let a = newAcc();
line(a, 1, 10, 0); line(a, 1, 10, 3); line(a, 1, 10, 8);
eq("gap ≤ 5 joins", actOf(a, 1), "600,609");
a = newAcc(); line(a, 1, 10, 0); line(a, 1, 10, 6);
eq("gap > 5 splits", actOf(a, 1), "600,601,606,607");
ACT.gap = 15; a = newAcc(); line(a, 1, 10, 0); line(a, 1, 10, 14);
eq("gap 15 joins", actOf(a, 1), "600,615"); ACT.gap = 5;
// a tool call's duration fills the time without lines
a = newAcc();
const d = line(a, 1, 11, 0); const st = tool(a, d, "Bash", "m", MQ_MSG);
pend(a, d, st, "Bash", "c1", ms(1, 11, 0), iso(1, 11, 0), "{}", []);
const p = a.pend.get("c1");
if (p) done(p, 20 * 60000, false, 0, "c1", []);
flushSpans(a);
eq("tool duration", actOf(a, 1), "660,681");
// the span is also applied by the next line of the same session (no explicit flush)
a = newAcc();
const d2 = line(a, 1, 11, 0); const st2 = tool(a, d2, "Bash", "m", MQ_MSG);
pend(a, d2, st2, "Bash", "c2", ms(1, 11, 0), iso(1, 11, 0), "{}", []);
const p2 = a.pend.get("c2"); if (p2) done(p2, 10 * 60000, false, 0, "c2", []);
line(a, 1, 11, 12);
eq("span via next line", actOf(a, 1), "660,673");
// midnight
a = newAcc(); line(a, 2, 23, 58); line(a, 1, 0, 2);
eq("midnight day 1", actOf(a, 2), "1438,1440"); eq("midnight day 2", actOf(a, 1), "0,3");
a = newAcc(); line(a, 2, 23, 0); actSpan(a, ms(2, 23, 50), ms(1, 0, 10));
eq("span across midnight day 1", actOf(a, 2), "1380,1381,1430,1440"); eq("span across midnight day 2", actOf(a, 1), "0,11");
// the 200-interval cap merges the closest pair; coverage only grows
a = newAcc();
for (let i = 0; i < 205; i++) line(a, 1, Math.floor((i * 7) / 60), (i * 7) % 60);
const dd = a.days.get(dayKey(new Date(ms(1, 12, 0))));
eq("cap 200", dd ? String(dd.act.length / 2) : "-", "200");
eq("coverage ≥ 205", dd && spanMin(dd.act) >= 205 ? "y" : String(dd ? spanMin(dd.act) : 0), "y");
// no timestamp → no activity
a = newAcc(); const nd = bucket(a, 0, ""); eq("no timestamp", nd.act.join(","), "");
// union vs sum
eq("unionMin", String(unionMin([[600, 660], [630, 690]])), "90"); eq("spanMin sum", String(spanMin([600, 660]) + spanMin([630, 690])), "120");
eq("unionMin disjoint+adjacent", String(unionMin([[0, 10, 20, 30], [10, 20]])), "30");
const xs: number[] = []; addSpan(xs, 5, 10); addSpan(xs, 0, 3); addSpan(xs, 3, 5); addSpan(xs, 20, 25); addSpan(xs, 8, 22);
eq("addSpan merge", xs.join(","), "0,25");
const ys: number[] = []; addSpan(ys, 50, 60); addSpan(ys, 10, 20); addSpan(ys, 30, 40); eq("addSpan sorted insert", ys.join(","), "10,20,30,40,50,60");
// persistence
a = newAcc(); line(a, 1, 10, 0); line(a, 1, 10, 4);
const b = accIn(JSON.parse(JSON.stringify(accOut(a))));
eq("act round trip", actOf(b, 1), "600,605"); eq("al round trip", String(b.al), String(a.al));
// config values (repo.idleGapMin through intSetting: invalid → 5)
eq("idleGapMin 0 → 5", String(intOf(0, 1, 60, 5)), "5"); eq("idleGapMin 15", String(intOf(15, 1, 60, 5)), "15"); eq("idleGapMin 61 → 5", String(intOf(61, 1, 60, 5)), "5"); eq("idleGapMin 2.5 → 5", String(intOf(2.5, 1, 60, 5)), "5");

console.log(bad ? bad + " failed" : "active time ok");
if (bad) process.exit(1);
