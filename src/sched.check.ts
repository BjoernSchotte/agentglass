// agentglass — self-check for the adaptive refresh scheduler: scriptc build src/sched.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { type Act, type Job, type Sched, JOBS, levelOf, base, every, due, ran, sleepFor, forceMs, debugLine, refreshMode, newSched } from "./sched.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const t = 1000000000000;
function act(input: number, focusOut: number, replay: boolean, grow: number, indexing: boolean, live: boolean): Act { return { now: t, input, focusOut, replay, grow, indexing, live }; }

// ── levels (first match) ──
eq("input 1 s ago", levelOf(act(t - 1000, 0, false, 0, false, false)), "hot");
eq("replay", levelOf(act(0, 0, true, 0, false, false)), "hot");
eq("grow 4 s ago", levelOf(act(0, 0, false, t - 4000, false, true)), "hot");
eq("grow 6 s ago, live", levelOf(act(0, 0, false, t - 6000, false, true)), "warm");
eq("indexing", levelOf(act(0, 0, false, 0, true, false)), "hot");
eq("focus-out, input before", levelOf(act(t - 200000, t - 100000, false, 0, false, false)), "away");
eq("focus-out, input after (2 min ago)", levelOf(act(t - 120000, t - 130000, false, 0, false, false)), "idle");
eq("no focus-out, input 10 min ago: never away", levelOf(act(t - 600000, 0, false, 0, false, false)), "idle");
eq("live, no input", levelOf(act(0, 0, false, 0, false, true)), "warm");
eq("nothing", levelOf(act(0, 0, false, 0, false, false)), "idle");
eq("focus-out and indexing", levelOf(act(0, t - 1000, false, 0, true, false)), "hot");
eq("focus-out, live: away", levelOf(act(0, t - 1000, false, 0, false, true)), "away");

// ── table ──
eq("scan idle", String(base("scan", "idle", false, false, false)), "10000");
eq("procs idle live", String(base("procs", "idle", true, false, false)), "1500");
eq("procs idle", String(base("procs", "idle", false, false, false)), "5000");
eq("procs hot live", String(base("procs", "hot", true, false, false)), "1000");
for (const lv of ["hot", "warm", "idle", "away"]) {
  const l = lv === "hot" ? "hot" : lv === "warm" ? "warm" : lv === "idle" ? "idle" : "away";
  eq("watch live " + lv, String(base("watch", l, true, false, false)), "1500");
  eq("watch " + lv, String(base("watch", l, false, false, false)), "5000");
}
eq("fast idle", String(base("fast", "idle", false, false, false)), "-1");
eq("size winch", String(base("size", "hot", false, false, true)), "-1");
eq("size away", String(base("size", "away", false, false, false)), "10000");
eq("fixed tick", String(base("tick", "idle", false, true, false)), "500");
eq("fixed procs", String(base("procs", "idle", false, true, false)), "1500");
eq("fixed scan", String(base("scan", "hot", false, true, false)), "3000");
eq("fixed probe off", String(base("probe", "hot", false, true, false)), "-1");

// ── budget ──
let sc = newSched(false, false, t);
sc.lv = "hot";
ran(sc, "scan", t, 800);
eq("scan stretched", String(every(sc, "scan", false, false)), "16000");
ran(sc, "scan", t, 800);
eq("ewma steady", String(every(sc, "scan", false, false)), "16000");
sc.lv = "away";
ran(sc, "procs", t, 200);
eq("procs live capped", String(every(sc, "procs", true, false)), "1500");
eq("procs not live stretched to base", String(every(sc, "procs", false, false)), "5000");
ran(sc, "watch", t, 500);
eq("watch live capped", String(every(sc, "watch", true, false)), "1500");
eq("watch not live stretched", String(every(sc, "watch", false, false)), "10000");
const fx = newSched(true, false, t);
ran(fx, "scan", t, 800);
eq("fixed ignores ewma", String(every(fx, "scan", false, false)), "3000");
eq("fixed fast unarmed", String(every(fx, "fast", false, false)), "-1");
eq("fixed fast armed", String(every(fx, "fast", false, true)), "50");

