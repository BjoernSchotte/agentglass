// agentglass — self-check: OpenCode and Gemini skill loads (skill tool / activate_skill with their text, a skill row, reads
// of a SKILL.md, compaction, Gemini's implicit drop) and a Kiro compaction from synthetic lines:
// scriptc build src/harness/opencode-skill.check.ts -o os && ./os
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { opencode } from "./opencode.ts";
import { gemini } from "./gemini.ts";
import { kiro } from "./kiro.ts";
import { type Acc, type SkLoad, newAcc, skillUsesOf, skillLoad } from "../features/usage/record.ts";
import { outDir } from "../features/usage/skillrec.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function row(l: SkLoad): string { return [l.name, l.trig, String(l.S), l.lt.join("/"), l.ct.join("/"), l.end ? l.why : "open"].join(" "); }
function feed(f: string, u: (a: Acc, l: string) => void): Acc { const a = newAcc(); for (const l of readFileSync("testdata/skills/" + f, "utf8").split("\n")) if (l) u(a, l); return a; }

const o = feed("opencode.jsonl", opencode.usage);
eq("opencode loads", o.sk.map(row).join("\n"), [
  "alpha model 1000 0/0/1000/0 0/1000/0/0 compact",
  "beta model 500 0/0/500/0 0/500/0/0 compact",
  "gamma user -1 0/0/0/0 0/0/0/0 compact",
].join("\n"));
eq("opencode uses", JSON.stringify(skillUsesOf([o], null)), "[{\"name\":\"alpha\",\"source\":\"model\",\"n\":1},{\"name\":\"beta\",\"source\":\"model\",\"n\":1},{\"name\":\"gamma\",\"source\":\"command\",\"n\":1}]");

const g = feed("gemini.jsonl", gemini.usage);
eq("gemini loads", g.sk.map(row).join("\n"), [
  "alpha model 924 924/0/0/0 0/924/0/0 drop", // Gemini's divisor 3.9: 3600 B → 924 tok
  "beta model 462 462/0/0/0 0/0/0/0 drop",
].join("\n"));
eq("gemini uses", JSON.stringify(skillUsesOf([g], null)), "[{\"name\":\"alpha\",\"source\":\"model\",\"n\":1},{\"name\":\"beta\",\"source\":\"model\",\"n\":1}]");
eq("no text kept", String(JSON.stringify(o.sk).indexOf("LOREMSKILLTEXT") + JSON.stringify(g.sk).indexOf("LOREMSKILLTEXT")), "-2");

const k = newAcc(); skillLoad(k, "x", "model", 1, "", "lorem", true, "", false);
kiro.usage(k, "{\"version\":\"v1\",\"kind\":\"Compaction\",\"data\":{}}");
eq("kiro compaction unloads", (k.sk[0] as SkLoad).why, "compact");

// the skill tool's output names the skill's directory: OpenCode's Base directory line, Gemini's available_resources
eq("dir from OpenCode output", outDir("<skill_content name=\"x\">\nBase directory for this skill: file:///r/.opencode/skills/x/\nRelative paths …", "x"), "/r/.opencode/skills/x");
eq("dir from Gemini output", outDir("<activated_skill name=\"x\">\n  <available_resources>\nShowing up to 200 items.\n\n/h/.gemini/skills/x/\n└───SKILL.md\n  </available_resources>", "x"), "/h/.gemini/skills/x");
eq("no dir named", outDir("just text", "x") + outDir("<available_resources>\n/h/other/y/\n</available_resources>", "x"), "");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok opencode/gemini/kiro skills");
