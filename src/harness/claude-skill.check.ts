// agentglass — self-check: Claude skill loads (slash command, Skill tool over two text lines, stub, SKILL.md Read, listing,
// compaction + re-injection, copied lines) from a synthetic log: scriptc build src/harness/claude-skill.check.ts -o cs && ./cs
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { claude } from "./claude.ts";
import { type SkLoad, newAcc, skillUsesOf } from "../features/usage/record.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const lines = readFileSync("testdata/skills/claude.jsonl", "utf8").split("\n");
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
{ // a plugin skill's line names "<plugin>:<name>" (not the plugin); a description with ": " in it; a bare "- name:"
  const p = newAcc();
  claude.usage(p, JSON.stringify({ type: "attachment", uuid: "att-p", timestamp: "2026-10-01T09:00:01.000Z", attachment: { type: "skill_listing", content: "- superpowers:brainstorming: Use this: before work\n- solo: x\n- bare:\n- not a skill: x\nplain" } }));
  eq("listing names: plugin skills", p.lst.join(","), "superpowers:brainstorming,solo,bare");
}
eq("no text kept", String(JSON.stringify(a.sk).indexOf("LOREMSKILLTEXT")), "-1");
let carried = 0; for (const l of a.sk) for (let i = 0; i < 4; i++) carried += (l.lt[i] ?? 0) + (l.ct[i] ?? 0);
eq("skills ≤ context", String(carried <= a.inTok + a.cr + a.cw), "true");

// bundled skills have no "Base directory" line: a user's /simplify is known by its name (a plain prompt command /mine is not
// a skill), a model's Skill call of one by its call; both scope builtin
const b = newAcc(); const U = (pid: string, uuid: string, c: string, meta: boolean, src: string): string => "{\"promptId\":\"" + pid + "\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":" + JSON.stringify(c) + "},\"uuid\":\"" + uuid + "\",\"timestamp\":\"2026-10-01T10:00:00.000Z\"" + (meta ? ",\"isMeta\":true" : "") + (src ? ",\"sourceToolUseID\":\"" + src + "\"" : "") + "}";
const asst = (id: string, w: number, rest: string): string => "{\"type\":\"assistant\",\"uuid\":\"" + id + "\",\"timestamp\":\"2026-10-01T10:00:01.000Z\",\"requestId\":\"r" + id + "\",\"message\":{\"id\":\"m" + id + "\",\"model\":\"claude-sonnet-4-5\",\"role\":\"assistant\",\"content\":[" + rest + "],\"usage\":{\"input_tokens\":0,\"cache_read_input_tokens\":1000,\"cache_creation_input_tokens\":" + String(w) + ",\"output_tokens\":5,\"cache_creation\":{\"ephemeral_5m_input_tokens\":" + String(w) + ",\"ephemeral_1h_input_tokens\":0}}}}";
for (const l of [
  U("q1", "b-1", "<command-message>simplify</command-message>\n<command-name>/simplify</command-name>", false, ""), U("q1", "b-2", "LOREMBUNDLED " + "z".repeat(707), true, ""),
  asst("b-3", 400, "{\"type\":\"text\",\"text\":\"ok\"}"),
  U("q2", "b-4", "<command-message>mine</command-message>\n<command-name>/mine</command-name>", false, ""), U("q2", "b-5", "my own prompt command text", true, ""),
  asst("b-6", 50, "{\"type\":\"tool_use\",\"id\":\"toolu_c1\",\"name\":\"Skill\",\"input\":{\"skill\":\"claude-api\"}}"),
  U("q2", "b-7", "LOREMAPI " + "y".repeat(351), true, "toolu_c1"),
  asst("b-8", 300, "{\"type\":\"text\",\"text\":\"ok\"}"),
]) claude.usage(b, l);
eq("bundled loads", b.sk.map(row).join("\n"), ["simplify user 720 200  open bundled:simplify", "claude-api model 360 100  open bundled:claude-api"].join("\n"));
eq("bundled scope", b.sk.map((l: SkLoad) => l.scope).join(","), "builtin,builtin");
eq("bundled uses", JSON.stringify(skillUsesOf([b], null)), "[{\"name\":\"claude-api\",\"source\":\"model\",\"n\":1},{\"name\":\"simplify\",\"source\":\"command\",\"n\":1}]");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok claude skills");
