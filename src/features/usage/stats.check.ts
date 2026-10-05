// agentglass — self-check for the Stats top-tools list (skill markers lead: a long name is cut, they are not): scriptc build src/features/usage/stats.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { toolRows, allowGauge, open, statsTotalsFor, statsSummaryFor, periodMessage, statsPeriod } from "./stats.ts";
import { parse } from "../query/parse.ts";
import { EMPTY, compile } from "../query/eval.ts";
import { fxBase } from "../query/fixture.ts";
import { MPS } from "../query/ui.ts";
import { type Cnt, newCnt } from "./calls.ts";
import { vwidth } from "../../util/text.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function m(kv: [string, number][]): Map<string, Cnt> { const r = new Map<string, Cnt>(); for (const [k, n] of kv) { const c = newCnt(); c.n = n; r.set(k, c); } return r; }
const names = m([["Bash", 5], ["mcp__s__t", 2]]);
const skills = m([["command\tcodex", 3], ["model\tcodex", 5], ["model\tbrainstorming", 1]]);
const show = (): string => toolRows(names, skills).map((r) => r.label + " " + String(r.n)).join(" | ");

const c1 = show(); ok("collapsed: skills group sorted by uses", c1 === "✧ skills 9 | Bash 5 | s 2", c1);
const g = toolRows(names, skills).find((r) => r.skill && !r.kid);
ok("group row: a skill group, not a server", !!g && !g.server && g.err === 0, g ? g.key : "none");
open.add(g ? g.key : "");
const c2 = show(); ok("expanded: kids by uses, sources marked", c2 === "✧ skills 9 | /3 ⚙5 codex 8 | ⚙ brainstorming 1 | Bash 5 | s 2", c2);
const kid = toolRows(names, skills).find((r) => r.skill && r.kid);
ok("kid row: a skill kid", !!kid && kid.key === "skill\tcodex", kid ? kid.key : "none");
const c3 = toolRows(names, m([["command\tx", 2]])).map((r) => r.label + " " + String(r.n)).join(" | ");
ok("command-only kid", c3 === "Bash 5 | s 2 | ✧ skills 2 | / x 2", c3);
const c4 = toolRows(names, new Map<string, Cnt>()).map((r) => r.label).join(" | ");
ok("no skills: no group row", c4 === "Bash | s", c4);
// filtered Stats: the summary row equals totals() of the same filter (bucket and row paths)
fxBase();
for (const ex of ["", "harness is codex", "repo is agentglass", "subagent is false"]) {
  const a = statsSummaryFor(ex); const t = statsTotalsFor(ex);
  const sa = [a.tools, a.cost.toFixed(9), a.inTok, a.outTok, a.add, a.del, a.sess].join(","); const st = [t.tools, t.cost.toFixed(9), t.inTok, t.outTok, t.add, t.del, t.sessions].join(",");
  ok("summary = totals: " + (ex || "(none)"), sa === st, sa + " vs " + st);
}
ok("today unfiltered", statsSummaryFor("").tools === 8, String(statsSummaryFor("").tools));
const cs = statsSummaryFor("tool is Bash and status is error"); const ct = statsTotalsFor("tool is Bash and status is error");
ok("call-scoped", cs.scoped && cs.tools === 1 && ct.callScoped && ct.tools === 1 && cs.cost === ct.cost && cs.cost > 0, [cs.scoped, cs.tools, ct.tools, cs.cost, ct.cost].join(","));
// a content clause asks its matching paths once per aggregation, not per session or call row (each ask walks every session)
for (const ex of ["content ~ zzz", "content ~ zzz and tool is Bash"]) {
  const n0 = MPS.asks; statsSummaryFor(ex);
  ok("content paths asked once: " + ex, MPS.asks - n0 === 1, String(MPS.asks - n0));
}
const old = compile(parse("day is 2020-01-01").cs, "stats").f ?? EMPTY;
ok("empty period ∩ day", periodMessage(old, statsPeriod()) === "today does not match day is 2020-01-01", periodMessage(old, statsPeriod()));
ok("period intersects", periodMessage(compile(parse("day is today").cs, "stats").f ?? EMPTY, statsPeriod()) === "", "");
// allowance gauges (Codex rate limits, Claude plan): every window, the fuller bold; narrow drops the others, then the gauge
{
  const plain = (t: string): string => t.replace(/\x1b\[[0-9;]*m/g, "");
  const ws = [{ lbl: "5h", pct: 13, hi: false }, { lbl: "7d", pct: 64, hi: true }];
  const g = allowGauge("cx", ws, 80);
  ok("gauge: both windows", plain(g) === " · cx 5h 13% 7d 64%" && vwidth(g) === 19, plain(g));
  ok("gauge: the fuller one bold", g.indexOf("\x1b[1m7d 64%") >= 0 && g.indexOf("\x1b[1m5h") < 0, JSON.stringify(g));
  ok("gauge: narrow keeps the fuller window", plain(allowGauge("cx", ws, 18)) === " · cx 7d 64%", plain(allowGauge("cx", ws, 18)));
  ok("gauge: too narrow = nothing", allowGauge("cx", ws, 11) === "" && allowGauge("cx", [], 80) === "", allowGauge("cx", ws, 11));
}
console.log(bad ? bad + " failed" : "stats: all checks passed");
if (bad) process.exit(1);
