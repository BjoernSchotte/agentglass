// agentglass — self-check for skills in the timeline views (skill-usage §6.1–§6.5): transcript lines at loads and unloads,
// ] onto a load, the event detail's load record, v (view skill with the text read back), the call graph's skill lanes and
// tree row, related events' skill rows, the Wait timeline's ticks, replay's open skills; from the synthetic Claude log:
// scriptc build src/features/skills/timeline.check.ts -o st && ./st
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { type Sess, newSess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { H } from "../../hooks.ts";
import { sessions } from "../../model/sessions.ts";
import { marksOf } from "../../model/marks.ts";
import { ledger, complete } from "../usage/ledger.ts";
import { openTranscript, renderTranscript, layout } from "../../ui/transcript.ts";
import { viewKey } from "../../ui/evfilter.ts";
import { onInput } from "../../input.ts";
import { skillLanes, skillAgg, sortAggs, type Agg } from "../callgraph/model.ts";
import { skillRows } from "../related/build.ts";
import { KIND_SETS } from "../related/model.ts";
import { skillBuckets, skillTicks } from "../wait/tab.ts";
import { EMPTY } from "../query/eval.ts";
import { loadsAt, openAt } from "./marks.ts";
import { skillViewLines } from "./view.ts";
import { setVis } from "./vis.ts";
import "../../harness/index.ts";
import "../replay.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, ""); }
function has(ls: string[], s: string): number { for (let i = 0; i < ls.length; i++) if (plain(ls[i] ?? "").indexOf(s) >= 0) return i; return -1; }
setVis([], false);
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "tl", "cache");
const dir = join(HOME, "tl", "p"); mkdirSync(dir, { recursive: true });
const P = join(dir, "s-fixture-claude.jsonl");
writeFileSync(P, readFileSync("testdata/skills/claude.jsonl", "utf8"));
const s: Sess = newSess("claude", "s-fixture-claude", P, false); s.size = statSync(P).size; s.mtime = Date.now(); s.cwd = "/w/app"; sessions.set(P, s);
complete(s);
const a = ledger.get(P);
eq("indexed (the copied /gamma pair loads here: no other log owns it)", a ? String(a.sk.length) : "none", "7");

// marks: loads (the listing left out) and unloads
const ms = marksOf(s, ["skill"]);
eq("marks", ms.map((m) => m.kind.slice(6) + " " + m.label + " " + m.sub).join(", "),
  "load alpha user, load beta model, load beta model, load delta model, unload alpha compact, unload beta compact, unload beta compact, unload delta compact, load alpha compact, load gamma user");
