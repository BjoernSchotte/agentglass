// agentglass — agent-wait fleet merge: exact sums and histograms across hosts, peaks per host only
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, arr } from "../../util/json.ts";
import { HB, hb, pct } from "../usage/calls.ts";
import { mergeWait, rowsOfObj } from "./merge.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function hist(ms: number[]): number[] { const h: number[] = []; for (let i = 0; i < HB; i++) h.push(0); for (const m of ms) { const b = hb(m); h[b] = (h[b] ?? 0) + 1; } return h; }
function sum(ms: number[]): number { let n = 0; for (const m of ms) n += m; return n; }
function max(ms: number[]): number { let n = 0; for (const m of ms) n = Math.max(n, m); return n; }
function row(key: string, kind: string, ms: number[], errors: number, prev: number | null, peak: number): Obj {
  const h = hist(ms);
  return { key, kind, heavy: kind === "test", calls: ms.length + 1, timedCalls: ms.length, totalMs: sum(ms), share: 0.5, p50Ms: pct(h, 0.5, max(ms)), p95Ms: pct(h, 0.95, max(ms)), maxMs: max(ms),
    errors, errorRate: errors / (ms.length + 1), prevTotalMs: prev, trend: null, agents: 2, peak, peakAt: "2026-10-07T00:00:00.000Z", atLeast2Ms: 5, atLeast3Ms: 1, slowdown: { aloneP50Ms: 1, overlapP50Ms: 2, ratio: 2, alone: 1, overlapped: 1 }, hist: h };
}
const a1 = [120000, 90000, 30000, 4000]; const a2 = [200000, 1500, 700]; const b1 = [60000, 61000, 1000000];
const A: Obj = { period: { since: "x", until: "y", days: 7 }, agentTime: { activeMs: 1000000, toolMs: 400000, userMs: 10, modelMs: 600000, pollingMs: 5 }, rows: [row("pnpm test", "test", a1, 1, 100000, 3), row("git status", "vcs", a2, 0, null, 1)],
  kinds: [row("test", "test", a1, 1, 100000, 3)], tools: [], now: { heavyRunning: 2 }, heavy: { peak: 3 } };
const B: Obj = { period: { since: "x", until: "y", days: 7 }, agentTime: { activeMs: 3000000, toolMs: 600000, userMs: 0, modelMs: 2400000, pollingMs: 0 }, rows: [row("pnpm test", "test", b1, 2, 50000, 2)],
  kinds: [row("test", "test", b1, 2, 50000, 2)], tools: [], now: { heavyRunning: 0 }, heavy: { peak: 2 } };
const m = mergeWait([A, B]);
const rs = arr(m["rows"]).map((x: unknown): Obj => obj(x) ?? {});
const pt = rs[0] ?? {};
const all = a1.concat(b1);
eq("rows by total", rs.map((r: Obj): string => String(r["key"])).join(","), "pnpm test,git status");
eq("calls", String(pt["calls"]), String(a1.length + 1 + b1.length + 1));
eq("timed", String(pt["timedCalls"]), String(all.length));
eq("total", String(pt["totalMs"]), String(sum(all)));
eq("errors", String(pt["errors"]), "3");
eq("agents", String(pt["agents"]), "4");
eq("max", String(pt["maxMs"]), String(max(all)));
eq("hist = hist of the union", JSON.stringify(pt["hist"]), JSON.stringify(hist(all)));
eq("p95 from the merged hist", String(pt["p95Ms"]), String(pct(hist(all), 0.95, max(all))));
eq("p50 from the merged hist", String(pt["p50Ms"]), String(pct(hist(all), 0.5, max(all))));
eq("prev summed", String(pt["prevTotalMs"]), "150000");
eq("trend recomputed", String(pt["trend"]), String(Math.round((sum(all) / 150000 - 1) * 10000) / 10000));
eq("share from merged agent time", String(pt["share"]), String(Math.round((sum(all) / 4000000) * 10000) / 10000));
eq("peaks per host only", [pt["peak"], pt["peakAt"], pt["atLeast2Ms"], pt["atLeast3Ms"], pt["slowdown"]].map((v: unknown) => String(v)).join(","), "null,null,null,null,null");
eq("prev unknown on one host → null", String((rs[1] ?? {})["prevTotalMs"]) + " " + String((rs[1] ?? {})["trend"]), "null null");
eq("agent time summed", JSON.stringify(m["agentTime"]), JSON.stringify({ activeMs: 4000000, toolMs: 1000000, userMs: 10, modelMs: 3000000, pollingMs: 5 }));
eq("kinds merged", String(obj(arr(m["kinds"])[0])?.["totalMs"] ?? ""), String(sum(all)));
eq("no now, no heavy", String(m["now"]) + " " + String(m["heavy"]), "null null");
eq("hosts", String(m["hosts"]), "2");
// back to rows the tab draws
const ws = rowsOfObj(m, "family");
eq("rows of the object", ws.map((w) => w.key + ":" + String(w.n) + ":" + String(w.ms)).join(","), "pnpm test:9:" + String(sum(all)) + ",git status:4:" + String(sum(a2)));
eq("empty merge", JSON.stringify(arr(mergeWait([])["rows"])), "[]");

console.log(bad ? bad + " failed" : "wait merge: all checks passed");
if (bad) process.exit(1);
