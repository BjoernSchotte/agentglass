// agentglass — agent-wait period report: exact sums vs brute force, agent-time split, trend, filter, resumable stepping
// SPDX-License-Identifier: Apache-2.0
import { fxReset, fxSession, isoAt } from "../query/fixture.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, callsOf } from "../usage/ledger.ts";
import { startOfDay, spanMin } from "../usage/record.ts";
import { callList } from "../usage/rows.ts";
import { DICT, nameOf, localOf } from "../usage/facts.ts";
import { setCallDaysForTest } from "../usage/callcache.ts";
import { compile, EMPTY } from "../query/eval.ts";
import { parse } from "../query/parse.ts";
import { type WRow, type SlowCall, newWaitRun, stepWait, waitResult, trendOf, shareOf } from "./report.ts";
import { parseWaitCfg, setWaitCfgForTest } from "./family.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function q(s: string): string { return JSON.stringify(s); }
let mid = 0;
function call(iso: string, name: string, id: string, input: string): string {
  mid++;
  return "{\"type\":\"assistant\",\"timestamp\":" + q(iso) + ",\"message\":{\"id\":\"m" + String(mid) + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":" + q(id) + ",\"name\":" + q(name) + ",\"input\":" + input + "}],\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}";
}
function result(iso: string, id: string, err: boolean): string {
  return "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":" + q(id) + (err ? ",\"is_error\":true" : "") + ",\"content\":\"x\"}]},\"uuid\":\"u" + id + "\",\"timestamp\":" + q(iso) + "}";
}
function plus(iso: string, ms: number): string { return new Date(Date.parse(iso) + ms).toISOString(); }
// a Bash call of ms (-1: no result) at daysAgo hh:mm
function bash(d: number, hh: number, mm: number, id: string, cmd: string, ms: number, err: boolean): string[] {
  const t = isoAt(d, hh, mm); const o = [call(t, "Bash", id, "{\"command\":" + q(cmd) + "}")];
  if (ms >= 0) o.push(result(plus(t, ms), id, err));
  return o;
}
function tool(d: number, hh: number, mm: number, id: string, name: string, ms: number): string[] { const t = isoAt(d, hh, mm); return [call(t, name, id, "{}"), result(plus(t, ms), id, false)]; }

setWaitCfgForTest(parseWaitCfg({ minSec: 10 }));
fxReset();
fxSession("claude", "A", "/w/a", "", "claude-sonnet-4-5", ([] as string[]).concat(
  bash(0, 10, 0, "a1", "pnpm test", 120000, false), bash(0, 10, 5, "a2", "npx tsc --noEmit", 30000, false), bash(0, 10, 10, "a3", "git status", 1000, false),
  tool(0, 10, 11, "a4", "AskUserQuestion", 60000), tool(0, 10, 20, "a5", "TaskOutput", 300000), bash(0, 10, 30, "a6", "cat x | python3 -", 5000, true),
  bash(0, 10, 40, "a7", "sleep 100", -1, false), bash(1, 9, 0, "a8", "pnpm test", 200000, false)));
fxSession("claude", "As", "/w/a", "A", "claude-sonnet-4-5", bash(0, 11, 0, "s1", "pnpm test", 90000, false));
fxSession("claude", "B", "/w/b", "", "claude-sonnet-4-5", ([] as string[]).concat(
  bash(0, 10, 1, "b1", "pnpm test", 100000, true), bash(2, 9, 0, "b2", "pnpm test", 50000, false), bash(3, 9, 0, "b3", "npx tsc", 20000, false)));

const since = startOfDay() - 86400000; const until = startOfDay() + 86400000; const prevSince = since - (until - since);
function full(f0: string): ReturnType<typeof waitResult> {
  const f = f0 ? compile(parse(f0).cs, "stats").f ?? EMPTY : EMPTY;
  const r = newWaitRun(f, since, until); while (!stepWait(r, 1e9)) { /* one pass */ } return waitResult(r);
}
const rep = full("");
eq("done", String(rep.done), "true");

