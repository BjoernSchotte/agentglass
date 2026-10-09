// agentglass — skills in the --watch stream's ordinary event lines: a call that loads a skill (Skill, activate_skill, skill,
// a read of its SKILL.md) names it in its arguments and puts its text into its result. Under skills.hide / --redact those
// lines follow skillVis like the skill lines do: omit drops them, name fakes the name, content and name hide the text; the
// names of hidden skills are scrubbed from titles and texts too (spec Privacy: every surface)
// SPDX-License-Identifier: Apache-2.0
import { type Obj, parse, str } from "../../util/json.ts";
import { execCmds } from "../usage/calls.ts";
import { skillPath, skillReadCmd } from "../usage/skillrec.ts";
import { type HideRule, skillVis, hideRules, textHiddenWhy, globMatch, HIDDEN } from "./vis.ts";

// the skill a call loads, from its tool name and its argument text as the stream prints it; "" = none
export function callSkill(tool: string, args: string): string {
  if (tool === "Skill" || tool === "activate_skill") return args.trim();
  if (tool === "skill") { const o: Obj | null = parse(args); return o ? str(o["id"]) || str(o["name"]) : args.trim(); }
  if (args.indexOf("SKILL.md") < 0) return "";
  const a = args.trim(); const direct = /\s/.test(a) ? "" : skillPath(a); if (direct) return direct; // a read tool's path
  for (const c of [args].concat(execCmds(args))) { const p = skillReadCmd(c); if (p) return skillPath(p); }
  return "";
}

// short forms of hidden names the stream met (a plugin skill's directory in its SKILL.md path) → what it prints instead;
// full names are matched against the rules at render time (scrub), so a glob rule hides a name before any load of it
const SCRUB = new Map<string, string>();
// remember a skill name the stream met; true when the skill is hidden in any way (its text must not show)
export function note(name: string): boolean {
  if (!name) return false;
  const v = skillVis(name);
  if ((v.mode === "name" || v.mode === "omit") && !SCRUB.has(name)) {
    const rep = v.mode === "omit" ? HIDDEN : v.shown;
    if (name.length >= 2) SCRUB.set(name, rep);
    const c = name.lastIndexOf(":"); if (c > 0 && name.length - c > 2) SCRUB.set(name.slice(c + 1), rep); // a plugin skill's dir in its SKILL.md path
  }
  return v.mode !== "show";
}
function word(c: string): boolean { return /[A-Za-z0-9_-]/.test(c); }
function nameCh(c: string): boolean { return /[A-Za-z0-9_:-]/.test(c); }
// what a word of the text prints as when a skills.hide rule hides it (name: the fake, omit: "(hidden)"); "" = shown as is.
// The rules alone decide (--redact's own scrubber fakes the names it knows: here every word would be a "user skill")
function ruled(w: string, rules: HideRule[]): string {
  for (const r of rules) {
    if (!globMatch(r.match, w)) continue;
    if (r.mode !== "name" && r.mode !== "omit") return "";
    const v = skillVis(w); return v.mode === "omit" ? HIDDEN : v.shown;
  }
  return "";
}
// the text with every hidden name (as a whole word) replaced: each name-like word against the rules, then the short forms
export function scrub(t: string): string {
  if (!t) return t;
  let o = t;
  const rules = hideRules();
  if (rules.length) {
    let r = ""; let i = 0; let last = 0;
    while (i < o.length) {
      if (!nameCh(o.charAt(i))) { i++; continue; }
      let e = i; while (e < o.length && nameCh(o.charAt(e))) e++;
      let w = o.slice(i, e); while (w.endsWith(":")) w = w.slice(0, -1); // "deploy:" in prose
      const rep = w.length >= 2 ? ruled(w, rules) : "";
      if (rep) { r += o.slice(last, i) + rep; last = i + w.length; }
      i = e;
    }
    o = r + o.slice(last);
  }
  if (!SCRUB.size) return o;
  for (const [real, rep] of SCRUB) {
    let at = o.indexOf(real); if (at < 0) continue;
    let r = ""; let last = 0;
    while (at >= 0) {
      const e = at + real.length;
      if ((at === 0 || !word(o.charAt(at - 1))) && (e >= o.length || !word(o.charAt(e)))) { r += o.slice(last, at) + rep; last = e; }
      at = o.indexOf(real, e);
    }
    o = r + o.slice(last);
  }
  return o;
}
// what a call's event line may show: drop (omit), or its argument text (the name faked), and whether its result's text is
// hidden ("" = shown, else why)
export function callVis(tool: string, args: string): { drop: boolean; args: string; hide: string } {
  const n = callSkill(tool, args); if (!n) return { drop: false, args, hide: "" };
  note(n);
  const v = skillVis(n);
  if (v.mode === "omit") return { drop: true, args: "", hide: "" };
  return { drop: false, args: tool === "Skill" || tool === "activate_skill" ? v.shown : scrub(args), hide: v.mode === "show" ? "" : "(" + textHiddenWhy(n) + ")" };
}
