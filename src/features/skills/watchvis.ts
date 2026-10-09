// agentglass — skills in the --watch stream's and the TUI's ordinary event lines: a call that loads a skill (Skill, activate_skill, skill,
// a read of its SKILL.md) names it in its arguments and puts its text into its result. Under skills.hide / --redact those
// lines follow skillVis like the skill lines do: omit drops them, name fakes the name, content and name hide the text; the
// names of hidden skills are scrubbed from titles and texts too (spec Privacy: every surface)
// SPDX-License-Identifier: Apache-2.0
import { type Obj, parse, str } from "../../util/json.ts";
import { execCmds } from "../usage/calls.ts";
import { skillPath, skillReadCmd } from "../usage/skillrec.ts";
import type { Ev, Sess } from "../../model/types.ts";
import { H } from "../../hooks.ts";
import { type HideRule, skillVis, hideRules, globMatch, textHiddenWhy, HIDDEN, VIS } from "./vis.ts";

// the skill a call loads, from its tool name and its argument text as the stream prints it; "" = none
export function callSkill(tool: string, args: string): string {
  if (tool === "Skill" || tool === "activate_skill") return args.trim();
  if (tool === "skill") { const o: Obj | null = parse(args); return o ? str(o["id"]) || str(o["name"]) : args.trim(); }
  if (args.indexOf("SKILL.md") < 0) return "";
  const a = args.trim(); const direct = /\s/.test(a) ? "" : skillPath(a); if (direct) return direct; // a read tool's path
  for (const c of [args].concat(execCmds(args))) { const p = skillReadCmd(c); if (p) return skillPath(p); }
  return "";
}

