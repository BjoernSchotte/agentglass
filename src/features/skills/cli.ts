// agentglass — `agentglass skills`: which skills sessions loaded, what each cost (load + carry, tail), advice, a session's
// timeline, the loaded text on demand, and the ledger's self check (skill-usage spec §6.17, §8, Privacy)
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, complete, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import type { Sess } from "../../model/types.ts";
import { sessions, loadHead } from "../../model/sessions.ts";
import { resolveRef } from "../../model/sessref.ts";
import { harnessIds } from "../../harness/index.ts";
import type { Obj } from "../../util/json.ts";
import { argVal } from "../../util/argv.ts";
import { discover } from "../cli.ts";
import { agentHost, agentScope, visible, cliError, type Scope } from "../agentenv.ts";
import { opt, helpOf, wantsHelp, addCmd } from "../clihelp.ts";
import { termCols } from "../format.ts";
import { cliFilter, cliSelect } from "../query/cli.ts";
import { accsOf, callsOf } from "../usage/ledger.ts";
import { callCutoff } from "../usage/callcache.ts";
import { type Acc, lastDays, startOfDay } from "../usage/record.ts";
import { LISTING } from "../usage/skillrec.ts";
import { type SkillRow, type LoadRow, SKILL_FIELDS, skillTable, skillLoads, skillCheck, sizeFill, visRows } from "./model.ts";
import { type Advice, type CallStat, type SpanStat, advise, adviseB, adviseCfg, adviceLines, visAdvice } from "./advise.ts";
import { rowFam, famKind, famName } from "../wait/family.ts";
import { identSync } from "../query/project.ts";
import { type InvSkill, inventory } from "./inventory.ts";
import { skillVis } from "./vis.ts";
import { shownText } from "./text.ts";

const PERIODS = ["today", "7d", "30d", "all"]; const SORTS = ["cost", "loads", "tail", "size", "share", "persess"];
const OPTS = [
  opt("--json", "", "machine-readable output", "", []), opt("--period", PERIODS.join("|"), "the days counted", "30d", PERIODS),
  opt("--sort", SORTS.join("|"), "row order", "cost", SORTS), opt("--harness", harnessIds().join("|"), "only this harness", "", harnessIds()),
  opt("--repo", "<name>", "only sessions of this project (the filter key repo)", "", []), opt("--filter", "'<expr>'", "only matching sessions (repeatable)", "", []),
  opt("--session", "<ref>", "one session's timeline: one line per load (current | last | <id> | <id prefix> | <harness>:<id>)", "", []),
  opt("--check", "", "verify the ledger's skill invariants; exit 3 on a violation", "", []),
  opt("--name", "<skill>", "only this skill (its name as shown: a fake under --redact)", "", []),
  opt("--advice", "<n>", "--json: how many advice items to include (0–50)", "3", []),
  opt("--all-projects", "", "inside an agent: every project (default: the current one)", "", []),
];
const HELP = `usage: agentglass skills [--period today|7d|30d|all] [--sort ${SORTS.join("|")}] [--harness h] [--repo r] [--filter expr] [--json]
       agentglass skills --session <ref> [--json]
       agentglass skills advise [--period …] [--json]
       agentglass skills show <name | <ref>#sk<i>> [--json]
       agentglass skills --check

  which skills the agents loaded and what each cost. A skill costs tokens when it is loaded (load: normally a cache write)
  and again on every later request while it stays in the context (carry: normally cache reads); tail = the carry after
  the turn it was loaded in. Tokens are the requests' measured tokens; a skill's share of a request is bounded by its text
  size (bytes / 2.6–3.9 by the model's tokenizer) and the context's growth (≈ = size inferred or the text was cut, ? = size unknown: counted, not priced).
  (listing) = the skill names and descriptions the harness puts into every request. $ = list price at today's prices.

  columns: loads (/ by you, ⚙ by the model; the rest re-injected after a compaction), sess, size (median tokens), load,
  carry, tail (tokens), share (of the input + cached tokens of the sessions it was loaded in), $, $/sess, tier

  advise   evidence-based suggestions: A1 carried too long, A2 never auto-loaded, A3 loaded twice in one context,
           A4 lost to compaction, A5 version changed, A6 listed but never loaded, A7 loaded then nothing, A8 overlap with
           another skill, A9 outcome in its turns (correlation, not cause); A10 versions across hosts: agentglass fleet
           skills (thresholds: config skills.advise.*)
  show     the text a load put into the context (the newest load of <name> in the period, or load i of a session's
           timeline); hidden by --redact and skills.hide rules (content | name | omit) in ~/.agentglass/config.json

  --json          {period, rows[{${SKILL_FIELDS.join(",")}}], hidden, advice[]}; --session: {session, loads[]} with text
  --period P      ${PERIODS.join(" | ")} (default 30d)
  --sort K        ${SORTS.join(" | ")} (default cost)
  --harness h     only this harness (${harnessIds().join(", ")})
  --repo r        only sessions of this project
  --filter expr   only matching sessions (the filter language, repeatable)
  --session ref   one session's timeline (its subagents included)
  --check         verify the skill invariants over the ledger (shares never above a request's tokens); exit 3 on a violation
  --name skill    only this skill (the table, advice, a session's timeline)
  --advice n      --json: the top n advice items (default 3, 0–50)

  exit codes: 0 ok · 2 usage error · 3 not found, or --check found a violation`;

