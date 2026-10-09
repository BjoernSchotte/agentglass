// agentglass — self-check: skill loads as marks (anchor on the loading call, else the time; no listing; unloads) and the
// event kinds they give: every load lands on one event, a Skill call is not counted twice:
// scriptc build src/features/skills/marks.check.ts -o skm && ./skm
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { type Ev, type Sess, newSess } from "../../model/types.ts";
import { parseEvents } from "../../harness/index.ts";
import { claude } from "../../harness/claude.ts";
import { type Mark, registerMarks } from "../../model/marks.ts";
import { kindIds, kindSet, kindsIn } from "../../model/kinds.ts";
import { newAcc } from "../usage/record.ts";
import { skillMarks } from "./marks.ts";
import { setVis, parseHide } from "./vis.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
setVis([], false);
const lines = readFileSync("testdata/skills/claude.jsonl", "utf8").split("\n");
const a = newAcc();
a.mc.set("u:u-copied-1", "/elsewhere/other.jsonl"); a.mc.set("u:u-copied-2", "/elsewhere/other.jsonl");
for (const l of lines) if (l) claude.usage(a, l);
const ms = skillMarks([a]);
eq("marks", ms.map((m: Mark) => m.kind + " " + m.label + " " + m.sub + " " + m.anchor.replace(/ts=2026-10-01T/, "ts=")).join("\n"), [
  "skill:load alpha user ts=09:00:05.000Z", "skill:unload alpha compact ts=09:00:17.000Z",
  "skill:load beta model call=toolu_b1", "skill:unload beta compact ts=09:00:17.000Z",
  "skill:load beta model call=toolu_b2", "skill:unload beta compact ts=09:00:17.000Z",
  "skill:load delta model call=toolu_r1", "skill:unload delta compact ts=09:00:17.000Z",
  "skill:load alpha compact ts=09:00:18.000Z",
].join("\n"));
setVis(parseHide([{ match: "delta", mode: "omit" }, { match: "beta", mode: "name" }]).rules, false);
const hid = skillMarks([a]);
eq("hidden: omit has no mark, name the fake", String(hid.some((m: Mark) => m.label === "delta" || m.label === "beta")) + " " + String(hid.length), "false 7");
setVis([], false);

// the event kinds: each load once; the Skill and Read calls already are skill:load / read, the marks add to them
const s: Sess = newSess("claude", "skm-0001", "/k/skm.jsonl", false); s.size = 1;
registerMarks({ kind: "skill", glyph: "✧", color: (): string => "", gen: (x: Sess): number => 0, of: (x: Sess): Mark[] => skillMarks([a]) });
const evs: Ev[] = [];
for (const l of lines) if (l) parseEvents("claude", l, evs, s);
const ids = kindIds(s, evs);
const loadsAt: string[] = []; for (let i = 0; i < evs.length; i++) if (kindSet(ids[i] + 0).indexOf("skill:load") >= 0) loadsAt.push(evs[i].kind + ":" + (evs[i].id || evs[i].text.slice(0, 6)));
// a result carries its call's kinds (#103 taxonomy, as for every call kind); without results: one event per load
eq("one event per load", loadsAt.filter((x: string) => !x.startsWith("result:")).join(","), "assistant:ok,tool:toolu_b1,tool:toolu_b2,tool:toolu_r1,assistant:ok");
const k = kindsIn(s, evs);
eq("chip count = loads + the Skill calls' results", String(k.get("skill:load") ?? 0), "7");
if (bad) { console.log("skill:load on " + loadsAt.join(",")); console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok skill marks");
