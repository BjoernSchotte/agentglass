// agentglass — the fleet's hosts (fleet spec 1, 7): reports → read-only rows, freshness, cross-host overlap, the fleet's
// cost, budget and allowance. The only module that knows hosts exist; the rows never enter the sessions map
// SPDX-License-Identifier: Apache-2.0
import { H } from "../../hooks.ts";
import { TERM } from "../../term.ts";
import { type Sess, newSess } from "../../model/types.ts";
import { FRESH, RG, sessions } from "../../model/sessions.ts";
import { type Obj, obj, str } from "../../util/json.ts";
import type { Ident } from "../../model/project.ts";
import { REMOTE_IDENT } from "../query/project.ts";
import { HOSTQ } from "../query/eval.ts";
import { HOST_ENUM } from "../query/attrs.ts";
import { type Bill, MODES } from "../usage/billing.ts";
import { type ModeSum, type BState, newSum, addSum, budgetState, monthStart } from "../usage/costs.ts";
import { type CostNow, type Ent, type Extra, budget, costWithX, extraOf, sumDaysOf, PRICE_EXTRA } from "../usage/summary.ts";
import type { SessAcc } from "../usage/pricerows.ts";
import { PGEN } from "../usage/pricing.ts";
import { ledger } from "../usage/ledger.ts";
import { L, todayKey, lastDays } from "../usage/record.ts";
import { modeOf } from "../usage/bill-live.ts";
import { ownIdsBy, rowsBy, forgetIds } from "../usage/msgrows.ts";
import { hashId } from "./ownc.ts";
import { type LocalLog, type LocalRows, type FleetHost, type Exact, type Shadow, type MergeJob, mergeStart, mergeStep, modeOfShadow, newXCache, costDays } from "./merge.ts";
import type { HostCfg, FleetCfg } from "./config.ts";
import type { HostFeed, HostReport, FeedState, LiveRow } from "./model.ts";

// mine/mineAt: the newest report of this entry's own feed; report/okAt: the report its rows show — its own, or another
// feed's of the same host (spec 17: via = that entry's name, vkind its transport; "" = its own)
// dupOf: the entry whose rows show this host instead ("local": this machine, never merged); merged: dupOf is another
// feed of the same host (its report competes for that entry's rows) rather than a conflict
// applied: the report rows were last built from (a round that changes nothing else keeps them)
// beatAt: the live stream's last beat (viewer clock, 0 = no stream), live: its newest state per session key (spec 16)
export interface RemoteHost { cfg: HostCfg; feed: HostFeed; report: HostReport | null; rows: Sess[]; okAt: number; dupOf: string; alertsSeen: Set<string>; fresh: boolean; st: FeedState | null; applied: HostReport | null; beatAt: number; live: Map<string, LiveRow>;
  mine: HostReport | null; mineAt: number; via: string; vkind: string; merged: boolean }
// localId: this machine's hostId(); intervalMs: the effective refresh interval (stretched while the TUI is unfocused)
export const FLEET = { hosts: [] as RemoteHost[], cfg: null as FleetCfg | null, localId: "", intervalMs: 60000, rowsGen: 0 }; // rowsGen: bumped when a host's rows are rebuilt
const OBJ = new Map<string, Obj>(); // remote row path → its --json object (preview, fleet --json)
export function rowObj(s: Sess): Obj | null { return s.host ? OBJ.get(s.path) ?? null : null; }
function num(v: unknown): number { return typeof v === "number" ? v as number : 0; }
export function remotePath(host: string, harness: string, id: string): string { return "@" + host + "/" + harness + ":" + id; }

