// agentglass — self-check for the running session summary (runsum.ts): on random sessions (prompts, codex turn markers,
// fx durations, tool calls with and without ids, results, errors, untimed calls, repeat runs, live or not, subagents),
// fed in random chunks with a save/load between chunks, turns, wall and active time equal summary(buildGraph(…)) and the
// repeat runs equal loopRuns — the session detail's figures do not change by being read from a cursor.
//   scriptc build src/features/callgraph/runsum.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import { type Src, buildGraph, summary } from "./model.ts";
import { loopRuns } from "../detect.ts";
import { parse } from "../../util/json.ts";
import { type LogSum, newSum, sumFeed, sumOut, toJson, fromJson, ivAdd, ivLen } from "./runsum.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; if (bad < 12) console.log("FAIL " + w + ": " + got); } }
let seed = 42; function rnd(): number { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick(n: number): number { return Math.floor(rnd() * n); }
const T0 = Date.parse("2026-10-01T08:00:00.000Z");
function iso(t: number): string { return new Date(t).toISOString(); }
function ev(kind: string, text: string, t: number, id: string, full: string): Ev { return { kind, text, ts: t > 0 ? iso(t) : "", id, full }; }
// a random log: turns of a prompt (or a "turn started" marker), assistant text, tool calls with results; repeats; untimed
function session(top: boolean, start: number): Ev[] {
  const out: Ev[] = []; let t = start; let n = 0;
  const turns = 1 + pick(6);
  for (let k = 0; k < turns; k++) {
    if (top) {
      if (pick(4) === 0) { out.push(ev("meta", "turn started", t, "", "")); out.push(ev("user", "do task " + k, t, "", "")); }
      else out.push(ev("user", "prompt " + k, t, "", ""));
    }
    const calls = pick(8);
    const untimed = pick(5) === 0; // a turn whose calls share one timestamp (spread)
    const same = pick(3) === 0; // a repeat run: one call over and over
    for (let c = 0; c < calls; c++) {
      if (!untimed) t += 500 + pick(4000);
      if (pick(3) === 0) out.push(ev("assistant", "thinking about it", t, "", ""));
      const id = pick(6) === 0 ? "" : "c" + String(n++);
      const name = same ? "Bash" : ["Bash", "Read", "Edit", "Grep"][pick(4)] ?? "Bash";
      const arg = same ? "pnpm test" : "arg " + pick(3);
      out.push(ev("tool", name + "\u0000" + arg, t, id, arg));
      if (pick(7) === 0 && k === turns - 1 && c === calls - 1) continue; // the last call stays open
      if (!untimed) t += pick(3000);
      out.push(ev("result", pick(5) === 0 ? "Exit code 1\nfailed" : "ok", t, id, ""));
    }
    t += 1000 + pick(5000);
    if (top && pick(3) === 0) out.push(ev("meta", pick(2) === 0 ? "turn complete · " + String(1 + pick(30)) + ".5s" : "turn aborted", t, "", ""));
  }
  return out;
}
// the running summary of one log: random chunks, a save and a load between them
function running(evs: Ev[], top: boolean): LogSum {
  let ls = newSum("/x", "", top); let i = 0;
  while (i < evs.length) {
    const n = 1 + pick(7);
    for (let j = 0; j < n && i < evs.length; j++) { const e = evs[i] as Ev; sumFeed(ls, e); i++; }
    const j = parse(JSON.stringify(toJson(ls))); const back = j ? fromJson(j) : null;
    if (back) ls = back; else { ok("roundtrip", false, "null"); break; }
  }
  return ls;
}
function runsKey(rs: { tool: string; arg: string; n: number; ts: string }[]): string { return rs.map((r) => r.tool + "/" + r.arg + "/" + String(r.n) + "/" + r.ts).join(";"); }

// intervals
const iv: number[] = []; ivAdd(iv, 10, 20); ivAdd(iv, 30, 40); ivAdd(iv, 15, 32); ivAdd(iv, 50, 60); ivAdd(iv, 5, 6);
ok("ivAdd merges and keeps order", JSON.stringify(iv) === "[5,6,10,40,50,60]" && ivLen(iv) === 41, JSON.stringify(iv));

let cases = 0;
for (let k = 0; k < 400; k++) {
  const main = session(true, T0 + k * 86400000);
  const subs: Ev[][] = []; const ns = pick(3);
  for (let j = 0; j < ns; j++) { const s = session(false, T0 + k * 86400000 + 2000 + pick(20000)); if (s.length >= 2) subs.push(s); }
  const live = pick(4) === 0; const now = T0 + k * 86400000 + 9000000;
  const srcs: Src[] = [{ evs: main, live, kind: "", spawn: "" }];
  for (const s of subs) srcs.push({ evs: s, live: false, kind: "worker", spawn: "" });
  const g = buildGraph(srcs, now); if (g.noTiming) continue;
  const want = summary(g);
  const states: LogSum[] = [running(main, true)]; const lv: boolean[] = [live];
  for (const s of subs) { states.push(running(s, false)); lv.push(false); }
  const got = sumOut(states, lv, now);
  if (!got) { // only where the graph fills a one-timestamp subagent from its host: the caller reads in full then
    let one = false; for (const s of subs) { let a = 0; let z = 0; for (const e of s) { const t = Date.parse(e.ts) || 0; if (!t) continue; if (!a) a = t; z = t; } if (a && z <= a) one = true; }
    ok("case " + String(k) + ": null only for a one-timestamp subagent", one, ""); continue;
  }
  cases++;
  ok("case " + String(k) + " turns", got.turns === want.turns, String(got.turns) + " vs " + String(want.turns));
  ok("case " + String(k) + " wall", got.wallMs === want.wall, String(got.wallMs) + " vs " + String(want.wall));
  ok("case " + String(k) + " active", got.activeMs === Math.round(want.active) || Math.abs(got.activeMs - want.active) < 1e-6, String(got.activeMs) + " vs " + String(want.active));
  const wr: { tool: string; arg: string; n: number; ts: string }[] = []; for (const r of loopRuns(main, 3)) wr.push(r); for (const s of subs) for (const r of loopRuns(s, 3)) wr.push(r);
  const gr: { tool: string; arg: string; n: number; ts: string }[] = []; for (const x of got.runs) gr.push(x.r);
  ok("case " + String(k) + " repeats", runsKey(gr) === runsKey(wr), runsKey(gr) + " vs " + runsKey(wr));
}
ok("enough compared cases", cases > 250, String(cases));
console.log(bad ? String(bad) + " failed" : "running summary: all checks passed (" + String(cases) + " sessions)");
if (bad) process.exit(1);