let rc = 0;
function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(rc); } }
function fail(msg: string, hint = ""): never { cliError("usage", msg, hint, 2); }
interface Opts { json: boolean; period: string; sort: string; harness: string; repo: string; filters: string[]; session: string; check: boolean; pos: string[]; name: string; advice: number }
function opts(args: string[]): Opts {
  const o: Opts = { json: false, period: "30d", sort: "cost", harness: "", repo: "", filters: [], session: "", check: false, pos: [], name: "", advice: 3 };
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    const val = (): string => { const v = argVal(args, i); if (v === null) fail(a + " needs a value"); i++; return String(v); };
    if (a === "--json") o.json = true;
    else if (a === "--check") o.check = true;
    else if (a === "--period") { o.period = val(); if (PERIODS.indexOf(o.period) < 0) fail("--period must be one of " + PERIODS.join(", "), "e.g. --period 7d"); }
    else if (a === "--sort") { o.sort = val(); if (SORTS.indexOf(o.sort) < 0) fail("--sort must be one of " + SORTS.join(", ")); }
    else if (a === "--harness") { o.harness = val(); if (harnessIds().indexOf(o.harness) < 0) fail("unknown harness " + o.harness, "one of " + harnessIds().join(", ")); }
    else if (a === "--repo") o.repo = val();
    else if (a === "--filter") o.filters.push(val());
    else if (a === "--session") o.session = val();
    else if (a === "--name") o.name = val();
    else if (a === "--advice") { const v = val(); if (!/^[0-9]{1,2}$/.test(v) || Number(v) > 50) fail("--advice needs a number from 0 to 50", "e.g. --advice 10"); o.advice = Number(v); }
    else if (a === "--all-projects" || a === "--project-only" || a === "--content") continue;
    else if (a === "--format" || a === "--fields") fail(a + " does not apply: use --json");
    else if (a.startsWith("-")) fail("unknown option " + a, "see agentglass skills --help");
    else o.pos.push(a);
  }
  if (agentHost().on) o.json = true; // an agent reads JSON
  return o;
}
export function periodDays(p: string): string[] | null { return p === "today" ? lastDays(1) : p === "7d" ? lastDays(7) : p === "30d" ? lastDays(30) : null; }
function periodText(p: string): string { return p === "all" ? "in the history" : p === "today" ? "today" : "in the last " + p.slice(0, -1) + " days"; }
function periodLen(p: string): number { return p === "today" ? 1 : p === "7d" ? 7 : p === "30d" ? 30 : 90; }

