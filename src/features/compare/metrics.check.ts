// agentglass — self-check for compare's summary metrics: scriptc build src/features/compare/metrics.check.ts -o mc && ./mc
// SPDX-License-Identifier: Apache-2.0
import { money } from "../usage/costs.ts";
import { statsTotalsFor } from "../usage/stats.ts";
import { parse } from "../query/parse.ts";
import { totals } from "../query/agg.ts";
import { compile } from "../query/eval.ts";
import { type Metric, type Cmp, type Group, groupOfSession, groupOfExpr, compareGroups, cmpJob, cmpStep } from "./metrics.ts";
import { cmpBase, cmpCleanup, sess, costOf, prompt, call, TMP } from "./fixture.ts";
import { fxSession, isoAt } from "../query/fixture.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function rowOf(c: Cmp, k: string): Metric | null { for (const m of c.rows) if (m.key === k) return m; return null; }
function val(c: Cmp, k: string): string { const m = rowOf(c, k); return m ? m.a + " | " + m.b + " | " + m.d + " | " + m.r + " | " + String(m.tone) : "missing"; }
function part(c: Cmp, k: string, i: number): string { return val(c, k).split(" | ")[i] ?? ""; }
function G(src: string): Group { const r = groupOfExpr(src); if (!r.g) { bad++; console.log("FAIL group " + src + ": " + (r.err ? r.err.msg : "")); return groupOfSession(sess("a1")); } return r.g; }

