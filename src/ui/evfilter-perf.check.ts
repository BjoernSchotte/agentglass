// agentglass — event-kind filter budget (skill-usage §5a.9): a filtered 50 000-event transcript stays within a 16 ms frame
// scriptc build -O2 src/ui/evfilter-perf.check.ts -o efp && ./efp
// check: timing
// SPDX-License-Identifier: Apache-2.0
import { type Ev, type Sess, newSess } from "../model/types.ts";
import type { TV } from "../state.ts";
import { kindIds } from "../model/kinds.ts";
import { VF_STORE, vfSet, mask, runs, matchCount, nextMatch, resetForTest } from "./evfilter.ts";
import { layout } from "./transcript.ts";

let bad = 0;
const N = 50000;
const T = Date.parse("2026-10-01T09:00:00Z");
const TOOLS = ["Bash\u0000npm test", "Bash\u0000git status", "Read\u0000/w/a.ts", "Edit\u0000/w/a.ts", "mcp__github__get_issue\u0000#1", "Grep\u0000x", "Bash\u0000pnpm build", "Skill\u0000brainstorming"];
const s: Sess = newSess("claude", "perf-50k", "/k/perf.jsonl", false); s.size = 1;
for (let i = 0; i < N; i++) {
  const ts = new Date(T + i * 1000).toISOString(); const k = i % 10;
  let e: Ev;
  if (k === 0) e = { kind: "user", text: "prompt " + String(i), ts, id: "", full: "" };
  else if (k === 1 || k === 6) e = { kind: "assistant", text: "reply " + String(i), ts, id: "", full: "" };
  else if (k === 2 || k === 4 || k === 7) e = { kind: "tool", text: TOOLS[(i >> 3) % (i % 997 === 0 ? 8 : 7)] ?? "", ts, id: "c" + String(i), full: "" };
  else e = { kind: "result", text: i % 31 === 0 ? "Exit code 1" : "ok", ts, id: "c" + String(i - 1), full: "" };
  s.evs.push(e);
}
VF_STORE.path = "/tmp/agentglass-evfilter-perf-" + String(process.pid) + ".json"; resetForTest();
function ms(f: () => void): number { const a = Date.now(); f(); return Date.now() - a; }
const cold = ms(() => { kindIds(s, s.evs); });
let worst = 0;
for (const ex of ["event.kind is skill", "event.kind is_one_of shell error", "mcp.server is github", "not event.kind is reply"]) {
  vfSet("transcript", ex);
  const t = ms(() => { mask("transcript", s, s.evs); runs("transcript", s, s.evs, 0, N); matchCount("transcript", s, s.evs); });
  worst = Math.max(worst, t);
  console.log("filter " + ex + ": " + String(t) + " ms");
}
// a frame with the filter unchanged: the mask memo, the visible window's gap runs, the count, one ] step
let frame = 0;
for (let k = 0; k < 20; k++) frame = Math.max(frame, ms(() => { mask("transcript", s, s.evs); runs("transcript", s, s.evs, N - 200, N); matchCount("transcript", s, s.evs); nextMatch("transcript", s, s.evs, N - 100, -1); }));
// the transcript's layout of the filtered 50k (only shown events are formatted; gap lines for the rest)
vfSet("transcript", "event.kind is skill");
const tv: TV = { s, evs: s.evs, off: 0, ep: "", scroll: 0, follow: true, expand: false, lines: [], lw: 0, ln: -1, lexp: false, cur: -1, lineEv: [], lineStart: [], focusKind: "", focusTs: "", focusText: "", limit: -1, from: -1, items: [], xr: [], fk: "" };
const lay = ms(() => { layout(tv, 76, N); });
console.log("classify 50k (once per events array): " + String(cold) + " ms · filter change worst " + String(worst) + " ms · frame " + String(frame) + " ms · layout " + String(lay) + " ms");
if (worst > 16) { bad++; console.log("FAIL a filter change over 50k events took " + String(worst) + " ms (budget 16)"); }
if (frame > 16) { bad++; console.log("FAIL a frame took " + String(frame) + " ms (budget 16)"); }
if (lay > 16) { bad++; console.log("FAIL the filtered layout took " + String(lay) + " ms (budget 16)"); }
if (cold > 400) { bad++; console.log("FAIL classifying 50k events took " + String(cold) + " ms (budget 400, once)"); }
if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("event filter budget: ok");