// the period's sessions (top level, in scope and filter), each indexed to its end, with its copies' and subagents' records
interface Set0 { accs: Acc[]; ids: string[]; tops: Sess[]; bySess: Map<string, Sess> }
function gather(o: Opts, sc: Scope): Set0 {
  discover();
  const from = o.period === "all" ? 0 : startOfDay() - (periodLen(o.period) - 1) * 86400000;
  const cands: Sess[] = []; for (const s of sessions.values()) if (s.depth === 0 && s.mtime >= from && (!o.harness || s.h === o.harness)) cands.push(s);
  const fs = o.filters.slice(); if (o.repo) fs.push("repo is " + JSON.stringify(o.repo));
  const cf = fs.length ? cliFilter(fs, o.harness, false, false, false) : null;
  const tops: Sess[] = [];
  for (const s of cf ? cliSelect(cf, cands) : cands) if (visible(s, sc)) tops.push(s);
  const r: Set0 = { accs: [], ids: [], tops, bySess: new Map<string, Sess>() };
  const add = (s: Sess, id: string): void => { loadHead(s); complete(s); for (const a of accsOf(s)) { r.accs.push(a); r.ids.push(id); } r.bySess.set(s.h + ":" + s.id, s); for (const c of s.subs) add(c, id); };
  for (const s of tops) add(s, s.h + ":" + s.id);
  return r;
}

