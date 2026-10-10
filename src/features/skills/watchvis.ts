// agentglass — skills in the --watch stream's and the TUI's ordinary event lines: a call that loads a skill (Skill, activate_skill, skill,
// a read of its SKILL.md) names it in its arguments and puts its text into its result. Under skills.hide / --redact those
// lines follow skillVis like the skill lines do: omit drops them, name fakes the name, content and name hide the text; the
// names of hidden skills are scrubbed from titles and texts too (spec Privacy: every surface)
// SPDX-License-Identifier: Apache-2.0
import { type Obj, parse, str } from "../../util/json.ts";
import { execCmds } from "../usage/calls.ts";
import { skillPath, skillReadCmd, fnvFeed, FNV1 } from "../usage/skillrec.ts";
import type { Ev, Sess } from "../../model/types.ts";
import { H, READ, HIDE } from "../../hooks.ts";
import { type HideRule, skillVis, hideRules, globMatch, textHiddenWhy, HIDDEN, VIS } from "./vis.ts";
import { inventory, projectSkills } from "./inventory.ts";
import { CUT } from "../../util/text.ts";

// the skill a call loads, from its tool name and its argument text as the stream prints it; "" = none
export function callSkill(tool: string, args: string): string {
  if (tool === "Skill" || tool === "activate_skill") return args.trim();
  if (tool === "skill") { const o: Obj | null = parse(args); return o ? str(o["id"]) || str(o["name"]) : args.trim(); }
  if (args.indexOf("SKILL.md") < 0) return "";
  const a = args.trim(); const direct = /\s/.test(a) ? "" : skillPath(a); if (direct) return direct; // a read tool's path
  for (const c of [args].concat(execCmds(args))) { const p = skillReadCmd(c); if (p) return skillPath(p); }
  return "";
}

