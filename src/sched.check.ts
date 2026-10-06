// agentglass — self-check for the adaptive refresh scheduler: scriptc build src/sched.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { H, armed } from "./hooks.ts";
import { type Act, type Job, type Sched, JOBS, fastDraw, levelOf, base, every, due, ran, sleepFor, forceMs, debugLine, refreshMode, newSched, runJob, hotWhy } from "./sched.ts";

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

// ── the fast job follows what is armed: 50 ms for a replay, the marquee's 150 ms otherwise ──
{ const f = newSched(false, false, t); f.lv = "hot"; eq("fast default (replay)", String(every(f, "fast", false, true)), "50"); f.fastMs = 150; eq("fast for the marquee", String(every(f, "fast", false, true)), "150"); eq("fast unarmed", String(every(f, "fast", false, false)), "-1"); }
// ── table ──
eq("scan idle", String(base("scan", "idle", false, false, false)), "10000");
eq("procs idle live", String(base("procs", "idle", true, false, false)), "1500");
eq("procs idle", String(base("procs", "idle", false, false, false)), "5000");
eq("procs hot live", String(base("procs", "hot", true, false, false)), "1500");
// hot is never busier than the old fixed loop for data jobs (an agent streaming keeps the level hot all day):
// procs 1.5 s, scan 3 s, slow 5 s, tick 500 ms; only render (on change) and the stat-only probe are faster
for (const j of ["procs", "scan", "slow", "tick"]) {
  const jj: Job = j === "procs" ? "procs" : j === "scan" ? "scan" : j === "slow" ? "slow" : "tick";
  eq("hot " + j + " = fixed", String(base(jj, "hot", false, false, false)), String(base(jj, "hot", false, true, false)));
}
eq("hot render", String(base("render", "hot", false, false, false)), "250");
eq("hot probe", String(base("probe", "hot", false, false, false)), "250");
for (const lv of ["hot", "warm", "idle", "away"]) {
  const l = lv === "hot" ? "hot" : lv === "warm" ? "warm" : lv === "idle" ? "idle" : "away";
  eq("watch live " + lv, String(base("watch", l, true, false, false)), "1500");
  eq("watch " + lv, String(base("watch", l, false, false, false)), "5000");
  // the tick keeps its level's cadence and budget with agents live (the watch job books a live log the ledger is behind
  // on before rules read it: main.ts); a costly tick is not pulled to the alarm cadence
  eq("tick live = tick " + lv, String(base("tick", l, true, false, false)), String(base("tick", l, false, false, false)));
  const q = newSched(false, false, t); q.lv = l; cost(q, "tick", 400); q.unf = lv === "away";
  eq("tick live keeps its budget " + lv, String(every(q, "tick", true, false) > 4000), "true");
}
eq("tick away: 5 s", String(base("tick", "away", true, false, false)), "5000");
eq("fast idle", String(base("fast", "idle", false, false, false)), "-1");
eq("size winch", String(base("size", "hot", false, false, true)), "-1");
eq("size away", String(base("size", "away", false, false, false)), "10000");
eq("fixed tick", String(base("tick", "idle", false, true, false)), "500");
eq("fixed procs", String(base("procs", "idle", false, true, false)), "1500");
eq("fixed scan", String(base("scan", "hot", false, true, false)), "3000");
eq("fixed probe off", String(base("probe", "hot", false, true, false)), "-1");

// ── budget ──
// a job's cost in steady state: n runs of dur ms (one sample counts at most 4× the average, so it takes a few runs)
function cost(s2: Sched, j: Job, dur: number): void { for (let i = 0; i < 80; i++) ran(s2, j, t, dur); }
let sc = newSched(false, false, t);
sc.lv = "hot";
ran(sc, "scan", t, 800);
eq("one slow run barely stretches", String(every(sc, "scan", false, false)), "3000");
cost(sc, "scan", 800);
eq("scan stretched", String(Math.round(every(sc, "scan", false, false))), "16000");
const sp = newSched(false, false, t); sp.lv = "hot";
cost(sp, "tick", 10);
ran(sp, "tick", t, 900); // a cache save inside the tick
eq("one burst barely stretches", String(every(sp, "tick", false, false) < 1000), "true");
for (let i = 0; i < 8; i++) ran(sp, "tick", t, 800);
eq("a sustained cost converges", String(every(sp, "tick", false, false) > 12000), "true");
sc.lv = "away";
cost(sc, "procs", 200);
eq("procs live capped", String(every(sc, "procs", true, false)), "1500");
eq("procs not live stretched to base", String(every(sc, "procs", false, false)), "5000");
cost(sc, "watch", 500);
eq("watch live capped", String(every(sc, "watch", true, false)), "1500");
eq("watch not live stretched", String(Math.round(every(sc, "watch", false, false))), "10000");
cost(sc, "tick", 100);
eq("tick stretched", String(every(sc, "tick", false, false)), "5000");
sc.burst = true;
eq("indexing burst: tick keeps its cadence", String(every(sc, "tick", false, false)), "5000");
sc.lv = "hot";
eq("indexing burst hot", String(every(sc, "tick", false, false)), "250");
sc.burst = false;
eq("burst over: stretched", String(Math.round(every(sc, "tick", false, false))), "2000");
sc.lv = "away";
const fx = newSched(true, false, t);
cost(fx, "scan", 800);
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
eq("unf render hot", String(every(sc, "render", false, false)), "5000");
eq("unf tick hot", String(every(sc, "tick", false, false)), "1000");
eq("unf scan hot", String(every(sc, "scan", false, false)), "6000");
eq("unf probe hot", String(every(sc, "probe", false, false)), "250");
eq("unf probe hot, live: rides on watch", String(every(sc, "probe", true, false)), "-1");
sc.fastMs = 150; eq("unf marquee paused", String(every(sc, "fast", false, true)), "-1");
sc.fastMs = 50; eq("unf replay goes on", String(every(sc, "fast", false, true)), "50"); sc.fastMs = 150;
eq("unf size", String(every(sc, "size", false, false)), "10000");
eq("unf watch live", String(every(sc, "watch", true, false)), "1500");
// a young agent with no session yet: its first log may come any moment, in any level (a first prompt)
sc.lv = "away"; eq("away scan", String(every(sc, "scan", false, false)), "15000");
sc.pend = true; eq("away scan, agent pending", String(every(sc, "scan", false, false)), "2000"); eq("away slow, agent pending", String(every(sc, "slow", false, false)), "2000"); sc.pend = false;
eq("away slow", String(every(sc, "slow", false, false)), "30000");
sc.lv = "away";
eq("unf render away", String(every(sc, "render", false, false)), "5000");
sc.lv = "hot"; sc.unf = false;
eq("focused render hot", String(every(sc, "render", false, false)), "250");

