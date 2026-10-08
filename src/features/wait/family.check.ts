// agentglass — agent-wait command families: the golden table, user rules, several commands per call, tool kinds, memo
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { type WaitCfg, type FamRule, parseWaitCfg, setWaitCfgForTest, familyOf, famHint, cutMayHide, callFamily, toolKind, toolFamily, rowFam, famName, famKind, famGeneric, shownFam, FAM_STATS, ALL_KINDS, FAM_RULES, GOLDEN_SIG } from "./family.ts";
import { DICT, intern } from "../usage/facts.ts";
import { rowsFrom, newRows, push, addCmd, rowIds, KIND_CMD, KIND_HINT } from "../usage/rows.ts";
import { REDACT } from "../redact-on.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const D = parseWaitCfg(undefined);

// the golden table: every line exact
const path = (process.env.AGENTGLASS_SRC || "src") + "/features/wait/families.golden";
let n = 0;
for (const l of readFileSync(path, "utf8").split("\n")) {
  if (!l || l.startsWith("#")) continue;
  const c = l.split("\t");
  if (c.length !== 3) { bad++; console.log("FAIL golden line shape: " + JSON.stringify(l)); continue; }
  const f = familyOf(c[0] ?? "", D); n++;
  eq("golden " + JSON.stringify(c[0]), f.name + "\t" + f.kind, (c[1] ?? "") + "\t" + (c[2] ?? ""));
}
eq("golden size ≥ 200", String(n >= 200), "true");
// a changed table means changed built-in rules: stored digests must not outlive them (family.ts FAM_RULES)
{ const txt = readFileSync(path, "utf8"); let h = 2166136261; for (let i = 0; i < txt.length; i++) { h ^= txt.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const sig = String(FAM_RULES) + ":" + String(h);
  if (sig !== GOLDEN_SIG) { bad++; console.log("FAIL families.golden changed: set FAM_RULES = " + String(FAM_RULES + 1) + " and GOLDEN_SIG = \"" + String(FAM_RULES + 1) + ":" + String(h) + "\" in family.ts"); } }

// heavy: the default kinds; heavyKinds narrows them
eq("heavy default tsc", String(familyOf("npx tsc", D).heavy), "true");
eq("heavy default git", String(familyOf("git status", D).heavy), "false");
eq("heavy ci not heavy", String(familyOf("gh run watch 1", D).heavy), "false");
const onlyTest = parseWaitCfg({ heavyKinds: ["test"] });
eq("heavyKinds test: tsc light", String(familyOf("npx tsc", onlyTest).heavy), "false");
eq("heavyKinds test: pnpm test heavy", String(familyOf("pnpm test", onlyTest).heavy), "true");

// user rules: $1 captures, trailing ..., in-word globs, order (first wins), heavy override
const U = parseWaitCfg({ families: [
  { match: "make *", family: "make $1", kind: "build" },
  { match: "./scripts/ci.sh ...", family: "ci.sh", kind: "test", heavy: true },
  { match: "pnpm run storybook:*", kind: "test" },
  { match: "make docs", family: "never", kind: "other" },
  { match: "python3 tools/*.py ...", family: "tool $1", kind: "build", heavy: false },
] });
eq("rules parsed", String(U.rules.length) + " " + String(U.diags.length), "5 0");
function show(f: { name: string; kind: string; heavy: boolean }): string { return f.name + "/" + f.kind + "/" + (f.heavy ? "heavy" : "light"); }
eq("rule make $1", show(familyOf("make docs", U)), "make docs/build/heavy");
eq("rule make: two words only", show(familyOf("make -j8 docs", U)), "make docs/build/heavy");
eq("rule ci.sh ...", show(familyOf("./scripts/ci.sh --fast x", U)), "ci.sh/test/heavy");
eq("rule ci.sh behind cd", show(familyOf("cd /w/app && ./scripts/ci.sh", U)), "ci.sh/test/heavy");
eq("rule storybook glob keeps the built-in name", show(familyOf("pnpm run storybook:test:dev", U)), "pnpm run storybook:test:dev/test/heavy");
eq("rule heavy false, missing capture", show(familyOf("python3 tools/gen.py --all", U)), "tool/build/light");
eq("rule miss → built-in", show(familyOf("pnpm test", U)), "pnpm test/test/heavy");
eq("rule after wrappers", show(familyOf("timeout 60 make docs", U)), "make docs/build/heavy");

// invalid entries: one diagnostic each, the valid rest kept, defaults for bad scalars
const B = parseWaitCfg({ families: [{ match: "" }, { match: "x", kind: "nope" }, { family: "y" }, "str", { match: "ok *", family: 3 }, { match: "keep *", kind: "lint" }], heavyKinds: ["nope"], minSec: -1 });
eq("invalid: diags", String(B.diags.length), "7");
eq("invalid: kept rule", String(B.rules.length) + " " + B.rules.map((r: FamRule): string => r.words.join(" ")).join("|"), "1 keep *");
eq("invalid: heavyKinds default", B.heavyKinds.join(" "), "test typecheck lint build install");
eq("invalid: minSec default", String(B.minSec), "10");
eq("invalid: diag names the entry", B.diags[1] ?? "", "wait.families[1]: kind \"nope\" unknown (test typecheck lint build install ci wait vcs net other) — ignored");
eq("not an object", parseWaitCfg(3).diags.join("|"), "wait: not an object — ignored");
eq("minSec ok", String(parseWaitCfg({ minSec: 30 }).minSec), "30");

// several commands in one call: the highest kind priority, ties → the first
eq("call: test over vcs", callFamily(["git status", "pnpm test"], D).name, "pnpm test");
eq("call: typecheck after test", callFamily(["npx tsc", "pnpm test"], D).name, "pnpm test");
eq("call: tie → first", callFamily(["pnpm test", "npm test"], D).name, "pnpm test");
eq("call: ci over other", callFamily(["ls", "gh pr checks 1"], D).name, "gh pr checks");
eq("call: none", show(callFamily([], D)), "sh/other/light");

// non-shell tools
eq("tool user", toolKind("AskUserQuestion"), "user");
eq("tool user codex", toolKind("request_user_input_async"), "user");
eq("tool wait", toolKind("TaskOutput") + " " + toolKind("BashOutput") + " " + toolKind("write_stdin"), "wait wait wait");
eq("tool agent", toolKind("Agent") + " " + toolKind("Task") + " " + toolKind("SendMessage") + " " + toolKind("spawn_agent"), "agent agent agent agent");
eq("tool web", toolKind("WebFetch") + " " + toolKind("web_search"), "web web");
eq("tool mcp", toolKind("mcp__github__x"), "mcp");
eq("tool mcp family", toolFamily("mcp__github__create_issue"), "mcp github");
eq("tool family plain", toolFamily("Read"), "Read");
eq("tool file", toolKind("Read") + " " + toolKind("apply_patch") + " " + toolKind("read_file"), "file file file");
eq("tool other", toolKind("Foo"), "other");
eq("kinds enum", ALL_KINDS.join(" "), "test typecheck lint build install ci wait vcs net other user agent web mcp file");

// 40-character cut; redaction happens at display (generic families only)
eq("cut 40", familyOf("node scripts/" + "x".repeat(60) + ".js", D).name.length <= 40 ? "ok" : "long", "ok");
const gen = familyOf("node scripts/gen.js", D);
eq("generic node", gen.name + " " + String(gen.generic), "node gen.js true");
eq("generic sh check", String(familyOf("sh scripts/check.sh", D).generic), "true");
eq("not generic", String(familyOf("pnpm test", D).generic), "false");
eq("shown under --redact", shownFam("node gen.js", true), REDACT ? "node" : "node gen.js");
eq("shown not generic", shownFam("pnpm test", false), "pnpm test");

// memo over call rows: one normalisation per distinct command id
setWaitCfgForTest(D);
const ct = intern(DICT.cmd, "pnpm test"); const cg = intern(DICT.cmd, "git status"); const tb = intern(DICT.tool, "Bash"); const tr = intern(DICT.tool, "Read");
const row = (t: number, tool: number, cmds: number[]) => ({ t, tool, model: -1, mq: 0, progs: [] as number[], cmds, files: [] as number[], ms: 1000, err: 0, out: 0, cid: "" });
const rs = rowsFrom([row(1, tb, [ct]), row(2, tb, [ct]), row(3, tr, []), row(4, tb, [cg, ct])]);
const n0 = FAM_STATS.norm;
const f0 = rowFam(rs, 0); const f1 = rowFam(rs, 1);
eq("memo same id", String(f0 === f1 && f0 >= 0), "true");
eq("memo once", String(FAM_STATS.norm - n0), "1");
eq("memo name", famName(f0) + " " + famKind(f0) + " " + String(famGeneric(f0)), "pnpm test test false");
eq("row without command", String(rowFam(rs, 2)), "-1");
eq("row with two commands", famName(rowFam(rs, 3)), "pnpm test");
eq("memo twice more", String(FAM_STATS.norm - n0), "2");
eq("out of range", String(rowFam(rs, 9)), "-1");
const cfgT: WaitCfg = parseWaitCfg({ families: [{ match: "pnpm test", family: "unit", kind: "test" }] });
setWaitCfgForTest(cfgT);
eq("config change resets the memo", famName(rowFam(rs, 0)), "unit");
setWaitCfgForTest(null);

// the family hint of a command cut at 200 characters (record.ts stores it beside the cut text): the segment the family
// comes from, taken from the whole line; "" when the stored text names the same segment
let env = "export"; for (let i = 0; i < 34; i++) env += " V" + String(i) + "=" + String(i);
const long1 = "cd /w/app && " + env + " && pnpm test -- --run"; // the family's segment lies past the cut
eq("hint: past the cut", famHint(long1), "pnpm test -- --run");
eq("hint: its family", familyOf(famHint(long1), D).name, familyOf(long1, D).name);
eq("hint: the cut text alone misses it", familyOf(long1.slice(0, 200), D).name === "pnpm test" ? "same" : "lost", "lost");
eq("hint: short line needs none", famHint("cd /w/app && pnpm test"), "");
const long2 = "cd /w/app && pnpm vitest run " + "x/".repeat(120) + "a.test.ts";
eq("hint: the segment starts inside the cut, its head names the family", famHint(long2), "");
const long3 = "cat " + "y/".repeat(110) + "log.txt | python3 -";
eq("hint: a filter first, the program past the cut", familyOf(famHint(long3), D).name, "python3");
const head4 = "cd /w/app && export A="; const long4 = head4 + "a".repeat(200 - head4.length - 6) + " && echo done"; // cut inside "echo"
eq("hint: the cut makes a program of a trivial step", familyOf(long4.slice(0, 200), D).name, "ec");
eq("hint: only trivial steps", famHint(long4), ":");
eq("hint: trivial → sh", familyOf(famHint(long4), D).name, "sh");
eq("hint: trivial either way needs none", famHint("cd /w/app && " + env + " && echo done"), "");
const long5 = "cd /w/app && " + env + " && until gh run view 1 --exit-status; do sleep 20; done";
eq("hint: a loop past the cut", familyOf(famHint(long5), D).name, familyOf(long5, D).name);
eq("hint: user rules apply to the hint", familyOf(famHint(long1), parseWaitCfg({ families: [{ match: "pnpm test ...", family: "unit" }] })).name, "unit");
eq("hint: ≤ 200 characters", String(famHint("cd /w && " + env + " && node " + "z".repeat(300) + ".js").length <= 200), "true");
// format-2 lines (no hints): only those whose cut may have hidden the family make their session index again
eq("may hide: a whole segment inside the cut", String(cutMayHide(("pnpm test && echo " + "x".repeat(300)).slice(0, 200))), "false");
eq("may hide: only trivial steps in the cut", String(cutMayHide(long1.slice(0, 200))), "true");
eq("may hide: a filter so far", String(cutMayHide(long3.slice(0, 200))), "true");
eq("may hide: the segment runs to the cut, its head decides", String(cutMayHide(long2.slice(0, 200))), "false");
eq("may hide: the cut splits the deciding word", String(cutMayHide(("pnpm " + "-w ".repeat(63) + "run test").slice(0, 200))), "true");
eq("may hide: only options before the cut", String(cutMayHide(("pnpm " + "-w ".repeat(70) + "run test").slice(0, 200))), "true");
eq("may hide: a script name at the cut", String(cutMayHide(("pnpm run " + "x".repeat(200)).slice(0, 200))), "true");
eq("may hide: a nested shell command at the cut", String(cutMayHide(("bash -lc \"cd /w && " + "y".repeat(200) + " && pnpm test\"").slice(0, 200))), "true");
eq("may hide: a heredoc body after the program", String(cutMayHide(("python3 - <<'EOF' " + "z = 1; ".repeat(40) + " EOF").slice(0, 200))), "false");
eq("may hide: agrees with famHint where it says no", String(famHint("pnpm test && echo " + "x".repeat(300))), "");
// a row counts a command by its hint (the link right after it)
setWaitCfgForTest(D);
const hr = newRows(); const cut = intern(DICT.cmd, long1.slice(0, 200)); const hint = intern(DICT.cmd, famHint(long1));
const h0 = push(hr, 1, tb, -1, 0); addCmd(hr, h0, cut, hint);
const h1 = push(hr, 2, tb, -1, 0); addCmd(hr, h1, cut, -1);
const h2 = push(hr, 3, tb, -1, 0); addCmd(hr, h2, cg, -1); addCmd(hr, h2, cut, hint); addCmd(hr, h2, cut, hint);
eq("row: by its hint", famName(rowFam(hr, h0)), "pnpm test");
eq("row: no hint → the stored text", famName(rowFam(hr, h1)), familyOf(long1.slice(0, 200), D).name);
eq("row: hint of the second command", famName(rowFam(hr, h2)), "pnpm test");
eq("row: a repeated command adds nothing", String(rowIds(hr, h2, KIND_CMD).length) + " " + String(rowIds(hr, h2, KIND_HINT).length), "2 1");
setWaitCfgForTest(null);

console.log(bad ? bad + " failed" : "family: all checks passed");
if (bad) process.exit(1);
