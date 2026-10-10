// agentglass — skills.hide scrub budget: hiding is one linear pass per text, whatever the rules. A large session (MBs of
// text, long `full` fields, thousands of distinct skill-reference words) under "*" name, "*" omit and 20 mixed rules is
// scrubbed within a work bound (counters: chars visited, glob matches, candidate compares) and a loose wall bound. The
// quadratic scrub (one indexOf sweep per hidden name over every text, a regex per character) took minutes here
// scriptc build -O2 src/features/skills/scrub-perf.check.ts -o scp && ./scp
// check: timing
// SPDX-License-Identifier: Apache-2.0
import { type Ev, type Sess, newSess } from "../../model/types.ts";
import { setVis, skillVis, type HideRule } from "./vis.ts";
import { hideEvents, scrub, SCRUB_STAT, INSTALLED } from "./watchvis.ts";
import { READ } from "../../hooks.ts";

let bad = 0;
function ok(what: string, c: boolean, info: string): void { if (!c) { bad++; console.log("FAIL " + what + (info ? ": " + info.slice(0, 300) : "")); } }
function eq(what: string, a: string, b: string): void { ok(what, a === b, JSON.stringify(a) + " != " + JSON.stringify(b)); }

// ── semantics the single pass keeps (vis.check.ts and hide.check.ts cover the rest) ──
setVis([{ match: "acme:*", mode: "name" }, { match: "xyz", mode: "name" }], false);
const fx = skillVis("xyz").shown; const fp = skillVis("acme:xyz").shown;
// a skill's own name keeps its own fake: a plugin skill's dir ("xyz" of acme:xyz) never takes it over
eq("longest name wins at a position (plugin name over its dir)", scrub("load acme:xyz and xyz"), "load " + fp + " and " + fx);
eq("a name inside a longer word stays", scrub("xyzz xyz-y y_xyz xyz"), "xyzz xyz-y y_xyz " + fx);
eq("text edges", scrub("xyz"), fx);
setVis([{ match: "(odd)", mode: "omit" }, { match: "a.b", mode: "name" }], false);
eq("a name that starts with a non-word char", scrub("see (odd) here"), "see (hidden) here");
eq("a name with a dot", scrub("use a.b, not a.bc"), "use " + skillVis("a.b").shown + ", not a.bc");
// hidden names that overlap ("X:a" ends inside "a.b" in "X:a.b"): the longest at the first position wins and the other's
// rest goes too — no ".b" left behind
setVis([{ match: "X:a", mode: "name" }, { match: "a.b", mode: "name" }, { match: "b.c", mode: "omit" }], false);
{ const fa = skillVis("X:a").shown; const fb = skillVis("a.b").shown;
  eq("overlapping names: both go", scrub("load X:a.b now"), "load " + fa + fb + " now");
  eq("overlapping names: a chain", scrub("X:a.b.c!"), fa + fb + "(hidden)!");
  eq("overlapping names: apart", scrub("X:a, a.b"), fa + ", " + fb); }
setVis([{ match: "*", mode: "omit" }], false);
eq("* omit keeps prose and finds refs", scrub("run /deploy then $other and p:q at 10:30 in skills/dir/x"), "run /(hidden) then $(hidden) and (hidden) at 10:30 in skills/(hidden)/x");
eq("* omit: a file:line, host:port or time is no plugin skill", scrub("see app.ts:57, localhost:4318 at T09:30 — up 57 hours"), "see app.ts:57, localhost:4318 at T09:30 — up 57 hours");
eq("a ref seen later hides earlier mentions too", scrub("deployer then /deployer"), "(hidden) then /(hidden)");
eq("* omit: a plugin ref's :line tail stays, the ref goes", scrub("at acme:deploy:15 and /p:x:3:7 then"), "at (hidden):15 and /(hidden):3:7 then");
// an installed plugin skill with a digit after its colon is no file:line: hidden from its first mention
INSTALLED.of = (): string[] => ["p:3d", "tools:2fa", "acme:deploy"];
setVis([{ match: "*", mode: "omit" }], false);
eq("* omit: installed p:3d, tools:2fa:12 go; a file:line stays", scrub("use p:3d, tools:2fa:12 and app.ts:57 or p:3"), "use (hidden), (hidden):12 and app.ts:57 or p:3");
// a skill keeps its own fake whichever is met first: a plugin skill's dir, or the skill of that name
setVis([{ match: "*", mode: "name" }], false);
scrub("load acme:xyz"); eq("a skill met after a plugin skill's dir takes its own fake", scrub("then /xyz"), "then /" + skillVis("xyz").shown);
eq("the plugin skill keeps its fake", scrub("load acme:xyz"), "load " + skillVis("acme:xyz").shown);
// a text scrubbed twice (a title, then its JSON line) keeps the fakes the first scrub put in
setVis([{ match: "*", mode: "name" }], false);
{ const s1 = scrub("run /deploy-x, $other-y and p:q-z then /deploy-x"); eq("scrub twice = once", scrub(s1), s1); ok("scrub hid the refs", s1.indexOf("deploy-x") < 0 && s1.indexOf("other-y") < 0 && s1.indexOf("p:q-z") < 0, s1); }
// a lean reader (the call graph) drops replies and full texts: the names in them still hide the texts it keeps
setVis([{ match: "*", mode: "name" }], false);
{ const ls: Sess = newSess("claude", "lean", "/k/lean.jsonl", false);
  const le: Ev[] = [{ kind: "assistant", text: "next /secret-x", ts: "", id: "", full: "" }, { kind: "thinking", text: "or $other-y", ts: "", id: "", full: "" },
    { kind: "tool", text: "Bash\u0000run secret-x other-y", ts: "", id: "c1", full: "" }];
  READ.lean = true; hideEvents(ls, le, 0); READ.lean = false;
  const tl = le[2] ? le[2].text : ""; ok("lean: names in dropped texts hide kept ones", tl.indexOf("secret-x") < 0 && tl.indexOf("other-y") < 0, tl); }
