// agentglass — self-check: the Stats and Repos aggregates of a call-row filter never read a calls file in a frame (they
// defer like the Sessions list), say "filtering n/m" meanwhile and end at the eager numbers: scriptc build src/features/query/fill.check.ts -o fc && ./fc
// SPDX-License-Identifier: Apache-2.0
import { rmSync } from "node:fs";
import { sessions } from "../../model/sessions.ts";
import { P } from "../../model/project.ts";
import { parse } from "./parse.ts";
import { EMPTY, compile } from "./eval.ts";
import { fillOnForTest, fillStep, fillChip, fillEmpty, rowsFill } from "./ui.ts";
import { fxBase } from "./fixture.ts";
import { ledger, unread, LAZY } from "../usage/ledger.ts";
import { saveCallsTo, loadCallsFrom } from "../usage/callcache.ts";
import { newRows } from "../usage/rows.ts";
import { statsSummaryFor, statsFillFor, statsDrillFor } from "../usage/stats.ts";
import { repoAgg, repoFillFor } from "../repos/agg.ts";
import { L, lastDays } from "../usage/record.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }
P.sync = true; // projects resolve on first ask (no tick here)

const days = lastDays(7);
function summary(expr: string): string { const t = statsSummaryFor(expr); return [t.sess, t.tools, t.cost.toFixed(6), t.inTok, t.outTok, t.add, t.del].join(" "); }
function repos(expr: string): string {
  const f = compile(parse(expr).cs, "stats").f ?? EMPTY;
  return repoAgg(days, f).map((r) => r.key + ":" + String(r.sessions) + "/" + String(r.calls) + "/" + String(r.err) + "/" + r.cost.toFixed(6)).sort().join(" ");
}
function drill(expr: string): string { const d = statsDrillFor(expr, "Bash"); return [d.n, d.err, d.all].join(" "); }
const EXPRS = ["tool is Bash", "tool is Bash and harness is claude", "model ~ sonnet and tool is Edit", "status is error and tool is_not Read"];

fxBase();
for (const e of EXPRS) eq(e + ": compiles", String(compile(parse(e).cs, "stats").err === null), "true");
const eager = new Map<string, string>();
for (const e of EXPRS) eager.set(e, summary(e) + " | " + repos(e) + " | " + drill(e));
eq("eager: the Bash filter matches something", String((eager.get("tool is Bash") ?? "").startsWith("0 ")), "false");

// every calls file unread, as after a warm start
const dir = "/tmp/agentglass-fill-check-" + String(process.pid); rmSync(dir, { recursive: true, force: true });
function unreadAll(): void {
  for (const s of sessions.values()) { const a = ledger.get(s.path); if (a && !unread.has(s.path)) { saveCallsTo(dir, s.path, a); a.rows = newRows(); a.lastCall = -1; unread.add(s.path); } }
  L.ver++; // as after a load: no aggregate made before stands
}
unreadAll();
const was = LAZY.rows; let reads = 0;
LAZY.rows = (path: string, a) => { reads++; const r = loadCallsFrom(dir, path, a); if (!r) return false; a.rows = r; a.lastCall = r.n - 1; return true; };
fillOnForTest(true);
for (const e of EXPRS) {
  // the first pass reads nothing and reports what it left out
  const r0 = reads; const n0 = unread.size;
  drill(e); repos(e); summary(e); // the drill and the table share the tab's progress (one shows at a time): the table last
  eq(e + ": first pass reads no calls file", String(reads - r0) + " " + String(unread.size), "0 " + String(n0));
  const st = statsFillFor(e); const rt = repoFillFor(days, e);
  eq(e + ": Stats deferred some", String(st.left > 0 && st.left === st.total), "true");
  eq(e + ": Repos deferred the same", String(rt.left) + "/" + String(rt.total), String(st.left) + "/" + String(st.total));
  eq(e + ": the chip", plain(fillChip(st)), " · filtering 0/" + String(st.total));
  eq(e + ": the empty text", String(plain(fillEmpty(st)).startsWith("filtering… 0/" + String(st.total))), "true");
  // slices fill in; every pass in between reads nothing itself, n grows to m
  let guard = 0; let last = -1;
  while (fillStep(0) && guard < 50) {
    guard++; const r1 = reads; drill(e); repos(e); summary(e);
    eq(e + ": a pass between slices reads nothing", String(reads - r1), "0");
    const s2 = statsFillFor(e); if (s2.left > 0) { eq(e + ": n never falls", String(s2.total - s2.left >= last), "true"); last = s2.total - s2.left; }
  }
  const dr = drill(e); eq(e + ": filled: exact numbers", summary(e) + " | " + repos(e) + " | " + dr, eager.get(e) ?? "");
  eq(e + ": filled: no progress left", JSON.stringify(statsFillFor(e)) + JSON.stringify(repoFillFor(days, e)), "{\"left\":0,\"total\":0}{\"left\":0,\"total\":0}");
  eq(e + ": filled: no chip", fillChip(statsFillFor(e)), "");
  unreadAll();
}
// a filter without row clauses: nothing is deferred or queued
summary("harness is claude"); eq("no row clauses: nothing queued", String(fillStep(0)), "false");
// the queue of an abandoned call filter stops when the tab's filter changes
summary("tool is Bash"); summary("harness is claude");
eq("filter changed: the Stats queue is dropped", String(fillStep(0)) + " " + JSON.stringify(rowsFill("Stats", "x")), "false {\"left\":0,\"total\":0}");
fillOnForTest(false);
// one-shot runs (no fill): the eager read, unchanged
unreadAll(); LAZY.rows = (path: string, a) => { const r = loadCallsFrom(dir, path, a); if (!r) return false; a.rows = r; a.lastCall = r.n - 1; return true; };
eq("one-shot: eager at once", summary("tool is Bash"), (eager.get("tool is Bash") ?? "").split(" | ")[0] ?? "");
LAZY.rows = was; rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "stats/repos fill: all checks passed");
if (bad) process.exit(1);
