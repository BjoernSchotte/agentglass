// agentglass — skill advice A1–A10: evidence + a suggestion per skill, never an edit (skill-usage spec §8). Pure over the read
// model's rows and loads, the listings' names, the installed-skill inventory, the loading turns' calls (A5, A7, A9) and
// the fleet's versions (A10); thresholds are config skills.advise.*
// SPDX-License-Identifier: Apache-2.0
//   { "skills": { "advise": { "minSizeTok": 2000, "tailShare": 0.6, "minSessions": 3, "minUserLoads": 3, "reloadSessions": 2, "compactLoads": 3, "versionSessions": 3,
//     "idleShare": 0.5, "idleLoads": 5, "overlap": 0.6, "overlapTurns": 5, "outcomeTurns": 10, "driftDays": 7 } } }
import { obj } from "../../util/json.ts";
import { section } from "../../util/config.ts";
import { say } from "../../state.ts";
import { type SkillRow, type LoadRow, p50 } from "./model.ts";
import type { InvSkill } from "./inventory.ts";
import { skillVis } from "./vis.ts";
import { LISTING, SKILL_BPT, CLAUDE_BPT, GEMINI_BPT } from "../usage/skillrec.ts";

// severity = $ at stake per 30 days (for ordering); sessions = up to 10 session ids the evidence comes from
export interface Advice { id: string; skill: string; severity: number; evidence: string[]; suggestion: string; sessions: string[] }
interface Ver { h: string; t: number; ls: LoadRow[] }
interface VerStat { ps: number; size: number; tail: number; err: number; cov: number; n: number } // err -1 = no call rows; cov of n sessions have call rows kept
// phase B: A7 idleShare of ≥ idleLoads judged model loads; A8 Jaccard ≥ overlap over ≥ overlapTurns shared loading turns;
// A9 ≥ outcomeTurns turns on each side; A10 versions seen within driftDays
export interface AdviseCfg { minSizeTok: number; tailShare: number; minSessions: number; minUserLoads: number; reloadSessions: number; compactLoads: number; versionSessions: number;
  idleShare: number; idleLoads: number; overlap: number; overlapTurns: number; outcomeTurns: number; driftDays: number }
// what the period knows besides rows and loads: its length in days, the listings' skill names → sessions listing them,
// the requests of the period's sessions (an inventory description rides along on each)
export interface AdviseIn { days: number; listed: Map<string, number>; requests: number }
export const ADVISE_DEFAULTS: AdviseCfg = { minSizeTok: 2000, tailShare: 0.6, minSessions: 3, minUserLoads: 3, reloadSessions: 2, compactLoads: 3, versionSessions: 3,
  idleShare: 0.5, idleLoads: 5, overlap: 0.6, overlapTurns: 5, outcomeTurns: 10, driftDays: 7 };

// pure (checks): skills.advise's raw object → thresholds (invalid → default) and one problem per invalid key
export function parseAdvise(raw: unknown): { cfg: AdviseCfg; bad: string[] } {
  const d = ADVISE_DEFAULTS; const bad: string[] = [];
  const cfg: AdviseCfg = { minSizeTok: d.minSizeTok, tailShare: d.tailShare, minSessions: d.minSessions, minUserLoads: d.minUserLoads, reloadSessions: d.reloadSessions, compactLoads: d.compactLoads, versionSessions: d.versionSessions,
    idleShare: d.idleShare, idleLoads: d.idleLoads, overlap: d.overlap, overlapTurns: d.overlapTurns, outcomeTurns: d.outcomeTurns, driftDays: d.driftDays };
  const o = obj(raw); if (!o) { if (raw !== undefined) bad.push("skills.advise must be an object — defaults in force"); return { cfg, bad }; }
  const int = (k: string, lo: number, def: number): number => {
    const v = o[k]; if (v === undefined) return def;
    if (typeof v === "number" && Number.isInteger(v as number) && (v as number) >= lo) return v as number;
    bad.push("skills.advise." + k + " must be an integer ≥ " + String(lo) + " — using " + String(def)); return def;
  };
  cfg.minSizeTok = int("minSizeTok", 0, d.minSizeTok); cfg.minSessions = int("minSessions", 1, d.minSessions); cfg.minUserLoads = int("minUserLoads", 1, d.minUserLoads);
  cfg.reloadSessions = int("reloadSessions", 1, d.reloadSessions); cfg.compactLoads = int("compactLoads", 1, d.compactLoads); cfg.versionSessions = int("versionSessions", 1, d.versionSessions);
  cfg.idleLoads = int("idleLoads", 1, d.idleLoads); cfg.overlapTurns = int("overlapTurns", 1, d.overlapTurns); cfg.outcomeTurns = int("outcomeTurns", 1, d.outcomeTurns); cfg.driftDays = int("driftDays", 1, d.driftDays);
  const share = (k: string, def: number): number => {
    const v = o[k]; if (v === undefined) return def;
    if (typeof v === "number" && (v as number) > 0 && (v as number) <= 1) return v as number;
    bad.push("skills.advise." + k + " must be a number in (0, 1] — using " + String(def)); return def;
  };
  cfg.tailShare = share("tailShare", d.tailShare); cfg.idleShare = share("idleShare", d.idleShare); cfg.overlap = share("overlap", d.overlap);
  return { cfg, bad };
}
let cached: AdviseCfg | null = null;
export function adviseCfg(): AdviseCfg { if (!cached) { const p = parseAdvise(section("skills")["advise"]); for (const b of p.bad) say("warn", "config " + b); cached = p.cfg; } return cached; }

