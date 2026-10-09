// agentglass — self-check: Claude skill loads (slash command, Skill tool over two text lines, stub, SKILL.md Read, listing,
// compaction + re-injection, copied lines) from a synthetic log: scriptc build src/harness/claude-skill.check.ts -o cs && ./cs
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { claude } from "./claude.ts";
import { type SkLoad, newAcc, skillUsesOf } from "../features/usage/record.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const lines = readFileSync("src/features/skills/fixtures/claude.jsonl", "utf8").split("\n");
const a = newAcc();
a.mc.set("u:u-copied-1", "/elsewhere/other.jsonl"); a.mc.set("u:u-copied-2", "/elsewhere/other.jsonl"); // another log owns the copied pair
for (const l of lines) if (l) claude.usage(a, l);

function row(l: SkLoad): string { return [l.name, l.trig, String(l.bytes), String(l.S), l.stub ? "stub" : "", l.end ? l.why : "open", l.dir].join(" "); }
eq("loads", a.sk.map(row).join("\n"), [
  "(listing) listing 720 200  compact ",
  "alpha user 3600 1000  compact /h/.claude/skills/alpha",
  "beta model 7200 2000  compact /h/.claude/skills/beta",
  "beta model 52 15 stub compact ",
  "delta model 1800 500  compact /h/.claude/skills/delta",
  "alpha compact 3600 1000  open /h/.claude/skills/alpha",
].join("\n"));
const L0 = a.sk[0] as SkLoad; const A = a.sk[1] as SkLoad; const B = a.sk[2] as SkLoad; const D = a.sk[4] as SkLoad; const R = a.sk[5] as SkLoad;
eq("listing load from write", L0.lt.join(","), "0,0,200,0");
eq("alpha load", A.lt.join(",") + " carry " + A.ct.join(","), "0,0,1000,0 carry 0,4000,0,0"); // r3..r6 from cache reads
eq("beta load over two lines", B.lt.join(",") + " carry " + B.ct.join(",") + " hash " + String(B.hash.length), "0,0,2000,0 carry 0,2000,0,0 hash 16");
eq("delta read", String(D.rd) + " " + D.lt.join(","), "true 0,0,500,0");
eq("re-injection after compaction", R.lt.join(",") + " carry " + R.ct.join(",") + " rel " + String(R.rel), "0,0,1000,0 carry 0,1000,0,0 rel false");
eq("no line positions outside a ledger read", String(A.off), "-1");
eq("day skill counts", JSON.stringify(skillUsesOf([a], null)), "[{\"name\":\"beta\",\"source\":\"model\",\"n\":2},{\"name\":\"alpha\",\"source\":\"command\",\"n\":1},{\"name\":\"delta\",\"source\":\"model\",\"n\":1}]");
eq("listing names", a.lst.join(","), "alpha,beta,delta");
eq("no text kept", String(JSON.stringify(a.sk).indexOf("LOREMSKILLTEXT")), "-1");
let carried = 0; for (const l of a.sk) for (let i = 0; i < 4; i++) carried += (l.lt[i] ?? 0) + (l.ct[i] ?? 0);
eq("skills ≤ context", String(carried <= a.inTok + a.cr + a.cw), "true");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok claude skills");