// real name → what the stream prints instead (the fake, or "(hidden)" for omit), for every hidden name seen so far.
// BY indexes them by their leading word (the run of word characters a name starts with) → the names' lengths, longest
// first: scrub finds a text's hidden names in one pass, a lookup per word and per length (not per name: thousands of
// "p:x" names share a leading word). ODD: the rare names that start with another character, swept one by one
const SCRUB = new Map<string, string>();
const BY = new Map<string, number[]>(); const ODD: string[] = [];
// SUF: entries that are only a plugin skill's dir ("xyz" of acme:xyz): a skill of that name, noted later, takes its own fake
const SUF = new Set<string>();
// FAKES: what scrub put in (the fakes): a text scrubbed twice (a title, then its JSON line) keeps them, no word of them is noted
const FAKES = new Set<string>();
// GUESS: names only guessed to be skills from a reference's shape under a broad rule ("/flurb", "$x"): hidden in that
// shape only (shape()), never as a bare word — "/tmp" or "$HOME" once made "tmp" and "HOME" vanish from every text. A
// name known to be a skill later (a load, KNOWN, a rule) leaves it and hides everywhere
const GUESS = new Set<string>();
// the leading words' length range and first characters (ASCII; others always looked up): most words skip the lookup
const LEADS = { min: 1 << 30, max: 0, first: new Uint8Array(128) };
let seeded = false; let scrubGen = -1;
// PART: the hidden names known to be skills (a rule names it, a load, KNOWN), not guessed from a reference's shape under a
// broad rule ("/tmp", "$PATH"): only these are also hidden as a "-"/"_" part of a word — under a broad rule only from 5
// characters: shorter skill names are mostly words ("run", "init") that identifiers hold for themselves ("dry-run",
// "__init__"), thousands of parts in a large session for no skill reference. LEARNT: every such name (LSET), in the order
// noted, for views read before them (HIDE.n counts from the first; a rule change starts over past the old count): a known
// skill's name the TUI learns late is scrubbed from what it shows
const PART = new Set<string>(); const LEARNT: string[] = []; const LSET = new Set<string>();
// PART's names' length range and first characters (ASCII; others always looked up): most parts of words skip the lookups
const PF = { min: 1 << 30, max: 0, first: new Uint8Array(128) };
function partAdd(nm: string): void {
  PART.add(nm); if (nm.length < PF.min) PF.min = nm.length; if (nm.length > PF.max) PF.max = nm.length;
  const f = nm.charCodeAt(0); if (f < 128) PF.first[f] = 1;
} const LN = { base: 0, on: false, rule: false };
// work counters (scrub-perf.check.ts bounds them): characters visited, glob matches tried, name compares
export const SCRUB_STAT = { chars: 0, glob: 0, cmp: 0 };
function seed(): void { // rules without a glob name their skills already: titles are scrubbed before the first load is seen
  if (scrubGen !== VIS.gen) { scrubGen = VIS.gen; SCRUB.clear(); BY.clear(); ODD.length = 0; SUF.clear(); FAKES.clear(); GUESS.clear(); LEADS.min = 1 << 30; LEADS.max = 0; for (let c = 0; c < 128; c++) LEADS.first[c] = 0; PART.clear(); PF.min = 1 << 30; PF.max = 0; for (let c = 0; c < 128; c++) PF.first[c] = 0; LSET.clear(); LN.base += LEARNT.length + 1; LEARNT.length = 0; globsOf(); seeded = false; } // other rules: what they hide, from scratch
  if (seeded) return; seeded = true;
  const on = LN.on; LN.on = true; LN.rule = true;
  for (const r of hideRules()) if (r.match.indexOf("*") < 0 && r.match.indexOf("?") < 0) note(r.match);
  LN.on = on; LN.rule = false;
}
function put(real: string, rep: string): void {
  const had = SCRUB.has(real); SCRUB.set(real, rep); FAKES.add(rep); if (had) return;
  let e = 0; while (e < real.length && wc(real.charCodeAt(e))) e++;
  if (!e) { ODD.push(real); return; }
  const lead = real.slice(0, e); const ls = BY.get(lead) ?? []; const n = real.length;
  if (e < LEADS.min) LEADS.min = e; if (e > LEADS.max) LEADS.max = e;
  const f = real.charCodeAt(0); if (f < 128) LEADS.first[f] = 1;
  let i = 0; while (i < ls.length && (ls[i] ?? 0) > n) i++; // longest first: "p:x" before "p"
  if (i < ls.length && ls[i] === n) return;
  ls.splice(i, 0, n); BY.set(lead, ls);
}
// remember a skill name the stream met; true when the skill is hidden in any way (its text must not show). dir: a plugin
// skill's dir too (its SKILL.md path names it); not for a name known only by name (KNOWN: installed, listed), whose dir
// alone ("review" of p:review) is no skill and stays a prose word. guess: only a reference's shape says it is a skill (GUESS)
export function note(name: string, dir = true, guess = false): boolean {
  if (!name) return false;
  seed();
  const v = skillVis(name);
  if (!guess) GUESS.delete(name);
  if (v.mode === "name" || v.mode === "omit") {
    const rep = v.mode === "omit" ? HIDDEN : v.shown;
    if (name.length >= 2 && (!SCRUB.has(name) || SUF.has(name))) { if (guess && !SCRUB.has(name)) GUESS.add(name); put(name, rep); SUF.delete(name); }
    // a plugin skill's dir in its SKILL.md path, also when its name was known before (KNOWN: by name only, no dir); a skill
    // of that name keeps its own fake, whichever is seen first. A dir only guessed before ("/xyz") hides everywhere now
    const c = name.lastIndexOf(":"); const d = name.slice(c + 1);
    if (dir && c > 0 && name.length - c > 2) { if (!SCRUB.has(d)) { put(d, rep); SUF.add(d); } else GUESS.delete(d); }
  }
  if (LN.on && SCRUB.has(name) && !SUF.has(name) && !GUESS.has(name) && !LSET.has(name)) { // a skill's name, surely
    LSET.add(name); LEARNT.push(name); if (LN.rule || name.length >= 5) partAdd(name);
  }
  return v.mode !== "show";
}
// a word character: letters, digits, _ and - (a table: the passes ask once per character; 2 = "-" or "_")
const WC = new Uint8Array(128);
for (let c = 0; c < 128; c++) WC[c] = c === 95 || c === 45 ? 2 : (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) ? 1 : 0;
function wc(c: number): boolean { return c < 128 && WC[c] !== 0; }
function word(c: string): boolean { return c.length > 0 && wc(c.charCodeAt(0)); }
function alpha(c: number): boolean { return (c >= 97 && c <= 122) || (c >= 65 && c <= 90); }
// what may precede a slash command: white space (as \s), ( < > " ' `
function lead(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 40 || c === 60 || c === 62 || c === 34 || c === 39 || c === 96 || c === 160 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}
// a glob rule hiding names (name, omit) matches skills no load has shown yet: the text's words are matched against those
// rules, so a title names no such skill even before its first load. A rule with 3+ literal characters ("acme-*",
// "*:internal-*") hides every word it matches; a broader one ("*", "a*") only words written as a skill reference — a
// slash command (/x, Claude's <command-name>/x), a Codex $x mention, pi's /skill:x, a skills/x/ directory, a plugin's
// "p:x" — or it would hide the prose
function ref(t: string, i: number, e: number, colon: number): boolean {
  if (e - i < 2 || !alpha(t.charCodeAt(i))) return false;
  if (colon > 0 && alpha(t.charCodeAt(colon + 1))) return true; // "p:x" ("a.ts:57", "host:4318", "T09:30": no skill)
  return shape(t, i, e);
}
// is the name at i..e written as a skill reference: "$x" (no capital: "$HOME" is a variable, skill names are lower case),
// "/x" after white space or a quote, not a path's segment ("/tmp/x", "~/app", a URL's "/app") or a closing tag ("</x>"),
// pi's "/skill:x" (as wordAt reads it: "skill:x" at a word's start), a skills/x/ dir
function shape(t: string, i: number, e: number): boolean {
  const p = i > 0 ? t.charCodeAt(i - 1) : 0;
  if (p === 36) { for (let j = i; j < e; j++) { const c = t.charCodeAt(j); if (c >= 65 && c <= 90) return false; } return true; } // $
  if (i >= 7 && t.startsWith("skills/", i - 7)) return true;
  if (p === 58) return i >= 6 && t.startsWith("skill:", i - 6) && (i === 6 || !wc(t.charCodeAt(i - 7))); // wordAt's "skill:" (sk)
  if (p !== 47) return false; // /
  const q = i < 2 ? 32 : t.charCodeAt(i - 2); // "</x>" closes a tag: no command
  return lead(q) && q !== 60 && t.charCodeAt(e) !== 47;
}
// the glob rules hiding names, compiled once per rule change; a word's verdict is kept (GW: words tried, GS: a strong
// rule matches, GA: any rule does — sets, a lookup allocates nothing), so each distinct word meets each rule once (bounded)
// lits: each strong rule's longest literal run — a word it matches holds it, so a native search finds the candidates
const GL = { gen: -1, gs: [] as HideRule[], strong: [] as boolean[], anyStrong: false, lits: [] as string[], weak: false };
const GW = new Set<string>(); const GS = new Set<string>(); const GA = new Set<string>();
function forgetVerdicts(): void { GW.clear(); GS.clear(); GA.clear(); }
function globsOf(): void {
  if (GL.gen === VIS.gen) return;
  GL.gen = VIS.gen; GL.gs = []; GL.strong = []; GL.anyStrong = false; GL.lits = []; GL.weak = false; forgetVerdicts();
  for (const r of hideRules()) if ((r.mode === "name" || r.mode === "omit") && (r.match.indexOf("*") >= 0 || r.match.indexOf("?") >= 0)) {
    const st = r.match.split("*").join("").split("?").join("").length >= 3;
    GL.gs.push(r); GL.strong.push(st); if (!st) { GL.weak = true; continue; }
    GL.anyStrong = true;
    let lit = ""; for (const a of r.match.split("*")) for (const b of a.split("?")) if (b.length > lit.length) lit = b;
    let fits = true; for (let i = 0; i < lit.length; i++) { const c = lit.charCodeAt(i); if (!wc(c) && c !== 58) fits = false; }
    if (fits && GL.lits.indexOf(lit) < 0) GL.lits.push(lit); // else no word holds it: the rule hides no prose word
  }
}
// does a rule hide word w: a strong one (strong), or any (else)
function hides(w: string, strong: boolean): boolean {
  if (GW.has(w)) return strong ? GS.has(w) : GA.has(w);
  let v = 0;
  for (let k = 0; k < GL.gs.length && v !== 3; k++) {
    const st = GL.strong[k] === true;
    if (v >= 2 && !st) continue; // only a strong rule can still add
    SCRUB_STAT.glob++;
    if (globMatch((GL.gs[k] as HideRule).match, w)) v |= st ? 3 : 2;
  }
  if (GW.size > 200000) forgetVerdicts();
  GW.add(w); if (v & 1) GS.add(w); if (v) GA.add(w);
  return strong ? (v & 1) !== 0 : v !== 0;
}
// the installed skills' names (user, plugins, and these projects'; the inventory scans at most once per hour). Plugin skills
// whose name has a ":" before a non-letter ("p:3d"): ref() reads those as a file:line, so they are looked up by name (only
// under a broad rule and for such a word); marks.ts's KNOWN notes them all
export const INSTALLED = { of: (repos: string[]): string[] => { const o: string[] = []; for (const s of inventory(repos)) o.push(s.name); return o; },
  project: (repo: string): string[] => { const o: string[] = []; for (const s of projectSkills(repo)) o.push(s.name); return o; } };
