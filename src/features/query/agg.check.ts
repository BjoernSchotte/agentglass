// agentglass — self-check for aggregate()/totals(): scriptc build src/features/query/agg.check.ts -o ac && ./ac
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import { lastDays } from "../usage/record.ts";
import type { Rows } from "../usage/rows.ts";
import { HB } from "../usage/calls.ts";
import { parse } from "./parse.ts";
import { type Compiled, EMPTY, compile } from "./eval.ts";
import { type Dist, aggregate, aggregateWhere, minus, totals, tsOf } from "./agg.ts";
import { fxBase } from "./fixture.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function F(s: string): Compiled { const r = compile(parse(s).cs, "stats"); return r.f ?? EMPTY; }
function dump(d: Dist | null): string {
  if (!d) return "(none)";
  const ks = [...d.vals.keys()].sort(); const o: string[] = [];
  for (const k of ks) { const b = d.vals.get(k); if (b) o.push(k + "=" + String(b.n) + "/" + String(b.err)); }
  return o.join(",");
}
function first(ds: Dist[]): Dist | null { return ds.length ? ds[0] : null; }

fxBase();
const all = F(""); const days2 = lastDays(2);
const tt = totals(all, days2);
eq("tools total", String(tt.tools), "10");
eq("errors", String(tt.errors), "3");
eq("sessions top-level / subs", tt.sessions + "/" + tt.subs, "3/1");
eq("bucket totals path", tt.path + "/" + String(tt.callScoped), "buckets/false");
eq("lines", tt.add + "/" + tt.del, "2/1");
eq("all history = 2 days", String(totals(all, null).tools), "10");
const byTool = first(aggregate(all, "call", days2, ["tool"], "count"));
eq("bucket path for tool", byTool ? byTool.path : "", "buckets");
eq("tool counts", dump(byTool), "Bash=3/1,Edit=1/0,Grep=1/1,Read=2/0,exec=1/0,shell=2/1");
const viaRows = first(aggregate(F("status is_one_of ok error unknown"), "call", days2, ["tool"], "count"));
eq("rows path when a call clause", viaRows ? viaRows.path : "", "rows");
eq("bucket = rows for tool counts", dump(viaRows), dump(byTool));
const m = first(aggregate(all, "call", days2, ["model"], "count"));
eq("model needs rows", m ? m.path : "", "rows");
eq("model values", dump(m), "claude-sonnet-4-5=7/2,gpt-x-unpriced=2/1,unknown=1/0");
const ses = first(aggregate(all, "session", days2, ["harness"], "cost"));
eq("session weight cost, unpriced counted", ses ? String(ses.unpriced) : "", "1");
eq("session entity counts sessions", dump(ses), "claude=2/2,codex=1/1,kiro=1/0");
const cs = totals(F("tool is Bash and status is error"), days2);
eq("call-scoped totals", [cs.callScoped, cs.tools, cs.errors, cs.sessions].join(","), "true,1,1,1");
eq("call-scoped cost = the matching session-day", String(cs.cost > 0 && cs.cost < tt.cost), "true");
const multi = first(aggregate(F("harness is codex"), "call", days2, ["program"], "count"));
eq("multi-valued once per value", dump(multi), "git=1/0,npm=2/1");
eq("yesterday only", String(totals(all, [days2[0] ?? ""]).tools), "2");
const z: number[] = []; for (let i = 0; i < HB; i++) z.push(0);
eq("p95 untimed", String(tsOf({ n: 1, err: 0, dn: 0, ms: 0, max: 0, hist: z, out: 0 }, 0.95)), "-1");
const bashT = totals(F("tool is Bash"), days2).perTool.get("Bash");
eq("Bash timed 2 of 3", bashT ? bashT.dn + "/" + bashT.n : "none", "2/3");
const bashB = totals(all, days2).perTool.get("Bash");
eq("Bash timed 2 of 3 (buckets)", bashB ? bashB.dn + "/" + bashB.n : "none", "2/3");
const sl = aggregateWhere(all, days2, ["tool"], "count", (s: Sess, r: Rows, i: number) => r.ms[i] >= 1500);
eq("aggregateWhere", dump(first(sl)), "Bash=1/0,exec=1/0");
eq("minus", dump(first(minus(aggregate(all, "call", days2, ["tool"], "count"), sl))), "Bash=2/1,Edit=1/0,Grep=1/1,Read=2/0,shell=2/1");
eq("session hour = start hour", dump(first(aggregate(all, "session", days2, ["hour"], "count"))), "10=1/1,14=1/1,9=1/1,unknown=1/0");
eq("session tools used (bucket union)", dump(first(aggregate(F("harness is claude"), "session", days2, ["tool"], "count"))), "Bash=1/1,Edit=1/1,Grep=1/1,Read=1/1");
eq("session entity on rows", dump(first(aggregate(F("status is error"), "session", days2, ["tool"], "count"))), "Bash=1/1,Grep=1/1,shell=1/1");
eq("call hour (buckets)", dump(first(aggregate(F("harness is codex"), "call", days2, ["hour"], "count"))), "10=2/0");
const dur = first(aggregate(all, "call", days2, ["tool"], "duration"));
const bd = dur ? dur.vals.get("Bash") : undefined; eq("duration weight", bd ? String(bd.w) : "", "3000");
eq("cached", String(aggregate(all, "call", days2, ["tool"], "count") === aggregate(all, "call", days2, ["tool"], "count")), "true");
console.log(bad ? bad + " failed" : "filter aggregate: all checks passed");
if (bad) process.exit(1);