// a report's sessions as rows (spec 7.1): pid 0, path "@host/harness:id" (never a file), head and tail done
const ROWC = new Map<string, { o: Obj; s: Sess }>(); // remote row path → the row built from that --json object (a report that kept it keeps the row)
export function rowsOf(h: string, r: HostReport, at: number): Sess[] {
  const out: Sess[] = []; const seen = new Set<string>();
  const from = r.hello.now - Math.max(1, r.hello.days) * 86400000; // a snapshot carries the cost window's sessions: the list shows `days`
  for (const row of r.sessions) {
    const o = row.s; const harness = str(o["harness"]); const id = str(o["id"]);
    if (!harness || !id) continue;
    if (r.exact && o["live"] !== true && Date.parse(str(o["updated"])) < from) continue;
    const path = remotePath(h, harness, id); const hit = ROWC.get(path);
    if (hit && hit.o === o) { hit.s.rat = at; OBJ.set(path, o); seen.add(path); out.push(hit.s); continue; } // the same --json object: the same row
    const s = newSess(harness, id, path, false);
    s.host = h; s.rat = at; s.rlive = o["live"] === true; s.headDone = true; s.tailSize = 0;
    // a hub host (otlp-hub) sends titles only when its export opts in: no title there means "not sent", so the id shows
    s.title = str(o["title"]) || (hostByName(h)?.cfg.kind === "otlp" ? id : "(no prompt yet)"); s.cwd = str(o["cwd"]); s.branch = str(o["branch"]); s.remote = str(o["remote"]); s.model = str(o["model"]);
    const t = Date.parse(str(o["updated"])); s.mtime = t > 0 ? t : 0; s.last = s.mtime; s.size = num(o["bytes"]);
    s.status = str(o["status"]); s.kind = str(o["kind"]);
    const tk = obj(o["tokens"]) ?? {}; s.inTok = num(tk["in"]); s.outTok = num(tk["out"]); s.cacheRTok = num(tk["cacheRead"]); s.cacheWTok = num(tk["cacheWrite"]);
    s.cost = typeof o["costUsd"] === "number" ? o["costUsd"] as number : -1;
    const b = obj(o["billing"]) ?? {}; s.bill = str(b["mode"]) || "unknown"; s.plan = str(b["plan"]); s.billSrc = str(b["source"]);
    s.unkTok = num(o["unpricedTokens"]); s.unkCr = num(o["unpricedCredits"]); s.tools = num(o["tools"]); s.linesAdd = num(o["linesAdded"]); s.linesDel = num(o["linesRemoved"]);
    s.attention = o["attention"] === true; s.stuck = str(o["stuck"]);
    OBJ.set(s.path, o); ROWC.set(path, { o, s }); seen.add(path);
    out.push(s);
  }
  for (const k of [...ROWC.keys()]) if (k.startsWith("@" + h + "/") && !seen.has(k)) ROWC.delete(k);
  return out;
}
// a stale report's rows are not live: no attention, no stuck mark (the report's values come back when it is fresh)
// (a dir host's state is minutes old: never shown as running, spec 15.4)
function markFresh(rows: Sess[], fresh: boolean, canLive: boolean): void {
  for (const s of rows) { const o = OBJ.get(s.path); s.attention = fresh && !!o && o["attention"] === true; s.stuck = fresh && o ? str(o["stuck"]) : ""; s.rlive = canLive && fresh && !!o && o["live"] === true; }
}
// a dir host's drop cadence (the writer's --every, from its snapshots; host name → ms, 0 = once: cron or a timer)
export const DIR_EVERY = new Map<string, number>();
export const DIR_EVERY_DEFAULT = 900000;
// ── the live stream (spec 16): while its beats keep coming (≤ 90 s) its states override the report's for its sessions ──
export const LIVE_FRESH_MS = 90000;
export function liveFresh(rh: RemoteHost, now: number): boolean { return rh.beatAt > 0 && now - rh.beatAt <= LIVE_FRESH_MS; }
// the stream's newest states onto the host's rows (after every report and every stream poll); false = nothing moved
// the entry whose rows show rh's host (rh itself unless it is another feed of an earlier entry)
export function primaryOf(rh: RemoteHost): RemoteHost { return rh.merged ? hostByName(rh.dupOf) ?? rh : rh; }
// the feeds of rh's host whose stream beat last (spec 17: live state from the freshest live source)
export function liveSrc(rh: RemoteHost): RemoteHost { let b = rh; for (const x of FLEET.hosts) if (x.merged && x.dupOf === rh.cfg.name && x.beatAt > b.beatAt) b = x; return b; }
// this entry runs its host's live stream: an exact ssh feed with watch on, the first such feed of its host (one stream
// per machine however many feeds reach it)
function canWatch(rh: RemoteHost): boolean { const c = rh.cfg; const r = rh.mine; return c.enabled && c.kind === "ssh" && c.watch && !!r && r.exact && !(rh.dupOf && !rh.merged); }
export function watcher(rh: RemoteHost): boolean {
  if (!canWatch(rh)) return false;
  const p = primaryOf(rh);
  for (const x of FLEET.hosts) { if (x === rh) return true; if ((x === p || (x.merged && x.dupOf === p.cfg.name)) && canWatch(x)) return false; }
  return true;
}
// keys: only these sessions changed in the stream (its beat state did not): only their rows are looked at
export function overlay(rh: RemoteHost, now: number, keys: string[] | null = null): boolean {
  const src = liveSrc(rh); const on = liveFresh(src, now); if (!src.live.size && !on) return false;
  let moved = false;
  const one = (s: Sess): void => {
    const l = on ? src.live.get(s.h + ":" + s.id) ?? null : null; // the stream names every live session: one it does not name is not live
    const o = OBJ.get(s.path);
    const live = l ? l.live : on ? false : rh.fresh && !!o && o["live"] === true;
    const att = l ? l.attention || l.approval : rh.fresh && !!o && o["attention"] === true;
    const stk = l ? l.stuck : rh.fresh && o ? str(o["stuck"]) : "";
    if (s.rlive !== live || s.attention !== att || s.stuck !== stk) { s.rlive = live; s.attention = att; s.stuck = stk; moved = true; }
  };
  if (keys) { for (const k of keys) { const i = k.indexOf(":"); const hit = ROWC.get(remotePath(rh.cfg.name, k.slice(0, i), k.slice(i + 1))); if (hit && i > 0 && rh.rows.length && !rh.dupOf) one(hit.s); } }
  else for (const s of rh.rows) one(s);
  if (moved) RG.gen++;
  return moved;
}
// rh shows report r (its own, or src's: another feed of its host); dup: the entry that shows it instead
function show(rh: RemoteHost, r: HostReport, at: number, src: RemoteHost, dup: string, merged: boolean): void {
  rh.report = r; rh.okAt = at; rh.via = src === rh ? "" : src.cfg.name; rh.vkind = src.cfg.kind; rh.merged = merged;
  const c = FLEET.cfg; if (c) rh.fresh = freshOf(rh, Date.now(), c, FLEET.intervalMs);
  if (rh.applied === r && rh.dupOf === dup) return; // the same rows as last round
  const was = rh.applied;
  if (was && !dup && rh.dupOf === "" && was.sessions === r.sessions && was.hello.days === r.hello.days) { // a delta that changed no session: the rows stay, newer
    rh.applied = r; for (const s of rh.rows) s.rat = at; markFresh(rh.rows, rh.fresh, rh.vkind !== "dir"); overlay(rh, Date.now()); RG.gen++; return;
  }
  for (const s of rh.rows) OBJ.delete(s.path);
  rh.dupOf = dup; rh.applied = r;
  FLEET.rowsGen++;
  if (dup) rh.rows = [];
  else { rh.rows = rowsOf(rh.cfg.name, r, at); markFresh(rh.rows, rh.fresh, rh.vkind !== "dir"); overlay(rh, Date.now()); }
  RG.gen++;
}
// which feed of one host its rows come from (spec 17): an exact report over an inexact one, a fresh over a stale one,
// a snapshot or drop over the hub, then the newest; ties keep config order
function better(x: RemoteHost, b: RemoteHost, now: number, f: FleetCfg): boolean {
  const rx = x.mine; const rb = b.mine; if (!rx || !rb) return !!rx;
  if (rx.exact !== rb.exact) return rx.exact;
  const fx = freshKind(x.cfg.kind, x.cfg.name, x.mineAt, now, f, FLEET.intervalMs); const fb = freshKind(b.cfg.kind, b.cfg.name, b.mineAt, now, f, FLEET.intervalMs);
  if (fx !== fb) return fx;
  const hx = x.cfg.kind === "otlp"; const hb = b.cfg.kind === "otlp"; if (hx !== hb) return !hx;
  return x.mineAt > b.mineAt;
}
// a new report from rh's own feed (ids: kept for callers; the grouping is redone over every entry)
export function applyReport(rh: RemoteHost, r: HostReport, at: number, ids: Map<string, string>): void { rh.mine = r; rh.mineAt = at; reapply(); }
// the duplicate map of a round: this machine, then every host in config order
export function idMap(): Map<string, string> {
  const m = new Map<string, string>(); const c = FLEET.cfg;
  if (FLEET.localId) m.set(FLEET.localId, c ? c.localName : "local");
  return m;
}
// every entry's newest report again, grouped by host id in config order (a report that arrives late must not steal an
// earlier entry's host): the first entry of a host shows the best of its feeds' reports (spec 17), the others show
// nothing; a report with this machine's id is never merged
export function reapply(): void {
  const c = FLEET.cfg; if (!c) return;
  const now = Date.now(); const first = new Map<string, RemoteHost>(); const best = new Map<string, RemoteHost>();
  for (const rh of FLEET.hosts) {
    const r = rh.mine; if (!r) continue;
    const id = r.hello.hostId;
    if (id && id === FLEET.localId) { show(rh, r, rh.mineAt, rh, c.localName, false); continue; }
    const p = id ? first.get(id) : undefined;
    if (!p) { if (id) { first.set(id, rh); best.set(id, rh); } else show(rh, r, rh.mineAt, rh, "", false); continue; }
    show(rh, r, rh.mineAt, rh, p.cfg.name, true);
    const b = best.get(id); if (b && better(rh, b, now, c)) best.set(id, rh);
  }
  for (const [id, p] of first) { const b = best.get(id) ?? p; const r = b.mine; if (r) show(p, r, b.mineAt, b, "", false); }
}
// fresh while its age ≤ 2 × interval + timeout (interval: the effective one, stretched while unfocused)
// a dir host: while its newest applied file is at most 2 × the writer's cadence + 10 min old (spec 15.4)
// (rh's report may be another feed's of its host: that feed's transport and cadence count)
export function freshOf(rh: RemoteHost, now: number, f: FleetCfg, intervalMs: number): boolean {
  if (rh.report === null) return false;
  return freshKind(rh.vkind || rh.cfg.kind, rh.via || rh.cfg.name, rh.okAt, now, f, intervalMs);
}
function freshKind(kind: string, name: string, at: number, now: number, f: FleetCfg, intervalMs: number): boolean {
  if (kind === "dir") { const e = DIR_EVERY.get(name) || DIR_EVERY_DEFAULT; return now - at <= 2 * e + 600000; }
  return freshAt(at, now, f, intervalMs);
}
export function freshAt(okAt: number, now: number, f: FleetCfg, intervalMs: number): boolean { return now - okAt <= 2 * intervalMs + f.timeoutS * 1000; }
// recomputes every host's freshness; true = one changed (rows re-marked, the view's signature moved)
const LIVE_ON = new Map<string, boolean>(); // host name → its live stream was beating at the last syncFresh
export function syncFresh(now: number): boolean {
  const f = FLEET.cfg; if (!f) return false;
  let moved = false;
  for (const rh of FLEET.hosts) {
    const fr = freshOf(rh, now, f, FLEET.intervalMs);
    const on = liveFresh(liveSrc(rh), now); const was = LIVE_ON.get(rh.cfg.name); LIVE_ON.set(rh.cfg.name, on);
    if (fr !== rh.fresh) { rh.fresh = fr; markFresh(rh.rows, fr, (rh.vkind || rh.cfg.kind) !== "dir"); moved = true; }
    else if (was === on) continue; // nothing to lay over again (the stream's new states are laid over as they arrive)
    if (overlay(rh, now)) moved = true; // a stream that stopped beating: its states fall back to the report's
  }
  if (moved) RG.gen++;
  return moved;
}
export function hostByName(name: string): RemoteHost | null { for (const rh of FLEET.hosts) if (rh.cfg.name === name) return rh; return null; }
// the hosts whose rows count: enabled, a report under 7 days old (older ones: fleet status only), not a duplicate
export const SHOWN_MS = 7 * 86400000;
export function merged(): RemoteHost[] { const o: RemoteHost[] = []; const now = Date.now(); for (const rh of FLEET.hosts) if (rh.cfg.enabled && rh.report && !rh.dupOf && now - rh.okAt <= SHOWN_MS) o.push(rh); return o; }
// "harness:id" keys present on 2+ hosts (this machine counts as one) that the exact merge cannot tell apart: one of them
// is a Part A host, or the harness is not Claude (no message ownership): the same session read twice (spec 7.2)
export function overlap(local: Sess[], hosts: RemoteHost[]): Set<string> {
  const seen = new Map<string, number>(); const loose = new Set<string>();
  const add = (k: string, set: Set<string>, exact: boolean): void => { if (!set.has(k)) { set.add(k); seen.set(k, (seen.get(k) ?? 0) + 1); if (!exact) loose.add(k); } };
  const l = new Set<string>(); for (const s of local) if (!s.parent) add(s.h + ":" + s.id, l, true);
  // message ownership covers Claude only: another harness's session on 2+ hosts stays marked whatever the reports
  for (const rh of hosts) { const m = new Set<string>(); const ex = !!rh.report && rh.report.exact; for (const s of rh.rows) add(s.h + ":" + s.id, m, ex && s.h === "claude"); }
  const out = new Set<string>(); for (const [k, n] of seen) if (n >= 2 && loose.has(k)) out.add(k);
  return out;
}

