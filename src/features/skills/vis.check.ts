// agentglass — self-check for skill visibility (skills.hide, --redact): scriptc build src/features/skills/vis.check.ts -o vc && ./vc
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { parseHide, setVis, skillVis, textShown, textHiddenWhy, globMatch, listingShown, VIS_SURFACES, VIS_SOURCES, VIS_DATA, SKILL_DATA_RE, type HideRule } from "./vis.ts";
import { fakeSkill } from "../redact.ts";
import { callSkill, callVis, scrub, hideEvents } from "./watchvis.ts";
import type { Ev } from "../../model/types.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ok(what: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + what); } }

// globs
ok("glob star", globMatch("acme-*", "acme-x") && !globMatch("acme-*", "xacme-x"));
ok("glob plugin", globMatch("*:internal-*", "acme:internal-x") && !globMatch("*:internal-*", "internal-x"));
ok("glob ?", globMatch("a?c", "abc") && !globMatch("a?c", "abbc"));
ok("glob case", !globMatch("Acme", "acme"));
ok("glob exact", globMatch("secret", "secret") && !globMatch("secret", "secrets"));

// rule parsing: bare string → content; bad entries ignored with a reason; order kept
const p = parseHide(["legacy", { match: "acme-*", mode: "name" }, { match: "x", mode: "bogus" }, { mode: "omit" }, 3, { match: "secret", mode: "omit" }, { match: "*:internal-*", mode: "content" }]);
eq("rules", p.rules.map((r: HideRule) => r.match + "=" + r.mode).join(","), "legacy=content,acme-*=name,secret=omit,*:internal-*=content");
eq("bad count", String(p.bad.length), "3");
ok("bad names the entry", p.bad[0] !== undefined && (p.bad[0] ?? "").indexOf("entry 3") >= 0);
eq("not a list", String(parseHide({ a: 1 }).bad.length), "1");
eq("absent", String(parseHide(undefined).rules.length + parseHide(undefined).bad.length), "0");

// first match wins
setVis(parseHide([{ match: "acme-*", mode: "name" }, { match: "acme-x", mode: "omit" }, { match: "notes", mode: "content" }, { match: "secret", mode: "omit" }]).rules, false);
eq("first match", skillVis("acme-x").mode, "name");
ok("name fake same length", skillVis("acme-x").shown !== "acme-x" && skillVis("acme-x").shown.length === 6);
eq("omit", skillVis("secret").mode + "|" + skillVis("secret").shown, "omit|");
eq("content keeps name", skillVis("notes").shown, "notes");
eq("show", skillVis("pub").mode + "|" + skillVis("pub").shown, "show|pub");

// textShown: local × outward × --content × each mode
eq("text pub local", String(textShown("pub", false, false)), "true");
eq("text pub outward", String(textShown("pub", true, false)), "false");
eq("text pub outward content", String(textShown("pub", true, true)), "true");
for (const n of ["notes", "acme-x", "secret"]) for (const o of [false, true]) for (const c of [false, true]) ok("text hidden " + n, !textShown(n, o, c));
eq("why rule", textHiddenWhy("notes"), "text hidden by skills.hide");
eq("why shown", textHiddenWhy("pub"), "");

// --redact: user skills faked (stable, same length), built-ins kept with text hidden; stricter of redact and a rule
setVis(parseHide([{ match: "notes", mode: "content" }, { match: "secret", mode: "omit" }]).rules, true);
const f = skillVis("my-team-skill").shown;
ok("redact fakes", f !== "my-team-skill" && f.length === "my-team-skill".length && f === fakeSkill("my-team-skill"));
eq("redact stable", skillVis("my-team-skill").shown, f);
eq("redact: a fake stays itself (scrubbed call text)", skillVis(f).shown, f);
ok("redact plugin whole", skillVis("acme:deploy").shown.length === 11 && skillVis("acme:deploy").shown.indexOf("acme") < 0);
eq("redact builtin", skillVis("claude-api").mode + "|" + skillVis("claude-api").shown, "content|claude-api");
eq("redact listing", skillVis("(listing)").shown, "(listing)");
eq("redact + content rule → name", skillVis("notes").mode, "name");
eq("redact + omit rule → omit", skillVis("secret").mode, "omit");
eq("why redact", textHiddenWhy("pub"), "text hidden (--redact)");
ok("redact no text", !textShown("pub", false, false) && !textShown("pub", true, true));