// ── formatting ──
function tok(n: number): string { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)); }
function usd(x: number, tier: string, unpriced: boolean): string { const p = tier === "≈" ? "≈" : ""; if (tier === "?" && x <= 0) return "?"; return p + (x >= 100 ? "$" + x.toFixed(0) : "$" + x.toFixed(2)) + (unpriced ? "+" : ""); }
function lp(s: string, w: number): string { return s.length >= w ? s : " ".repeat(w - s.length) + s; }
function rp(s: string, w: number): string { const c = Array.from(s); return c.length > w ? c.slice(0, w - 1).join("") + "…" : s + " ".repeat(w - c.length); }
function round(x: number): number { return Math.round(x * 1e6) / 1e6; }
export function termWidth(): number { return termCols(process.stdout.isTTY === true && !agentHost().on); }
interface Col { h: string; w: number; f: (r: SkillRow) => string; drop: number } // drop: lower goes first when narrow
const COLS: Col[] = [
  { h: "loads", w: 6, drop: 9, f: (r: SkillRow) => String(r.loadsUser + r.loadsModel + r.loadsCompact) },
  { h: "/", w: 4, drop: 1, f: (r: SkillRow) => r.name === LISTING ? "·" : String(r.loadsUser) },
  { h: "⚙", w: 4, drop: 1, f: (r: SkillRow) => r.name === LISTING ? "·" : String(r.loadsModel) },
  { h: "sess", w: 5, drop: 9, f: (r: SkillRow) => String(r.sessions) },
  { h: "size", w: 7, drop: 9, f: (r: SkillRow) => r.tier === "?" && r.sizeP50 === 0 ? "?" : tok(r.sizeP50) },
  { h: "load", w: 7, drop: 1, f: (r: SkillRow) => tok(r.load) },
  { h: "carry", w: 8, drop: 9, f: (r: SkillRow) => tok(r.carry) },
  { h: "tail", w: 7, drop: 2, f: (r: SkillRow) => tok(r.tail) },
  { h: "share", w: 7, drop: 9, f: (r: SkillRow) => (r.share * 100).toFixed(1) + " %" },
  { h: "$", w: 9, drop: 9, f: (r: SkillRow) => usd(r.usd, r.tier, r.unpriced) },
  { h: "$/sess", w: 9, drop: 9, f: (r: SkillRow) => usd(r.perSess, r.tier, r.unpriced) },
  { h: "tier", w: 6, drop: 9, f: (r: SkillRow) => r.tier === "exact" ? "" : r.tier },
];
// the table at width w: the name column takes what the others leave (≥ 14), narrow terminals drop load, / and ⚙, then tail
export function tableLines(rows: SkillRow[], w: number): string[] {
  let cols = COLS.slice();
  const width = (cs: Col[]): number => { let n = 0; for (const c of cs) n += c.w; return n; };
  for (const lvl of [1, 2]) if (width(cols) + 14 > w) cols = cols.filter((c: Col) => c.drop > lvl);
  const nw = Math.max(14, Math.min(28, w - width(cols)));
  let h = rp("skill", nw); for (const c of cols) h += lp(c.h, c.w);
  const outL = [h.trimEnd()];
  for (const r of rows) { let l = rp(r.name, nw); for (const c of cols) l += lp(c.f(r), c.w); outL.push(l.trimEnd()); }
  return outL;
}
function adviceIn(set: Set0, rows: SkillRow[], loads: LoadRow[], o: Opts): Advice[] { return periodAdvice(set.accs, set.ids, set.tops, set.bySess, rows, loads, periodLen(o.period), o.harness); }
// a session's calls in [t0, t1) over its subagents too (call rows are per log): all, failed, test runs and passed ones, commits
function spanOf(ss: Sess[], t0: number, t1: number, cut: number): SpanStat {
  const o: SpanStat = { n: 0, err: 0, tests: 0, testsOk: 0, commits: 0, kept: false };
  for (const s of ss) {
    const r = callsOf(s); if (r.n > 0 || s.mtime >= cut) o.kept = true;
    for (let i = 0; i < r.n; i++) {
      const t = r.t[i] + 0; if (t < t0 || t >= t1) continue;
      const e = r.err[i] + 0; o.n++; if (e === 1) o.err++;
      const f = rowFam(r, i); if (f < 0) continue;
      if (famKind(f) === "test" && e >= 0) { o.tests++; if (e === 0) o.testsOk++; }
      if (famName(f).startsWith("git commit") && e === 0) o.commits++;
    }
  }
  return o;
}
// the advice A1–A9 for a period's sessions (tops; accs/ids: their logs under their session's key; bySess: every session by
// that key; keyOf: the key, "<harness>:<id>" in the CLI, the log path in the Stats panel); the CLI and the Stats skills
// panel ask the same. Hidden skills already out (visAdvice)
export function periodAdvice(accs: Acc[], ids: string[], tops: Sess[], bySess: Map<string, Sess>, rows: SkillRow[], loads: LoadRow[], days: number, harness: string, keyOf: (s: Sess) => string = (s: Sess): string => s.h + ":" + s.id): Advice[] {
  const set: Set0 = { accs, ids, tops, bySess };
  const listed = new Map<string, number>(); let reqs = 0;
  for (const a of set.accs) { reqs += a.rq; for (const n of a.lst) listed.set(n, (listed.get(n) ?? 0) + 1); }
  const repos: string[] = []; for (const s of set.tops) if (s.cwd && repos.indexOf(s.cwd) < 0 && repos.length < 200) repos.push(s.cwd);
  // A5's error rate: the session's call rows started in the loading turn; rows are kept filter.callDays (an older session
  // without rows says nothing about its errors: kept false)
  const cut = callCutoff();
  const calls = (sid: string, t0: number, t1: number): CallStat => {
    const s = set.bySess.get(sid); if (!s) return { n: 0, err: 0, kept: false };
    const r = callsOf(s); let n = 0; let e = 0;
    for (let i = 0; i < r.n; i++) { const t = r.t[i] + 0; if (t >= t0 && t < t1) { n++; if (r.err[i] + 0 > 0) e++; } }
    return { n, err: e, kept: r.n > 0 || s.mtime >= cut };
  };
  const tree = new Map<string, Sess[]>(); const turns = new Map<string, number>();
  const own = new Set<string>(); for (const s of set.tops) own.add(s.path); // a subagent listed itself (the panel: every log) counts under its own key only
  const kids = (s: Sess, into: Sess[]): void => { into.push(s); for (const c of s.subs) if (!own.has(c.path)) kids(c, into); };
  for (const s of set.tops) { const v: Sess[] = []; kids(s, v); tree.set(keyOf(s), v); }
  for (let k = 0; k < set.accs.length; k++) { const id = set.ids[k] ?? ""; const a = set.accs[k] as Acc; if (!a.sub) turns.set(id, (turns.get(id) ?? 0) + a.tq); }
  const repoOf = new Map<string, string>(); for (const s of set.tops) { const x = identSync(s); repoOf.set(keyOf(s), x && x.kind !== "none" ? x.key : ""); }
  const oi = { sessions: [...tree.keys()], repo: (s: string): string => repoOf.get(s) ?? "", turns: (s: string): number => turns.get(s) ?? 0, span: (s: string, t0: number, t1: number): SpanStat => spanOf(tree.get(s) ?? [], t0, t1, cut) };
  const cfg = adviseCfg();
  const all = advise(rows, loads, { days, listed, requests: reqs }, inventory(repos).filter((x: InvSkill) => !harness || x.harness === harness), cfg, calls).concat(adviseB(rows, loads, oi, [], cfg, Date.now()));
  all.sort((x: Advice, y: Advice) => y.severity - x.severity);
  return visAdvice(all);
}
// --name: a skill as shown (a fake under --redact matches; its real name only where it is shown as is)
function named(o: Opts, shown: string): boolean { return !o.name || shown === o.name; }
function advJson(a: Advice): Obj { return { id: a.id, skill: a.skill, severityUsd: round(a.severity), evidence: a.evidence, suggestion: a.suggestion, sessions: a.sessions }; }
export function rowJson(r: SkillRow): Obj { return { name: r.name, loadsUser: r.loadsUser, loadsModel: r.loadsModel, loadsCompact: r.loadsCompact, sessions: r.sessions, sizeP50: r.sizeP50, load: r.load, carry: r.carry, tail: r.tail, usd: round(r.usd), carryUsd: round(r.carryUsd), tailUsd: round(r.tailUsd), perSess: round(r.perSess), share: round(r.share), tier: r.tier, hashes: r.hashes, scope: r.scope, unpriced: r.unpriced }; }