// ── cost ──
// a `cost --json` object → mode sums; proj per mode (-1 = the host had no projection for it), projOk = it had one
export interface HostSum { today: ModeSum; week: ModeSum; month: ModeSum; proj: number[]; projOk: boolean }
function modeSum(o: Obj | null): ModeSum {
  const m = newSum(); if (!o) return m;
  const bm = obj(o["byMode"]) ?? {};
  for (let i = 0; i < MODES.length; i++) m.by[i] = num(bm[MODES[i] ?? ""]);
  m.est = num(o["estimatedUsd"]);
  const u = obj(o["unpriced"]) ?? {}; m.unk = num(u["tokens"]); m.uc = num(u["credits"]);
  const bym = obj(u["byModel"]) ?? {}; for (const k of Object.keys(bym)) m.um.set(k, num(bym[k]));
  return m;
}
export function sumOf(cost: Obj | null): HostSum {
  const c = cost ?? {};
  const month = obj(c["month"]); const pr = month ? obj(month["projected"]) : null; const pb = pr ? obj(pr["byMode"]) ?? {} : {};
  const proj: number[] = [];
  for (let i = 0; i < MODES.length; i++) { const v = pb[MODES[i] ?? ""]; proj.push(pr && typeof v === "number" ? v as number : -1); }
  return { today: modeSum(obj(c["today"])), week: modeSum(obj(c["week"])), month: modeSum(month), proj, projOk: pr !== null };
}
export interface HostCost { name: string; today: number; week: number; month: number; age: number; stale: boolean; local: boolean }
// approx: some figure is an estimate (a stale host, a session on 2+ hosts, a host without a projection); marked: the
// period figures themselves are (stale or overlap: the header's and the Stats line's ≈)
// exact: the exact merge priced it (some host delivered exact reports); removed: copies taken out across hosts;
// merging: a merge running in slices (the TUI) with its progress, null = none (until the first one is done the exact
// hosts count as their own cost objects, marked ≈)
export interface FleetCost { today: ModeSum; week: ModeSum; month: ModeSum; projByMode: number[]; approx: boolean; marked: boolean; perHost: HostCost[]; exact: boolean; removed: number; merging: Progress | null }
function tot(m: ModeSum): number { let t = 0; for (const c of m.by) t += c; return t; }
// ── the exact merge (spec 13): local Claude logs and every exact report, cached until a report or the ledger moves. The
// TUI runs it in time slices (mergeTick from its tick: the first merge of 2 hosts mirroring 200 k messages took 4.7 s in
// one piece, and a viewer's first one also rebuilds its msgrows sidecars); a CLI run at once ──
const EX = { at: 0, ver: -1, sig: "", cs: "", x: null as Exact | null, gen: 0, ms: 0, sums: 0, max: 0, smax: 0 }; // cs: the host set x was merged from; ms/sums: time spent merging and summing, max/smax: the longest merge slice and sum (the debug footer)
export function mergeMs(): number[] { const o = [EX.ms, EX.sums, EX.max, EX.smax]; EX.ms = 0; EX.sums = 0; EX.max = 0; EX.smax = 0; return o; }
export function mergeGen(): number { return EX.gen; } // bumped by every finished merge
// a merge result of the current host set exists (one of another set never stands for it)
export function merged0(): boolean { return EX.x !== null && (!RUN.r || RUN.r.csig === EX.cs); }
const XC = newXCache(); // what the merge keeps between rounds (merge.ts)
// a merge in progress: the inputs it started with (sig/ver/at: what EX takes when it is done), this machine's Claude logs
// hashed one after another (ss, i → ll), then the job
interface Run { sig: string; ver: number; at: number; fh: FleetHost[]; csig: string; reprice: boolean; pv: string; ss: Sess[]; i: number; ll: LocalLog[]; job: MergeJob | null; t0: number }
const RUN = { r: null as Run | null };
export interface Progress { done: number; total: number; ms: number } // ms: how long it has been running
export function merging(now: number): Progress | null {
  const r = RUN.r; if (!r) return null;
  let parts = 0; let sess = 0; for (const h of r.fh) { parts += h.r.owned.length; sess += h.r.sessions.length; }
  const j = r.job; const total = r.ss.length + (j ? j.total : parts + 2 * r.ss.length + sess);
  return { done: r.i + (j ? j.done : 0), total: Math.max(1, total), ms: now - r.t0 };
}
function localRows(path: string, until: number): LocalRows {
  const a = ledger.get(path); if (!a) return { rows: [], ok: false, done: true };
  const r = rowsBy(path, "claude", a, until); if (!r) return { rows: [], ok: false, done: false };
  return { rows: r.rows, ok: r.ok, done: true };
}
function localShift(hostTz: number): number { return -new Date().getTimezoneOffset() - hostTz; }
// one slice of the merge in progress, until the clock passes `until`; true = none left (EX.x is the newest result)
export function mergeTick(until: number): boolean {
  const r = RUN.r; if (!r) return true;
  const t0 = Date.now();
  try {
    for (; r.i < r.ss.length; r.i++) { // this machine's Claude logs: their owned messages as hashes (the slow part: SHA-256 per id)
      const s = r.ss[r.i]; if (!s) continue;
      const a = ledger.get(s.path); if (!a) continue;
      const x = ownIdsBy(s.path, a, until, hashId); if (!x) return false;
      let top = s; for (let g = 0; top.parent && g < 8; g++) { const p = sessions.get(top.parent); if (!p) break; top = p; }
      r.ll.push({ path: s.path, skey: top.h + ":" + top.id, hs: x.hs, ks: x.ks, bill: modeOf(s, ""), off: a.off });
      if (Date.now() >= until && r.i + 1 < r.ss.length) { r.i++; return false; }
    }
    if (!r.job) r.job = mergeStart(r.ll, FLEET.localId, r.fh, r.reprice, localRows, XC, r.csig, r.pv, costDays(r.at));
    if (!mergeStep(r.job, until)) return false;
    EX.at = r.at; EX.ver = r.ver; EX.sig = r.sig; EX.cs = r.csig; EX.x = r.job.x; EX.gen++; RUN.r = null;
    return true;
  } finally { const d = Date.now() - t0; EX.ms += d; if (until !== Infinity && d > EX.max) EX.max = d; }
}
// maxAgeMs: how long a result may be reused while only the local ledger moved (the TUI: 30 s; a CLI run: always fresh).
// sync: run a merge to its end now (a CLI run); else start one for mergeTick and return the last result (null = none yet)
export function exactMerge(hosts: RemoteHost[], reprice: boolean, maxAgeMs: number, sync = true): Exact | null {
  const now = Date.now(); const fh: FleetHost[] = []; const sig: string[] = [reprice ? "r" : "n", String(PGEN.n)]; // a price change re-prices the shadows
  const csig: string[] = []; // what the merge's owner index depends on: each report's content, not its time
  for (const rh of hosts) {
    const r = rh.report; if (!r || !r.exact) continue; const sh = localShift(r.hello.tzOffsetMin);
    fh.push({ name: rh.cfg.name, hostId: r.hello.hostId, r, shiftMin: sh }); sig.push(rh.cfg.name + "@" + String(rh.okAt) + "#" + String(r.hello.now));
    csig.push(rh.cfg.name + "@" + r.hello.hostId + "~" + String(sh)); // its rows' changes the merge finds itself
  }
  // sync = false returns the last result while a merge runs, only when it is of the same hosts (names, ids, time zones):
  // with a host added or gone it would count a new exact host as $0 or a gone one still — null: their own figures, ≈
  const cs = csig.join("|"); const last = EX.cs === cs ? EX.x : null;
  if (RUN.r) { if (!sync) return last; mergeTick(Infinity); } // one merge at a time: the next starts from what this one leaves
  const sg = sig.join("|"); const hit = EX.x;
  if (hit && sg === EX.sig && cs === EX.cs && (EX.ver === L.ver || now - EX.at < maxAgeMs)) return hit;
  const ss: Sess[] = []; for (const s of sessions.values()) if (s.h === "claude" && ledger.has(s.path)) ss.push(s);
  forgetIds((p: string): boolean => ledger.has(p)); // logs gone since: their ids
  RUN.r = { sig: sg, ver: L.ver, at: now, fh, csig: cs, reprice, pv: String(PGEN.n), ss, i: 0, ll: [], job: null, t0: now };
  if (sync) { mergeTick(Infinity); return EX.x; }
  return last;
}
export function entOf(x: Shadow): Ent { return { a: x.a, mode: (p: string): Bill => modeOfShadow(x, p) }; }
function sumHost(es: Ent[], days: string[]): number { return tot(sumDaysOf(es, days)); }
// the merge's entries summed once per merge result and day (the header asks every few seconds): all of them for the
// fleet's figures, and per host name ("" = this machine's corrections) [today, week, month]
const SUMS = { x: null as Exact | null, day: "", all: null as Extra | null, per: new Map<string, number[]>() };
function sumsOf(x: Exact): { all: Extra; per: Map<string, number[]> } {
  const day = todayKey(); const hit = SUMS.all;
  if (hit && SUMS.x === x && SUMS.day === day) return { all: hit, per: SUMS.per };
  const t0 = Date.now(); const es: Ent[] = []; const byHost = new Map<string, Ent[]>();
  for (const s of x.accs) { const e = entOf(s); es.push(e); const p = byHost.get(s.host); if (p) p.push(e); else byHost.set(s.host, [e]); }
  const td = [day]; const wk = lastDays(7); const mk = monthStart(Date.now()); const per = new Map<string, number[]>();
  for (const [h, hs] of byHost) per.set(h, [sumHost(hs, td), sumHost(hs, wk), sumHost(hs, mk)]);
  const all = extraOf(es);
  SUMS.x = x; SUMS.day = day; SUMS.all = all; SUMS.per = per; const d = Date.now() - t0; EX.sums += d; if (d > EX.smax) EX.smax = d;
  return { all, per };
}
// this machine's figures plus each merged host's: exact reports through the merge (one table, this machine's days), Part A
// reports as their own cost objects (each host's table and day boundaries)
// sync = false (the TUI): the merge runs in slices; until its first result the exact hosts count as their own cost
// objects (each host's table and days, copies counted on every host that has them), marked ≈
export function fleetCost(localNow0: CostNow, hosts: RemoteHost[], now: number, f: FleetCfg, ov: number, maxAgeMs = 0, sync = true): FleetCost {
  let exactN = 0; for (const rh of hosts) if (rh.report && rh.report.exact) exactN++;
  const x = exactN ? exactMerge(hosts, f.reprice, maxAgeMs, sync) : null;
  const mg = exactN ? merging(now) : null;
  const xs = x ? sumsOf(x) : null;
  const localNow = xs ? costWithX(xs.all) : localNow0;
  const today = newSum(); const week = newSum(); const month = newSum(); const proj: number[] = [];
  addSum(today, localNow.today); addSum(week, localNow.week); addSum(month, localNow.month);
  let approx = ov > 0 || (!!x && x.inexact.length > 0) || (exactN > 0 && !x); let marked = approx;
  for (let i = 0; i < MODES.length; i++) { const p = localNow.projByMode[i]; const v = p ? p.month : -1; proj.push(v >= 0 ? v : localNow.month.by[i] ?? 0); if (v < 0 && (localNow.month.by[i] ?? 0) > 0) approx = true; }
  const by = (host: string): number[] => xs ? xs.per.get(host) ?? [0, 0, 0] : [0, 0, 0];
  const lc = by("");
  const per: HostCost[] = [{ name: f.localName, today: tot(localNow0.today) + (lc[0] ?? 0), week: tot(localNow0.week) + (lc[1] ?? 0), month: tot(localNow0.month) + (lc[2] ?? 0), age: 0, stale: false, local: true }];
  for (const rh of hosts) {
    const r = rh.report; if (!r) continue;
    if (r.exact && x) {
      const stale = !freshOf(rh, now, f, FLEET.intervalMs); if (stale) { approx = true; marked = true; }
      const es = by(rh.cfg.name);
      per.push({ name: rh.cfg.name, today: es[0] ?? 0, week: es[1] ?? 0, month: es[2] ?? 0, age: now - rh.okAt, stale, local: false });
      continue;
    }
    const hs = sumOf(r.cost);
    addSum(today, hs.today); addSum(week, hs.week); addSum(month, hs.month);
    for (let i = 0; i < MODES.length; i++) { const v = hs.proj[i] ?? -1; proj[i] = (proj[i] ?? 0) + (v >= 0 ? v : hs.month.by[i] ?? 0); if (v < 0 && (hs.month.by[i] ?? 0) > 0) approx = true; }
    const stale = !freshOf(rh, now, f, FLEET.intervalMs);
    if (stale || !hs.projOk) approx = true;
    if (stale) marked = true;
    per.push({ name: rh.cfg.name, today: tot(hs.today), week: tot(hs.week), month: tot(hs.month), age: now - rh.okAt, stale, local: false });
  }
  return { today, week, month, projByMode: proj, approx, marked, perHost: per, exact: !!x, removed: x ? x.removed + x.corrected : 0, merging: mg };
}
// the local budget over the fleet (one account, one budget; the hosts' own budgets are ignored)
export function fleetBudget(fc: FleetCost): BState {
  const bs = budgetState(budget, fc.month, fc.projByMode);
  bs.approx = bs.approx || fc.approx;
  return bs;
}

