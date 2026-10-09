// agentglass — self-check: pi skill loads (/skill: block, a read of a SKILL.md, compaction) from a synthetic session:
// scriptc build src/harness/pi-skill.check.ts -o ps && ./ps
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { pi } from "./pi.ts";
import { type SkLoad, newAcc, skillUsesOf } from "../features/usage/record.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const a = newAcc();
for (const l of readFileSync("testdata/skills/pi.jsonl", "utf8").split("\n")) if (l) pi.usage(a, l);
function row(l: SkLoad): string { return [l.name, l.trig, String(l.bytes), String(l.S), l.lt.join("/"), l.ct.join("/"), l.end ? l.why : "open", l.dir, l.scope].join(" "); }
eq("loads", a.sk.map(row).join("\n"), [
  "alpha user 3600 1000 0/0/1000/0 0/2000/0/0 compact /h/.pi/agent/skills/alpha project",
  "beta model 1800 500 0/0/500/0 0/500/0/0 compact /h/.pi/agent/skills/beta project",
].join("\n"));
eq("uses", JSON.stringify(skillUsesOf([a], null)), "[{\"name\":\"alpha\",\"source\":\"command\",\"n\":1},{\"name\":\"beta\",\"source\":\"model\",\"n\":1}]");
eq("no text kept", String(JSON.stringify(a.sk).indexOf("LOREMSKILLTEXT")), "-1");
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok pi skills");