// ── fast ──
sc = newSched(false, false, t); sc.lv = "hot";
eq("fast armed hot", String(every(sc, "fast", false, true)), "50");
eq("fast not armed", String(every(sc, "fast", false, false)), "-1");
eq("fast not armed: not due", String(due(sc, t + 60000, false, false).indexOf("fast")), "-1");
sc.lv = "idle";
eq("fast armed idle", String(every(sc, "fast", false, true)), "-1");

// ── unfocused cap ──
sc = newSched(false, false, t); sc.lv = "hot"; sc.unf = true;
eq("unf render hot", String(every(sc, "render", false, false)), "1000");
eq("unf tick hot", String(every(sc, "tick", false, false)), "250");
eq("unf probe hot", String(every(sc, "probe", false, false)), "250");
eq("unf watch live", String(every(sc, "watch", true, false)), "1500");
sc.lv = "away";
eq("unf render away", String(every(sc, "render", false, false)), "5000");
sc.lv = "hot"; sc.unf = false;
eq("focused render hot", String(every(sc, "render", false, false)), "250");

// ── due ──
sc = newSched(false, false, t); sc.lv = "hot";
eq("tick not due at 249", String(due(sc, t + 249, false, false).indexOf("tick")), "-1");
const d250 = due(sc, t + 250, false, false);
eq("tick due at 250", String(d250.indexOf("tick") >= 0 && d250.indexOf("probe") >= 0), "true");
function all(sc2: Sched, last: number): string {
  for (const j of JOBS) ran(sc2, j, last, 0);
  return due(sc2, t, false, false).join(",");
}
const scheduled = "size,procs,scan,slow,probe,tick,watch,render";
eq("clock back: all due", all(newSched(false, false, t), t + 60000), scheduled);
eq("clock forward 11 min: all due", all(newSched(false, false, t), t - 660000), scheduled);
const dd = due(sc, t + 600000, false, false);
eq("render last", dd.length ? dd[dd.length - 1] : "", "render");

// ── sleep ──
sc = newSched(false, false, t); sc.lv = "idle";
eq("sleep max", String(sleepFor(sc, t, false, false)), "1000");
sc.lv = "hot";
eq("sleep min", String(sleepFor(sc, t, false, true)), "50");
eq("sleep floor", String(sleepFor(sc, t + 600000, false, false)), "16");
eq("sleep hot", String(sleepFor(sc, t + 100, false, false)), "150");

eq("force away", String(forceMs("away")), "5000");
eq("force hot", String(forceMs("hot")), "1000");

// ── config ──
let m = refreshMode("", "");
eq("default", m.mode + "|" + m.err, "adaptive|");
m = refreshMode("fixed", "adaptive");
eq("env wins", m.mode + "|" + m.err, "fixed|");
m = refreshMode("", "fixed");
eq("config", m.mode, "fixed");
m = refreshMode("", "fast");
eq("invalid", m.mode + "|" + String(m.err.indexOf("fast") >= 0), "adaptive|true");

// ── debug line ──
sc = newSched(false, false, t); sc.lv = "hot";
eq("debug starts", debugLine(sc, false, false).slice(0, 7), "lvl hot");
ran(sc, "procs", t, 200);
eq("procs slow", String(debugLine(sc, true, false).indexOf("procs slow") >= 0), "true");
eq("procs not slow without live", String(debugLine(sc, false, false).indexOf("procs slow") >= 0), "false");
const j0: Job = "tick";
eq("debug shows tick", String(debugLine(sc, false, false).indexOf(j0 + " 0ms/250ms") >= 0), "true");

console.log(bad ? bad + " failed" : "sched: all checks passed");
if (bad) process.exit(1);
