// agentglass — self-check: skill loads and unloads as OTLP span events (skill-usage spec 6.14) on the synthetic Claude skill
// log; text only with --content, hidden skills per skills.hide, fakes under --redact: scriptc build src/features/otlp/skills.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { newSess } from "../../model/types.ts";
import { type XTurn, type XSpan } from "./types.ts";
import { type BuildOpts, newSessB, finish } from "./build.ts";
import { encodeRequest, titleAttr } from "./encode.ts";
import { cfgFrom } from "./config.ts";
import { setVis } from "../skills/vis.ts";
import { readFileSync } from "node:fs";
import { newAcc } from "../usage/record.ts";
import { claude } from "../../harness/claude.ts";
import { skillsJson } from "../skills/json.ts";
import { newAgg, ingestLine, reportsOf, restoreHost, extraOf } from "../hub/map.ts";
import { type Obj, obj, arr } from "../../util/json.ts";
import { REDACT } from "../redact-on.ts";
import { scrubText } from "../redact.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ":\n  got  " + got + "\n  want " + want); } }
{
  const SK = "testdata/skills/claude.jsonl";
  const so = (content: boolean): BuildOpts => ({ now: Date.parse("2026-10-02T00:00:00.000Z"), quietMs: 600000, content, subagents: false });
  const run = (content: boolean): XTurn[] => { const s = newSess("claude", "s-fixture-claude", SK, false); s.mtime = Date.parse("2026-10-01T09:00:30.000Z"); return finish(newSessB(s, []), so(content)); };
  const evs = (ts: XTurn[]): string => { const o: string[] = []; for (const t of ts) for (const sp of t.spans) for (const e of sp.events) { if (!e.name.startsWith("gen_ai.skill.")) continue; let n = ""; let x = ""; for (const a of e.attrs) { if (a.k === "gen_ai.skill.name") n = a.s; if (a.k === "agentglass.skill.trigger" || a.k === "agentglass.skill.reason") x = a.s; } o.push(e.name.slice(13) + ":" + n + ":" + x); } return o.join(" "); };
  const attr = (ts: XTurn[], name: string, ev: string, k: string): string => { for (const t of ts) for (const sp of t.spans) for (const e of sp.events) { let hit = false; for (const a of e.attrs) if (a.k === "gen_ai.skill.name" && a.s === name) hit = true; if (!hit || e.name !== ev) continue; for (const a of e.attrs) if (a.k === k) return a.t === "i" ? String(a.n) : a.t === "b" ? String(a.b) : a.s; } return ""; };
  setVis([], false);
  const t0 = run(false);
  eq("skill events in order", evs(t0), "load:(listing):listing load:alpha:user load:beta:model load:beta:model load:delta:model unload:(listing):compact unload:alpha:compact unload:beta:compact unload:beta:compact unload:delta:compact load:alpha:compact load:gamma:user");
  eq("load attributes", [attr(t0, "alpha", "gen_ai.skill.load", "agentglass.skill.size_tokens"), attr(t0, "alpha", "gen_ai.skill.load", "agentglass.skill.scope"), attr(t0, "alpha", "gen_ai.skill.load", "agentglass.skill.tier"), String(attr(t0, "alpha", "gen_ai.skill.load", "agentglass.skill.hash").length)].join(" "), "1000 project exact 16"); // /h is no home here: a project skill
  eq("events on turn roots", String(t0.every((t: XTurn) => t.spans.every((sp: XSpan, i: number) => i === 0 || sp.events.length === 0))), "true");
  let cu = ""; for (const t of t0) for (const a of t.spans[0].attrs) if (a.k === "agentglass.skill.cost_usd") cu = String(a.n > 0);
  eq("session skill cost on the root", cu, "true");
  const cfg = cfgFrom({}); const cfgC = cfgFrom({ contentMax: 100000 }); cfgC.content = true;
  eq("no text without --content", String(encodeRequest(t0, cfg).indexOf("LOREMSKILLTEXT")), "-1");
  const t1 = run(true); const body = encodeRequest(t1, cfgC);
  eq("text with --content", String(body.indexOf("LOREMSKILLTEXT") > 0 && body.indexOf("agentglass.skill.text") > 0), "true");
  eq("--content export but the encoder without content: no text", String(encodeRequest(t1, cfg).indexOf("LOREMSKILLTEXT")), "-1");
  setVis([{ match: "alpha", mode: "content" }, { match: "beta", mode: "omit" }, { match: "delta", mode: "name" }], false);
  const t2 = run(true); const b2 = encodeRequest(t2, cfgC);
  eq("hidden: beta omitted, delta faked, alpha without text", String(evs(t2).indexOf(":beta:") < 0) + " " + String(evs(t2).indexOf(":delta:") < 0) + " " + String(attr(t2, "alpha", "gen_ai.skill.load", "agentglass.skill.text") === ""), "true true true");
  eq("hidden: no beta, no delta name anywhere", String(b2.indexOf("\"beta\"") < 0 && b2.indexOf("\"delta\"") < 0), "true");
  // a hidden skill's name and text stay out of the call spans too, with --content and call details: the Read of its
  // SKILL.md (the path, its text as the result), the Skill call's arguments and result, the prompts naming it
  setVis([{ match: "*", mode: "content" }], false);
  const cfgM = cfgFrom({ contentMax: 100000, detail: "meta" }); cfgM.content = true;
  const b4 = encodeRequest(run(true), cfgM);
  eq("content rule: no skill text in any span with --content", String(b4.indexOf("LOREMSKILLTEXT")) + " " + String(b4.indexOf("MORELOREMTEXT")), "-1 -1");
  setVis([{ match: "del*", mode: "omit" }, { match: "beta", mode: "name" }, { match: "*:never", mode: "omit" }], false);
  const b5 = encodeRequest(run(true), cfgM);
  eq("omit/name rules: no name in call details, arguments, results or prompts", String(b5.indexOf("delta")) + " " + String(b5.indexOf("beta")) + " " + String(b5.indexOf("LOREMSKILLTEXT") > 0), "-1 -1 true");
  setVis([], true);
  const t3 = run(false);
  eq("--redact fakes user skill names, keeps hashes", String(evs(t3).indexOf(":alpha:") < 0) + " " + String(attr(t3, "(listing)", "gen_ai.skill.load", "agentglass.skill.trigger")), "true listing");
  setVis([], false);
}
// the hub turns the load and usage events back into the session's skills[]: name, source, n, size, tier, hash, scope,
// loads, tokens and $ as the local --json entry
{
  setVis([], false);
  const s = newSess("claude", "s-fixture-claude", "testdata/skills/claude.jsonl", false); s.mtime = Date.parse("2026-10-01T09:00:30.000Z");
  const ts = finish(newSessB(s, []), { now: Date.parse("2026-10-02T00:00:00.000Z"), quietMs: 600000, content: false, subagents: false });
  const g = newAgg(); ingestLine(g, encodeRequest(ts, cfgFrom({})), null);
  let hub: Obj[] = []; for (const r of reportsOf(g, Date.parse("2026-10-02T00:00:00.000Z"), true, 3650).values()) for (const x of r.sessions) for (const v of arr(x.s["skills"])) { const o = obj(v); if (o) hub.push(o); }
  const a = newAcc(); for (const l of readFileSync("testdata/skills/claude.jsonl", "utf8").split("\n")) if (l) claude.usage(a, l);
  const loc = skillsJson([a]);
  // under --redact (the checks' env) the encoder scrubs every string it sends: a name the scrubber knows arrives faked
  const nm = (v: unknown): string => { const n = typeof v === "string" ? v as string : ""; return REDACT ? scrubText(n) : n; };
  const pick = (o: Obj, local: boolean): string => JSON.stringify([local ? nm(o["name"]) : o["name"], o["source"], o["n"], o["size"], o["tier"], o["hash"], o["scope"]]);
  eq("hub entries", String(hub.length), "4");
  eq("hub skills[] = local --json entries", hub.map((o: Obj) => pick(o, false)).sort().join(" "), loc.map((o: Obj) => pick(o, true)).sort().join(" "));
  const figs = (o: Obj, local: boolean): string => JSON.stringify([local ? nm(o["name"]) : o["name"], o["source"], o["loads"], o["tokens"], o["costUsd"], o["carryUsd"], o["tailUsd"]]);
  eq("hub: the sender's tokens and $ per entry", hub.map((o: Obj) => figs(o, false)).sort().join(" "), loc.map((o: Obj) => figs(o, true)).sort().join(" "));
  eq("hub: priced", String(hub.every((o: Obj) => typeof o["costUsd"] === "number") && hub.some((o: Obj) => (o["costUsd"] as number) > 0)), "true");
  // a re-sent turn (an export retried) counts nothing twice: the usage event is the session's figures so far
  ingestLine(g, encodeRequest(ts.slice(ts.length - 1), cfgFrom({})), null);
  const again: Obj[] = []; for (const r of reportsOf(g, Date.parse("2026-10-02T00:00:00.000Z"), true, 3650).values()) for (const x of r.sessions) for (const v of arr(x.s["skills"])) { const o = obj(v); if (o) again.push(o); }
  // the hub's saved state (a fleet viewer's next run starts from it): skills[] survive the restore, figures and all
  const g2 = newAgg(); for (const [k, r] of reportsOf(g, Date.parse("2026-10-02T00:00:00.000Z"), true, 3650)) restoreHost(g2, k, r, extraOf(g, k));
  const back: Obj[] = []; for (const r of reportsOf(g2, Date.parse("2026-10-02T00:00:00.000Z"), true, 3650).values()) for (const x of r.sessions) for (const v of arr(x.s["skills"])) { const o = obj(v); if (o) back.push(o); }
  eq("hub: skills[] after a restore", back.map((o: Obj) => figs(o, false) + pick(o, false)).sort().join(" "), hub.map((o: Obj) => figs(o, false) + pick(o, false)).sort().join(" "));
  eq("hub: a re-sent turn", again.map((o: Obj) => figs(o, false)).sort().join(" "), hub.map((o: Obj) => figs(o, false)).sort().join(" "));
  hub = [];
}
// a field cut at its limit after the scrub must not leave a word's head that reads as a hidden name ("xyzs" → "xyz")
{
  setVis([{ match: "xyz", mode: "omit" }], false);
  const tc = cfgFrom({}); tc.titles = true;
  const a = titleAttr("a".repeat(252) + " xyzs tail", tc)[0];
  eq("a cut title leaves no hidden name", a ? String(a.s.endsWith("xyz")) : "no attr", "false");
  setVis([], false);
}
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp skill events: all checks passed");
