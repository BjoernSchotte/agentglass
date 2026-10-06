// agentglass — the fleet's hosts (fleet spec 1, 7): reports → read-only rows, freshness, cross-host overlap, the fleet's
// cost, budget and allowance. The only module that knows hosts exist; the rows never enter the sessions map
// SPDX-License-Identifier: Apache-2.0
import { H } from "../../hooks.ts";
import { type Sess, newSess } from "../../model/types.ts";
import { FRESH, RG, sessions } from "../../model/sessions.ts";
import { type Obj, obj, str } from "../../util/json.ts";
import type { Ident } from "../../model/project.ts";
import { REMOTE_IDENT } from "../query/project.ts";
import { HOSTQ } from "../query/eval.ts";
import { HOST_ENUM } from "../query/attrs.ts";
import { type Bill, MODES } from "../usage/billing.ts";
import { type ModeSum, type BState, newSum, addSum, budgetState, monthStart } from "../usage/costs.ts";
import { type CostNow, type Ent, budget, costWith, sumDaysOf } from "../usage/summary.ts";
import { ledger } from "../usage/ledger.ts";
import { L, todayKey, lastDays } from "../usage/record.ts";
import { modeOf } from "../usage/bill-live.ts";
import { ownKeys, rowsFor } from "../usage/msgrows.ts";
import { type LocalLog, type FleetHost, type Exact, type Shadow, exactFleet, modeOfShadow } from "./merge.ts";
import type { HostCfg, FleetCfg } from "./config.ts";
import type { HostFeed, HostReport, FeedState, OwnRow, LiveRow } from "./model.ts";

// applied: the report rows were last built from (a round that changes nothing else keeps them)
// beatAt: the live stream's last beat (viewer clock, 0 = no stream), live: its newest state per session key (spec 16)
export interface RemoteHost { cfg: HostCfg; feed: HostFeed; report: HostReport | null; rows: Sess[]; okAt: number; dupOf: string; alertsSeen: Set<string>; fresh: boolean; st: FeedState | null; applied: HostReport | null; beatAt: number; live: Map<string, LiveRow> }
// localId: this machine's hostId(); intervalMs: the effective refresh interval (stretched while the TUI is unfocused)
export const FLEET = { hosts: [] as RemoteHost[], cfg: null as FleetCfg | null, localId: "", intervalMs: 60000 };
const OBJ = new Map<string, Obj>(); // remote row path → its --json object (preview, fleet --json)
export function rowObj(s: Sess): Obj | null { return s.host ? OBJ.get(s.path) ?? null : null; }
function num(v: unknown): number { return typeof v === "number" ? v as number : 0; }
export function remotePath(host: string, harness: string, id: string): string { return "@" + host + "/" + harness + ":" + id; }

