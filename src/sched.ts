// agentglass — adaptive refresh: activity level, per-job intervals per level, CPU budget, clock jumps.
// Pure: the caller passes the clock and the activity in (main.ts runs the loop), so sched.check.ts can test it.
// SPDX-License-Identifier: Apache-2.0
import { numAt } from "./util/text.ts";

export type Level = "hot" | "warm" | "idle" | "away";
export type Job = "size" | "procs" | "scan" | "slow" | "probe" | "tick" | "watch" | "fast" | "render";
// run order inside one turn: data first, render last
export const JOBS: Job[] = ["size", "procs", "scan", "slow", "probe", "tick", "watch", "fast", "render"];
// input/focusOut/grow: timestamps in ms, 0 = never
export interface Act { now: number; input: number; focusOut: number; replay: boolean; grow: number; indexing: boolean; live: boolean }
export interface JS { last: number; ew: number } // last run, EWMA of its duration (ms)
// unf: focus-out reported and no focus-in since (render capped at 1/s); burst: ledger indexing pending, its tick keeps
// the level's cadence (the 100 ms slice per tick is the one intentional burst, not a cost to stretch away)
// fastMs: the fast job's interval while armed (50 ms for a replay; the marquee steps every 150 ms: more turns only cost)
export interface Sched { fixed: boolean; winch: boolean; lv: Level; unf: boolean; burst: boolean; js: Map<string, JS>; fastMs: number }

const LV: Level[] = ["hot", "warm", "idle", "away"];
const JUMP = 600000; // a job last run more than 10 min ago (suspend) or in the future (clock went back) runs now
const ALARM = 1500; // watch and procs while an agent is live: alarm latency wins over the budget
// base intervals hot / warm / idle / away; -1 = not scheduled at that level. hot never polls data faster than the old
// fixed loop (procs 1.5 s, scan 3 s, slow 5 s, tick 500 ms): with agents streaming the level is hot nearly all day, and
// faster polling there cost more than the old loop. hot is faster only where it is cheap: stat-only probe, render on change
function row(j: Job): number[] {
  if (j === "render") return [250, 500, 1000, 5000];
  if (j === "probe") return [250, 1000, 1000, 1000];
  if (j === "procs") return [1500, 1500, 5000, 5000];
  if (j === "scan") return [3000, 3000, 10000, 15000];
  if (j === "slow") return [5000, 5000, 15000, 30000];
  if (j === "tick") return [500, 500, 2000, 5000];
  if (j === "fast") return [50, 50, -1, -1];
  return [2000, 2000, 5000, 10000]; // size
}
// fixed = the old cadence: 500 ms tick (watchdog included), procs every 3rd, scan every 6th, slow every 10th
function fixedMs(j: Job): number {
  if (j === "procs") return 1500;
  if (j === "scan") return 3000;
  if (j === "slow") return 5000;
  if (j === "fast") return 50;
  if (j === "probe") return -1;
  return 500; // render, tick, watch, size
}

// what makes the level hot, for the debug footer
export function hotWhy(a: Act): string {
  const w: string[] = [];
  if (a.input > 0 && a.now - a.input < 3000) w.push("input");
  if (a.replay) w.push("replay");
  if (a.grow > 0 && a.now - a.grow < 5000) w.push("grow");
  if (a.indexing) w.push("index");
  return w.join("+");
}
export function levelOf(a: Act): Level {
  if ((a.input > 0 && a.now - a.input < 3000) || a.replay || (a.grow > 0 && a.now - a.grow < 5000) || a.indexing) return "hot";
  if (a.focusOut > 0 && a.input < a.focusOut) return "away"; // only focus-out makes away, never inactivity alone
  if ((a.input > 0 && a.now - a.input < 60000) || a.live) return "warm";
  return "idle";
}

export function newSched(fixed: boolean, winch: boolean, now: number): Sched {
  const js = new Map<string, JS>();
  for (const j of JOBS) js.set(j, { last: now, ew: 0 });
  return { fixed, winch, lv: "warm", unf: false, burst: false, js, fastMs: 50 };
}

export function base(j: Job, lv: Level, live: boolean, fixed: boolean, winch: boolean): number {
  if (j === "size" && winch) return -1;
  if (fixed) return fixedMs(j);
  if (j === "watch") return live ? ALARM : 5000;
  const v = numAt(row(j), LV.indexOf(lv), -1);
  return j === "procs" && live ? Math.min(v, ALARM) : v;
}

// effective interval: base stretched to 20 × the job's average cost (≤ ~5% of a core), capped for alarms; -1 = paused
export function every(sc: Sched, j: Job, live: boolean, armed: boolean): number {
  const b = base(j, sc.lv, live, sc.fixed, sc.winch);
  if (b < 0 || (j === "fast" && !armed)) return -1;
  if (sc.fixed) return b;
  const x = sc.js.get(j);
  if (j === "tick" && sc.burst) return sc.lv === "hot" ? 250 : b; // ledger indexing: 100 ms slices at 250 ms while hot, no stretch
  let e = x ? Math.max(b, 20 * x.ew) : b;
  if (j === "render" && sc.unf) e = Math.max(e, 5000); // unfocused: nobody looks — frames only for a change (an alarm draws at once: main.ts watch)
  if (j === "fast") e = Math.max(e, sc.fastMs);
  if (sc.unf) { // unfocused: no marquee steps (a replay goes on), the live probe rides on the watch job (its alarm latency), size seldom
    if (j === "fast" && sc.fastMs > 50) return -1;
    if (j === "probe" && live) return -1;
    if (j === "size") e = Math.max(e, 10000);
    if (j === "tick") e = Math.max(e, 1000); // ingest within a second of the watch job reading it (alarm values)
    if (j === "scan") e = Math.max(e, 6000); // a new agent scans at once (main.ts: procs)
  }
  return live && (j === "watch" || j === "procs") ? Math.min(e, ALARM) : e;
}