function table(o: Opts, set: Set0): void {
  const days = periodDays(o.period);
  const all = skillTable(set.accs, set.ids, days, o.sort);
  const loads = skillLoads(set.accs, set.ids);
  const adv = adviceIn(set, all, loads, o).filter((a: Advice) => named(o, a.skill));
  const v = visRows(all.slice()); if (o.name) v.rows = v.rows.filter((r: SkillRow) => named(o, r.name));
  if (o.json) { out(JSON.stringify({ period: o.period, rows: v.rows.map(rowJson), hidden: v.hidden, advice: adv.slice(0, o.advice).map(advJson), notes: "tokens are measured request tokens; a skill's share is bounded by its text size and the context growth; ≈ inferred or cut, ? unknown size (not priced); $ at current list prices" })); return; }
  if (!v.rows.length) { out("no skill loads " + periodText(o.period) + (set.tops.length ? " (" + String(set.tops.length) + " sessions)" : "") + " — skills are counted from Claude, Codex, pi, OpenCode and Gemini logs"); return; }
  for (const l of tableLines(v.rows, termWidth())) out(l);
  if (adv.length) { out(""); for (const a of adv.slice(0, 3)) out(adviceLines(a)[0] ?? ""); if (adv.length > 3) out("… " + String(adv.length - 3) + " more: agentglass skills advise"); }
}
function adviseCmd(o: Opts, set: Set0): void {
  const days = periodDays(o.period);
  const rows = skillTable(set.accs, set.ids, days, "cost");
  const adv = adviceIn(set, rows, skillLoads(set.accs, set.ids), o).filter((a: Advice) => named(o, a.skill));
  if (o.json) { out(JSON.stringify({ period: o.period, advice: adv.map(advJson) })); return; }
  if (!adv.length) { out("no advice " + periodText(o.period) + ": no skill crossed a threshold (config skills.advise.*)"); return; }
  for (let i = 0; i < adv.length; i++) { if (i) out(""); for (const l of adviceLines(adv[i] as Advice)) out(l); }
}
function oneSession(o: Opts, sc: Scope, ref: string): { s: Sess; accs: Acc[]; ids: string[] } {
  discover();
  const f = resolveRef(ref, false, (x: Sess): boolean => visible(x, sc));
  if (!f.s) cliError(f.err || "not_found", "session \"" + ref + "\": " + f.msg, f.hint, f.code || 3);
  const s = f.s as Sess; const accs: Acc[] = []; const ids: string[] = [];
  const add = (x: Sess): void => { loadHead(x); complete(x); for (const a of accsOf(x)) { accs.push(a); ids.push(x.h + ":" + x.id); } for (const c of x.subs) add(c); };
  add(s);
  return { s, accs, ids };
}
function hhmm(t: number): string { if (t <= 0) return "--:--"; const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }
const TRIG = new Map<string, string>(); TRIG.set("user", "/"); TRIG.set("model", "⚙"); TRIG.set("compact", "↻"); TRIG.set("listing", "·");
function loadLine(i: number, r: LoadRow): string {
  const st = r.end === 0 ? "in context" : r.why === "compact" ? "out (compacted)" : r.why === "drop" ? "out (dropped)" : r.why === "relist" ? "out (relisted)" : "out (" + r.why + ")";
  const size = r.size < 0 ? "size ?" : (r.tier === "≈" ? "≈" : "") + tok(r.size) + " tok";
  return "sk" + String(i) + "  " + hhmm(r.t) + "  " + (TRIG.get(r.trig) ?? r.trig) + " " + r.name + (r.stub ? " (stub)" : "") + (r.rel ? " (again after compaction)" : "") + " · " + size +
    " · " + String(r.requests) + " req · " + usd(r.usd, r.tier, r.unpriced) + (r.tailUsd > 0 ? " (tail " + usd(r.tailUsd, r.tier, false) + ")" : "") + " · " + st;
}
function timeline(o: Opts, sc: Scope): void {
  const g = oneSession(o, sc, o.session);
  const raw = skillLoads(g.accs, g.ids); sizeFill(raw);
  const ls: Obj[] = []; const lines: string[] = []; let skipped = 0;
  for (const r of raw) {
    const v = skillVis(r.name); if (v.mode === "omit") continue; // its tokens stay in the session's totals
    const i = lines.length + ls.length + skipped;
    if (!named(o, v.shown)) { skipped++; continue; } // sk<i> stays the load's index in the full timeline
    if (!o.json) { const real = r.name; r.name = v.shown; lines.push(loadLine(i, r)); r.name = real; continue; }
    const t = shownText(sessOf(r.sess) ?? g.s, r.name, r.hash, r.off, r.len, false, false);
    ls.push({ i, session: r.sess, name: v.shown, trigger: r.trig, at: r.t > 0 ? new Date(r.t).toISOString() : null, turn: r.turn, bytes: r.bytes, size: r.size, end: r.end > 0 ? new Date(r.end).toISOString() : null, why: r.why || null,
      reloadedAfterCompact: r.rel, stub: r.stub, requests: r.requests, tokens: { load: r.load, carry: r.carry, tail: r.tail }, costUsd: round(r.usd), carryUsd: round(r.carryUsd), tailUsd: round(r.tailUsd),
      tier: r.tier, hash: r.hash, scope: r.scope, dir: v.mode === "show" ? r.dir : "", text: t.text || null, textHidden: t.why || null });
  }
  if (o.json) { const v = visRows(skillTable(g.accs, g.ids, null, o.sort)); out(JSON.stringify({ session: g.s.h + ":" + g.s.id, rows: v.rows.filter((r: SkillRow) => named(o, r.name)).map(rowJson), hidden: v.hidden, loads: ls })); return; }
  if (!lines.length) { out("no skill loads in " + g.s.h + ":" + g.s.id); return; }
  for (const l of lines) out(l);
}
function sessOf(id: string): Sess | null { const i = id.indexOf(":"); const h = id.slice(0, i); const sid = id.slice(i + 1); for (const s of sessions.values()) if (s.h === h && s.id === sid) return s; return null; }