// a report's sessions as rows (spec 7.1): pid 0, path "@host/harness:id" (never a file), head and tail done
export function rowsOf(h: string, r: HostReport, at: number): Sess[] {
  const out: Sess[] = [];
  const from = r.hello.now - Math.max(1, r.hello.days) * 86400000; // a snapshot carries the cost window's sessions: the list shows `days`
  for (const row of r.sessions) {
    const o = row.s; const harness = str(o["harness"]); const id = str(o["id"]);
    if (!harness || !id) continue;
    if (r.exact && o["live"] !== true && Date.parse(str(o["updated"])) < from) continue;
    const s = newSess(harness, id, remotePath(h, harness, id), false);
    s.host = h; s.rat = at; s.rlive = o["live"] === true; s.headDone = true; s.tailSize = 0;
    s.title = str(o["title"]) || "(no prompt yet)"; s.cwd = str(o["cwd"]); s.branch = str(o["branch"]); s.remote = str(o["remote"]); s.model = str(o["model"]);
    const t = Date.parse(str(o["updated"])); s.mtime = t > 0 ? t : 0; s.last = s.mtime; s.size = num(o["bytes"]);
    s.status = str(o["status"]); s.kind = str(o["kind"]);
    const tk = obj(o["tokens"]) ?? {}; s.inTok = num(tk["in"]); s.outTok = num(tk["out"]); s.cacheRTok = num(tk["cacheRead"]); s.cacheWTok = num(tk["cacheWrite"]);
    s.cost = typeof o["costUsd"] === "number" ? o["costUsd"] as number : -1;
    const b = obj(o["billing"]) ?? {}; s.bill = str(b["mode"]) || "unknown"; s.plan = str(b["plan"]); s.billSrc = str(b["source"]);
    s.unkTok = num(o["unpricedTokens"]); s.unkCr = num(o["unpricedCredits"]); s.tools = num(o["tools"]); s.linesAdd = num(o["linesAdded"]); s.linesDel = num(o["linesRemoved"]);
    s.attention = o["attention"] === true; s.stuck = str(o["stuck"]);
    OBJ.set(s.path, o);
    out.push(s);
  }
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
export function overlay(rh: RemoteHost, now: number): boolean {
  const on = liveFresh(rh, now); if (!rh.live.size && !on) return false;
  let moved = false;
  for (const s of rh.rows) {
    const l = on ? rh.live.get(s.h + ":" + s.id) ?? null : null; // the stream names every live session: one it does not name is not live
    const o = OBJ.get(s.path);
    const live = l ? l.live : on ? false : rh.fresh && !!o && o["live"] === true;
    const att = l ? l.attention || l.approval : rh.fresh && !!o && o["attention"] === true;
    const stk = l ? l.stuck : rh.fresh && o ? str(o["stuck"]) : "";
    if (s.rlive !== live || s.attention !== att || s.stuck !== stk) { s.rlive = live; s.attention = att; s.stuck = stk; moved = true; }
  }
  if (moved) RG.gen++;
  return moved;
}
// a new report for rh; ids = hostId → the name that holds it (this machine first, then earlier hosts): a report from this
// machine or from a host listed twice is not merged
export function applyReport(rh: RemoteHost, r: HostReport, at: number, ids: Map<string, string>): void {
  rh.report = r; rh.okAt = at;
  const c = FLEET.cfg; if (c) rh.fresh = freshOf(rh, Date.now(), c, FLEET.intervalMs);
  const prev = ids.get(r.hello.hostId);
  const dup = r.hello.hostId && prev !== undefined && prev !== rh.cfg.name ? prev : "";
  if (!dup && r.hello.hostId) ids.set(r.hello.hostId, rh.cfg.name);
  if (rh.applied === r && rh.dupOf === dup) return; // the same rows as last round
  for (const s of rh.rows) OBJ.delete(s.path);
  rh.dupOf = dup; rh.applied = r;
  if (dup) rh.rows = [];
  else { rh.rows = rowsOf(rh.cfg.name, r, at); markFresh(rh.rows, rh.fresh, rh.cfg.kind !== "dir"); overlay(rh, Date.now()); }
  RG.gen++;
}
// the duplicate map of a round: this machine, then every host in config order
export function idMap(): Map<string, string> {
  const m = new Map<string, string>(); const c = FLEET.cfg;
  if (FLEET.localId) m.set(FLEET.localId, c ? c.localName : "local");
  return m;
}
// all reports again in config order (a report that arrives late must not steal an earlier host's id)
export function reapply(): void {
  const ids = idMap();
  for (const rh of FLEET.hosts) if (rh.report) applyReport(rh, rh.report, rh.okAt, ids);
}
// fresh while its age ≤ 2 × interval + timeout (interval: the effective one, stretched while unfocused)
// a dir host: while its newest applied file is at most 2 × the writer's cadence + 10 min old (spec 15.4)
export function freshOf(rh: RemoteHost, now: number, f: FleetCfg, intervalMs: number): boolean {
  if (rh.report === null) return false;
  if (rh.cfg.kind === "dir") { const e = DIR_EVERY.get(rh.cfg.name) || DIR_EVERY_DEFAULT; return now - rh.okAt <= 2 * e + 600000; }
  return freshAt(rh.okAt, now, f, intervalMs);
}
export function freshAt(okAt: number, now: number, f: FleetCfg, intervalMs: number): boolean { return now - okAt <= 2 * intervalMs + f.timeoutS * 1000; }
// recomputes every host's freshness; true = one changed (rows re-marked, the view's signature moved)
export function syncFresh(now: number): boolean {
  const f = FLEET.cfg; if (!f) return false;
  let moved = false;
  for (const rh of FLEET.hosts) {
    const fr = freshOf(rh, now, f, FLEET.intervalMs);
    if (fr !== rh.fresh) { rh.fresh = fr; markFresh(rh.rows, fr, rh.cfg.kind !== "dir"); moved = true; }
    if (overlay(rh, now)) moved = true; // a stream that stopped beating: its states fall back to the report's
  }
  if (moved) RG.gen++;
  return moved;
}
export function hostByName(name: string): RemoteHost | null { for (const rh of FLEET.hosts) if (rh.cfg.name === name) return rh; return null; }
// the hosts whose rows count: enabled, a report under 7 days old (older ones: fleet status only), not a duplicate
export const SHOWN_MS = 7 * 86400000;
export function merged(): RemoteHost[] { const o: RemoteHost[] = []; const now = Date.now(); for (const rh of FLEET.hosts) if (rh.cfg.enabled && rh.report && !rh.dupOf && now - rh.okAt <= SHOWN_MS) o.push(rh); return o; }
// "harness:id" keys present on 2+ hosts (this machine counts as one) where one of them is a Part A host: the same session
// read twice, which only the exact merge (exact reports, this machine) can tell apart (spec 7.2)
export function overlap(local: Sess[], hosts: RemoteHost[]): Set<string> {
  const seen = new Map<string, number>(); const loose = new Set<string>();
  const add = (k: string, set: Set<string>, exact: boolean): void => { if (!set.has(k)) { set.add(k); seen.set(k, (seen.get(k) ?? 0) + 1); if (!exact) loose.add(k); } };
  const l = new Set<string>(); for (const s of local) if (!s.parent) add(s.h + ":" + s.id, l, true);
  for (const rh of hosts) { const m = new Set<string>(); const ex = !!rh.report && rh.report.exact; for (const s of rh.rows) add(s.h + ":" + s.id, m, ex); }
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
// exact: the exact merge priced it (some host delivered exact reports); removed: copies taken out across hosts
export interface FleetCost { today: ModeSum; week: ModeSum; month: ModeSum; projByMode: number[]; approx: boolean; marked: boolean; perHost: HostCost[]; exact: boolean; removed: number }
function tot(m: ModeSum): number { let t = 0; for (const c of m.by) t += c; return t; }
// ── the exact merge (spec 13): local Claude logs and every exact report, cached until a report or the ledger moves ──
const EX = { at: 0, ver: -1, sig: "", x: null as Exact | null };
function localLogs(): LocalLog[] {
  const out: LocalLog[] = [];
  for (const s of sessions.values()) {
    if (s.h !== "claude") continue;
    const a = ledger.get(s.path); if (!a) continue;
    let top = s; for (let g = 0; top.parent && g < 8; g++) { const p = sessions.get(top.parent); if (!p) break; top = p; }
    out.push({ path: s.path, skey: top.h + ":" + top.id, keys: ownKeys(s.path, a), bill: modeOf(s, "") });
  }
  return out;
}
function localRows(path: string): OwnRow[] | null { const a = ledger.get(path); if (!a) return null; const r = rowsFor(path, "claude", a); return r.ok ? r.rows : null; }
function localShift(hostTz: number): number { return -new Date().getTimezoneOffset() - hostTz; }
// maxAgeMs: how long a result may be reused while only the local ledger moved (the TUI: 30 s; a CLI run: always fresh)
export function exactMerge(hosts: RemoteHost[], reprice: boolean, maxAgeMs: number): Exact {
  const now = Date.now(); const fh: FleetHost[] = []; const sig: string[] = [reprice ? "r" : "n"];
  for (const rh of hosts) { const r = rh.report; if (!r || !r.exact) continue; fh.push({ name: rh.cfg.name, hostId: r.hello.hostId, r, shiftMin: localShift(r.hello.tzOffsetMin) }); sig.push(rh.cfg.name + "@" + String(rh.okAt) + "#" + String(r.hello.now)); }
  const sg = sig.join("|"); const hit = EX.x;
  if (hit && sg === EX.sig && (EX.ver === L.ver || now - EX.at < maxAgeMs)) return hit;
  const x = exactFleet(localLogs(), FLEET.localId, fh, reprice, localRows);
  EX.at = now; EX.ver = L.ver; EX.sig = sg; EX.x = x;
  return x;
}
export function entOf(x: Shadow): Ent { return { a: x.a, mode: (p: string): Bill => modeOfShadow(x, p) }; }
function sumHost(es: Ent[], days: string[]): number { return tot(sumDaysOf(es, days)); }
// this machine's figures plus each merged host's: exact reports through the merge (one table, this machine's days), Part A
// reports as their own cost objects (each host's table and day boundaries)
export function fleetCost(localNow0: CostNow, hosts: RemoteHost[], now: number, f: FleetCfg, ov: number, maxAgeMs = 0): FleetCost {
  let exactN = 0; for (const rh of hosts) if (rh.report && rh.report.exact) exactN++;
  const x = exactN ? exactMerge(hosts, f.reprice, maxAgeMs) : null;
  const ents: Ent[] = []; if (x) for (const s of x.accs) ents.push(entOf(s));
  const localNow = x ? costWith(ents) : localNow0;
  const today = newSum(); const week = newSum(); const month = newSum(); const proj: number[] = [];
  addSum(today, localNow.today); addSum(week, localNow.week); addSum(month, localNow.month);
  let approx = ov > 0 || (!!x && x.inexact.length > 0); let marked = approx;
  for (let i = 0; i < MODES.length; i++) { const p = localNow.projByMode[i]; const v = p ? p.month : -1; proj.push(v >= 0 ? v : localNow.month.by[i] ?? 0); if (v < 0 && (localNow.month.by[i] ?? 0) > 0) approx = true; }
  const td = [todayKey()]; const wk = lastDays(7); const mk = monthStart(now);
  const by = (host: string): Ent[] => { const o: Ent[] = []; if (x) for (const s of x.accs) if (s.host === host) o.push(entOf(s)); return o; };
  const lc = by("");
  const per: HostCost[] = [{ name: f.localName, today: tot(localNow0.today) + sumHost(lc, td), week: tot(localNow0.week) + sumHost(lc, wk), month: tot(localNow0.month) + sumHost(lc, mk), age: 0, stale: false, local: true }];
  for (const rh of hosts) {
    const r = rh.report; if (!r) continue;
    if (r.exact && x) {
      const stale = !freshOf(rh, now, f, FLEET.intervalMs); if (stale) { approx = true; marked = true; }
      const es = by(rh.cfg.name);
      per.push({ name: rh.cfg.name, today: sumHost(es, td), week: sumHost(es, wk), month: sumHost(es, mk), age: now - rh.okAt, stale, local: false });
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
  return { today, week, month, projByMode: proj, approx, marked, perHost: per, exact: !!x, removed: x ? x.removed + x.corrected : 0 };
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

// ── registration: rows, freshness, the host filter key, remote projects ──
H.remoteRows.push((): Sess[] => {
  let o: Sess[] = [];
  for (const rh of merged()) o = o.concat(rh.rows);
  return o;
});
FRESH.ok = (host: string): boolean => { const rh = hostByName(host); return rh !== null && (rh.fresh || liveFresh(rh, Date.now())); };
HOST_ENUM.values = (): string[] => { const c = FLEET.cfg; const o = [c ? c.localName : "local"]; if (c) for (const h of c.hosts) o.push(h.name); return o; };
REMOTE_IDENT.of = (s: Sess): Ident | null => {
  const o = OBJ.get(s.path); const r = o ? obj(o["repo"]) : null; if (!r) return null;
  return { key: str(r["key"]), label: str(r["label"]), kind: str(r["kind"]), top: str(r["top"]), common: "", gitdir: "", worktree: str(r["worktree"]), remote: str(r["remote"]), via: "remote", gone: false, unread: false };
};
// the configured hosts (feeds made by the caller: the TUI and the CLI spawn differently)
export function setFleet(c: FleetCfg, localId: string, feeds: HostFeed[]): void {
  FLEET.cfg = c; FLEET.localId = localId; FLEET.intervalMs = c.refreshS * 1000; HOSTQ.local = c.localName;
  FLEET.hosts = [];
  for (let i = 0; i < c.hosts.length && i < feeds.length; i++) { const h = c.hosts[i]; const fd = feeds[i]; if (h && fd) FLEET.hosts.push({ cfg: h, feed: fd, report: null, rows: [], okAt: 0, dupOf: "", alertsSeen: new Set<string>(), fresh: false, st: null, applied: null, beatAt: 0, live: new Map<string, LiveRow>() }); }
  RG.gen++;
}