// transcript: a line at each load and unload, before the event it lands on
S.W = 120; S.H = 40; S.mode = "list";
openTranscript(s); renderTranscript();
const t = S.tv;
if (!t) { eq("transcript", "none", "open"); process.exit(1); }
const L = t.lines;
const la = has(L, "✧ alpha · user · ");
eq("alpha load line", la >= 0 ? plain(L[la] ?? "").replace(/\$[0-9.]+/g, "$x") : L.map(plain).join("\n"), "✧ alpha · user · 1.0K tok · carried 4 req · ≈$x");
eq("unload line (one per compaction, each skill named)", has(L, "✧ alpha, beta ×2, delta out (compacted)") > la ? "after" : L.map(plain).join("\n"), "after");
eq("no listing line", String(has(L, "(listing)")), "-1");
eq("stub marked", has(L, "✧ beta · model (stub)") >= 0 ? "ok" : L.map(plain).join("\n"), "ok");
eq("re-injected after compaction", has(L, "✧ alpha · compact") > has(L, "out (compacted)") ? "ok" : "no", "ok");
// a load made by a tool call sits on that call (its line right above it), not on whatever event follows the result
const sk = has(L, "⚒ Skill("); // (the hermetic run redacts the arguments)
eq("Skill load above its call", sk > 0 ? plain(L[sk - 1] ?? "").slice(0, 16) : L.map(plain).join("\n"), "✧ beta · model ·");
// ] from the top lands on the first load's event (no kind filter: the next mark)
const j = viewKey("transcript", s, t.evs, 0, "]");
eq("] onto a load", j >= 0 && loadsAt(s, t.evs, j).length > 0 ? "load" : String(j), "load");
eq("] onto alpha", j >= 0 ? (loadsAt(s, t.evs, j)[0]?.name ?? "") : "", "alpha");
eq("the load line sits on that event", la >= 0 ? String(t.lineEv[la]) : "", String(j));
// the event detail starts with the load record; v opens view skill with the text read back from the log
t.cur = j; S.mode = "transcript";
let head: string[] = []; for (const f of H.detailHead) head = head.concat(f(s, t.evs, j, 100));
eq("detail head", has(head, "━━ SKILL LOAD") >= 0 && has(head, "trigger  / by you") >= 0 ? "ok" : head.map(plain).join("\n"), "ok");
onInput("v"); eq("v opens view skill", S.mode + " " + S.fview, "view skill");
const sv = skillViewLines(100);
eq("view skill text", has(sv, "LOREMSKILLTEXT") >= 0 ? "text" : sv.join("\n"), "text");
onInput("esc"); eq("esc back to the transcript", S.mode, "transcript");
setVis([{ match: "alpha", mode: "content" }], false);
onInput("v"); const sh = skillViewLines(100); onInput("esc");
eq("content rule hides the text", has(sh, "LOREMSKILLTEXT") < 0 && has(sh, "text hidden by skills.hide") >= 0 ? "hidden" : sh.join("\n"), "hidden");
setVis([{ match: "beta", mode: "omit" }], false);
t.lw = -1; layout(t, 116, t.evs.length);
eq("omitted: no line", String(has(t.lines, "✧ beta")), "-1");
setVis([], false); t.lw = -1;
// call graph: lanes under the turns with a band per load (load → unload), and the tree's skills row (last)
const lanes = skillLanes(marksOf(s, ["skill:load"]), Date.parse("2026-10-01T10:00:00.000Z"), 3);
eq("lanes", lanes.lanes.map((l) => l.map((b) => b.label + (b.open ? " open" : "")).join(" ")).join(" | ") + " +" + String(lanes.more), "alpha alpha open | beta gamma open | beta +1");
const al = lanes.lanes[0]?.[0];
eq("alpha band = load → compaction", al ? String(al.t1 - al.t0 > 0) + " " + String(al.t1 === (ms.find((m) => m.kind === "skill:unload" && m.label === "alpha")?.t0 ?? -1)) : "", "true true");
const sa = skillAgg(marksOf(s, ["skill:load"]), Date.parse("2026-10-01T10:00:00.000Z"));
eq("tree row", sa ? sa.name + " " + String(sa.count) + " " + sa.kids.map((k) => k.name + "×" + String(k.count)).join(",") : "none", "✧ skills 6 ✧ alpha×2,✧ beta×2,✧ delta×1,✧ gamma×1");
const tree: Agg[] = [{ name: "Bash", total: 1, self: 1, count: 1, max: 1, err: 0, best: 0, agent: false, kids: [] }];
if (sa) tree.unshift(sa); sortAggs(tree, 0);
eq("tree: skills after the calls", tree.map((x) => x.name).join(","), "Bash,✧ skills");
// related events: skill rows of the window, only in the "all kinds" set
const rr = skillRows(s, Date.parse("2026-10-01T08:00:00.000Z"), Date.parse("2026-10-01T12:00:00.000Z"), true, "/w/app");
eq("related rows", rr.map((r) => r.kind + " " + r.text).join(" | "), "skill ✧ alpha loaded (user) | skill ✧ beta loaded (model) | skill ✧ beta loaded (model) | skill ✧ delta loaded (model) | skill ✧ alpha loaded (compact) | skill ✧ gamma loaded (user)");
eq("related kind sets", String((KIND_SETS[0] ?? []).indexOf("skill") >= 0) + " " + String((KIND_SETS[1] ?? []).indexOf("skill") >= 0), "false true");
// the Wait timeline: loads per bucket of the period's sparkline, ✧ ticks aligned with it
const t0 = Date.parse("2026-10-01T00:00:00.000Z");
const bk = skillBuckets(t0, t0 + 86400000, 3600000, EMPTY);
const hr = new Date(Date.parse("2026-10-01T09:00:05.000Z")).getUTCHours();
eq("wait buckets", String(bk.length) + " " + String((bk[hr] ?? 0) > 0) + " total " + String(bk.reduce((x: number, y: number) => x + y, 0)), "24 true total 6");
eq("wait ticks", plain(skillTicks(bk, 24)).replace(/ /g, ".").indexOf("✧") === hr ? "aligned" : plain(skillTicks(bk, 24)), "aligned");
// replay: the skills in context at a moment
const mid = openAt(s, Date.parse("2026-10-01T09:00:30.000Z"));
eq("open at a moment (alpha again, gamma)", String(mid.n) + " " + String(mid.tok > 0), "2 true");
console.log(bad ? String(bad) + " failed" : "skill timelines: all checks passed");
if (bad) process.exit(1);
