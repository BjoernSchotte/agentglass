// agentglass — agent-wait across a fleet: hosts' `wait --json` objects merged where the data allows it exactly
// SPDX-License-Identifier: Apache-2.0
// Counts, sums, errors and duration histograms add up (quantiles come from the merged histogram); peaks, overlap and the
// now block stay per host: different machines do not contend (spec agent-wait §9, Decision 13).
import { type Obj, obj, arr, str } from "../../util/json.ts";
import { HB, pct } from "../usage/calls.ts";
import type { WRow, WaitReport, Cand } from "./report.ts";
import { EMPTY } from "../query/eval.ts";

function num(v: unknown): number { return typeof v === "number" ? v as number : 0; }
function r4(x: number): number { return Math.round(x * 10000) / 10000; }
const TIME = ["activeMs", "toolMs", "userMs", "modelMs", "pollingMs"];
interface MRow { o: Obj; hist: number[]; prevNull: boolean }
function mergeRows(lists: unknown[][], activeMs: number): Obj[] {
  const by = new Map<string, MRow>();
  for (const l of lists) for (const x of l) {
    const r = obj(x); if (!r) continue; const k = str(r["key"]);
    let m = by.get(k);
    if (!m) {
      const h: number[] = []; for (let i = 0; i < HB; i++) h.push(0);
      m = { o: { key: k, kind: str(r["kind"]), heavy: r["heavy"] === true, calls: 0, timedCalls: 0, totalMs: 0, share: 0, p50Ms: null, p95Ms: null, maxMs: null, errors: 0, errorRate: null,
        prevTotalMs: 0, trend: null, agents: 0, peak: null, peakAt: null, atLeast2Ms: null, atLeast3Ms: null, slowdown: null, hist: h }, hist: h, prevNull: false };
      by.set(k, m);
    }
    const o = m.o;
    for (const f of ["calls", "timedCalls", "totalMs", "errors", "agents"]) o[f] = num(o[f]) + num(r[f]);
    if (r["maxMs"] !== null && r["maxMs"] !== undefined) o["maxMs"] = Math.max(num(o["maxMs"]), num(r["maxMs"]));
    if (r["prevTotalMs"] === null || r["prevTotalMs"] === undefined) m.prevNull = true; else o["prevTotalMs"] = num(o["prevTotalMs"]) + num(r["prevTotalMs"]);
    const h = arr(r["hist"]); for (let i = 0; i < HB && i < h.length; i++) m.hist[i] = (m.hist[i] ?? 0) + num(h[i]);
  }
  const out: Obj[] = [];
  for (const m of by.values()) {
    const o = m.o; const mx = num(o["maxMs"]); const p50 = pct(m.hist, 0.5, mx); const p95 = pct(m.hist, 0.95, mx);
    o["p50Ms"] = p50 < 0 ? null : p50; o["p95Ms"] = p95 < 0 ? null : p95;
    o["share"] = activeMs > 0 ? r4(num(o["totalMs"]) / activeMs) : 0;
    o["errorRate"] = num(o["calls"]) > 0 ? r4(num(o["errors"]) / num(o["calls"])) : null;
    if (m.prevNull) o["prevTotalMs"] = null;
    o["hist"] = m.hist.slice(); // an array stored into an object is a copy (scriptc): the sums go in at the end
    o["trend"] = !m.prevNull && num(o["prevTotalMs"]) > 0 ? r4(num(o["totalMs"]) / num(o["prevTotalMs"]) - 1) : null;
    out.push(o);
  }
  out.sort((a: Obj, b: Obj) => num(b["totalMs"]) - num(a["totalMs"]) || num(b["calls"]) - num(a["calls"]) || (str(a["key"]) < str(b["key"]) ? -1 : 1));
  return out;
}
export function mergeWait(objs: Obj[]): Obj {
  const at: Obj = {}; for (const k of TIME) at[k] = 0;
  let complete = true;
  for (const o of objs) { const a = obj(o["agentTime"]) ?? {}; for (const k of TIME) at[k] = num(at[k]) + num(a[k]); if (o["previous"] === null) complete = false; }
  const act = num(at["activeMs"]);
  const L = (k: string): unknown[][] => { const o: unknown[][] = []; for (const x of objs) o.push(arr(x[k])); return o; };
  const first = objs.length ? objs[0] ?? {} : {};
  return { period: first["period"] ?? null, previous: complete && objs.length ? first["previous"] ?? null : null, hosts: objs.length, agentTime: at,
    rows: mergeRows(L("rows"), act), kinds: mergeRows(L("kinds"), act), tools: mergeRows(L("tools"), act), heavy: null, now: null };
}
// rows of a wait object as the tab draws them (by: family → rows, kind → kinds, tool → tools)
export function rowsOfObj(o: Obj, by: string): WRow[] {
  const out: WRow[] = [];
  for (const x of arr(o[by === "kind" ? "kinds" : by === "tool" ? "tools" : "rows"])) {
    const r = obj(x); if (!r) continue;
    const h: number[] = []; const rh = arr(r["hist"]); for (let i = 0; i < HB; i++) h.push(num(rh[i]));
    out.push({ key: str(r["key"]), id: -1, generic: false, kind: str(r["kind"]), heavy: r["heavy"] === true, isTool: by === "tool", n: num(r["calls"]), timed: num(r["timedCalls"]), ms: num(r["totalMs"]),
      max: num(r["maxMs"]), hist: h, err: num(r["errors"]), agents: num(r["agents"]), prevN: 0, prevMs: num(r["prevTotalMs"]), slow: [] });
  }
  return out;
}
// a report-shaped view of a wait object (the tab's fleet mode draws it with the local code)
export function reportOfObj(o: Obj): WaitReport {
  const a = obj(o["agentTime"]) ?? {};
  return { since: 0, until: 0, prevSince: 0, days: 0, complete: o["previous"] !== null && o["previous"] !== undefined, fams: rowsOfObj(o, "family"), kinds: rowsOfObj(o, "kind"), tools: rowsOfObj(o, "tool"),
    split: { activeMs: num(a["activeMs"]), toolMs: num(a["toolMs"]), userMs: num(a["userMs"]), pollMs: num(a["pollingMs"]), modelMs: num(a["modelMs"]) }, spans: [], sessions: 0, bgCalls: 0, done: true,
    f: EMPTY, cut: 0, cands: new Map<string, Cand[]>() };
}