function usd(x: number): string { return x >= 100 ? "$" + x.toFixed(0) : x >= 0.995 ? "$" + x.toFixed(2) : x >= 0.0095 ? "$" + x.toFixed(2) : x > 0 ? "<$0.01" : "$0"; }
function tok(n: number): string { return n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n)); }
function pct(x: number): string { return String(Math.round(x * 100)) + " %"; }
function ids(ls: LoadRow[]): string[] { const o: string[] = []; for (const l of ls) if (o.indexOf(l.sess) < 0 && o.length < 10) o.push(l.sess); return o; }
function distinct(ls: LoadRow[]): number { const o: string[] = []; for (const l of ls) if (o.indexOf(l.sess) < 0) o.push(l.sess); return o.length; }

// a session's tool calls (and failed ones) in a span; kept = its call rows are still kept (filter.callDays), else n/err say nothing
export interface CallStat { n: number; err: number; kept: boolean }
// A5's call error rate in the loading turns: only over sessions whose call rows are kept, and it says so when that is not all
function errText(x: VerStat, y: VerStat): string {
  if (x.cov === 0 || y.cov === 0) return " · call errors: no call rows kept for " + (x.cov === 0 && y.cov === 0 ? "either version" : x.cov === 0 ? "the older version" : "the newer version") + " (filter.callDays)";
  if (x.err < 0 || y.err < 0) return " · call errors: no calls in the loading turns";
  const part = x.cov < x.n || y.cov < y.n ? " (call rows of " + String(x.cov) + "/" + String(x.n) + " → " + String(y.cov) + "/" + String(y.n) + " sessions)" : "";
  return " · call errors " + pct(x.err) + " → " + pct(y.err) + part;
}
// the advice for a period, ordered by $ at stake; calls(sess, t0, t1) = the session's tool calls (and errors) in a span
export function advise(rows: SkillRow[], loads: LoadRow[], ctx: AdviseIn, inv: InvSkill[], cfg: AdviseCfg, calls: (sess: string, t0: number, t1: number) => CallStat): Advice[] {
  const out: Advice[] = []; const per30 = 30 / Math.max(1, ctx.days);
  const of = new Map<string, LoadRow[]>();
  for (const l of loads) { if (l.name === LISTING) continue; const v = of.get(l.name); if (v) v.push(l); else of.set(l.name, [l]); }
  for (const r of rows) {
    if (r.name === LISTING) continue;
    const ls = of.get(r.name) ?? [];
    // A1 carried too long
    const share = r.usd > 0 ? r.tailUsd / r.usd : 0;
    if (r.sizeP50 >= cfg.minSizeTok && share >= cfg.tailShare && r.sessions >= cfg.minSessions) {
      const user = r.loadsUser > r.loadsModel;
      out.push({ id: "A1", skill: r.name, severity: r.tailUsd * per30,
        evidence: ["tail carry " + usd(r.tailUsd) + " of " + usd(r.usd) + " (" + pct(share) + ") over " + String(r.sessions) + " sessions", "size " + tok(r.sizeP50) + " tok, carried " + tok(r.carry) + " tok after loading"],
        suggestion: "split SKILL.md: keep the decision part, move details to references/ read on demand" + (user ? "; or start a new session after the task it was loaded for" : ""), sessions: ids(ls) });
    }
    // A2 never auto-loaded
    const ul = ls.filter((l) => l.trig === "user");
    if (r.loadsUser >= cfg.minUserLoads && r.loadsModel === 0 && distinct(ul) >= cfg.minSessions) {
      out.push({ id: "A2", skill: r.name, severity: r.usd * per30 * 0.1,
        evidence: ["invoked by hand " + String(r.loadsUser) + "× in " + String(distinct(ul)) + " sessions, never loaded by the model"],
        suggestion: "add the phrasing you use to the description; or mark it manual-only (disable-model-invocation: true) to silence this", sessions: ids(ul) });
    }
    // A3 loaded twice in one context: a load while an earlier one of the same name was still in context
    const dup: LoadRow[] = [];
    for (let i = 0; i < ls.length; i++) {
      const x = ls[i] as LoadRow;
      for (let j = 0; j < i; j++) { const y = ls[j] as LoadRow; if (y.sess === x.sess && y.t <= x.t && (y.end === 0 || y.end > x.t) && y.n === 1 && x.n === 1) { dup.push(x); break; } }
    }
    if (distinct(dup) >= cfg.reloadSessions) {
      let du = 0; for (const x of dup) du += x.usd;
      out.push({ id: "A3", skill: r.name, severity: du * per30,
        evidence: ["loaded again while in context " + String(dup.length) + "× in " + String(distinct(dup)) + " sessions, the copies cost " + usd(du)],
        suggestion: "the model re-invoked a skill it already had: say so in the skill (\"already loaded? continue\"), or narrow its description", sessions: ids(dup) });
    }
    // A4 lost to compaction
    const rel = ls.filter((l) => l.rel);
    if (rel.length >= cfg.compactLoads) {
      let lu = 0; for (const x of rel) lu += x.usd - x.carryUsd;
      out.push({ id: "A4", skill: r.name, severity: lu * per30,
        evidence: ["loaded again after a compaction " + String(rel.length) + "× (" + usd(lu) + " of loads)"],
        suggestion: "it is needed after compaction: make it shorter, or move the long-running part to a sub-agent", sessions: ids(rel) });
    }
    // A5 version changed: consecutive hashes (by first load) with enough sessions each
    if (r.hashes.length > 1) {
      const hs: Ver[] = [];
      for (const l of ls) { if (!l.hash || l.stub) continue; let e: Ver | null = null; for (const x of hs) if (x.h === l.hash) e = x; if (!e) { e = { h: l.hash, t: l.t, ls: [] }; hs.push(e); } e.ls.push(l); if (l.t > 0 && l.t < e.t) e.t = l.t; } // a re-invocation stub has its own text: no version
      hs.sort((x, y) => x.t - y.t);
      for (let i = 1; i < hs.length; i++) {
        const a = hs[i - 1] as Ver; const b = hs[i] as Ver;
        if (distinct(a.ls) < cfg.versionSessions || distinct(b.ls) < cfg.versionSessions) continue;
        const st = (v: LoadRow[]): VerStat => {
          let u = 0; let tl = 0; let n = 0; let er = 0; const sz: number[] = []; const kept: string[] = [];
          for (const l of v) {
            u += l.usd; tl += l.tailUsd; if (l.size >= 0) sz.push(l.size);
            const c = calls(l.sess, l.t, l.te > 0 ? l.te : l.end > 0 ? l.end : l.t + 3600000); if (!c.kept) continue;
            n += c.n; er += c.err; if (kept.indexOf(l.sess) < 0) kept.push(l.sess);
          }
          return { ps: u / Math.max(1, distinct(v)), size: p50(sz), tail: u > 0 ? tl / u : 0, err: n > 0 ? er / n : -1, cov: kept.length, n: distinct(v) };
        };
        const x = st(a.ls); const y = st(b.ls);
        out.push({ id: "A5", skill: r.name, severity: Math.abs(y.ps - x.ps) * distinct(b.ls) * per30,
          evidence: ["version " + a.h.slice(0, 8) + " → " + b.h.slice(0, 8) + " (first seen " + new Date(b.t).toISOString().slice(0, 10) + ")",
            "sessions " + String(distinct(a.ls)) + " → " + String(distinct(b.ls)) + " · size " + tok(x.size) + " → " + tok(y.size) + " tok · $/session " + usd(x.ps) + " → " + usd(y.ps) + " · tail " + pct(x.tail) + " → " + pct(y.tail) + errText(x, y)],
          suggestion: (y.ps > x.ps ? "the new version costs more per session" : "the new version costs less per session") + ": compare the two periods (agentglass compare) before keeping it", sessions: ids(b.ls) });
      }
    }
  }
  // A7 loaded, then nothing: model loads whose loading turn made no tool call after the load (turns that ended, sessions
  // whose call rows are kept), or that left the context within one request
  for (const r of rows) {
    if (r.name === LISTING) continue;
    let judged = 0; let idle = 0; let iu = 0; const idl: LoadRow[] = [];
    for (const l of of.get(r.name) ?? []) {
      if (l.trig !== "model" || l.n !== 1 || l.stub) continue;
      const gone = l.end > 0 && l.requests <= 1;
      if (!gone && l.te <= 0) continue; // its turn is still running: not known yet
      const c = gone ? { n: 0, err: 0, kept: true } : calls(l.sess, l.t + 1, l.te); if (!c.kept) continue;
      judged++; if (gone || c.n === 0) { idle++; iu += l.usd; idl.push(l); }
    }
    if (judged >= cfg.idleLoads && idle / judged >= cfg.idleShare) {
      out.push({ id: "A7", skill: r.name, severity: iu * per30,
        evidence: ["loaded by the model " + String(judged) + "×, then no tool call in that turn (or gone within a request) " + String(idle) + "× (" + pct(idle / judged) + "), " + usd(iu) + " for those loads"],
        suggestion: "narrow its description: the model pulls it in for requests it does not help with", sessions: ids(idl) });
    }
  }
  // A8 overlap: two skills loaded in the same turns (Jaccard over the loading turns of each)
  const turnsOf = new Map<string, string[]>(); const usdOf = new Map<string, number>(); const names: string[] = [];
  for (const r of rows) { if (r.name === LISTING) continue; names.push(r.name); usdOf.set(r.name, r.usd); const ks: string[] = []; for (const l of of.get(r.name) ?? []) { if (l.trig !== "user" && l.trig !== "model") continue; const k = l.sess + "#" + String(l.turn); if (ks.indexOf(k) < 0) ks.push(k); } turnsOf.set(r.name, ks); }
  for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
    const x = names[i] ?? ""; const y = names[j] ?? ""; const tx = turnsOf.get(x) ?? []; const ty = turnsOf.get(y) ?? [];
    if (tx.length < cfg.overlapTurns || ty.length < cfg.overlapTurns) continue;
    let both = 0; for (const k of tx) if (ty.indexOf(k) >= 0) both++;
    const jac = both / (tx.length + ty.length - both);
    if (both < cfg.overlapTurns || jac < cfg.overlap) continue;
    const ux = usdOf.get(x) ?? 0; const uy = usdOf.get(y) ?? 0; const small = ux <= uy ? x : y; const big = small === x ? y : x;
    const vb = skillVis(big); if (vb.mode === "omit") continue; // the other one is hidden: its name may not appear
    const sess: string[] = []; for (const l of of.get(small) ?? []) if (sess.indexOf(l.sess) < 0 && sess.length < 10 && (turnsOf.get(big) ?? []).indexOf(l.sess + "#" + String(l.turn)) >= 0) sess.push(l.sess);
    out.push({ id: "A8", skill: small, severity: Math.min(ux, uy) * jac * per30,
      evidence: ["loaded together with " + vb.shown + " in " + String(both) + " turns (overlap " + pct(jac) + " of the turns either was loaded in)"],
      suggestion: "merge the two, or reference one from the other so only one is loaded", sessions: sess });
  }
  // A6 listed, never loaded: names from the listings, else the inventory
  const loaded = new Set<string>(); for (const r of rows) if (r.loadsUser + r.loadsModel + r.loadsCompact > 0 && r.name !== LISTING) loaded.add(r.name);
  let lsUsd = 0; for (const r of rows) if (r.name === LISTING) lsUsd = r.usd;
  let nListed = 0; for (const n of ctx.listed.keys()) { void n; nListed++; }
  const each = nListed > 0 ? lsUsd / nListed : 0; // ≈ by name count
  const told = new Set<string>();
  for (const [n, s] of ctx.listed) {
    if (loaded.has(n)) continue; told.add(n);
    out.push({ id: "A6", skill: n, severity: each * per30, evidence: ["in the skill listing of " + String(s) + " sessions, never loaded in " + String(ctx.days) + " days; its share of the listing ≈ " + usd(each)],
      suggestion: "uninstall or disable it: its description rides along on every request (in subagents the listing is larger still)", sessions: [] });
  }
  for (const s of inv) {
    if (loaded.has(s.name) || told.has(s.name) || s.manual) continue; told.add(s.name);
    const t = Math.ceil(s.descBytes / (s.harness === "claude" ? CLAUDE_BPT : s.harness === "gemini" ? GEMINI_BPT : SKILL_BPT)); // the harness's current models' tokenizer
    out.push({ id: "A6", skill: s.name, severity: 0, evidence: ["installed (" + s.harness + ", " + s.scope + "), never loaded in " + String(ctx.days) + " days; its description ≈ " + tok(t) + " tok per request, ≈ " + tok(t * ctx.requests) + " tok in the period"],
      suggestion: "uninstall or disable it if you do not use it: its description rides along on every request", sessions: [] });
  }
  out.sort((x, y) => y.severity - x.severity || (x.id < y.id ? -1 : x.id > y.id ? 1 : x.skill < y.skill ? -1 : x.skill > y.skill ? 1 : 0));
  return out;
}
// what a surface may show: hidden skills' advice goes (omit) or names the fake (name mode)
export function visAdvice(xs: Advice[]): Advice[] {
  const out: Advice[] = [];
  for (const a of xs) { const v = skillVis(a.skill); if (v.mode === "omit") continue; a.skill = v.shown; out.push(a); }
  return out;
}
// one advice item as text lines (CLI, panel): "A1 carried too long · <skill> · ≈ $x / 30 days", evidence, suggestion
export const ADVICE_IDS = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"];
export const ADVICE_NAMES = ["carried too long", "never auto-loaded", "loaded twice in one context", "lost to compaction", "version changed", "listed, never loaded",
  "loaded, then nothing", "overlap", "outcome (correlation, not cause)", "versions differ across hosts"];
