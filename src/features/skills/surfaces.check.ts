// agentglass — self-check for skills on the list surfaces: the skill entity of the filter language, triage's skill
// dimension, compare's skills section, the Repos column (skill-usage §6.8–§6.11):
// scriptc build src/features/skills/surfaces.check.ts -o sq && ./sq
// SPDX-License-Identifier: Apache-2.0
import { sessions } from "../../model/sessions.ts";
import { parse } from "../query/parse.ts";
import { type Ctx, compile, matchSession, skillRows, skillsAt } from "../query/eval.ts";
import { sessDim } from "../query/agg.ts";
import { setVis, skillVis } from "./vis.ts";
import { skFixture, at } from "./fixture.ts";
import "../compare/key.ts"; // the session key compare groups use
import { groupOfSession, compareGroups } from "../compare/metrics.ts";
import { skillCmpRows } from "../compare/sections.ts";
import { repoAgg } from "../repos/agg.ts";
import { repoSkills } from "../repos/tab.ts";
import { EMPTY } from "../query/eval.ts";
import { todayKey } from "../usage/record.ts";
import { resolveTick } from "../../model/project.ts";
import { identOf } from "../query/project.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function M(src: string): string {
  const p = parse(src); if (p.err) return "ERR " + p.err.msg;
  const r = compile(p.cs, "list"); if (!r.f) return "ERR " + (r.err ? r.err.msg : "");
  const o: string[] = []; for (const s of sessions.values()) if (matchSession(r.f, s, null)) o.push(s.id);
  return o.sort().join(",");
}
function E(src: string, ctx: Ctx): string { const p = parse(src); if (p.err) return "parse: " + p.err.msg; const r = compile(p.cs, ctx); return r.err ? r.err.msg : "ok"; }

const fx = skFixture();
eq("skill is", M("skill is alpha"), "k1,k2");
eq("same row: alpha by the user", M("skill is alpha and skill.trigger is user"), "k1");
eq("same row: beta was never user-loaded", M("skill is beta and skill.trigger is user"), "");
eq("trigger alone (alpha in k1, gamma in k2)", M("skill.trigger is user"), "k1,k2");
eq("loads", M("skill.loads >= 2"), "k1");
eq("cost unknown: gamma has no size", M("skill.cost is unknown"), "k2");
eq("cost never matches unknown", M("skill is gamma and skill.cost >= 0"), "");
eq("cost", M("skill is alpha and skill.cost > 0"), "k1,k2");
eq("size of the newest load", M("skill is alpha and skill.size >= 1k"), "k1,k2");
eq("tail: alpha carried past its turn in k1", M("skill.tail > 0"), "k1");
eq("scope", M("skill.scope is project"), "k1,k2");
eq("not a skill", M("skill is nope"), "");
eq("rows of k1", skillRows(fx.k1).map((q) => q.name + " " + q.trigs.join("/") + " " + String(q.loads)).join(", "), "alpha user/model 2, beta model 1");
eq("--watch: only skill and skill.trigger", E("skill.cost > 1", "watch").indexOf("known only after") >= 0 ? "refused" : E("skill.cost > 1", "watch"), "refused");
eq("--watch: skill is fine", E("skill is alpha and skill.trigger is model", "watch"), "ok");
eq("event views refuse skill keys", E("skill is alpha", "events").indexOf("event.kind is skill") >= 0 ? "refused" : "?", "refused");
eq("Stats takes skill keys", E("skill is alpha", "stats"), "ok");
eq("bad trigger", E("skill.trigger is robot", "list").indexOf("skill.trigger is one of") >= 0 ? "refused" : E("skill.trigger is robot", "list"), "refused");
// triage: a session's skills, and the skills in context at a call's time
eq("session dim", sessDim("skill", fx.k1).join(","), "alpha,beta");
eq("in context at 14:10", skillsAt(fx.k1, at(14, 10)).join(","), "alpha,beta");
eq("compacted away at 14:40", skillsAt(fx.k1, at(14, 40)).join(","), "");
eq("reloaded at 15:05", skillsAt(fx.k1, at(15, 5)).join(","), "alpha");
// compare: per skill loads and $ on each side
{
  const c = compareGroups(groupOfSession(fx.k1), groupOfSession(fx.k2), [], true, null);
  const k = skillCmpRows(c);
  eq("compare rows", k.rows.map((r) => r.name + " " + String(r.loadsA) + "/" + String(r.loadsB) + (r.unkB ? " ?" : "")).join(", "), "alpha 2/1, beta 1/0, gamma 0/1 ?");
  const r0 = k.rows[0]; eq("compare $ per side", r0 && r0.usdA > r0.usdB && r0.usdB > 0 ? "ok" : r0 ? String(r0.usdA) + "/" + String(r0.usdB) : "none", "ok");
  eq("no significance for single sessions", String(k.significance), "false");
}
// Repos: the period's top skill by $ and how many more (the listing left out)
function repoCell(): string {
  identOf(fx.k1); resolveTick(1e9, 1e9, (): number => Date.now(), (c: string, a: string[]): string => "");
  for (const r of repoAgg([todayKey()], EMPTY)) if (r.paths.indexOf(fx.k1.path) >= 0) { const x = repoSkills(r); return x.top + " +" + String(x.more); }
  return "no repo";
}
eq("repo skills", repoCell(), "alpha +2");
// hiding: omit leaves no row; name mode matches its fake (exactly) and the real name
setVis([{ match: "beta", mode: "omit" }, { match: "alpha", mode: "name" }], false);
eq("omitted skill: no row", M("skill is beta"), "");
eq("name mode: the real name still selects", M("skill is alpha"), "k1,k2");
const fake = skillVis("alpha").shown;
eq("name mode: the fake selects", M("skill is " + fake), "k1,k2");
eq("name mode: no partial match on a fake", M("skill ~ " + fake.slice(0, 3)), "");
eq("triage dim shows the fake, not the omitted", sessDim("skill", fx.k1).join(","), fake);
{
  const k = skillCmpRows(compareGroups(groupOfSession(fx.k1), groupOfSession(fx.k2), [], true, null));
  eq("compare: fake name, omitted folded", k.rows.map((r) => r.name + " " + String(r.loadsA) + "/" + String(r.loadsB)).join(", "), fake + " 2/1, gamma 0/1, (hidden) 1/0");
}
setVis([], false);
console.log(bad ? String(bad) + " failed" : "skill list surfaces: all checks passed");
if (bad) process.exit(1);