// --watch event lines: the skill a call loads, and what its line shows
setVis(parseHide([{ match: "sec*", mode: "omit" }, { match: "acme-x", mode: "name" }, "notes"]).rules, false);
eq("callSkill Skill", callSkill("Skill", "acme-x"), "acme-x");
eq("callSkill opencode", callSkill("skill", "{\"id\":\"notes\"}"), "notes");
eq("callSkill read", callSkill("Read", "/h/.claude/skills/notes/SKILL.md"), "notes");
eq("callSkill codex exec", callSkill("exec", "const r = await tools.exec_command({\"cmd\":\"sed -n '1,9p' /h/.codex/skills/secret/SKILL.md\"});"), "secret");
eq("callSkill plain call", callSkill("Bash", "ls /h/.codex/skills/secret/SKILL.md"), "");
ok("callVis omit drops", callVis("Read", "/h/.claude/skills/secret/SKILL.md").drop);
const cn = callVis("Read", "/h/.pi/agent/skills/acme-x/SKILL.md");
ok("callVis name fakes the path, hides the text", !cn.drop && cn.args.indexOf("acme-x") < 0 && cn.args.endsWith("/SKILL.md") && cn.hide === "(text hidden by skills.hide)");
eq("callVis content keeps the name", callVis("Skill", "notes").args + " " + callVis("Skill", "notes").hide, "notes (text hidden by skills.hide)");
eq("callVis shown skill", callVis("Skill", "pub").hide, "");
ok("scrub whole words only", scrub("use acme-x now; acme-xy stays").indexOf("acme-xy stays") > 0 && scrub("use acme-x now").indexOf("acme-x ") < 0);
// a glob rule hides a name in a title before any load of it was seen (--watch and --json titles); prose words stay
setVis(parseHide([{ match: "*:internal-*", mode: "omit" }, { match: "acme-*", mode: "name" }, { match: "*", mode: "content" }]).rules, false);
const ti = scrub("/acme:internal-x fix the second bug");
eq("glob omit: a title before any load", ti, "/(hidden) fix the second bug");
const tn = scrub("<command-name>/acme-tool</command-name> then $acme-other, /skill:acme-pi and ~/.pi/skills/acme-dir/SKILL.md; acme-prose stays");
ok("glob name: references and prose faked " + tn, ["acme-tool", "acme-other", "acme-pi", "acme-dir", "acme-prose"].every((n: string) => tn.indexOf(n) < 0) && tn.indexOf(" stays") > 0 && tn.indexOf("/SKILL.md") > 0);
eq("a * rule hides no prose", scrub("fix the build at 10:30"), "fix the build at 10:30");
{ // a "*" omit rule (hide every skill): the reference goes, the title's other words stay
  setVis(parseHide([{ match: "*", mode: "omit" }]).rules, false);
  eq("* omit: title keeps its words", scrub("run /deploy then fix the second bug in app.js at 10:30"), "run /(hidden) then fix the second bug in app.js at 10:30");
  setVis(parseHide([{ match: "*:internal-*", mode: "omit" }, { match: "acme-*", mode: "name" }, { match: "*", mode: "content" }]).rules, false);
}
eq("a specific glob hides prose mentions too", scrub("first load the acme-later skill"), "first load the " + skillVis("acme-later").shown + " skill");
// a listing names and describes every skill: hidden ones (any mode but show) leave it
setVis(parseHide([{ match: "sec*", mode: "omit" }, { match: "acme-x", mode: "name" }, "notes"]).rules, false);
eq("listing without hidden skills", listingShown("- pub: shown\n  more of pub\n- secret: s\n  more of secret\n- acme-x: a\n- notes: n\n- p:pub2: shown too"), "- pub: shown\n  more of pub\n- p:pub2: shown too\n(3 hidden by skills.hide)");
// the TUI's events (transcript, detail, call graph, related): the same rules over parsed events, results paired by call id
{
  const E = (kind: string, text: string, id: string, full: string): Ev => ({ kind, text, ts: "2026-10-01T09:00:00.000Z", id, full });
  const evs: Ev[] = [E("user", "/notes and acme-x please", "", ""), E("tool", "Skill\u0000secret", "c1", "{\"skill\":\"secret\"}"), E("tool", "Read\u0000/h/.claude/skills/notes/SKILL.md", "c2", ""),
    E("tool", "Skill\u0000acme-x", "c3", "{\"skill\":\"acme-x\"}"), E("tool", "Bash\u0000ls", "c4", "")];
  hideEvents(null, evs, 0);
  const later: Ev[] = [E("result", "Launching skill: secret", "c1", ""), E("result", "LOREMSKILLTEXT notes body", "c2", "LOREMSKILLTEXT notes body"), E("result", "Launching skill: acme-x", "c3", "{\"commandName\":\"acme-x\"}"), E("result", "a.txt", "c4", "")];
  hideEvents(null, later, 0); // a later read: results find their calls
  const all = evs.concat(later).map((e: Ev): string => e.kind + " " + e.text.split("\u0000").join("(") + " | " + e.full).join("\n");
  ok("events: omitted skill's call and result gone", all.indexOf("secret") < 0 && evs.length === 4 && later.length === 3);
  ok("events: content skill's text hidden", all.indexOf("LOREMSKILLTEXT") < 0 && all.indexOf("result (text hidden by skills.hide) | ") >= 0);
  ok("events: name skill faked in call, result and prompt", all.indexOf("acme-x") < 0 && all.indexOf("tool Skill(" + skillVis("acme-x").shown) >= 0);
  ok("events: other calls untouched", all.indexOf("tool Bash(ls") >= 0 && all.indexOf("result a.txt") >= 0);
  setVis([], false);
  const free: Ev[] = [E("tool", "Skill\u0000secret", "c9", "")]; hideEvents(null, free, 0);
  eq("events: no rules, no change", free.map((e: Ev): string => e.text).join(""), "Skill\u0000secret");
}
setVis([], false);

