// agentglass — triage runs: scriptc build src/features/triage/run.check.ts -o trc && ./trc
// SPDX-License-Identifier: Apache-2.0
import { parse, print } from "../query/parse.ts";
import { fxReset, fxSession, fxBase, isoAt } from "../query/fixture.ts";
import { rank } from "./score.ts";
import { type Run, newRun, runTriage, parseTriageCfg, triageJob, triageStep, triageProgress } from "./run.ts";
let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
// 200 codex shell calls today in one session: 20 errors (6 npm + 14 ls), 180 ok (4 npm + 176 ls) → npm 30% of errors vs 2.2% of rest
function codexCalls(spec: [string, boolean][]): string[] {
  const out: string[] = ["{\"timestamp\":\"" + isoAt(0, 10, 0) + "\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5\"}}"];
  let i = 0;
  for (const [cmd, fail] of spec) {
    i++; const ts = isoAt(0, 10, 0); const id = "c" + String(i);
    out.push("{\"timestamp\":\"" + ts + "\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"bash\\\",\\\"-lc\\\",\\\"" + cmd + "\\\"]}\",\"call_id\":\"" + id + "\"}}");
    out.push("{\"timestamp\":\"" + ts + "\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"" + id + "\",\"output\":\"" + (fail ? "Process exited with code 1" : "ok") + "\"}}");
  }
  return out;
}
function many(cmd: string, fail: boolean, n: number): [string, boolean][] { const o: [string, boolean][] = []; for (let i = 0; i < n; i++) o.push([cmd, fail]); return o; }
fxReset();
fxSession("codex", "p1", "/w/p", "", "gpt-5", codexCalls(many("npm test", true, 6).concat(many("ls", true, 14), many("npm test", false, 4), many("ls", false, 176))));
const r1 = runTriage(newRun("Stats", "call", [], parse("status is error").cs, 1));
eq("sizes", r1.selN + "/" + r1.baseN, "20/180");
const top = rank(r1.rows, false, 3, 3, "");
eq("planted program npm first", top.length ? top[0].attr + " " + top[0].value : "none", "program npm");
eq("npm marked", top.length ? String(top[0].s.sig) : "", "true");
eq("single-valued dims skipped", r1.dimsUsed.indexOf("harness") < 0 && r1.dimsUsed.indexOf("tool") < 0 ? "ok" : r1.dimsUsed.join(","), "ok");
eq("status not a dim when fixed", r1.dimsUsed.indexOf("status") < 0 ? "ok" : "status present", "ok");
const un = rank(r1.rows, true, 3, 3, "");
eq("under: ls first", un.length ? un[0].value : "none", "ls");
// no planted pattern: 20 errors (1 npm + 19 ls), 180 ok (9 npm + 171 ls) → nothing marked
fxReset();
fxSession("codex", "p2", "/w/p", "", "gpt-5", codexCalls(many("npm test", true, 1).concat(many("ls", true, 19), many("npm test", false, 9), many("ls", false, 171))));
const r2 = runTriage(newRun("Stats", "call", [], parse("status is error").cs, 1));
eq("no planted pattern", r2.rows.filter((r) => r.s.sig).length === 0 ? "ok" : r2.rows.filter((r) => r.s.sig).map((r) => r.attr + " " + r.value).join(","), "ok");
// sliced counts (the TUI): a zero budget does one session per step; progress only grows; the result equals a full count;
// the job counts a copy of the run, so a key that changes the run meanwhile does not mix into it
fxReset(); fxBase();
function sliced(r: Run, mutate: boolean): string {
  const j = triageJob(r); let steps = 0; let last = 0; let mono = true;
  if (mutate) { r.days = 30; r.sel = []; }
  while (!triageStep(j, Date.now())) { steps++; const p = triageProgress(j); if (p < last || p > 1) mono = false; last = p; }
  const res = j.res;
  return (steps > 1 ? "sliced" : "one step") + " " + (mono ? "mono" : "not mono") + " " + (res ? res.selN + "/" + res.baseN : "none");
}
eq("sliced rest, run changed meanwhile", sliced(newRun("Stats", "call", [], parse("tool is Bash and status is error").cs, 2), true), "sliced mono 1/9");
const rsl = newRun("Stats", "call", [], [], 2); rsl.slow = true; rsl.preset = 2;
eq("sliced slow (p90 first)", sliced(rsl, false), "sliced mono " + String(runTriage(rsl).selN) + "/" + String(runTriage(rsl).baseN));
eq("sliced slow total", String(runTriage(rsl).selN + runTriage(rsl).baseN), "8");
// rest = scope − selection, two-clause selection (no OR in the grammar)
fxReset(); fxBase();
const r3 = runTriage(newRun("Stats", "call", [], parse("tool is Bash and status is error").cs, 2));
eq("rest = scope − selection, two-clause selection", r3.selN + "/" + r3.baseN, "1/9");
// the selection's own equality values restate it against the rest: not listed (the attributes' other values are)
eq("fixed values not listed", r3.rows.filter((r) => (r.attr === "tool" && r.value === "Bash") || (r.attr === "status" && r.value === "error")).map((r) => r.attr).join(","), "");
// empty baseline: scope already says status is error
const r4 = runTriage(newRun("Stats", "call", parse("status is error").cs, parse("status is error").cs, 2));
eq("empty-baseline guard", r4.guard, "empty-baseline"); eq("offending", print(r4.offending), "status is error");
const r5 = newRun("Stats", "call", parse("status is error").cs, parse("status is error").cs, 2); r5.dropped = r4.offending;
eq("dropping lifts the guard", runTriage(r5).guard, "");
eq("empty selection", runTriage(newRun("Stats", "call", [], parse("tool is Nope").cs, 2)).guard, "empty-selection");
eq("small sample flag", String(r3.small), "true");
// slow: per-tool p90, untimed excluded from both groups (fxBase: Bash 2 timed + 1 untimed; kiro shell untimed)
const rs = newRun("Stats", "call", [], [], 2); rs.slow = true; rs.preset = 2;
const rsr = runTriage(rs);
eq("slow excludes untimed", String(rsr.selN + rsr.baseN), "8");   // 10 calls − Bash sleep (untimed) − kiro shell (untimed)
eq("slow selects some", rsr.selN > 0 && rsr.baseN > 0 ? "ok" : rsr.selN + "/" + rsr.baseN, "ok");
// previous period: calls yesterday vs today
const rp = newRun("Stats", "call", [], [], 1); rp.base = "previous"; rp.preset = 6;
const rpr = runTriage(rp);
eq("previous", rpr.selN + "/" + rpr.baseN, "8/2");
// session entity: hour is the start hour
const rh = runTriage(newRun("Sessions", "session", [], parse("cost is unknown").cs, 2));
eq("session hour = start", rh.rows.filter((r) => r.attr === "hour").map((r) => r.value).join(","), "10");
// session entity rest: the selection's sessions are described whole, the rest is scope − selection
const rt = runTriage(newRun("Sessions", "session", [], parse("tool is Bash").cs, 2));
eq("session sizes", rt.selN + "/" + rt.baseN, "1/3");
eq("session tools of the selection are whole", rt.rows.filter((r) => r.attr === "tool" && r.value === "Read").map((r) => String(r.s.a) + "/" + String(r.s.b)).join(","), "1/0");
// a multi-valued attribute: Bash restates the selection, Read (used in the same sessions) is an answer
eq("multi-valued fixed: the value goes", rt.rows.some((r) => r.attr === "tool" && r.value === "Bash") ? "listed" : "ok", "ok");
// group baseline (compare's t)
const rg = newRun("Compare", "call", [], parse("harness is claude").cs, 2); rg.base = "group"; rg.group = parse("harness is codex").cs;
const rgr = runTriage(rg);
eq("group baseline sizes", rgr.selN + "/" + rgr.baseN, "7/2");
eq("group keeps the selection's own values", rgr.rows.some((r) => r.attr === "harness" && r.value === "claude") ? "ok" : "missing", "ok");
// weighted runs: no chi-square, shares of the weight
const rw = newRun("Stats", "call", [], parse("status is error").cs, 2); rw.weight = "duration";
const rwr = runTriage(rw);
eq("weighted rows unmarked", rwr.rows.filter((r) => r.s.chi2 !== -1).length === 0 && rwr.rows.length > 0 ? "ok" : "chi2 present", "ok");
// config fallbacks
eq("cfg defaults", JSON.stringify(parseTriageCfg({ longCall: "abc", expensiveUsd: -1, minSupport: 1.5 })), "{\"longCall\":\"30s\",\"expensiveUsd\":5,\"minSupport\":3,\"warn\":\"config triage.longCall, triage.expensiveUsd, triage.minSupport invalid — using defaults\"}");
eq("cfg numbers", JSON.stringify(parseTriageCfg({ longCall: 45, expensiveUsd: 2.5, minSupport: 4 })), "{\"longCall\":\"45s\",\"expensiveUsd\":2.5,\"minSupport\":4,\"warn\":\"\"}");
eq("cfg missing", JSON.stringify(parseTriageCfg({})), "{\"longCall\":\"30s\",\"expensiveUsd\":5,\"minSupport\":3,\"warn\":\"\"}");
console.log(bad ? bad + " failed" : "triage runs: all checks passed");
if (bad) process.exit(1);
