// agentglass — skill visibility: what a surface may show of a skill (its name, its loaded text). Local surfaces show
// everything by default; --redact and the user's skills.hide rules hide (spec Privacy, Decision 8). Every surface that
// prints a skill name or text goes through skillVis()/textShown() (VIS_SURFACES, checked by vis.check.ts)
// SPDX-License-Identifier: Apache-2.0
//   { "skills": { "hide": [ { "match": "acme-*", "mode": "name" }, { "match": "x", "mode": "omit" }, "legacy-skill" ] } }
import { type Obj, obj, str, arr } from "../../util/json.ts";
import { section } from "../../util/config.ts";
import { say } from "../../state.ts";
import { REDACT } from "../redact-on.ts";
import { H } from "../../hooks.ts";
import { BUILTIN_SKILLS, fnvFeed, FNV1, listingName } from "../usage/skillrec.ts";

// mode: show (everything) | content (name and numbers, no text) | name (as content, the name faked) | omit (no per-skill
// row anywhere: its tokens fold into one "(hidden) n skills" row); shown = the name to print ("" for omit)
export interface Vis { mode: string; shown: string }
export interface HideRule { match: string; mode: string }
export const MODES = ["show", "content", "name", "omit"]; // in order of strictness
function rank(m: string): number { const i = MODES.indexOf(m); return i < 0 ? 0 : i; }
export const HIDDEN = "(hidden)"; // the row omitted skills fold into

// glob over the name: * any run, ? one character; case-sensitive (plugin: prefixes are part of the name)
export function globMatch(pat: string, s: string): boolean {
  let p = 0; let i = 0; let star = -1; let mark = 0;
  while (i < s.length) {
    const c = p < pat.length ? pat.charAt(p) : "";
    if (c === "?" || (c !== "*" && c !== "" && c === s.charAt(i))) { p++; i++; }
    else if (c === "*") { star = p; mark = i; p++; }
    else if (star >= 0) { p = star + 1; mark++; i = mark; }
    else return false;
  }
  while (p < pat.length && pat.charAt(p) === "*") p++;
  return p === pat.length;
}
// pure (checks): skills.hide's raw value → rules (in order) and one problem text per invalid entry
export function parseHide(raw: unknown): { rules: HideRule[]; bad: string[] } {
  const rules: HideRule[] = []; const bad: string[] = [];
  if (raw === undefined || raw === null) return { rules, bad };
  if (!Array.isArray(raw)) { bad.push("skills.hide must be a list of rules — ignored"); return { rules, bad }; }
  let i = 0;
  for (const v of arr(raw)) {
    i++;
    if (typeof v === "string") { const m = str(v); if (m) rules.push({ match: m, mode: "content" }); else bad.push("skills.hide entry " + String(i) + " is empty — ignored"); continue; }
    const o: Obj | null = obj(v);
    const match = o ? str(o["match"]) : ""; const mode = o ? str(o["mode"]) || "content" : "";
    if (!o || !match) { bad.push("skills.hide entry " + String(i) + " needs a \"match\" glob — ignored"); continue; }
    if (mode === "show" || rank(mode) === 0) { bad.push("skills.hide entry " + String(i) + " (" + match + "): mode must be content, name or omit — ignored"); continue; }
    rules.push({ match, mode });
  }
  return { rules, bad };
}

// VIS.redact: --redact (checks flip it); rules: null = not read yet (read once: the config is read once per run)
// gen: bumped whenever the rules change (a memo over shown names keys on it)
export const VIS = { redact: REDACT, rules: null as HideRule[] | null, gen: 0 };
const memo = new Map<string, Vis>();
export function hideRules(): HideRule[] {
  let r = VIS.rules;
  if (!r) { const p = parseHide(section("skills")["hide"]); for (const b of p.bad) say("warn", "config " + b); r = p.rules; VIS.rules = r; }
  return r;
}
// checks: replace the rules (and the redact switch) and forget what was decided
export function setVis(rules: HideRule[], redact: boolean): void { VIS.rules = rules; VIS.redact = redact; memo.clear(); VIS.gen++; }

