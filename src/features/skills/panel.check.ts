// agentglass — self-check for the skills panel (S in Stats), the view-skill pane and the Stats preview's skills line
// (skill-usage §6.6, §6.7): scriptc build src/features/skills/panel.check.ts -o sp && ./sp
// (GOLDEN_WRITE=1 rewrites panel-80.golden and panel-120.golden: review them)
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { width } from "../../util/text.ts";
import type { Sess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { H } from "../../hooks.ts";
import { sessions } from "../../model/sessions.ts";
import { onInput } from "../../input.ts";
import { statsTabIndex } from "../usage/stats.ts";
import { lastDays, todayKey } from "../usage/record.ts";
import { EMPTY } from "../query/eval.ts";
import { localFor, setLocal } from "../query/scope.ts";
import { printClause } from "../query/parse.ts";
import { type PanelScope, openSkillsPanel, panelLines, panelState, panelKey } from "./panel.ts";
import { skillViewLines } from "./view.ts";
import { setVis } from "./vis.ts";
import { skFixture } from "./fixture.ts";
import { type HostRow, SKILL_FLEET } from "./fleet.ts";
import type { SkillRow } from "./model.ts";
import type { HostHash } from "./advise.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function has(ls: string[], s: string): boolean { for (const l of ls) if (l.indexOf(s) >= 0) return true; return false; }
const fx = skFixture();
let week = false;
const SC: PanelScope = {
  origin: "test", label: (): string => "today", days: (): string[] => week ? lastDays(7) : [todayKey()],
  sess: (): Sess[] => [...sessions.values()], filter: () => EMPTY, period: (k: string): boolean => { if (k === "w") { week = true; return true; } return false; }, keys: [["w", "7 days"]],
};
S.mode = "list"; S.tab = 0;
openSkillsPanel(SC, "");
eq("open", S.mode + " " + S.fview, "view skills");
// goldens at 80 and 120 columns: columns drop load, / and ⚙, then tail at 80
const g80 = panelLines(80, 24); const g120 = panelLines(120, 30);
for (const [name, ls] of [["panel-80.golden", g80], ["panel-120.golden", g120]] as [string, string[]][]) {
  const gp = (process.env.AGENTGLASS_SRC || "src") + "/features/skills/" + name;
  if (process.env.GOLDEN_WRITE === "1") { writeFileSync(gp, ls.join("\n") + "\n"); console.log(name + " written: review it"); continue; }
  const want = readFileSync(gp, "utf-8").replace(/\n$/, "").split("\n");
  for (let i = 0; i < Math.max(ls.length, want.length); i++) eq(name + " line " + String(i + 1), ls[i] ?? "(none)", want[i] ?? "(none)");
}
eq("80: the narrow columns", has(g80, " / ") || has(g80, "  tail") ? "kept" : "dropped", "dropped");
// the summary line fits the box and always ends on the sort hint (a hidden row, the listing, a filter lengthen it)
setVis([{ match: "beta", mode: "omit" }], false); openSkillsPanel(SC, "");
for (const w of [60, 80]) { const l0 = panelLines(w, 24)[0] ?? ""; eq("summary at " + String(w) + ": fits, sort hint kept", String(width(l0) <= w - 4) + " " + String(l0.trimEnd().endsWith("(s)")) + " " + String(l0.indexOf("1 hidden") >= 0), "true true true"); }
setVis([], false); openSkillsPanel(SC, "");
eq("120: every column", has(g120, "  tail") && has(g120, " ⚙") ? "kept" : "dropped", "kept");
// keys: s cycles the sort, a toggles advice, v views the newest load, ↵ filters the session list
panelKey("s"); eq("sort", panelState().sort, "loads");
for (let i = 0; i < 5; i++) panelKey("s");
eq("sort wraps", panelState().sort, "cost");
panelKey("a"); eq("advice pane", has(panelLines(80, 24), "no advice for") || has(panelLines(80, 24), "A1") ? "shown" : panelLines(80, 24).join("\n"), "shown");
panelKey("a"); eq("advice closes", String(panelState().adv), "false");
panelKey("v"); eq("v opens view skill", S.fview, "skill");
const sv = skillViewLines(80);
eq("view skill: record (the newest load: the reload)", (sv[0] ?? "").trimEnd(), "✧ alpha (loaded again after a compaction)");
eq("view skill: why no text", has(sv, "(text not found (no position recorded for this load))") ? "ok" : sv.join("\n"), "ok");
eq("view skill: trigger line", has(sv, "trigger  ⚙ by the model") ? "ok" : sv.join("\n"), "ok");
onInput("esc"); eq("esc back to the panel", S.fview, "skills");
panelKey("enter");
eq("↵: Sessions with the skill filter", String(S.tab) + " " + S.mode + " " + localFor("Sessions").map(printClause).join(" and "), "0 list skill is alpha");
setLocal("Sessions", []);
// the hidden row: an omitted skill's tokens stay, its name does not
setVis([{ match: "beta", mode: "omit" }], false);
openSkillsPanel(SC, "");
const gh = panelLines(120, 30);
eq("hidden: no beta", has(gh, "beta") ? "leak" : "ok", "ok");
eq("hidden: (hidden) row", has(gh, "(hidden)") && has(gh, "+ 1 hidden") ? "ok" : gh.join("\n"), "ok");
panelKey("esc"); eq("esc closes", S.mode, "list");
setVis([], false);
// S in Stats opens the panel over the Stats period
S.mode = "list"; S.tab = statsTabIndex(); onInput("S");
eq("S in Stats", S.mode + " " + panelState().origin, "view Stats");
eq("Stats panel rows", has(panelLines(120, 30), "alpha") && has(panelLines(120, 30), "gamma") ? "ok" : panelLines(120, 30).join("\n"), "ok");
onInput("esc"); eq("back to Stats", S.mode + " " + String(S.tab), "list " + String(statsTabIndex()));
S.tab = 0; onInput("S"); eq("S elsewhere does not open it", S.mode, "list");
// a fleet shown (skill-usage 6.15): one row per skill and host with a host column (this machine's first among equals),
// the panel's advice adds A10 from the hosts' versions, v on another host's row says where its text is
{
  const mk = (name: string, usd: number): SkillRow => ({ name, loadsUser: 1, loadsModel: 1, loadsCompact: 0, sessions: 1, sizeP50: 1000, load: 1000, carry: 2000, tail: 0, usd, carryUsd: usd / 2, tailUsd: 0, perSess: usd, share: 0.01, ctx: 1e5, tier: "exact", hashes: [], scope: "user", unpriced: false });
  SKILL_FLEET.on = (): boolean => true; SKILL_FLEET.local = (): string => "ws";
  SKILL_FLEET.rows = (days: string[] | null, by: string): HostRow[] => [{ host: "ws", row: mk("alpha", 0.5) }, { host: "vm1", row: mk("alpha", 0.25) }, { host: "vm1", row: mk("deploy", 0.1) }];
  SKILL_FLEET.hashes = (): HostHash[] => [{ host: "ws", name: "deploy", hash: "aaaaaaaa11111111", at: Date.now() }, { host: "vm1", name: "deploy", hash: "bbbbbbbb22222222", at: Date.now() }];
  S.mode = "list"; S.tab = statsTabIndex(); onInput("S");
  for (const w of [80, 120]) {
    const fl = panelLines(w, 24);
    eq("fleet " + String(w) + ": host column", has(fl, "host") && has(fl, " ws ") && has(fl, " vm1 ") ? "ok" : fl.join("\n"), "ok");
    eq("fleet " + String(w) + ": fits", fl.slice(1).every((l: string): boolean => l.length <= w - 4) ? "ok" : fl.join("\n"), "ok");
  }
  eq("fleet: summary", has(panelLines(120, 24), "2 skills on 2 hosts") ? "ok" : panelLines(120, 24).join("\n"), "ok");
  eq("fleet: this machine's row first", panelState().host + " " + panelState().sel, "ws alpha");
  panelKey("down"); eq("fleet: rows move by host", panelState().host + " " + panelState().sel, "vm1 alpha");
  panelKey("down"); panelKey("a");
  eq("fleet: A10 in the panel's advice", has(panelLines(120, 30), "A10 versions differ across hosts · deploy") ? "ok" : panelLines(120, 30).join("\n"), "ok");
  panelKey("a"); panelKey("v"); eq("fleet: v on another host's row stays", S.fview, "skills");
  onInput("esc");
  SKILL_FLEET.on = (): boolean => false; S.tab = 0;
}
// the preview's skills line
let pl = "";
for (const f of H.previewSections) for (const l of f(fx.k1, 70)) { const t = l.replace(/\x1b\[[0-9;]*m/g, ""); if (t.startsWith("skills")) pl = t; }
eq("preview line", pl.replace(/≈\$[0-9.]+/g, "$x"), "skills   alpha ×2 $x · beta $x   (carry " + pl.slice(pl.indexOf("(carry ") + 7));
eq("preview: no listing, carry share", pl.indexOf("(listing)") < 0 && /\(carry \d+ %\)$/.test(pl) ? "ok" : pl, "ok");
console.log(bad ? String(bad) + " failed" : "skills panel: all checks passed");
if (bad) process.exit(1);