// every surface module calls skillVis or textShown, or takes its skills from a source that did
for (const f2 of VIS_SURFACES) {
  ok("surface exists: " + f2, existsSync(f2));
  if (!existsSync(f2)) continue;
  const t = readFileSync(f2, "utf-8");
  ok("surface uses skillVis: " + f2, VIS_SOURCES.some((x: string) => t.indexOf(x) >= 0));
}
// every module that reads skill data is a listed surface or data layer (a new surface must be listed, and so checked)
function walk(d: string, out: string[]): void {
  for (const n of readdirSync(d)) { const p2 = d + "/" + n; if (statSync(p2).isDirectory()) walk(p2, out); else if (n.endsWith(".ts") && !n.endsWith(".check.ts") && n.indexOf("fixture") < 0) out.push(p2); }
}
const all: string[] = []; walk("src", all);
let seen = 0;
for (const f3 of all) {
  if (!SKILL_DATA_RE.test(readFileSync(f3, "utf-8"))) continue;
  seen++;
  ok("reads skill data, listed in VIS_SURFACES or VIS_DATA: " + f3, VIS_SURFACES.indexOf(f3) >= 0 || VIS_DATA.indexOf(f3) >= 0);
}
ok("the walk found the skill modules", seen >= 20);
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok skill visibility");