// a name's fake: redact.ts's (stable, scrubbed from screen text too) when the binary has it, else letters from its hash
function fakeOf(name: string): string {
  const f = H.fakeSkill[0]; if (f) return f(name);
  let h = fnvFeed(FNV1, name); let o = "";
  for (let i = 0; i < name.length; i++) { const c = name.charAt(i); if (c === "-" || c === ":" || c === "_") { o += c; continue; } o += "abcdefghijklmnopqrstuvwxyz".charAt(h % 26); h = Math.imul(h ^ i, 16777619) >>> 0; }
  return o === name ? "x" + o.slice(1) : o;
}
// --redact and skills.hide combined, the stricter mode wins
export function skillVis(name: string): Vis {
  const hit = memo.get(name); if (hit) return hit;
  let mode = "show";
  for (const r of hideRules()) if (globMatch(r.match, name)) { mode = r.mode; break; }
  if (VIS.redact) { const rm = BUILTIN_SKILLS.has(name) ? "content" : "name"; if (rank(rm) > rank(mode)) mode = rm; }
  if (name === "(listing)" && mode === "name") mode = "content"; // agentglass's own label, never a secret
  const v: Vis = { mode, shown: mode === "omit" ? "" : mode === "name" ? fakeOf(name) : name };
  memo.set(name, v);
  return v;
}
// may a surface show this skill's loaded text? Locally by default; outward (OTLP, fleet, hub, MCP) only with that path's
// --content; never when the skill is hidden in any way
export function textShown(name: string, outward: boolean, content: boolean): boolean {
  if (skillVis(name).mode !== "show") return false;
  return outward ? content : true;
}
// a skill listing's text as a surface may show it: the entries (name, description, continuation lines) of skills hidden in
// any way left out, their count in their place — a listing names and describes every installed skill
export function listingShown(t: string): string {
  const o: string[] = []; let skip = false; let n = 0;
  for (const ln of t.split("\n")) {
    const nm = listingName(ln);
    if (nm) { skip = skillVis(nm).mode !== "show"; if (skip) { n++; continue; } }
    else if (ln.startsWith("- ")) skip = false;
    else if (skip) continue;
    o.push(ln);
  }
  if (n) o.push("(" + String(n) + " hidden by skills.hide)");
  return o.join("\n");
}
// why a text is not shown, for the "view skill" pane and `skills show`
export function textHiddenWhy(name: string): string {
  const v = skillVis(name);
  if (v.mode === "show") return "";
  return VIS.redact && !hideRules().some((r: HideRule) => globMatch(r.match, name)) ? "text hidden (--redact)" : "text hidden by skills.hide";
}

// modules that print skill names or text: each must call skillVis (or textShown, or a source below that did); vis.check.ts
// reads them, and fails on a module that reads skill data (SKILL_DATA_RE) without being listed here or in VIS_DATA
export const VIS_SURFACES: string[] = ["src/features/skills/cli.ts", "src/features/skills/advise.ts", "src/features/skills/text.ts", "src/features/skills/model.ts", "src/features/skills/json.ts", "src/features/skills/watchvis.ts", "src/features/skills/marks.ts", "src/features/cli.ts",
  "src/features/query/eval.ts", "src/features/compare/sections.ts", "src/features/repos/tab.ts", "src/features/skills/panel.ts", "src/features/skills/view.ts", "src/features/usage/stats.ts",
  "src/features/wait/tab.ts", "src/features/rules/metrics.ts", "src/features/otlp/build.ts", "src/features/fleet/snap.ts", "src/features/fleet/hosts.ts",
  "src/features/callgraph/model.ts", "src/features/callgraph/view.ts", "src/features/query/agg.ts", "src/features/query/ui.ts", "src/features/related/build.ts", "src/features/related/view.ts",
  "src/features/replay.ts", "src/features/skills/fleet.ts", "src/features/compare/cli.ts"];
// calls that hand out skill data already through skillVis: the skill marks (skillMarks), the filter's skill rows, the read
// model's visible rows and loads, the hooked events; or a "skillVis: <why>" comment for a pure function over such data
export const VIS_SOURCES = ["skillVis: ", "skillVis(", "textShown(", "visRows(", "visLoads(", "marksOf(", "skillRows(", "skillsAt(", "openAt(", "hideEvents", "callVis(", "scrub("];
// modules that read skill data but print none: the engine and its storage, a parser's unload, the event kinds, the fleet's
// and hub's merges (names stay as the sending host showed them; this machine's surfaces apply its own rules on top)
export const VIS_DATA: string[] = ["src/features/usage/codec.ts", "src/features/usage/record.ts", "src/features/usage/skillrec.ts", "src/model/kinds.ts",
  "src/harness/kiro.ts", "src/features/fleet/merge.ts", "src/features/fleet/model.ts", "src/features/hub/map.ts", "src/features/skills/vis.ts"];
export const SKILL_DATA_RE = /\bSkLoad\b|\bskillRows\(|\bskillsAt\(|"skill:load"|\bvisRows\(|\bvisLoads\(|\bskillLoads\(|\bskillTable\(|\bskillMarks\(|\bloadsAt\(|\bopenAt\(|\.sa\b|\.sk\b/;
