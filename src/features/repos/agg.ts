// agentglass — repo-view: per-project aggregation of ledger days (cost, active time, errors, files, harness mix, branches)
// SPDX-License-Identifier: Apache-2.0
// Each session (top-level or subagent) adds its matching days to the project of its own cwd (a subagent without one: its
// parent's), so a worktree-isolated subagent books where it worked. Files are relative to each worktree's own top, so
// src/a.ts edited in two worktrees is one row. Active time is the union of the sessions' intervals per day.
import { resolve } from "node:path";
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { P, labelOf, real } from "../../model/project.ts";
import { ledger } from "../usage/ledger.ts";
import { L, unionMin, spanMin } from "../usage/record.ts";
import { type Cnt, newCnt } from "../usage/calls.ts";
import { type Call, DICT, nameOf, localOf } from "../usage/facts.ts";
import { type ModeSum, newSum, addDay } from "../usage/costs.ts";
import type { Bill } from "../usage/billing.ts";
import { modeOf } from "../usage/bill-live.ts";
import { type Compiled, EMPTY, sessMatches, dayMatches, eachCall } from "../query/eval.ts";
import { matchingPaths } from "../query/ui.ts";
import { identOf } from "../query/project.ts";
import { realCwd } from "../redact.ts";

export interface FileAgg { n: number; add: number; del: number; by: Set<string> }
export interface HarnessAgg { sess: number; cost: number; unk: number }
export interface BranchAgg { sess: number; cost: number; unk: number }
export interface RepoAgg {
  key: string; label: string; kind: string; worktrees: Map<string, string> /* name ("(main)") → top */; sessions: number; live: number; last: number;
  cost: number; unk: number; modes: ModeSum; inTok: number; outTok: number; calls: number; err: number; activeMin: number; agentMin: number;
  files: Map<string, FileAgg>; outside: FileAgg; tools: Map<string, Cnt>; progErr: Map<string, Cnt>;
  byHarness: Map<string, HarnessAgg>; branches: Map<string, BranchAgg>; paths: string[] /* top-level session paths, newest first */;
  remote: string; via: string; unread: boolean; // from the identity: header of the detail
  days: string[]; // the period it was aggregated over
}

function newFile(): FileAgg { return { n: 0, add: 0, del: 0, by: new Set<string>() }; }
function newHA(): HarnessAgg { return { sess: 0, cost: 0, unk: 0 }; }
function newRepo(key: string, label: string, kind: string, days: string[]): RepoAgg {
  return { key, label, kind, worktrees: new Map<string, string>(), sessions: 0, live: 0, last: 0, cost: 0, unk: 0, modes: newSum(), inTok: 0, outTok: 0, calls: 0, err: 0, activeMin: 0, agentMin: 0,
    files: new Map<string, FileAgg>(), outside: newFile(), tools: new Map<string, Cnt>(), progErr: new Map<string, Cnt>(), byHarness: new Map<string, HarnessAgg>(), branches: new Map<string, BranchAgg>(), paths: [],
    remote: "", via: "", unread: false, days };
}
function cntOf(m: Map<string, Cnt>, k: string): Cnt { let c = m.get(k); if (!c) { c = newCnt(); m.set(k, c); } return c; }
function haOf(m: Map<string, HarnessAgg>, k: string): HarnessAgg { let c = m.get(k); if (!c) { c = newHA(); m.set(k, c); } return c; }
function fileOf(m: Map<string, FileAgg>, k: string): FileAgg { let c = m.get(k); if (!c) { c = newFile(); m.set(k, c); } return c; }

// a changed file's path relative to top ("" = outside the repo); a relative path is relative to the session's cwd
export function relFile(top: string, cwd: string, p: string): string {
  if (!p || !top) return "";
  const abs = p.startsWith("/") ? resolve(p) : cwd ? resolve(cwd, p) : "";
  return abs.startsWith(top + "/") ? abs.slice(top.length + 1) : "";
}
// tool error rate in percent; -1 below 10 calls (shown as "·")
export function errPct(err: number, n: number): number { return n < 10 ? -1 : (err * 100) / n; }
// every day key in the ledger, sorted (period "all")
let adVer = -1; let adKeys: string[] = [];
export function allDays(): string[] {
  if (adVer === L.ver) return adKeys;
  const set = new Set<string>(); for (const a of ledger.values()) for (const k of a.days.keys()) set.add(k);
  adKeys = [...set].sort(); adVer = L.ver; return adKeys;
}