setVis([{ match: "abc*", mode: "name" }], false);
eq("3+ literal chars match every word", scrub("abcdef and xabc"), skillVis("abcdef").shown + " and xabc");
setVis([{ match: "*acme*", mode: "omit" }, { match: "*:int-*", mode: "omit" }], false);
eq("a strong rule's literal inside a word, a plugin name, pi's /skill:", scrub("x-acme-y, p:int-z and /skill:acme2 but acm-e, p:intz"), "(hidden), (hidden) and /skill:(hidden) but acm-e, p:intz");

// ── the large session ──
const PROSE = ["fix", "the", "second", "bug", "in", "app.js", "at", "10:30", "watchvis.ts:57", "then", "run", "tests", "and", "commit", "result", "ok"];
function line(i: number, n: number): string {
  let o = "";
  for (let k = 0; o.length < n; k++) {
    const j = (i * 31 + k * 7) % 997;
    if (k % 9 === 3) o += " /cmd-" + String(j % 3000);
    else if (k % 13 === 5) o += " $VAR" + String(j);
    else if (k % 17 === 7) o += " plug" + (j % 2 ? "" : String(j % 50)) + ":sk-" + String(j); // ~1000 names under one leading word
    else if (k % 23 === 11) o += " ~/.claude/skills/dir-" + String(j) + "/SKILL.md";
    else if (k % 29 === 13) o += " /home/dev/p" + String(j % 40) + "/src/m" + String(j) + ".ts";
    else if (k % 31 === 17) o += " höchst — ≈ grün"; // non-ASCII: string indices are not byte offsets
    else o += " " + (PROSE[(i + k) % PROSE.length] ?? "") + String(k % 3 === 0 ? j : "");
  }
  return o;
}
const N = 6000; const T = Date.parse("2026-10-01T09:00:00Z");
function session(): Ev[] {
  const evs: Ev[] = [];
  for (let i = 0; i < N; i++) {
    const ts = new Date(T + i * 1000).toISOString(); const k = i % 4;
    const full = i % 150 === 0 ? line(i, 120000) : line(i + 1, 1200);
    if (k === 0) evs.push({ kind: "user", text: line(i, 200), ts, id: "", full });
    else if (k === 1) evs.push({ kind: "tool", text: "Bash\u0000" + line(i, 120), ts, id: "c" + String(i), full });
    else if (k === 2) evs.push({ kind: "result", text: line(i, 300), ts, id: "c" + String(i - 1), full });
    else evs.push({ kind: "assistant", text: line(i, 400), ts, id: "", full });
  }
  return evs;
}
let chars = 0; for (const e of session()) chars += e.text.length + e.full.length;
console.log("synthetic session: " + String(N) + " events, " + String(Math.round(chars / 1048576 * 10) / 10) + " MB of text");
const MIXED: HideRule[] = [];
for (let i = 0; i < 20; i++) MIXED.push({ match: i % 4 === 0 ? "cmd-" + String(i * 7) + "*" : i % 4 === 1 ? "plug" + String(i) + ":*" : i % 4 === 2 ? "sk-?" + String(i) : "*-" + String(i), mode: ["name", "omit", "content"][i % 3] ?? "name" });
const NONE: HideRule[] = [];
const SETS: { n: string; r: HideRule[] }[] = [{ n: "* name", r: [{ match: "*", mode: "name" }] }, { n: "* omit", r: [{ match: "*", mode: "omit" }] }, { n: "20 mixed", r: MIXED }, { n: "no rules", r: NONE }];
let worst = 0; let k = 0;
for (const set of SETS) {
  setVis(set.r, false); const nm = set.n;
  const s: Sess = newSess("claude", "perf-" + String(k), "/k/perf-" + String(k) + ".jsonl", false); s.size = 1;
  const evs = session();
  SCRUB_STAT.chars = 0; SCRUB_STAT.glob = 0; SCRUB_STAT.cmp = 0;
  const a = Date.now(); hideEvents(s, evs, 0); const ms = Date.now() - a;
  worst = Math.max(worst, ms);
  console.log(nm + ": " + String(ms) + " ms · chars " + String(SCRUB_STAT.chars) + " · glob " + String(SCRUB_STAT.glob) + " · cmp " + String(SCRUB_STAT.cmp) + " · " + String(evs.length) + " events left");
  // linear: each text read a bounded number of times (two passes and a gate), a glob tried once per distinct word and
  // rule, a few name compares per word
  ok(nm + ": chars visited", SCRUB_STAT.chars <= 3 * chars, String(SCRUB_STAT.chars) + " > 3 × " + String(chars));
  ok(nm + ": glob matches", SCRUB_STAT.glob <= 20 * 40000, String(SCRUB_STAT.glob));
  ok(nm + ": name compares", SCRUB_STAT.cmp <= chars / 2, String(SCRUB_STAT.cmp));
  if (k === 0) { let left = 0; for (const e of evs) if (e.text.indexOf("/cmd-1 ") >= 0 || e.full.indexOf("plug:sk-1 ") >= 0) left++; ok("* name hides the refs", left === 0, String(left) + " events"); }
  k++;
}
// a developer machine does this in well under a second per rule set; CI runners are slower — the bound guards against
// the quadratic scrub (minutes), the counters against anything in between
const BUDGET = process.env.CI ? 6000 : 2000;
ok("wall bound", worst <= BUDGET, String(worst) + " ms > " + String(BUDGET));
if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("skills.hide scrub budget: ok");
