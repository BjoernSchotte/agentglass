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
import { BUILTIN_SKILLS, fnvFeed, FNV1 } from "../usage/skillrec.ts";

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
export const VIS = { redact: REDACT, rules: null as HideRule[] | null };
const memo = new Map<string, Vis>();
export function hideRules(): HideRule[] {
  let r = VIS.rules;
  if (!r) { const p = parseHide(section("skills")["hide"]); for (const b of p.bad) say("warn", "config " + b); r = p.rules; VIS.rules = r; }
  return r;
}
// checks: replace the rules (and the redact switch) and forget what was decided
export function setVis(rules: HideRule[], redact: boolean): void { VIS.rules = rules; VIS.redact = redact; memo.clear(); }

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
// why a text is not shown, for the "view skill" pane and `skills show`
export function textHiddenWhy(name: string): string {
  const v = skillVis(name);
  if (v.mode === "show") return "";
  return VIS.redact && !hideRules().some((r: HideRule) => globMatch(r.match, name)) ? "text hidden (--redact)" : "text hidden by skills.hide";
}

// modules that print skill names or text: each must call skillVis (vis.check.ts reads them); later surfaces add theirs
export const VIS_SURFACES: string[] = ["src/features/skills/cli.ts", "src/features/skills/advise.ts", "src/features/skills/text.ts", "src/features/skills/model.ts", "src/features/skills/json.ts", "src/features/skills/watchvis.ts", "src/features/cli.ts"];
