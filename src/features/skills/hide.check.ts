// agentglass — hidden skills stay hidden on every TUI surface (skill-usage Privacy, Testing; plan Task P2): from a Claude log
// that loads pub (no rule), acme-x (name), secret (omit) and notes (content), each with its own text marker
// (testdata/skills-hide/claude.jsonl). Under the rules: the session title, transcript (lines, events, detail), view
// skill, Stats skills panel, preview, Repos, triage, compare, filter values, related, call graph, replay, the Wait
// timeline and rules messages never show acme-x (its fake instead) or secret (its tokens in (hidden)), nor a hidden
// skill's text; pub's text shows; without rules nothing is hidden. The CLI and outward surfaces: scripts/skills-hide.test.sh
// scriptc build src/features/skills/hide.check.ts -o skh && ./skh
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { type Sess, type Ev, newSess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { H, realMeta } from "../../hooks.ts";
import { sessions, loadHead, loadTail, titleOf } from "../../model/sessions.ts";
import { marksOf } from "../../model/marks.ts";
import { ledger, complete, accsOf } from "../usage/ledger.ts";
import { accIn, accOut } from "../usage/codec.ts";
import { skNames, skOf } from "../usage/record.ts";
import { parse } from "../../util/json.ts";
import { openTranscript, renderTranscript } from "../../ui/transcript.ts";
import { actLines } from "../../ui/list.ts";
import { skillLanes, skillAgg } from "../callgraph/model.ts";
import { skillRows as relSkillRows, startBuild, stepBuild } from "../related/build.ts";
import type { RelEv } from "../related/model.ts";
import { skillBuckets } from "../wait/tab.ts";
import { EMPTY, skillRows } from "../query/eval.ts";
import { sessDim } from "../query/agg.ts";
import "../compare/key.ts";
import { groupOfSession, compareGroups } from "../compare/metrics.ts";
import { skillCmpRows } from "../compare/sections.ts";
import { skillMetric } from "../rules/metrics.ts";
import { type PanelScope, openSkillsPanel, panelLines } from "./panel.ts";
import { openSkillView, skillViewLines } from "./view.ts";
import { loadOf, openAt } from "./marks.ts";
import { setVis, skillVis, type HideRule } from "./vis.ts";
import { KNOWN } from "./watchvis.ts";
import "../../harness/index.ts";
import "../replay.ts";

let bad = 0;
function ok(what: string, c: boolean, info: string): void { if (!c) { bad++; console.log("FAIL " + what + (info ? ": " + info.slice(0, 400) : "")); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }
const SECRETS = ["acme-x", "secret", "ACMESKILLTEXT", "SECRETSKILLTEXT", "NOTESSKILLTEXT"];
// hidden: nothing of acme-x, secret, or a hidden skill's text in the surface's text
function hidden(what: string, text: string): void { for (const w of SECRETS) ok(what + ": no " + w, text.indexOf(w) < 0, text.slice(Math.max(0, text.indexOf(w) - 120), text.indexOf(w) + 60)); }

const RULES: HideRule[] = [{ match: "acme-*", mode: "name" }, { match: "secret", mode: "omit" }, { match: "notes", mode: "content" }];
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "skh", "cache");
const dir = join(HOME, "skh", "p"); mkdirSync(dir, { recursive: true });
const FX = readFileSync("testdata/skills-hide/claude.jsonl", "utf8");
const t0 = Date.parse("2026-10-01T09:00:00.000Z"); const t1 = t0 + 3600000;
function fresh(id: string): Sess { // the session as a new run sees it (head and tail read under the current rules; its own path)
  sessions.clear(); ledger.clear();
  const P = join(dir, id + ".jsonl"); writeFileSync(P, FX);
  const s: Sess = newSess("claude", id, P, false); s.size = statSync(P).size; s.mtime = Date.now(); s.cwd = "/w/keepme"; sessions.set(P, s);
  complete(s); loadHead(s); loadTail(s);
  return s;
}
const evText = (evs: Ev[]): string => evs.map((e: Ev): string => e.kind + " " + e.text + " | " + e.full).join("\n");

// ── under the rules ──
setVis(RULES, false);
const fake = skillVis("acme-x").shown;
const s = fresh("s-hide");
// the title (a fake title under the checks' --redact: the prompt as parsed, what titles and filters come from)
hidden("title", titleOf(s) + " " + realMeta(s).prompt); ok("prompt: the fake", realMeta(s).prompt.indexOf(fake) >= 0, realMeta(s).prompt);
// transcript: its lines, its events, the event detail's load record
S.W = 120; S.H = 60; S.mode = "list";
openTranscript(s); renderTranscript();
const tv = S.tv;
if (!tv) { ok("transcript open", false, ""); process.exit(1); }
const tl = tv.lines.map(plain).join("\n");
hidden("transcript lines", tl); ok("transcript: fake load line", tl.indexOf("✧ " + fake) >= 0, tl);
ok("transcript: pub and notes load lines", tl.indexOf("✧ pub") >= 0 && tl.indexOf("✧ notes") >= 0, tl);
hidden("transcript events", evText(tv.evs));
// (a skill load's own text is no transcript event: view skill reads it)
let det = "";
for (let i = 0; i < tv.evs.length; i++) for (const f of H.detailHead) det += f(s, tv.evs, i, 100).map(plain).join("\n") + "\n";
hidden("event detail", det);
// view skill on every load mark: hidden text says why, pub's text shows
const loads = marksOf(s, ["skill:load"]);
ok("marks: pub, fake, notes (secret omitted)", loads.map((m) => m.label).join(",") === "pub," + fake + ",notes", loads.map((m) => m.label).join(","));
let views = "";
for (const m of loads) { const l = loadOf(s, m); if (!l) continue; openSkillView(s, l); views += skillViewLines(100).join("\n") + "\n"; onInputEsc(); }
function onInputEsc(): void { S.mode = "list"; }
hidden("view skill", views); ok("view skill: pub's text", views.indexOf("PUBSKILLTEXT") >= 0, ""); ok("view skill: why", views.indexOf("text hidden by skills.hide") >= 0, views);
// Stats skills panel and the preview's skills line
const SC: PanelScope = { origin: "test", label: (): string => "all", days: (): string[] => { const d: string[] = []; for (const a of accsOf(s)) for (const k of a.days.keys()) d.push(k); return d; },
  sess: (): Sess[] => [...sessions.values()], filter: () => EMPTY, period: (k: string): boolean => false, keys: [] };
openSkillsPanel(SC, "");
const pn = panelLines(120, 30).join("\n") + panelLines(80, 24).join("\n");
hidden("Stats panel", pn); ok("Stats panel: fake and (hidden)", pn.indexOf(fake) >= 0 && pn.indexOf("(hidden)") >= 0, pn);
ok("Stats panel: the (hidden) row says how many skills it holds", pn.indexOf("(hidden) 1 skill") >= 0, pn);
S.mode = "list";
let pv = ""; for (const f of H.previewSections) for (const l of f(s, 100)) pv += plain(l) + "\n";
hidden("preview", pv); ok("preview: skills line", pv.indexOf("skills") >= 0 && pv.indexOf(fake) >= 0, pv);
// filters (value lists), triage, compare
hidden("filter values", skillRows(s).map((q) => q.shown).join(",")); // (q.name: the real name filters match, never shown)
ok("filter: the real name still selects, never shown", skillRows(s).some((q) => q.shown === fake), "");
hidden("triage dimension", sessDim("skill", s).join(","));
const cmp = skillCmpRows(compareGroups(groupOfSession(s), groupOfSession(s), [], true, null));
hidden("compare", cmp.rows.map((r) => r.name).join(",")); ok("compare: (hidden)", cmp.rows.some((r) => r.name === "(hidden)"), "");
// related: skill rows and the whole window's rows
hidden("related skill rows", relSkillRows(s, t0, t1, true, "/w/keepme").map((r: RelEv) => r.text).join("\n"));
const rb = startBuild(s, tv.evs, tv.evs.length - 1, 60, 10);
if (rb) { for (let g = 0; g < 1000 && stepBuild(rb, 1e9, () => Date.now()); g++) { /* to the end */ } hidden("related rows", rb.rows.map((r: RelEv) => r.text + " " + r.evText).join("\n")); }
else ok("related build", false, "");
// call graph lanes and tree row, replay's skills in context, the Wait timeline's loads (omitted ones not counted)
const lanes = skillLanes(marksOf(s, ["skill:load"]), t1, 3);
hidden("call graph lanes", lanes.lanes.map((l) => l.map((b) => b.label).join(" ")).join(" | "));
const sa = skillAgg(marksOf(s, ["skill:load"]), t1);
hidden("call graph tree", sa ? sa.name + " " + sa.kids.map((k) => k.name).join(",") : "");
ok("replay: 3 skills in context (secret's carry counted, not named)", openAt(s, t0 + 60000).n >= 3, String(openAt(s, t0 + 60000).n));
const wb = skillBuckets(t0, t1, 3600000, EMPTY);
ok("Wait timeline: 3 loads (the omitted one not ticked)", wb.reduce((x: number, y: number) => x + y, 0) === 3, wb.join(","));
// rules messages: {skill} is the shown name, never an omitted one
const msgs = ["skill_carry_usd", "skill_context_share", "skill_reloads"].map((m: string): string => m + "=" + skillMetric(m, accsOf(s)).skill).join(" ");
hidden("rules {skill}", msgs);
// a warm start: the ledger holds the loads and day rows as the cache's text (skOf/saOf decode on first use); each
// surface is the first reader of a freshly loaded entry and must hide the same
function warm(): boolean {
  const a = ledger.get(s.path); if (!a) return false;
  const b = accIn(parse(JSON.stringify(accOut(a))) ?? {}); ledger.set(s.path, b);
  let txt = b.skv !== ""; for (const d of b.days.values()) if (d.sa.size) txt = false;
  return txt;
}
const wsurf: [string, () => string][] = [
  ["Stats panel", (): string => { openSkillsPanel(SC, ""); const t = panelLines(120, 30).join("\n"); S.mode = "list"; return t; }],
  ["filter values", (): string => skillRows(s).map((q) => q.shown).join(",")],
  ["triage dimension", (): string => sessDim("skill", s).join(",")],
  ["compare", (): string => skillCmpRows(compareGroups(groupOfSession(s), groupOfSession(s), [], true, null)).rows.map((r) => r.name).join(",")],
  ["related skill rows", (): string => relSkillRows(s, t0, t1, true, "/w/keepme").map((r: RelEv) => r.text).join("\n")],
  ["rules {skill}", (): string => ["skill_carry_usd", "skill_context_share", "skill_reloads"].map((m: string): string => m + "=" + skillMetric(m, accsOf(s)).skill).join(" ")],
  ["view skill", (): string => { let v = ""; for (const m of marksOf(s, ["skill:load"])) { const l = loadOf(s, m); if (l) { openSkillView(s, l); v += skillViewLines(100).join("\n"); S.mode = "list"; } } return v; }],
];
for (const [what, f] of wsurf) { ok("warm start: " + what + " reads cache text", warm(), ""); const t = f(); ok("warm start: " + what + " output", t.length > 0, ""); hidden("warm start: " + what, t); }
{ // the names of a warm start's loads come from the cache text's name pool, no load decoded (KNOWN, marks.ts)
  const b = warm() ? ledger.get(s.path) : undefined; const ns = b ? skNames(b) : [];
  ok("warm start: skNames from the name pool", ["pub", "acme-x", "secret", "notes"].every((n: string) => ns.indexOf(n) >= 0) && b !== undefined && b.skv !== "", ns.join(","));
  ok("warm start: skNames = the decoded names", b !== undefined && ns.join(",") === skOf(b).map((l) => l.name).filter((n: string, i: number, a: string[]) => a.indexOf(n) === i).join(","), ns.join(",")); }
ok("warm start: Stats panel fake and (hidden)", warm() && ((): boolean => { openSkillsPanel(SC, ""); const t = panelLines(120, 30).join("\n"); S.mode = "list"; return t.indexOf(fake) >= 0 && t.indexOf("(hidden)") >= 0; })(), "");

// ── a name the TUI learns after a view read its events (a subagent's load indexed later): scrubbed on the next frame ──
setVis([{ match: "*", mode: "name" }], false);
{ const id = "s-late"; sessions.clear(); ledger.clear();
  const P = join(dir, id + ".jsonl");
  writeFileSync(P, '{"parentUuid":null,"isSidechain":false,"promptId":"p1","type":"user","sessionId":"s-late","cwd":"/w/keepme","timestamp":"2026-10-01T09:00:02.000Z","uuid":"s-late-u1","message":{"role":"user","content":"use late-sk now, then ts-late-sk-1"}}\n');
  const sl: Sess = newSess("claude", id, P, false); sl.size = statSync(P).size; sl.mtime = Date.now(); sl.cwd = "/w/keepme"; sessions.set(P, sl);
  complete(sl); loadHead(sl); loadTail(sl);
  openTranscript(sl); renderTranscript(); const tl0 = S.tv ? S.tv.lines.map(plain).join("\n") : "";
  const pv0 = actLines(sl, 100).map(plain).join("\n");
  ok("late name: shown while unknown (prose)", tl0.indexOf("late-sk now") >= 0 && pv0.indexOf("late-sk now") >= 0, tl0);
  const k0 = KNOWN.of; const extra = ["late-sk"];
  KNOWN.of = (x: Sess | null): string[] => k0(x).concat(extra.splice(0));
  renderTranscript(); const tl1 = S.tv ? S.tv.lines.map(plain).join("\n") : ""; const ev1 = S.tv ? evText(S.tv.evs) : "";
  const fl = skillVis("late-sk").shown; const pv1 = actLines(sl, 100).map(plain).join("\n");
  ok("late name: the transcript's lines scrubbed on the next frame", tl1.indexOf("late-sk") < 0 && tl1.indexOf(fl + " now") >= 0 && tl1.indexOf("ts-" + fl + "-1") >= 0, tl1);
  ok("late name: its events too", ev1.indexOf("late-sk") < 0, ev1);
  ok("late name: the preview's lines", pv1.indexOf("late-sk") < 0 && pv1.indexOf(fl) >= 0, pv1);
  KNOWN.of = k0; S.mode = "list"; }

// ── without rules nothing is hidden locally ──
setVis([], false);
const s0 = fresh("s-free");
openTranscript(s0); renderTranscript();
const t0l = S.tv ? S.tv.lines.map(plain).join("\n") : "";
ok("no rules: transcript names every load", ["✧ pub", "✧ acme-x", "✧ secret", "✧ notes"].every((n: string) => t0l.indexOf(n) >= 0), t0l);
ok("no rules: events carry the texts", S.tv ? evText(S.tv.evs).indexOf("SECRETSKILLTEXT") >= 0 : false, "");
let v0 = ""; for (const m of marksOf(s0, ["skill:load"])) { const l = loadOf(s0, m); if (l) { openSkillView(s0, l); v0 += skillViewLines(100).join("\n"); } }
ok("no rules: view skill shows each text", ["PUBSKILLTEXT", "ACMESKILLTEXT", "NOTESSKILLTEXT"].every((n: string) => v0.indexOf(n) >= 0), "");

console.log(bad ? String(bad) + " failed" : "skills hidden on every TUI surface: all checks passed");
if (bad) process.exit(1);