cmpBase();
const A = groupOfSession(sess("a1")); const B = groupOfSession(sess("b1"));
const c = compareGroups(A, B, [], true, null);
eq("sessions row hidden for two singles", rowOf(c, "sessions") === null ? "hidden" : "shown", "hidden");
eq("tool calls", val(c, "tools"), "5 | 10 | +5 | ×2.0 | 0");
eq("errors", val(c, "errors"), "1 | 1 | 0 | ×1.0 | 0");
eq("error rate", val(c, "error_rate"), "20.0% | 10.0% | −10.0 pp |  | -1");
eq("tokens in", val(c, "in"), "2.0K | 6.8K | +4.8K | ×3.4 | 0");
eq("cache hit", val(c, "cache_hit"), "75.0% | 30.6% | −44.4 pp |  | 0");
eq("wall", val(c, "wall"), "20m0s | 50m0s | +30m0s | ×2.5 | 0");
// active time: union of the side's session-day minutes. b1: 11:00–11:08, 11:25–11:41 (the 11:20 task notification is no
// activity), 11:48–11:49; its subagent's 11:10–11:12 falls into b1's idle gap and adds 2 → 27. a1 touches 21 clock
// minutes in 20 minutes of wall time: active never exceeds wall (whole minutes count, a session's span does not)
eq("active", val(c, "active"), "20m0s | 27m0s | +7m0s | ×1.4 | 0");
eq("active ≤ wall (--json)", String(c.a.active) + " " + String(c.a.wall), "1200000 1200000");
eq("files", val(c, "files"), "2 | 2 | 0 | ×1.0 | 0");
eq("lines", val(c, "lines"), "+4 −1 | +7 −2 |  |  | 0");
eq("models", val(c, "models"), "claude-sonnet-4-5 | claude-opus-4-5, claude-sonnet-4-5 |  |  | 0");
eq("subagents included", val(c, "subagents").split(" | ")[1] ?? "", "1 · " + money(costOf("b1s"), c.b.bill || "unknown"));
eq("subagents none", val(c, "subagents").split(" | ")[0] ?? "", "0");
eq("turns (top-level, notification not counted)", val(c, "turns"), "1 | 2 | +1 | ×2.0 | 0");
eq("timed", val(c, "timed"), "5/5 | 10/10 |  |  | 0");
eq("calls per turn", val(c, "calls_turn"), "5.0 | 5.0 | 0 | ×1.0 | 0");
eq("cost per turn", part(c, "cost_turn", 0), money(costOf("a1"), c.a.bill));
eq("cost cell", part(c, "cost", 1).indexOf(money(costOf("b1") + costOf("b1s"), c.b.bill)) === 0 ? "ok" : part(c, "cost", 1), "ok");
eq("cost tone", part(c, "cost", 4), costOf("b1") + costOf("b1s") > costOf("a1") ? "1" : "-1");
// the sign goes after an estimate's ≈ ("≈+$0.07", never "+≈$0.07")
const dm = money(costOf("b1") + costOf("b1s") - costOf("a1"), c.a.bill === c.b.bill ? c.a.bill : "");
eq("cost Δ", part(c, "cost", 2), dm.startsWith("≈") ? "≈+" + dm.slice(1) : "+" + dm);
eq("cost Δ sign after ≈", part(c, "cost", 2).indexOf("+≈") < 0 && part(c, "cost", 2).indexOf("≈") <= 0 ? "ok" : part(c, "cost", 2), "ok");
const cx = compareGroups(A, B, [], false, null);
const tx = rowOf(cx, "tools");
eq("subagents excluded", tx ? tx.b : "", "8");
eq("subagents excluded: row", part(cx, "subagents", 1), "0");
eq("subagents excluded: tokens", part(cx, "in", 1), "6.0K");
eq("subagents excluded: cache hit", part(cx, "cache_hit", 1), "33.3%");
eq("subagents excluded: turns", part(cx, "turns", 1), "2");
// unknown → n/a, no Δ: fx has no durations and no price
const cf = compareGroups(groupOfSession(sess("f1")), A, [], true, null);
const p95 = rowOf(cf, "p95");
eq("unknown → n/a, no Δ", p95 ? p95.a + "|" + p95.d + "|" + p95.r : "", "n/a||");
eq("untimed counted as timed 0", part(cf, "timed", 0), "0/1");
eq("turns fx", part(cf, "turns", 0), "1");
eq("same", String(compareGroups(A, A, [], true, null).same), "true");
eq("same (prefix vs canonical)", String(compareGroups(G("session is claude:a1"), A, [], true, null).same), "true");
eq("not same", String(c.same), "false");
const e = compareGroups(A, G("harness is pi"), [], true, null);
eq("empty group", String(e.emptyB) + String(e.emptyA), "truefalse");
eq("empty group counts zero", part(e, "tools", 1), "0");
// unpriced: cost ? and no Δ
cmpBase();
const up = compareGroups(A, G("harness is fx"), [], true, null);
const cu = rowOf(up, "cost");
eq("unpriced fx: cost cell", cu ? cu.b : "", "≈$0.00");
// an unpriced side has no cost per turn; the priced side keeps its own (no Δ between them)
const u1 = fxSession("claude", "u1", TMP + "/app", "", "zz-mystery-1", [prompt(isoAt(0, 7, 0), "hi")].concat(call(isoAt(0, 7, 1), "mu1", "zz-mystery-1", "{\"input_tokens\":500,\"output_tokens\":50}", "Bash", "u1c1", "{\"command\":\"ls\"}", 100, false)));
const cu2 = compareGroups(groupOfSession(u1), A, [], true, null);
eq("unpriced side: cost +?", part(cu2, "cost", 0) + " | " + part(cu2, "cost", 2), "cost ? | ");
eq("cost per turn beside an unpriced side", val(cu2, "cost_turn"), "n/a | " + money(costOf("a1"), cu2.b.bill) + " |  |  | 0");
cmpBase();
// a group whose expression does not compile: n/a everywhere, its message kept
const bad1 = compareGroups(A, { label: "x", cs: parse("tool is Bash and session is abc").cs, single: null }, [], true, null);
eq("compile error side", bad1.b.err + " | " + part(bad1, "tools", 1) + " | " + String(bad1.emptyB), "session \"abc\": id prefix needs at least 6 characters | n/a | true");
// sessions row for expression groups; wall hidden without a single session
const eg = compareGroups(G("model ~ sonnet"), G("model ~ opus"), [], true, null);
eq("sessions row shown", val(eg, "sessions").split(" | ").slice(0, 2).join(" | "), "1 | 1");
eq("wall hidden without singles", rowOf(eg, "wall") === null ? "hidden" : "shown", "hidden");
// a call clause: tools from matching rows only
const cc = compareGroups(G("tool is Bash"), G("tool is Edit"), [], true, null);
eq("call clause groups", val(cc, "tools").split(" | ").slice(0, 2).join(" | "), "3 | 4");
// scope applies to both groups as a plain AND (never merged into one_of)
const sc = compareGroups(G("harness is claude"), G("harness is fx"), parse("harness is claude").cs, true, null);
eq("scope ∧ group", String(sc.emptyB) + " " + part(sc, "tools", 0), "true 15");
// periods: today vs yesterday equal Stats per-day totals
const tp = compareGroups(G("day is yesterday"), G("day is today"), [], true, null);
eq("period B tools = Stats today", part(tp, "tools", 1), String(statsTotalsFor("day is today").tools));
eq("period A empty", String(tp.emptyA), "true");
// the resumable job ends with the same result as the one-shot count, in small slices
const j = cmpJob(G("model ~ sonnet"), G("harness is claude"), [], true, null); let steps = 0;
while (!cmpStep(j, Date.now() - 1)) steps++;
eq("job in slices", j.res ? val(j.res, "tools") : "none", val(compareGroups(G("model ~ sonnet"), G("harness is claude"), [], true, null), "tools"));
eq("job yielded", steps > 2 ? "ok" : String(steps), "ok");
// totals() and the resumable count agree (the refactor kept totals)
const tf = compile(parse("harness is claude").cs, "list").f;
eq("totals sessions", tf ? String(totals(tf, null).sessions) + "/" + String(totals(tf, null).subs) : "", "2/1");
cmpCleanup();
console.log(bad ? String(bad) + " failed" : "compare metrics: all checks passed");
if (bad) process.exit(1);
