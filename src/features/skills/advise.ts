// agentglass — skill advice A1–A6: evidence + a suggestion per skill, never an edit (skill-usage spec §8). Pure over the read
// model's rows and loads, the listings' names and the installed-skill inventory; thresholds are config skills.advise.*
// SPDX-License-Identifier: Apache-2.0
//   { "skills": { "advise": { "minSizeTok": 2000, "tailShare": 0.6, "minSessions": 3, "minUserLoads": 3, "reloadSessions": 2, "compactLoads": 3, "versionSessions": 3 } } }
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
export interface AdviseCfg { minSizeTok: number; tailShare: number; minSessions: number; minUserLoads: number; reloadSessions: number; compactLoads: number; versionSessions: number }
// what the period knows besides rows and loads: its length in days, the listings' skill names → sessions listing them,
// the requests of the period's sessions (an inventory description rides along on each)
export interface AdviseIn { days: number; listed: Map<string, number>; requests: number }
export const ADVISE_DEFAULTS: AdviseCfg = { minSizeTok: 2000, tailShare: 0.6, minSessions: 3, minUserLoads: 3, reloadSessions: 2, compactLoads: 3, versionSessions: 3 };

// pure (checks): skills.advise's raw object → thresholds (invalid → default) and one problem per invalid key
export function parseAdvise(raw: unknown): { cfg: AdviseCfg; bad: string[] } {
  const d = ADVISE_DEFAULTS; const bad: string[] = [];
  const cfg: AdviseCfg = { minSizeTok: d.minSizeTok, tailShare: d.tailShare, minSessions: d.minSessions, minUserLoads: d.minUserLoads, reloadSessions: d.reloadSessions, compactLoads: d.compactLoads, versionSessions: d.versionSessions };
  const o = obj(raw); if (!o) { if (raw !== undefined) bad.push("skills.advise must be an object — defaults in force"); return { cfg, bad }; }
  const int = (k: string, lo: number, def: number): number => {
    const v = o[k]; if (v === undefined) return def;
    if (typeof v === "number" && Number.isInteger(v as number) && (v as number) >= lo) return v as number;
    bad.push("skills.advise." + k + " must be an integer ≥ " + String(lo) + " — using " + String(def)); return def;
  };
  cfg.minSizeTok = int("minSizeTok", 0, d.minSizeTok); cfg.minSessions = int("minSessions", 1, d.minSessions); cfg.minUserLoads = int("minUserLoads", 1, d.minUserLoads);
  cfg.reloadSessions = int("reloadSessions", 1, d.reloadSessions); cfg.compactLoads = int("compactLoads", 1, d.compactLoads); cfg.versionSessions = int("versionSessions", 1, d.versionSessions);
  const ts = o["tailShare"];
  if (ts !== undefined) { if (typeof ts === "number" && (ts as number) > 0 && (ts as number) <= 1) cfg.tailShare = ts as number; else bad.push("skills.advise.tailShare must be a number in (0, 1] — using " + String(d.tailShare)); }
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
      for (const l of ls) { if (!l.hash) continue; let e: Ver | null = null; for (const x of hs) if (x.h === l.hash) e = x; if (!e) { e = { h: l.hash, t: l.t, ls: [] }; hs.push(e); } e.ls.push(l); if (l.t > 0 && l.t < e.t) e.t = l.t; }
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
export const ADVICE_IDS = ["A1", "A2", "A3", "A4", "A5", "A6"];
export const ADVICE_NAMES = ["carried too long", "never auto-loaded", "loaded twice in one context", "lost to compaction", "version changed", "listed, never loaded"];
export function adviceLines(a: Advice): string[] {
  const out = [a.id + " " + (ADVICE_NAMES[ADVICE_IDS.indexOf(a.id)] ?? "") + " · " + a.skill + (a.severity > 0 ? " · " + usd(a.severity) + " / 30 days" : "")];
  for (const e of a.evidence) out.push("   " + e);
  out.push("   → " + a.suggestion);
  return out;
}