// ── allowance (spec 7.4): per account the window with the newest fetchedAt, never a sum; Codex: the newest event ──
export interface Gauge { account: string; fetchedAt: number; h5: Obj | null; d7: Obj | null }
export function fleetAllowance(local: Obj | null, hosts: RemoteHost[]): Obj | null {
  const all: Obj[] = []; if (local) all.push(local);
  for (const rh of hosts) if (rh.report && rh.report.allowance) all.push(rh.report.allowance);
  const byAcc = new Map<string, Obj>(); let codex: Obj | null = null;
  for (const a of all) {
    const c = obj(a["claude"]);
    if (c) { const k = str(c["account"]); const old = byAcc.get(k); if (!old || num(c["fetchedAt"]) > num(old["fetchedAt"])) byAcc.set(k, c); }
    const x = obj(a["codex"]);
    if (x && (!codex || num(x["at"]) > num(codex["at"]))) codex = x;
  }
  if (!byAcc.size && !codex) return null;
  const cl: Obj[] = []; for (const v of byAcc.values()) cl.push(v);
  return { claude: cl, codex };
}

// the price panel's extra entries: every shadow and correction of the merge (harness from the session key)
function panelMerge(): Exact | null {
  const c = FLEET.cfg; const hs = merged(); if (!c || !hs.length) return null;
  for (const rh of hs) if (rh.report && rh.report.exact) return exactMerge(hs, c.reprice, 30000, !TERM.tui); // cached: a signature compare (the TUI: a new merge runs in the tick's slices)
  return null;
}
PRICE_EXTRA.accs = (): SessAcc[] => {
  const o: SessAcc[] = []; const x = panelMerge(); if (!x) return o;
  for (const e of x.accs) { const i = e.key.indexOf(":"); o.push({ a: e.a, h: e.host && i > 0 ? e.key.slice(0, i) : "claude" }); }
  return o;
};
PRICE_EXTRA.gen = (): number => panelMerge() ? EX.gen : -1;
// ── registration: rows, freshness, the host filter key, remote projects ──
H.remoteRows.push((): Sess[] => {
  let o: Sess[] = [];
  for (const rh of merged()) o = o.concat(rh.rows);
  return o;
});
FRESH.ok = (host: string): boolean => { const rh = hostByName(host); return rh !== null && (rh.fresh || liveFresh(liveSrc(rh), Date.now())); };
// the filter's host names: this machine, the configured hosts and the hosts hub sources found (otlp-hub)
HOST_ENUM.values = (): string[] => { const c = FLEET.cfg; const o = [c ? c.localName : "local"]; if (c) for (const h of c.hosts) o.push(h.name); for (const rh of FLEET.hosts) if (o.indexOf(rh.cfg.name) < 0) o.push(rh.cfg.name); return o; };
REMOTE_IDENT.of = (s: Sess): Ident | null => {
  const o = OBJ.get(s.path); const r = o ? obj(o["repo"]) : null; if (!r) return null;
  return { key: str(r["key"]), label: str(r["label"]), kind: str(r["kind"]), top: str(r["top"]), common: "", gitdir: "", worktree: str(r["worktree"]), remote: str(r["remote"]), via: "remote", gone: false, unread: false };
};
export function newRemote(h: HostCfg, fd: HostFeed): RemoteHost {
  return { cfg: h, feed: fd, report: null, rows: [], okAt: 0, dupOf: "", alertsSeen: new Set<string>(), fresh: false, st: null, applied: null, beatAt: 0, live: new Map<string, LiveRow>(), mine: null, mineAt: 0, via: "", vkind: "", merged: false };
}
// the configured hosts (feeds made by the caller: the TUI and the CLI spawn differently)
export function setFleet(c: FleetCfg, localId: string, feeds: HostFeed[]): void {
  FLEET.cfg = c; FLEET.localId = localId; FLEET.intervalMs = c.refreshS * 1000; HOSTQ.local = c.localName;
  FLEET.hosts = [];
  for (let i = 0; i < c.hosts.length && i < feeds.length; i++) { const h = c.hosts[i]; const fd = feeds[i]; if (h && fd) FLEET.hosts.push(newRemote(h, fd)); }
  RG.gen++;
}