const ODDREF = new Set<string>(); let oddGen = -1;
function oddRef(w: string): boolean {
  if (oddGen !== VIS.gen) {
    oddGen = VIS.gen; ODDREF.clear();
    for (const nm of INSTALLED.of([])) for (let c = nm.indexOf(":"); c > 0; c = nm.indexOf(":", c + 1)) if (!alpha(nm.charCodeAt(c + 1))) { ODDREF.add(nm); break; }
  }
  return ODDREF.has(w);
}
// a name not noted as itself yet (a plugin skill's dir only is: a skill of that name takes its own fake)
function fresh(w: string): boolean { return (!SCRUB.has(w) || SUF.has(w)) && !FAKES.has(w); }
// the word starting at i (word characters, a ":" between them: "p:x"): noted when a rule hides it; returns its end. Its
// ":<digit>…" tail is a line or port ("acme:deploy:15", "p:x:3:7"): the name before it is the candidate
function wordAt(t: string, i: number, n: number): number {
  let e = i; let colon = -1; // the last ":" inside the word
  while (e < n) { const c = t.charCodeAt(e); if (wc(c)) e++; else if (c === 58 && e + 1 < n && wc(t.charCodeAt(e + 1))) { colon = e; e++; } else break; }
  SCRUB_STAT.chars += e - i;
  let ne = e; let nc = colon; // the name's end and its last ":"
  while (nc > i && !alpha(t.charCodeAt(nc + 1))) { ne = nc; nc = t.lastIndexOf(":", nc - 1); if (nc <= i) nc = -1; }
  const sk = t.startsWith("skill:", i) ? 6 : 0; // pi's /skill:<name>
  let isRef = ref(t, i, ne, nc);
  if (!isRef && ne < e && GL.weak) // an installed "p:3d", maybe with a tail of its own ("p:3d:15")
    for (let c = e; c > ne; c = t.lastIndexOf(":", c - 1)) if (oddRef(t.slice(i + sk, c))) { isRef = true; ne = c; break; }
  if (!isRef && !GL.anyStrong) return e;
  // a strong rule matches the whole word ("acme-x:15" under "acme-*"); else the name ("acme-x" of it, a ref's name)
  const w = t.slice(i + sk, e); const nm = ne < e ? t.slice(i + sk, ne) : w;
  if (GL.anyStrong && w.length >= 2 && fresh(w) && hides(w, true)) note(w);
  else if (nm.length >= 2 && fresh(nm) && hides(nm, !isRef)) { // a guessed "p:x" hides no dir "x", a guessed "/x" only as "/x"
    const st = !isRef || hides(nm, true); note(nm, st, !st && nm.indexOf(":") < 0);
  }
  return e;
}
// the start of the word holding position p (word characters and the ":"s between them), -1 if p is in none
function wordStart(t: string, p: number, n: number): number {
  const c0 = t.charCodeAt(p);
  if (!wc(c0) && !(c0 === 58 && p > 0 && p + 1 < n && wc(t.charCodeAt(p - 1)) && wc(t.charCodeAt(p + 1)))) return -1;
  let i = p; if (c0 === 58) i--;
  while (i > 0) { const c = t.charCodeAt(i - 1); if (wc(c) || (c === 58 && i >= 2 && wc(t.charCodeAt(i - 2)))) i--; else break; }
  SCRUB_STAT.chars += p - i + 1;
  return i;
}
// the text's words a glob rule hides, noted. Native searches find the candidates, the prose between is never read: a
// reference follows a "/" or "$" or holds a ":", and a word a strong rule hides holds that rule's longest literal run
function globWords(t: string): void {
  globsOf();
  if (!GL.gs.length) return;
  const n = t.length;
  let ps = t.indexOf("/"); let pd = t.indexOf("$"); let pc = t.indexOf(":"); let done = 0;
  while (ps >= 0 || pd >= 0 || pc >= 0) {
    let p = n; if (ps >= 0) p = ps; if (pd >= 0 && pd < p) p = pd; if (pc >= 0 && pc < p) p = pc;
    let i = -1;
    if (p === pc) { pc = t.indexOf(":", p + 1); i = wordStart(t, p, n); } // inside a word: back to its start
    else {
      if (p === ps) ps = t.indexOf("/", p + 1); else pd = t.indexOf("$", p + 1);
      if (p + 1 < n && wc(t.charCodeAt(p + 1))) i = p + 1;
    }
    if (i >= done) done = wordAt(t, i, n);
  }
  for (const lit of GL.lits) {
    done = 0;
    for (let p = t.indexOf(lit); p >= 0; p = t.indexOf(lit, Math.max(p + 1, done))) {
      const i = p < done ? -1 : wordStart(t, p, n);
      if (i >= 0) done = wordAt(t, i, n);
    }
  }
}
// a "-" or "_": inside a word it parts an identifier's components ("ts-<name>-1", "<name>_v2")
function sep(c: number): boolean { return c < 128 && WC[c] === 2; }
// the longest hidden name starting at i, a word's start or (inner) a "-"/"_" component's (the word ends at e): its end (-1:
// none), its replacement in AT.rep; ls = the word's last "-"/"_" (-1: none). A name ends where its word does, or (a skill's name: PART) at a "-"/"_" in it; never
// inside a run of letters: "ts-<name>-1" and "<name>_v2" hold it, "<name>s" and "x<name>" do not
const AT = { rep: "" };
function nameAt(t: string, i: number, e: number, n: number, inner: boolean, ls: number): number {
  const f = t.charCodeAt(i);
  if (f < 128 && (inner ? !PF.first[f] : !LEADS.first[f])) return -1; // a part starts a skill's name only
  if (e - i >= LEADS.min && e - i <= LEADS.max) { // names led by the rest of the word ("x-y", "p:x" past it)
    const lead = t.slice(i, e); const ls = BY.get(lead);
    if (ls) for (const l of ls) {
      SCRUB_STAT.cmp++;
      const ke = i + l; if (ke > n) continue; // past the text
      const at = ke < n && wc(t.charCodeAt(ke)); if (at && !sep(t.charCodeAt(ke))) continue; // no end
      const nm = ke === e ? lead : t.slice(i, ke); const rep = SCRUB.get(nm);
      if (rep !== undefined && (!(inner || at) || PART.has(nm)) && (!GUESS.size || !GUESS.has(nm) || shape(t, i, ke))) { AT.rep = rep; return ke; }
    }
  }
  if (ls > i && (f >= 128 || PF.first[f])) for (let b = Math.min(ls, i + PF.max); b >= i + PF.min; b--) { // a skill's name ending at a "-"/"_"
    if (!sep(t.charCodeAt(b))) continue;
    SCRUB_STAT.cmp++;
    const nm = t.slice(i, b); if (!PART.has(nm)) continue;
    const rep = SCRUB.get(nm); if (rep !== undefined) { AT.rep = rep; return b; }
  }
  return -1;
}
// the text with every hidden name (a word; a skill's name also as "-"/"_" components of one) replaced: one pass over the text's words and
// their components, the longest hidden name starting at one wins; a hidden name starting inside it and ending past it
// ("a.b" in "X:a.b" after "X:a") goes too
// a column cut inside a word (util/text.ts fit) scrubs the head it leaves: "xyzs" cut to "xyz…" must not show a hidden xyz
CUT.word = (t: string): string => scrub(t);
export function scrub(t: string): string {
  seed();
  if (!t) return t;
  globWords(t);
  if (!SCRUB.size) return t;
  let o = t;
  if (BY.size) {
    const n = t.length; SCRUB_STAT.chars += n;
    const r: string[] = []; let last = 0; let i = 0; // parts, joined once: += would copy the text per name
    while (i < n) {
      if (!wc(t.charCodeAt(i))) { i++; continue; }
      let e = i + 1; let ls = -1;
      while (e < n) { const ch = t.charCodeAt(e); const k = ch < 128 ? WC[ch] : 0; if (!k) break; if (k === 2) ls = e; e++; }
      let c = i; // a component's start
      while (c < e) {
        let ke = nameAt(t, c, e, n, c > i, ls);
        if (ke < 0) { if (ls < c) break; while (c < e && !sep(t.charCodeAt(c))) c++; while (c < e && sep(t.charCodeAt(c))) c++; continue; } // the next part
        r.push(t.slice(last, c)); r.push(AT.rep);
        for (let j = c + 1; j < ke; j++) { // the words and components inside the name: one may start an overlapping one
          const pj = t.charCodeAt(j - 1);
          if (!wc(t.charCodeAt(j)) || sep(t.charCodeAt(j)) || (wc(pj) && !sep(pj))) continue;
          let we = j + 1; let wl = -1; while (we < n && wc(t.charCodeAt(we))) { if (sep(t.charCodeAt(we))) wl = we; we++; }
          const oe = nameAt(t, j, we, n, wc(pj), wl); if (oe > ke) { r.push(AT.rep); ke = oe; }
        }
        last = ke;
        if (ke >= e) { e = ke; break; }
        c = ke; while (c < e && sep(t.charCodeAt(c))) c++;
      }
      i = e;
    }
    if (last) { r.push(t.slice(last)); o = r.join(""); }
  }
  for (const real of ODD) { // names starting with a non-word character: rare, one sweep each
    let at = o.indexOf(real); if (at < 0) continue;
    const rep = SCRUB.get(real) ?? ""; let r = ""; let last = 0;
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

// the skill names agentglass knows (installed, or loaded or listed by any log in the ledger), new ones only
// (features/skills/marks.ts sets it; s: the session being read): a broad glob rule ("*", "a*") hides a prose word only
// once it is known as a skill, and a title or prompt may name one long before its load is read, or in another log
export const KNOWN = { of: (s: Sess | null): string[] => [] };
let weakGen = -1; let weakOn = false;
function known(s: Sess | null): void {
  if (weakGen !== VIS.gen) { weakGen = VIS.gen; weakOn = hideRules().some((r: HideRule) => (r.mode === "name" || r.mode === "omit") && /[*?]/.test(r.match) && r.match.replace(/[*?]/g, "").length < 3); }
  if (!weakOn) return;
  const ns = KNOWN.of(s); // may read logs (a one-shot reader's family): their events hooks note too
  const on = LN.on; LN.on = true; for (const n of ns) note(n, false); LN.on = on;
}
function hasAny(x: string, ns: string[], all: boolean): boolean {
  if (!x) return false; if (all) return true;
  for (const nm of ns) if (x.indexOf(nm) >= 0) return true;
  return false;
}
// a text scrubbed again (the fakes it holds stay); the new text, or the same when nothing changed
function again(x: string, ns: string[], all: boolean): string { return hasAny(x, ns, all) ? scrub(x) : x; }
HIDE.n = (s: Sess | null): number => { if (!hiding()) return 0; seed(); known(s); return LN.base + LEARNT.length; };
// a few new names: a native search per name and text; many (a rule change, a first sweep): every text scrubbed again
HIDE.rescrub = (evs: Ev[], at: number, full: boolean): boolean => {
  if (!hiding()) return false;
  seed();
  const k = at - LN.base; if (k >= LEARNT.length) return false;
  const all = k < 0 || LEARNT.length - k > 32; const ns = all ? [] : LEARNT.slice(k);
  let ch = false;
  for (const e of evs) {
    if (e.kind === "tool") { // its argument text: the tool's name stays (hideEvents)
      const j = e.text.indexOf("\u0000");
      if (j >= 0) { const a = e.text.slice(j + 1); const b = again(a, ns, all); if (b !== a) { e.text = e.text.slice(0, j + 1) + b; ch = true; } }
    } else { const b = again(e.text, ns, all); if (b !== e.text) { e.text = b; ch = true; } }
    if (full && e.full && !e.full.startsWith("@file:") && e.full.length < 1048576) { const b = again(e.full, ns, all); if (b !== e.full) { e.full = b; ch = true; } }
  }
  return ch;
};
// OpenCode logs a skill the user activates as a meta event "skill: <name>" (harness/opencode.ts): a load like a Skill call
function metaSkill(e: Ev): string { return e.kind === "meta" && e.text.startsWith("skill: ") ? e.text.slice(7).trim() : ""; }
function callOf(e: Ev): string[] { const j = e.text.indexOf("\u0000"); return j >= 0 ? [e.text.slice(0, j), e.text.slice(j + 1)] : [e.text, ""]; }

// the TUI's events (H.events, features/skills/marks.ts) under the same rules: a call loading an omitted skill and its result
// leave the list, a name rule's call shows the fake, a hidden skill's result shows why instead of its text, and hidden
// names are scrubbed from every other text; results find their call by id across reads (bounded). Free without rules.
// The batch's loads are noted first: a prompt naming a skill before its load is scrubbed too
const EVC = new Map<string, string[]>();
// sessions with a call's text rewritten (a path or command naming a hidden skill): related/build.ts matches files and
// commands on their real events. A dropped load is no row on either side
const REWROTE = new Set<string>(); let rwGen = -1;
export function hideEvents(s: Sess | null, evs: Ev[], from: number): void {
  if (!VIS.redact && !hideRules().length) return;
  const p = s ? s.path : ""; let w = from; let rw = false;
  if (rwGen !== VIS.gen) { rwGen = VIS.gen; REWROTE.clear(); }
  known(s);
  const on = LN.on; LN.on = true;
  for (let i = from; i < evs.length; i++) {
    const e = evs[i]; if (!e) continue;
    if (e.kind === "tool") { const c = callOf(e); note(callSkill(c[0] ?? "", c[1] ?? "")); } else note(metaSkill(e));
  }
  LN.on = on;
  for (let i = from; i < evs.length; i++) {
    const e = evs[i]; if (!e) continue;
    const sm = metaSkill(e);
    if (sm) {
      const v = skillVis(sm); if (v.mode === "omit") continue;
      if (v.shown !== sm) e.text = "skill: " + v.shown;
      evs[w] = e; w++; continue;
    }
    let tool = ""; let args = "";
    if (e.kind === "tool") {
      const c = callOf(e); tool = c[0] ?? ""; args = c[1] ?? "";
      if (e.id) { if (EVC.size > 20000) EVC.clear(); EVC.set(p + "\t" + e.id, [tool, args]); }
    } else if (e.kind === "result" && e.id) { const pc = EVC.get(p + "\t" + e.id); if (pc) { tool = pc[0] ?? ""; args = pc[1] ?? ""; } }
    const cv = tool ? callVis(tool, args) : { drop: false, args, hide: "" };
    if (cv.drop) continue;
    const t0 = e.text; const f0 = e.full;
    if (e.kind === "tool") e.text = tool + (e.text.indexOf("\u0000") >= 0 ? "\u0000" + scrub(cv.args) : "");
    else if (cv.hide) { e.text = cv.hide; e.full = ""; } // the result of a call that loaded a hidden skill: its text
    else if (!READ.lean || (e.kind !== "assistant" && e.kind !== "thinking")) e.text = scrub(e.text);
    else { seed(); globWords(e.text); } // a lean reader drops replies: only the names they hold, for the texts it keeps
    // and full texts unread (MBs of tool output: a third of the graph's load under "*"; its kept texts name their own refs)
    if (e.full && !READ.lean && !e.full.startsWith("@file:") && e.full.length < 1048576) e.full = scrub(e.full);
    if (e.kind === "tool" && (e.text !== t0 || e.full !== f0)) rw = true;
    evs[w] = e; w++;
  }
  if (w < evs.length) evs.splice(w, evs.length - w);
  if (rw && p) REWROTE.add(p);
}
// every reader of events follows skills.hide / --redact like the skill lines do: the TUI (transcript, detail, search, copy,
// call graph, related, replay), events, session, errors, related, OTLP and MCP (through the CLI). First, on the real text,
// before the redaction hook scrubs it; free without rules (hideEvents returns at once). --watch prints the hooked events; a
// text scrubbed again (a title, then its JSON line) keeps its fakes (FAKES). Titles (titleOf, every surface) are scrubbed the same way
export function hiding(): boolean { return VIS.redact || hideRules().length > 0; }
H.events.unshift(hideEvents);
H.hides.push(hiding);
H.rewrote.push((s: Sess): boolean => REWROTE.has(s.path));
H.titles.push((t: string, s: Sess): string => { if (!hiding()) return t; known(s); return scrub(t); });
// the hiding rules a memo was kept under, as a hash (the ledger keeps one per session: no rule text, a few bytes)
H.memoKey.push((): string => { if (!VIS.redact && !hideRules().length) return ""; return String(fnvFeed(FNV1, (VIS.redact ? "R" : "") + hideRules().map((r: HideRule): string => r.match + "=" + r.mode).join("\n"))); });
