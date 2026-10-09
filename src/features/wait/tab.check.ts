// agentglass — the Wait tab: rendering at 80 and 200 columns, keys, no work while hidden, one step per render, help
// SPDX-License-Identifier: Apache-2.0
import { S } from "../../state.ts";
import { H } from "../../hooks.ts";
import { buf, bufRow, bufCol, clearBuf } from "../../ui/screen.ts";
import { width } from "../../util/text.ts";
import { fxReset, fxSession, isoAt } from "../query/fixture.ts";
import { startOfDay } from "../usage/record.ts";
import { EMPTY } from "../query/eval.ts";
import { LIVE, type Run } from "./live.ts";
import { STEPS, newWaitRun, stepWait, waitResult } from "./report.ts";
import { WAIT_TAB, waitState, setWaitForTest, sparkline } from "./tab.ts";
import { VF_STORE, vfSet, vfOf, vfClear, resetForTest } from "../../ui/evfilter.ts";
VF_STORE.path = "/tmp/agentglass-waittab-vf-" + String(process.pid) + ".json"; resetForTest();

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function q(s: string): string { return JSON.stringify(s); }
let mid = 0;
function bash(d: number, hh: number, mm: number, id: string, cmd: string, ms: number, err: boolean): string[] {
  mid++; const t = isoAt(d, hh, mm); const t1 = new Date(Date.parse(t) + ms).toISOString();
  return ["{\"type\":\"assistant\",\"timestamp\":" + q(t) + ",\"message\":{\"id\":\"m" + String(mid) + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":" + q(id) + ",\"name\":\"Bash\",\"input\":{\"command\":" + q(cmd) + "}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}",
    "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":" + q(id) + (err ? ",\"is_error\":true" : "") + ",\"content\":\"x\"}]},\"uuid\":\"u" + id + "\",\"timestamp\":" + q(t1) + "}"];
}
fxReset();
fxSession("claude", "A", "/w/a", "", "claude-sonnet-4-5", ([] as string[]).concat(bash(1, 10, 0, "a1", "pnpm test", 300000, false), bash(1, 10, 10, "a2", "npx tsc", 60000, false), bash(1, 11, 0, "a3", "git status", 1000, false)));
fxSession("claude", "B", "/w/b", "", "claude-sonnet-4-5", ([] as string[]).concat(bash(1, 10, 1, "b1", "pnpm test", 200000, true), bash(1, 10, 20, "b2", "pnpm lint", 30000, false)));
// the screen as a character grid: every put lands at its cell; a put past the right edge is an overflow
function grid(W: number): { rows: string[]; over: number } {
  const g: string[][] = []; let over = 0;
  for (let y = 0; y < S.H; y++) { const r: string[] = []; for (let x = 0; x < W; x++) r.push(" "); g.push(r); }
  for (let i = 0; i < buf.length; i++) {
    const y = (bufRow[i] ?? 0) + 0; let x = (bufCol[i] ?? 0) + 0; const t = (buf[i] ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    for (const ch of t) { const w = width(ch); if (x + w > W) { over++; break; } const row = g[y]; if (row) row[x] = ch; x += w; if (w === 2 && row) row[x - 1] = ch; }
  }
  return { rows: g.map((r: string[]) => r.join("")), over };
}
const idx = H.tabs.indexOf(WAIT_TAB);
eq("tab registered", String(idx >= 0), "true");
S.mode = "list"; S.tab = 2 + idx;
const rep = (() => { const r = newWaitRun(EMPTY, startOfDay() - 6 * 86400000, Date.now() + 1); while (!stepWait(r, 1e9)) { /* */ } return waitResult(r); })();
setWaitForTest(rep);
function run(path: string, fam: string, kind: string): Run { return { path, h: "claude", family: fam, kind, heavy: true, ageSec: 130, rssKb: 900000, pid: 1, bg: false }; }
LIVE.cur = { at: Date.now(), load1: 5, cpus: 32, memAvailPct: 38, running: [run("/fx/claude/A.jsonl", "pnpm test", "test"), run("/fx/claude/B.jsonl", "pnpm test", "test"), run("/fx/claude/B.jsonl", "tsc", "typecheck")] };
function draw(W: number, Ht: number): { rows: string[]; over: number } { S.W = W; S.H = Ht; clearBuf(); WAIT_TAB.render(); return grid(W); }
const g80 = draw(80, 24);
eq("80 columns: nothing past the edge", String(g80.over), "0");
const all = g80.rows.join("\n");
eq("header names the period", String(all.indexOf("7 days") >= 0), "true");
eq("now line", String(all.indexOf("pnpm test ×2") >= 0), "true");
eq("agent time split", String(all.indexOf("tools") >= 0 && all.indexOf("model") >= 0), "true");
const first = g80.rows.findIndex((l: string) => l.indexOf("pnpm test ") >= 0 && l.indexOf("test") >= 0 && l.indexOf("%") >= 0);
const tscAt = g80.rows.findIndex((l: string) => /│ tsc +type/.test(l));
eq("table sorted by total", String(first >= 0 && tscAt > first), "true");
if (bad) console.log(g80.rows.join("\n"));
eq("overlap line of the selection", String(all.indexOf("pnpm test · ") >= 0 && all.indexOf("at once") >= 0), "true");
const g200 = draw(200, 50);
eq("200 columns: nothing past the edge", String(g200.over), "0");
// keys: s cycles the sort, v the view, d/w/m/a the period, ↵ the calls, esc back
WAIT_TAB.key("s"); eq("s: sort", waitState().sort, "count");
WAIT_TAB.key("s"); eq("s: sort again", waitState().sort, "p95");
WAIT_TAB.key("v"); eq("v: kinds", waitState().view, "kind");
const gk = draw(80, 24);
eq("kinds rows", String(gk.rows.some((l: string) => /typecheck|typec/.test(l))), "true");
WAIT_TAB.key("v"); eq("v: tools", waitState().view, "tool");
WAIT_TAB.key("v"); eq("v: families again", waitState().view, "family");
WAIT_TAB.key("enter"); eq("enter: calls", String(waitState().detail !== ""), "true");
const gd = draw(80, 24); eq("calls list fits", String(gd.over), "0");
WAIT_TAB.key("esc"); eq("esc: back", waitState().detail, "");
// the event-kind filter: only the shell:test rows, the others counted below the table; K i ! work here too
vfSet("wait", "event.kind is shell:test");
const fd = draw(80, 24); const ft = fd.rows.join("\n");
eq("filter: test family only", String(ft.indexOf("pnpm test") >= 0 && ft.indexOf("pnpm lint") < 0 && ft.indexOf("git") < 0), "true");
eq("filter: hidden rows counted", String(ft.indexOf("rows hidden ·") >= 0), "true");
eq("filter: count line", String(ft.indexOf("1 of 4 rows") >= 0), "true");
eq("filter fits 80", String(fd.over), "0");
WAIT_TAB.key("esc"); eq("esc clears the kind filter", vfOf("wait").expr, "");
WAIT_TAB.key("i"); eq("i solos the selected row's kind", String(vfOf("wait").expr.startsWith("event.kind is shell:")), "true");
vfClear("wait");
// work: none while hidden, one step per render while a report runs
setWaitForTest(null);
S.tab = 0; const n0 = STEPS.n;
for (let i = 0; i < 100; i++) for (const f of H.onTick) f();
eq("hidden: no steps", String(STEPS.n - n0), "0");
S.tab = 2 + idx; WAIT_TAB.key("m"); eq("m: 30 days", waitState().period, "m");
draw(80, 24); eq("visible: one step per render", String(STEPS.n - n0), "1");
draw(80, 24); eq("finished: no more steps", String(STEPS.n - n0), "1");
eq("host figures wanted while visible", String(LIVE.want > Date.now()), "true");
// sparkline: fits its width, scales to the peak
eq("sparkline", sparkline([0, 1, 2, 4], 4), "▁▃▅█");
eq("sparkline squeeze", String(width(sparkline([1, 2, 3, 4, 5, 6, 7, 8], 4))), "4");
eq("sparkline empty", sparkline([], 4), "");
// help: every key
let help = ""; for (const h of H.helpSections) if (h.name === "wait") help = h.keys.map((k: string[]) => k[0] ?? "").join(" ");
for (const k of ["d w m a", "s", "v", "↵", "t", "f", "esc", "/"]) eq("help lists " + k, String(help.indexOf(k) >= 0), "true");
let hints = ""; for (const f of H.footerHints) for (const h of f("list")) hints += (h[0] ?? "") + " ";
for (const k of ["↵", "v", "s", "t", "f"]) eq("footer hint " + k, String(hints.indexOf(k) >= 0), "true");

console.log(bad ? bad + " failed" : "wait tab: all checks passed");
if (bad) process.exit(1);