// real name → what the stream prints instead (the fake, or "(hidden)" for omit), for every hidden name seen so far
const SCRUB = new Map<string, string>();
let seeded = false; let scrubGen = -1;
function seed(): void { // rules without a glob name their skills already: titles are scrubbed before the first load is seen
  if (scrubGen !== VIS.gen) { scrubGen = VIS.gen; SCRUB.clear(); seeded = false; } // other rules: what they hide, from scratch
  if (seeded) return; seeded = true;
  for (const r of hideRules()) if (r.match.indexOf("*") < 0 && r.match.indexOf("?") < 0) note(r.match);
}
// remember a skill name the stream met; true when the skill is hidden in any way (its text must not show)
export function note(name: string): boolean {
  if (!name) return false;
  seed();
  const v = skillVis(name);
  if ((v.mode === "name" || v.mode === "omit") && !SCRUB.has(name)) {
    const rep = v.mode === "omit" ? HIDDEN : v.shown;
    if (name.length >= 2) SCRUB.set(name, rep);
    const c = name.lastIndexOf(":"); if (c > 0 && name.length - c > 2) SCRUB.set(name.slice(c + 1), rep); // a plugin skill's dir in its SKILL.md path
  }
  return v.mode !== "show";
}
function word(c: string): boolean { return /[A-Za-z0-9_-]/.test(c); }
// a glob rule hiding names (name, omit) matches skills no load has shown yet: the text's words are matched against those
// rules, so a title names no such skill even before its first load. A rule with 3+ literal characters ("acme-*",
// "*:internal-*") hides every word it matches; a broader one ("*", "a*") only words written as a skill reference — a
// slash command (/x, Claude's <command-name>/x), a Codex $x mention, pi's /skill:x, a skills/x/ directory, a plugin's
// "p:x" — or it would hide the prose
function ref(t: string, i: number, w: string): boolean {
  const c = /[A-Za-z]/.test(w.charAt(0)); if (!c || w.length < 2) return false;
  if (w.indexOf(":") > 0) return true;
  const p = i > 0 ? t.charAt(i - 1) : "";
  if (p === "$") return true;
  if (p !== "/") return false;
  return i < 2 || /[\s(<>"'`]/.test(t.charAt(i - 2)) || t.slice(Math.max(0, i - 7), i) === "skills/";
}
function globWords(t: string): void {
  const gs: HideRule[] = []; const strong: boolean[] = [];
  for (const r of hideRules()) if ((r.mode === "name" || r.mode === "omit") && (r.match.indexOf("*") >= 0 || r.match.indexOf("?") >= 0)) { gs.push(r); strong.push(r.match.replace(/[*?]/g, "").length >= 3); }
  if (!gs.length) return;
  let i = 0;
  while (i < t.length) {
    if (!word(t.charAt(i))) { i++; continue; }
    let e = i; while (e < t.length && (word(t.charAt(e)) || (t.charAt(e) === ":" && e + 1 < t.length && word(t.charAt(e + 1))))) e++;
    const w0 = t.slice(i, e); const at = i; i = e;
    const isRef = ref(t, at, w0);
    const w = w0.startsWith("skill:") ? w0.slice(6) : w0; // pi's /skill:<name>
    if (w.length < 2 || SCRUB.has(w)) continue;
    for (let k = 0; k < gs.length; k++) if ((isRef || strong[k]) && globMatch((gs[k] as HideRule).match, w)) { note(w); break; }
  }
}
// the text with every hidden name (as a whole word) replaced
export function scrub(t: string): string {
  seed();
  if (!t) return t;
  globWords(t);
  if (!SCRUB.size) return t;
  let o = t;
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

// the TUI's events (H.events, features/skills/marks.ts) under the same rules: a call loading an omitted skill and its result
// leave the list, a name rule's call shows the fake, a hidden skill's result shows why instead of its text, and hidden
// names are scrubbed from every other text; results find their call by id across reads (bounded). Free without rules
const EVC = new Map<string, string[]>();
export function hideEvents(s: Sess | null, evs: Ev[], from: number): void {
  if (!VIS.redact && !hideRules().length) return;
  const p = s ? s.path : ""; let w = from;
  for (let i = from; i < evs.length; i++) {
    const e = evs[i]; if (!e) continue;
    let tool = ""; let args = "";
    if (e.kind === "tool") {
      const j = e.text.indexOf("\u0000"); tool = j >= 0 ? e.text.slice(0, j) : e.text; args = j >= 0 ? e.text.slice(j + 1) : "";
      if (e.id) { if (EVC.size > 20000) EVC.clear(); EVC.set(p + "\t" + e.id, [tool, args]); }
    } else if (e.kind === "result" && e.id) { const pc = EVC.get(p + "\t" + e.id); if (pc) { tool = pc[0] ?? ""; args = pc[1] ?? ""; } }
    const cv = tool ? callVis(tool, args) : { drop: false, args, hide: "" };
    if (cv.drop) continue;
    if (e.kind === "tool") e.text = tool + (e.text.indexOf("\u0000") >= 0 ? "\u0000" + scrub(cv.args) : "");
    else if (cv.hide) { e.text = cv.hide; e.full = ""; } // the result of a call that loaded a hidden skill: its text
    else e.text = scrub(e.text);
    if (e.full && !e.full.startsWith("@file:") && e.full.length < 1048576) e.full = scrub(e.full);
    evs[w] = e; w++;
  }
  if (w < evs.length) evs.splice(w, evs.length - w);
}
// every reader of events follows skills.hide / --redact like the skill lines do: the TUI (transcript, detail, search, copy,
// call graph, related, replay), events, session, errors, related, OTLP and MCP (through the CLI). First, on the real text,
// before the redaction hook scrubs it; free without rules (hideEvents returns at once). --watch applies callVis per line
// on top (idempotent: a fake stays itself)
export function hiding(): boolean { return VIS.redact || hideRules().length > 0; }
H.events.unshift(hideEvents);
H.hides.push(hiding);
H.memoKey.push((): string => (VIS.redact ? "R" : "") + hideRules().map((r: HideRule): string => r.match + "=" + r.mode).join("\n"));
