// agentglass — self-check: Codex skill loads (SKILL.md read over two partial shell reads, ≈ when cut; the developer
// message's skill listing; compaction) from a synthetic rollout: scriptc build src/harness/codex-skill.check.ts -o xs && ./xs
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { codex } from "./codex.ts";
import { type SkLoad, newAcc, skillUsesOf } from "../features/usage/record.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const a = newAcc();
for (const l of readFileSync("testdata/skills/codex.jsonl", "utf8").split("\n")) if (l) codex.usage(a, l);
function row(l: SkLoad): string { return [l.name, l.trig, l.est ? "≈" : "exact", l.end ? l.why : "open", l.dir].join(" "); }
eq("loads", a.sk.map(row).join("\n"), [
  "(listing) listing exact compact ",
  "alpha model ≈ compact /h/.codex/skills/alpha",
  "(listing) listing exact open ",
].join("\n"));
const A = a.sk[1] as SkLoad;
eq("two partial reads: one load, both outputs", String(A.bytes > 3600 && A.bytes < 3800) + " " + String(A.rd), "true true");
eq("first part sent as load, the second with the next request", String((A.lt[2] ?? 0) + (A.lt[0] ?? 0) + (A.lt[1] ?? 0) > 0) + " " + String(A.nq), "true 2");
eq("model use counted", JSON.stringify(skillUsesOf([a], null)), "[{\"name\":\"alpha\",\"source\":\"model\",\"n\":1}]");
eq("listing names", a.lst.join(","), "alpha,beta,gamma");
eq("no text kept", String(JSON.stringify(a.sk).indexOf("LOREMSKILLTEXT")), "-1");
let carried = 0; for (const l of a.sk) for (let i = 0; i < 4; i++) carried += (l.lt[i] ?? 0) + (l.ct[i] ?? 0);
eq("skills ≤ context", String(carried <= a.inTok + a.cr + a.cw), "true");
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok codex skills");