// a filter with call clauses: per (session, day) the matching rows' count, errors and tools; only those days count
interface RowDay { n: number; err: number; names: Map<string, Cnt> }
function rowDays(f: Compiled, days: string[]): Map<string, RowDay> {
  const m = new Map<string, RowDay>();
  eachCall(f, days, (s: Sess, c: Call) => {
    const k = s.path + "\t" + localOf(c.t).day;
    let r = m.get(k); if (!r) { r = { n: 0, err: 0, names: new Map<string, Cnt>() }; m.set(k, r); }
    r.n++; const e = c.err === 1 ? 1 : 0; r.err += e;
    const t = cntOf(r.names, nameOf(DICT.tool, c.tool)); t.n++; t.err += e;
  });
  return m;
}
// the session passes the filter's session clauses and its full-text clauses (EMPTY passes everything)
function sessOk(f: Compiled, s: Sess): boolean { return f === EMPTY || (sessMatches(f, s) && (!f.content.length || matchingPaths(f).has(s.path))); }

interface Hit { key: string; at: number; rows: RepoAgg[] }
const cache = new Map<string, Hit>();
// per (days, canonical filter, ledger version, identity version), 5 s
export function repoAgg(days: string[], f0: Compiled | null): RepoAgg[] {
  const f = f0 ?? EMPTY;
  const key = days.join(",") + "|" + f.key + "|" + String(L.ver) + "|" + String(P.ver);
  const hit = cache.get(days.join(",") + "|" + f.key);
  if (hit && hit.key === key && Date.now() - hit.at < 5000) return hit.rows;
  const by = new Map<string, RepoAgg>();
  const acts = new Map<string, number[][]>(); // "<repo key>\t<day>" → the sessions' intervals
  const rd = f.needsCalls ? rowDays(f, days) : new Map<string, RowDay>();
  const reals = new Map<string, string>();
  for (const s of sessions.values()) {
    const a = ledger.get(s.path); if (!a || !sessOk(f, s)) continue;
    const id = identOf(s); if (!id) continue; // unresolved: the tab says "resolving N sessions…"
    let r = by.get(id.key);
    if (!r) { r = newRepo(id.key, labelOf(id), id.kind, days); r.remote = id.remote; r.via = id.via; by.set(id.key, r); }
    if (id.unread) r.unread = true;
    const cw = realCwd(s); let rc = reals.get(cw); if (rc === undefined) { rc = cw ? real(cw) : ""; reals.set(cw, rc); }
    let any = false; let cost = 0; let unk = 0;
    for (const dk of days) {
      const d = a.days.get(dk); if (!d) continue;
      if (f !== EMPTY && !dayMatches(f, s, dk, d)) continue;
      const m = f.needsCalls ? rd.get(s.path + "\t" + dk) : undefined; if (f.needsCalls && !m) continue;
      any = true;
      r.cost += d.cost; r.unk += d.unk; r.inTok += d.inTok; r.outTok += d.outTok; cost += d.cost; unk += d.unk;
      addDay(r.modes, d, (p: string): Bill => modeOf(s, p));
      if (m) { r.calls += m.n; r.err += m.err; for (const [n, c] of m.names) { const t = cntOf(r.tools, n); t.n += c.n; t.err += c.err; } }
      else for (const [n, st] of d.tt) { r.calls += st.n; r.err += st.err; const t = cntOf(r.tools, n); t.n += st.n; t.err += st.err; }
      for (const [k, c] of d.prog) { if (c.err <= 0) continue; const pe = cntOf(r.progErr, k.slice(k.indexOf("\t") + 1)); pe.n += c.n; pe.err += c.err; }
      for (const [k, c] of d.files) {
        const rel = relFile(id.top, rc, k.slice(k.indexOf("\t") + 1));
        const fa = rel ? fileOf(r.files, rel) : r.outside;
        fa.n += c.n; fa.add += c.add; fa.del += c.del; fa.by.add(s.h);
      }
      if (d.act.length) {
        r.agentMin += spanMin(d.act);
        const ak = id.key + "\t" + dk; const l = acts.get(ak); if (l) l.push(d.act); else acts.set(ak, [d.act]);
      }
    }
    if (!any) continue;
    r.worktrees.set(id.worktree || "(main)", id.top);
    const h = haOf(r.byHarness, s.h); h.cost += cost; h.unk += unk;
    if (s.branch) { const b = haOf(r.branches, s.branch); b.cost += cost; b.unk += unk; if (!s.parent) b.sess++; }
    if (!s.parent) { r.sessions++; h.sess++; if (s.pid) r.live++; r.paths.push(s.path); }
    const t = s.last || s.mtime; if (t > r.last) r.last = t;
  }
  for (const [ak, ls] of acts) { const r = by.get(ak.slice(0, ak.indexOf("\t"))); if (r) r.activeMin += unionMin(ls); }
  const rows: RepoAgg[] = [];
  for (const r of by.values()) {
    if (!r.byHarness.size) continue; // no session of it had a matching day
    r.paths.sort((x: string, y: string) => mtimeOf(y) - mtimeOf(x));
    rows.push(r);
  }
  if (cache.size > 32) cache.clear();
  cache.set(days.join(",") + "|" + f.key, { key, at: Date.now(), rows });
  return rows;
}
function mtimeOf(p: string): number { const s = sessions.get(p); return s ? s.last || s.mtime : 0; }