function lastOf(sc: Sched, j: Job): number { const x = sc.js.get(j); return x ? x.last : 0; }
function jumped(last: number, now: number): boolean { return last > now || now - last > JUMP; }

// a turn that runs anyway also runs the data jobs due within the next quarter of their interval (≤ 100 ms): every
// wake of the loop costs the runtime ~0.1 ms by itself, so jobs share wakes; render and fast keep their own beat (the
// spinner and marquee speed)
export function due(sc: Sched, now: number, live: boolean, armed: boolean): Job[] {
  const out: Job[] = [];
  for (const j of JOBS) {
    const e = every(sc, j, live, armed); if (e < 0) continue;
    const last = lastOf(sc, j);
    if (jumped(last, now) || now - last >= e) out.push(j);
  }
  if (!out.length) return out;
  for (const j of JOBS) {
    if (j === "render" || j === "fast" || out.indexOf(j) >= 0) continue;
    const e = every(sc, j, live, armed); if (e < 0) continue;
    if (now - lastOf(sc, j) >= e - Math.min(100, e / 4)) out.push(j);
  }
  return out;
}

export function ran(sc: Sched, j: Job, now: number, dur: number): void {
  const x = sc.js.get(j);
  if (!x) { sc.js.set(j, { last: now, ew: 0.3 * Math.min(dur, 50) }); return; }
  // one sample counts at most 4× the current average (≥ 50 ms): a rare burst inside a job (the first ledger pass at startup,
  // the cache save every 30 s in tick) must not stretch it for the next half minute; a lasting cost converges in a few runs
  x.last = now; x.ew = 0.7 * x.ew + 0.3 * Math.min(dur, Math.max(4 * x.ew, 50));
}

const failed = new Set<string>();
// one job, timed; a throw is caught (the loop must keep rescheduling) and reported once per job name
export function runJob(sc: Sched, j: Job, f: () => void, now: () => number, warn: (msg: string) => void): void {
  const t0 = now();
  try { f(); } catch (e) { if (!failed.has(j)) { failed.add(j); warn("refresh " + j + " failed: " + String(e)); } }
  ran(sc, j, t0, Math.max(0, now() - t0));
}

// until the earliest due job; ≥ 16 ms, ≤ 1 s so level changes apply promptly
export function sleepFor(sc: Sched, now: number, live: boolean, armed: boolean): number {
  let w = 1000;
  for (const j of JOBS) {
    const e = every(sc, j, live, armed); if (e < 0) continue;
    const last = lastOf(sc, j);
    w = Math.min(w, jumped(last, now) ? 0 : last + e - now);
  }
  return Math.max(16, Math.min(1000, w));
}

// what a fast-job turn draws: full = an armed source changed the body (replay), header = only the header row moved
// (marquee: one row instead of a whole frame, ~6 steps/s), dirty = unfocused, left to the 1/s render cap
export function fastDraw(full: boolean, header: boolean, unf: boolean): string {
  if (!full && !header) return "";
  if (unf) return full ? "dirty" : ""; // unfocused: a marquee step is not drawn at all
  return full ? "full" : "header";
}
// a frame is built at least this often even when nothing is dirty ("3m ago" texts)
export function forceMs(lv: Level): number { return lv === "away" ? 5000 : 1000; }

function dur(ms: number): string {
  if (ms < 10) return String(Math.round(ms * 10) / 10) + "ms";
  return ms < 1000 ? String(Math.round(ms)) + "ms" : String(Math.round(ms / 100) / 10) + "s";
}
export const DBG = { on: false, line: "" }; // AGENTGLASS_DEBUG_REFRESH=1: footer.ts shows line
// AGENTGLASS_DEBUG_REFRESH footer: lvl hot · procs 18ms/1s · scan 41ms/2s · …
// extra: process-wide parts (rss, ingest) right after the level, where a narrow footer does not cut them off
export function debugLine(sc: Sched, live: boolean, armed: boolean, why: string, extra: string): string {
  const parts = ["lvl " + sc.lv + (why ? " (" + why + ")" : "") + (sc.unf ? " unfocused" : "") + (sc.fixed ? " fixed" : "")];
  if (extra) parts.push(extra);
  for (const j of JOBS) {
    const e = every(sc, j, live, armed); if (e < 0) continue;
    const x = sc.js.get(j);
    parts.push(j + " " + dur(x ? x.ew : 0) + "/" + dur(e));
  }
  const p = sc.js.get("procs");
  if (live && !sc.fixed && p && 20 * p.ew > ALARM) parts.push("procs slow"); // ps alone exceeds the budget at the alarm bound
  return parts.join(" · ");
}

// env wins when set; an invalid value falls back to adaptive with an error for one startup toast
export function refreshMode(env: string, cfg: string): { mode: string; err: string } {
  const v = env || cfg; const src = env ? "AGENTGLASS_REFRESH" : "refresh.mode";
  if (v === "" || v === "adaptive" || v === "fixed") return { mode: v || "adaptive", err: "" };
  return { mode: "adaptive", err: src + " must be adaptive or fixed (got " + v + "); using adaptive" };
}