export function adviceLines(a: Advice): string[] {
  const out = [a.id + " " + (ADVICE_NAMES[ADVICE_IDS.indexOf(a.id)] ?? "") + " · " + a.skill + (a.severity > 0 ? " · " + usd(a.severity) + " / 30 days" : "")];
  for (const e of a.evidence) out.push("   " + e);
  out.push("   → " + a.suggestion);
  return out;
}

// ── phase B with inputs beyond the read model: A9 outcomes in the loading turns, A10 versions across hosts ──
// a session's tool calls in a span: all, failed, test runs (kind test) and passed ones, commits (vcs git commit); kept as CallStat
export interface SpanStat { n: number; err: number; tests: number; testsOk: number; commits: number; kept: boolean }
// sessions: the period's sessions; repo(s): its project key ("" none); turns(s): its human turns; span(s, t0, t1): its calls in [t0, t1)
export interface OutcomeIn { sessions: string[]; repo: (s: string) => string; turns: (s: string) => number; span: (s: string, t0: number, t1: number) => SpanStat }
// one host's version of a skill: its name as the host shows it, the text's hash, when it was loaded there
export interface HostHash { host: string; name: string; hash: string; at: number }
interface Side { turns: number; n: number; err: number; tests: number; ok: number; commits: number }
function side0(): Side { return { turns: 0, n: 0, err: 0, tests: 0, ok: 0, commits: 0 }; }
function addSpan(x: Side, st: SpanStat, sign: number): void { x.n += sign * st.n; x.err += sign * st.err; x.tests += sign * st.tests; x.ok += sign * st.testsOk; x.commits += sign * st.commits; }
function rate(a: number, b: number): string { return b > 0 ? pct(a / b) : "–"; }
export function adviseB(rows: SkillRow[], loads: LoadRow[], inp: OutcomeIn, hosts: HostHash[], cfg: AdviseCfg, now: number): Advice[] {
  const out: Advice[] = [];
  // A9: per skill its loading turns (ended, call rows kept) against the other turns of the sessions in the same projects
  for (const r of rows) {
    if (r.name === LISTING) continue;
    const seen: string[] = []; const sk = side0(); const repos: string[] = []; const own = new Map<string, number>(); const spans: LoadRow[] = [];
    for (const l of loads) {
      if (l.name !== r.name || (l.trig !== "user" && l.trig !== "model") || l.te <= 0) continue;
      const k = l.sess + "#" + String(l.turn); if (seen.indexOf(k) >= 0) continue;
      const st = inp.span(l.sess, l.t, l.te); if (!st.kept) continue;
      seen.push(k); spans.push(l); sk.turns++; addSpan(sk, st, 1); own.set(l.sess, (own.get(l.sess) ?? 0) + 1);
      const rp = inp.repo(l.sess); if (rp && repos.indexOf(rp) < 0) repos.push(rp);
    }
    if (sk.turns < cfg.outcomeTurns || !repos.length) continue;
    const rest = side0();
    for (const s of inp.sessions) {
      if (repos.indexOf(inp.repo(s)) < 0) continue;
      const all = inp.span(s, 0, Infinity); if (!all.kept) continue;
      addSpan(rest, all, 1); rest.turns += Math.max(0, inp.turns(s) - (own.get(s) ?? 0));
      for (const l of spans) if (l.sess === s) addSpan(rest, inp.span(s, l.t, l.te), -1);
    }
    if (rest.turns < cfg.outcomeTurns || (sk.tests + rest.tests === 0 && sk.n + rest.n === 0)) continue;
    const per = (x: Side): string => (x.commits / Math.max(1, x.turns)).toFixed(2);
    out.push({ id: "A9", skill: r.name, severity: 0,
      evidence: ["turns that loaded it " + String(sk.turns) + " vs the same projects' other turns " + String(rest.turns) + " (correlation, not cause)",
        "test runs passed " + rate(sk.ok, sk.tests) + " vs " + rate(rest.ok, rest.tests) + " · commits per turn " + per(sk) + " vs " + per(rest) + " · call errors " + rate(sk.err, sk.n) + " vs " + rate(rest.err, rest.n)],
      suggestion: "informational: compare the two groups before changing the skill (agentglass compare)", sessions: ids(spans) });
  }
  // A10: one name, several versions across hosts within driftDays
  const since = now - cfg.driftDays * 86400000; const by = new Map<string, HostHash[]>();
  for (const h of hosts) { if (h.at < since || !h.hash || h.name === LISTING) continue; const v = by.get(h.name); if (v) v.push(h); else by.set(h.name, [h]); }
  for (const [name, hs] of by) {
    const hashes: string[] = []; const hostsOf: string[] = []; for (const h of hs) { if (hashes.indexOf(h.hash) < 0) hashes.push(h.hash); if (hostsOf.indexOf(h.host) < 0) hostsOf.push(h.host); }
    if (hashes.length < 2 || hostsOf.length < 2) continue;
    const ev: string[] = [];
    for (const hn of hostsOf) { const mine: string[] = []; let at = 0; for (const h of hs) if (h.host === hn) { if (mine.indexOf(h.hash.slice(0, 8)) < 0) mine.push(h.hash.slice(0, 8)); if (h.at > at) at = h.at; } ev.push(hn + ": " + mine.join(", ") + " (last loaded " + new Date(at).toISOString().slice(0, 10) + ")"); }
    out.push({ id: "A10", skill: name, severity: 0, evidence: [String(hashes.length) + " versions on " + String(hostsOf.length) + " hosts in " + String(cfg.driftDays) + " days"].concat(ev),
      suggestion: "align the versions (the same SKILL.md on every host), or the hosts' costs and advice are not comparable", sessions: [] });
  }
  out.sort((x, y) => y.severity - x.severity || (x.id < y.id ? -1 : x.id > y.id ? 1 : x.skill < y.skill ? -1 : x.skill > y.skill ? 1 : 0));
  return out;
}