// skills show <name> | <ref>#sk<i>
function show(o: Opts, sc: Scope): void {
  const what = o.pos[1] ?? ""; if (!what) fail("skills show needs a skill name or <session>#sk<i>", "e.g. agentglass skills show brainstorming");
  let r: LoadRow | null = null; let s: Sess | null = null;
  const hash = what.lastIndexOf("#sk");
  if (hash > 0) {
    const g = oneSession(o, sc, what.slice(0, hash)); const i = Number(what.slice(hash + 3));
    const rows = skillLoads(g.accs, g.ids); const shown = rows.filter((x: LoadRow) => skillVis(x.name).mode !== "omit");
    if (!Number.isInteger(i) || i < 0 || i >= shown.length) cliError("not_found", "no load sk" + what.slice(hash + 3) + " in " + g.s.h + ":" + g.s.id + " (it has " + String(shown.length) + ")", "agentglass skills --session " + what.slice(0, hash), 3);
    r = shown[i] as LoadRow; s = sessOf(r.sess) ?? g.s;
  } else {
    const set = gather(o, sc);
    const rows = skillLoads(set.accs, set.ids);
    for (const x of rows) if ((x.name === what || skillVis(x.name).shown === what) && skillVis(x.name).mode !== "omit" && x.off >= 0 && (!r || x.t > r.t)) r = x;
    if (!r) cliError("not_found", "no load of skill \"" + what + "\" " + periodText(o.period), "agentglass skills lists them; --period all looks further", 3);
    s = sessOf((r as LoadRow).sess);
  }
  const L = r as LoadRow; const v = skillVis(L.name);
  const t = s ? shownText(s, L.name, L.hash, L.off, L.len, false, false) : { text: "", why: "text not found (the session is gone)" };
  if (o.json) { out(JSON.stringify({ name: v.shown, session: L.sess, trigger: L.trig, at: L.t > 0 ? new Date(L.t).toISOString() : null, size: L.size, tier: L.tier, hash: L.hash, scope: L.scope, dir: v.mode === "show" ? L.dir : "", text: t.text || null, textHidden: t.why || null })); return; }
  out("✧ " + v.shown + " · " + (TRIG.get(L.trig) ?? L.trig) + " " + L.trig + " · " + (L.size < 0 ? "size ?" : tok(L.size) + " tok") + (L.tier !== "exact" ? " " + L.tier : "") + " · hash " + L.hash + " · " + L.sess + " · " + (L.t > 0 ? new Date(L.t).toISOString() : ""));
  if (v.mode === "show" && L.dir) out("  base dir " + L.dir);
  out("");
  if (t.text) for (const l of t.text.split("\n")) out(l); else out("(" + t.why + ")");
}
function check(o: Opts, sc: Scope): void {
  const set = gather(o, sc);
  const v = skillCheck(set.accs, set.ids);
  let loads = 0; let drops = 0; let open = 0;
  for (const a of set.accs) for (const l of a.sk) { loads += l.n; if (l.why === "drop") drops++; if (l.end === 0) open++; }
  rc = v.length ? 3 : 0;
  if (o.json) { out(JSON.stringify({ ok: v.length === 0, sessions: set.tops.length, loads, open, implicitDrops: drops, violations: v.slice(0, 200) })); process.exit(rc); }
  out((v.length ? "FAIL" : "ok") + " skill invariants: " + String(set.tops.length) + " sessions, " + String(loads) + " loads (" + String(open) + " still in context), implicit drops " + String(drops) + ", violations " + String(v.length));
  for (const x of v.slice(0, 50)) out("  " + x);
  process.exit(rc);
}

function skills(args: string[]): void {
  if (wantsHelp(args)) { out(helpOf("skills", args, HELP)); process.exit(0); }
  S.cli = true;
  const o = opts(args);
  const sc = agentScope(args);
  const sub = o.pos[0] ?? "";
  if (sub && sub !== "advise" && sub !== "show") fail("unknown subcommand " + sub, "agentglass skills [advise | show <name>]");
  if (o.check) { check(o, sc); return; }
  if (sub === "show") { show(o, sc); process.exit(0); }
  if (o.session) { timeline(o, sc); process.exit(0); }
  const set = gather(o, sc);
  if (sub === "advise") adviseCmd(o, set); else table(o, set);
  process.exit(0);
}

addCmd({ cmd: "skills", usage: "agentglass skills [--period 30d] [advise | show <name>]", summary: "which skills sessions loaded and what each cost: load + carry tokens and $ per skill, tail after its turn\n(advise: what to change; show: the loaded text; --session <ref>: one session's timeline; --check: exit 3 on a violation)",
  options: OPTS, fields: SKILL_FIELDS, group: "cmd" }, "prices");
H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: `skills --json` is this command's flag
  if (args[0] !== "skills") return false;
  skills(args);
  return true;
});