// brute force over the rows: shell rows have a command id; windows by call time
const SHELL = ["Bash"];
let shN = 0; let shMs = 0; let shErr = 0; let tN = 0; let tMs = 0; let pN = 0; let pMs = 0;
const toolMs = new Map<string, number>(); const userMs = new Map<string, number>(); const actMs = new Map<string, number>();
for (const s of sessions.values()) {
  const rows = callList(callsOf(s)); const iv: number[][] = []; const uv: number[][] = [];
  for (const c of rows) {
    const shell = SHELL.indexOf(nameOf(DICT.tool, c.tool)) >= 0 && c.cmds.length > 0;
    if (c.t >= prevSince && c.t < since) { if (shell) { pN++; if (c.ms >= 0) pMs += c.ms; } continue; }
    if (c.t < since || c.t >= until) continue;
    if (shell) { shN++; if (c.ms >= 0) shMs += c.ms; if (c.err === 1) shErr++; }
    else { tN++; if (c.ms >= 0) tMs += c.ms; }
    if (c.ms >= 0) { iv.push([c.t, c.t + c.ms]); if (nameOf(DICT.tool, c.tool) === "AskUserQuestion") uv.push([c.t, c.t + c.ms]); }
  }
  toolMs.set(s.path, union(iv)); userMs.set(s.path, union(uv));
  const a = ledger.get(s.path); let act = 0;
  if (a) for (const [dk, d] of a.days) if (dk >= localOf(since).day && dk <= localOf(until - 1).day) act += spanMin(d.act) * 60000;
  actMs.set(s.path, act);
}
function union(iv: number[][]): number {
  iv.sort((x: number[], y: number[]) => (x[0] ?? 0) - (y[0] ?? 0)); let n = 0; let cs = -1; let ce = -1;
  for (const v of iv) { const a = v[0] ?? 0; const b = v[1] ?? 0; if (a > ce) { if (ce > cs) n += ce - cs; cs = a; ce = b; } else if (b > ce) ce = b; }
  if (ce > cs) n += ce - cs; return n;
}
function sum(rs: WRow[], f: (w: WRow) => number): number { let n = 0; for (const w of rs) n += f(w); return n; }
eq("Σ fam ms", String(sum(rep.fams, (w: WRow) => w.ms)), String(shMs));
eq("Σ fam n", String(sum(rep.fams, (w: WRow) => w.n)), String(shN));
eq("Σ fam err", String(sum(rep.fams, (w: WRow) => w.err)), String(shErr));
eq("Σ tool ms", String(sum(rep.tools, (w: WRow) => w.ms)), String(tMs));
eq("Σ tool n", String(sum(rep.tools, (w: WRow) => w.n)), String(tN));
eq("Σ kinds = fams + tools", String(sum(rep.kinds, (w: WRow) => w.ms)) + "/" + String(sum(rep.kinds, (w: WRow) => w.n)), String(shMs + tMs) + "/" + String(shN + tN));
eq("Σ prev", String(sum(rep.fams, (w: WRow) => w.prevMs)) + "/" + String(sum(rep.fams, (w: WRow) => w.prevN)), String(pMs) + "/" + String(pN));
const pt = rep.fams[0];
eq("top family", pt ? pt.key + " n" + String(pt.n) + " ms" + String(pt.ms) + " err" + String(pt.err) + " agents" + String(pt.agents) + " max" + String(pt.max) : "none", "pnpm test n4 ms510000 err1 agents2 max200000");
eq("untimed counts in n only", (() => { for (const w of rep.fams) if (w.key === "sleep") return String(w.n) + "/" + String(w.timed) + "/" + String(w.ms); return "missing"; })(), "1/0/0");
eq("filter family python3", (() => { for (const w of rep.fams) if (w.key === "python3") return w.kind + " err" + String(w.err); return "missing"; })(), "other err1");
eq("tool kinds", (() => { const o: string[] = []; for (const w of rep.tools) o.push(w.key + ":" + w.kind); return o.sort().join(" "); })(), "AskUserQuestion:user TaskOutput:wait");
eq("kind rows", (() => { const o: string[] = []; for (const w of rep.kinds) o.push(w.key + "=" + String(w.n)); return o.sort().join(" "); })(), "other=1 typecheck=1 user=1 vcs=1 wait=2 test=4".split(" ").sort().join(" "));
eq("slow list", pt ? pt.slow.map((c: SlowCall): string => String(c.ms)).join(",") : "", "200000,120000,100000,90000");
// agent-time split: per session, then summed
let tSum = 0; let uSum = 0; let aSum = 0; let mSum = 0;
for (const [p, v] of toolMs) { const act = actMs.get(p) ?? 0; tSum += v; uSum += userMs.get(p) ?? 0; aSum += act; mSum += Math.max(0, act - v); }
eq("split tool", String(rep.split.toolMs), String(tSum));
eq("split user", String(rep.split.userMs), "60000");
eq("split user brute", String(rep.split.userMs), String(uSum));
eq("split active", String(rep.split.activeMs), String(aSum));
eq("split model", String(rep.split.modelMs), String(mSum));
eq("split poll", String(rep.split.pollMs), "300000");
eq("active > 0", String(rep.split.activeMs > 0), "true");
eq("share", pt ? (shareOf(pt, rep.split) === pt.ms / rep.split.activeMs ? "ok" : "bad") : "", "ok");
// spans: heavy rows ≥ minSec only (git status, sleep, python3 out; tsc 30 s in)
eq("spans", String(rep.spans.length), "5");
eq("sessions", String(rep.sessions), "2");
// trend: the previous window inside retention
eq("complete", String(rep.complete), "true");
const tr = pt ? trendOf(pt, rep.complete) : null;
eq("trend", tr === null ? "null" : tr.toFixed(4), (510000 / 50000 - 1).toFixed(4));
setCallDaysForTest(3);
const rep3 = full("");
eq("retention: incomplete", String(rep3.complete), "false");
eq("retention: trend null", rep3.fams.map((w: WRow): string => String(trendOf(w, rep3.complete))).join(","), rep3.fams.map((w: WRow): string => "null").join(","));
setCallDaysForTest(0);
// filter: one session's rows
const rb = full("cwd is /w/b");
eq("filter b", rb.fams.map((w: WRow): string => w.key + " " + String(w.n)).join(","), "pnpm test 1");
eq("filter b prev", rb.fams.map((w: WRow): string => String(w.prevN)).join(","), "1");
const rk = full("kind is test");
eq("filter kind", rk.fams.map((w: WRow): string => w.key + " " + String(w.n)).join(",") + " tools " + String(rk.tools.length), "pnpm test 4 tools 0");
const rt = full("tool is AskUserQuestion");
eq("filter tool", rt.fams.length + " " + rt.tools.map((w: WRow): string => w.key).join(","), "0 AskUserQuestion");
// resumable: one session per step = one pass
const f0 = EMPTY; const r1 = newWaitRun(f0, since, until); let steps = 0; while (!stepWait(r1, 0)) steps++;
eq("steps", String(steps >= 2), "true");
eq("resumable = one pass", JSON.stringify(waitResult(r1)), JSON.stringify(rep));

setWaitCfgForTest(null);
console.log(bad ? bad + " failed" : "report: all checks passed");
if (bad) process.exit(1);