// ── due ──
sc = newSched(false, false, t); sc.lv = "hot";
// a data job due within a quarter of its interval (≤ 100 ms) shares a wake with one that is due; alone it waits
eq("tick shares the wake at 450 (probe due)", String(due(sc, t + 450, false, false).indexOf("tick") >= 0), "true");
{ const q = newSched(false, false, t); q.lv = "hot"; for (const j of ["size", "procs", "scan", "slow", "probe", "watch", "fast", "render"]) { const x = q.js.get(j); if (x) x.last = t + 440; }
  eq("tick alone not early at 450", String(due(q, t + 450, false, false).length), "0");
  eq("render never early (tick due at 680)", String(due(q, t + 680, false, false).indexOf("render")) + String(due(q, t + 680, false, false).indexOf("tick") >= 0), "-1true"); }
const d250 = due(sc, t + 250, false, false);
eq("probe due at 250", String(d250.indexOf("probe") >= 0 && d250.indexOf("tick") < 0), "true");
eq("tick due at 500", String(due(sc, t + 500, false, false).indexOf("tick") >= 0), "true");
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
eq("debug starts", debugLine(sc, false, false, "", "").slice(0, 7), "lvl hot");
cost(sc, "procs", 200);
eq("procs slow", String(debugLine(sc, true, false, "", "").indexOf("procs slow") >= 0), "true");
eq("procs not slow without live", String(debugLine(sc, false, false, "", "").indexOf("procs slow") >= 0), "false");
eq("debug extra after the level", debugLine(sc, false, false, "grow", "rss 12M").slice(0, 26), "lvl hot (grow) · rss 12M ·");
eq("debug why", debugLine(sc, false, false, "grow", "").slice(0, 14), "lvl hot (grow)");
eq("hotWhy", hotWhy(act(t - 1000, 0, false, t - 1000, true, false)), "input+grow+index");
const j0: Job = "tick";
eq("debug shows tick", String(debugLine(sc, false, false, "", "").indexOf(j0 + " 0ms/500ms") >= 0), "true");

// ── runJob: a throwing job never escapes, warns once per job, is still recorded ──
sc = newSched(false, false, t);
let warns = 0; let clock = t;
const boom = (): void => { throw new Error("boom"); };
for (let i = 1; i <= 3; i++) {
  clock = t + i * 1000;
  runJob(sc, "tick", boom, () => clock, (msg: string) => { warns++; if (msg.indexOf("tick") < 0 || msg.indexOf("boom") < 0) eq("warn text", msg, "refresh tick failed: Error: boom"); });
  const x = sc.js.get("tick");
  eq("throwing job recorded " + String(i), String(x ? x.last : 0), String(clock));
}
eq("warned once", String(warns), "1");
runJob(sc, "scan", boom, () => clock, (msg: string) => { warns++; });
eq("other job warns too", String(warns), "2");
const busy = (): void => { const e = Date.now() + 30; while (Date.now() < e) { /* busy */ } };
runJob(sc, "probe", busy, () => Date.now(), (msg: string) => { warns++; });
const px = sc.js.get("probe");
eq("duration measured", String(px ? px.ew >= 9 : false), "true"); // 0.3 × 30

// ── fast frames: a marquee step redraws the header row only; body changes (replay) the whole frame; unfocused: mark dirty ──
eq("fast nothing", fastDraw(false, false, false), "");
eq("fast header", fastDraw(false, true, false), "header");
eq("fast full", fastDraw(true, true, false), "full");
eq("fast unfocused header: nothing", fastDraw(false, true, true), "");
eq("fast unfocused full", fastDraw(true, false, true), "dirty");

// ── fast arm seam ──
eq("nothing armed", String(armed()), "false");
H.fastArmed.push(() => false); H.fastArmed.push(() => true);
eq("one armed", String(armed()), "true");
H.fastArmed.pop();
eq("disarmed", String(armed()), "false");

console.log(bad ? bad + " failed" : "sched: all checks passed");
if (bad) process.exit(1);
