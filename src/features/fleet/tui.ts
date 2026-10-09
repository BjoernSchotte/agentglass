// agentglass — the fleet in the TUI (fleet spec 8): pulls on the tick's cadence, other hosts' rows with a host tag, the
// header segment, the Stats fleet line and cost widget, the remote preview, alerts, palette actions, help
// SPDX-License-Identifier: Apache-2.0
import { H } from "../../hooks.ts";
import { S, say } from "../../state.ts";
import type { Sess } from "../../model/types.ts";
import { sessions, current, FRESH, SG } from "../../model/sessions.ts";
import { REMOTE } from "../../model/remote.ts";
import { AWAY } from "../../sched.ts";
import { type Obj, obj, str, arr } from "../../util/json.ts";
import { ago, vwidth, fit, fitStyled, fillTo, clean, home } from "../../util/text.ts";
import { hostId } from "../../util/hostid.ts";
import { CONFIG_FILE } from "../../util/config.ts";
import { detachedPid } from "../../platform/posix.ts";
import { C, CSI, RST, fg } from "../../ui/theme.ts";
import { put, box } from "../../ui/screen.ts";
import type { Ctx } from "../../hooks.ts";
import { addActions } from "../palette/actions.ts";
import { type Allow, asBill } from "../usage/billing.ts";
import { type RlWin, L } from "../usage/record.ts";
import { type HostRow, SKILL_FLEET, hostRows } from "../skills/fleet.ts";
import { kfmt, grp, moneyTag } from "../usage/costs.ts";
import { type CostNow, costNow } from "../usage/summary.ts";
import { allowanceInfo, codexWins } from "../usage/bill-live.ts";
import { type FleetHdr, FLEET_HOOK } from "../usage/stats.ts";
import { type FleetCfg, type HostCfg, loadFleet, fleetOn, hostNamed, openCmd } from "./config.ts";
import type { HostReport } from "./model.ts";
import { type RemoteHost, type Progress, FLEET, setFleet, reapply, syncFresh, merged, overlap, fleetCost, fleetBudget, fleetAllowance, freshOf, freshAt, rowObj, hostByName, overlay, liveFresh, primaryOf, watcher, mergeMs, mergeGen, merged0, merging, mergeTick, exactMerge, skillSets } from "./hosts.ts";
import { sshBin, hostControlPath } from "./ssh.ts";
import { forget, keyOf } from "./store.ts";
import { makeFeeds, hostStatus, statusLines, redactOf, MAX_PARALLEL } from "./cli.ts";
import { type WatchFeed, type WatchEv, watchFeed } from "./watchfeed.ts";
import { OS } from "../../platform/index.ts";
import { DEBUG_PARTS } from "../../util/selfmem.ts";
import { MSTAT } from "./merge.ts";

// on: hosts configured and this run pulls; force: the palette's "refresh now"; due/fails/doneAt per host name
// rgen: bumped by a new report or a freshness change (the fleet figures follow it; gen also follows the live stream)
const T = { rgen: 0, fsig: "", on: false, force: false, due: new Map<string, number>(), fails: new Map<string, number>(), busy: new Map<string, boolean>(), seeded: new Set<string>(), gen: 0, nossh: false };
export const BACKOFF_MS = [30000, 60000, 120000, 240000, 480000, 900000];
// the interval a host is pulled at: refreshSeconds, at least 300 s while nobody looks
export function intervalMs(c: FleetCfg, away: boolean): number { return (away ? Math.max(c.refreshS, 300) : c.refreshS) * 1000; }
// after n failures in a row: 30 s doubling to 15 min (0 = none)
export function backoffMs(n: number): number { return n <= 0 ? 0 : BACKOFF_MS[Math.min(n, BACKOFF_MS.length) - 1] ?? 900000; }
// when a host is next due: interval after its last finished pull, the backoff after a failure
export function nextDue(doneAt: number, ok: boolean, fails: number, interval: number): number { return doneAt + (ok ? interval : backoffMs(fails)); }

// ── alerts: a transition seen in a new report toasts once (host|session|rule|severity|since) ──
// (keyed by the host id when the report has one: two feeds of one host toast its alarm once)
export function alertKeys(host: string, r: HostReport): { key: string; msg: string }[] {
  const out: { key: string; msg: string }[] = []; const hk = r.hello.hostId || host;
  for (const row of r.sessions) for (const a of arr(row.s["alerts"])) {
    const o = obj(a); if (!o || o["acked"] === true) continue;
    out.push({ key: hk + "|" + row.key + "|" + str(o["rule"]) + "|" + str(o["severity"]) + "|" + str(o["since"]), msg: host + " · " + str(row.s["title"]) + ": " + str(o["message"]) });
  }
  return out;
}
// the toasts of a new report: alerts not seen before (the first report of a host only seeds: old alarms stay quiet)
// (another feed of a host toasts under the host's entry and shares its seen set)
export function newAlerts(rh: RemoteHost, r: HostReport, seed: boolean): string[] {
  const msgs: string[] = []; const p = primaryOf(rh); const seen = p.alertsSeen;
  for (const k of alertKeys(p.cfg.name, r)) { if (seen.has(k.key)) continue; seen.add(k.key); if (!seed) msgs.push(k.msg); }
  if (seen.size > 5000) seen.clear();
  return msgs;
}

// ── the tick ──
function init(): void {
  const c = loadFleet();
  for (const w of c.warns) say("warn", "config " + w);
  if (!fleetOn(c)) return;
  T.on = true;
  let ssh = false; for (const h of c.hosts) if (h.enabled && h.kind === "ssh") ssh = true;
  if (ssh && !sshBin()) { T.nossh = true; say("warn", "fleet needs ssh (AGENTGLASS_SSH): hosts are not pulled"); }
  const names: string[] = []; for (const h of c.hosts) names.push(h.name);
  forget(names);
  setFleet(c, hostId(), makeFeeds(c, detachedPid, 256)); // ≤ 256 parsed lines per host and tick
}
function tick(): void {
  const c = FLEET.cfg; if (!T.on || !c) return;
  const now = Date.now(); FLEET.intervalMs = intervalMs(c, AWAY.on);
  let fresh = false; let running = 0; const toasts: string[] = [];
  for (const rh of FLEET.hosts) {
    if (!rh.cfg.enabled || (rh.cfg.kind !== "ssh" && rh.cfg.kind !== "dir" && rh.cfg.kind !== "otlp")) continue; // otlp: the hosts hub sources found (syncHubs; no pulls)
    const st = rh.feed.poll(now); rh.st = st; const n = rh.cfg.name;
    if ((st.code === "dir" || st.code === "nossh") && !T.seeded.has(st.code)) { T.seeded.add(st.code); say("warn", "fleet: " + st.err); } // no pulls at all: say why once
    if (st.busy) { running++; T.busy.set(n, true); continue; }
    if (T.busy.get(n)) { // a pull finished: the next one is due an interval later, or after the backoff
      T.busy.set(n, false);
      const ok = st.code === "ok"; const f = ok ? 0 : (T.fails.get(n) ?? 0) + 1; T.fails.set(n, f);
      T.due.set(n, nextDue(now, ok, f, FLEET.intervalMs));
    }
    if (st.report && st.report !== rh.mine) {
      const seed = !T.seeded.has(n); T.seeded.add(n);
      for (const m of newAlerts(rh, st.report, seed || rh.cfg.kind === "dir" || !freshAt(st.okAt, now, c, FLEET.intervalMs))) toasts.push(m); // a stale report (the cache at start) and a drop (minutes old) only seed
      rh.mine = st.report; rh.mineAt = st.okAt; fresh = true;
      if (!T.due.has(n)) T.due.set(n, st.okAt + FLEET.intervalMs); // a cached report: the next pull when it would be due
    }
  }
  if (fresh) { reapply(); for (const rh of FLEET.hosts) if (rh.dupOf && !rh.merged && !T.seeded.has("dup:" + rh.cfg.name)) { T.seeded.add("dup:" + rh.cfg.name); say("warn", "fleet host " + rh.cfg.name + " is the same machine as " + rh.dupOf + ": not merged (agentglass fleet status)"); } }
  if (syncFresh(now) || fresh) { T.gen++; S.dirty = true; }
  let fs = ""; for (const rh of FLEET.hosts) fs += rh.fresh ? "1" : "0";
  if (fresh || fs !== T.fsig) { T.fsig = fs; T.rgen++; } // what the fleet figures depend on moved: a report, a host's freshness
  for (const m of toasts.slice(-3)) say("warn", m); // a burst after a long gap: the last ones
  if (T.nossh) return;
  const force = T.force; T.force = false;
  for (const rh of FLEET.hosts) { // due hosts, at most MAX_PARALLEL at once, the longest-waiting first
    if (running >= MAX_PARALLEL) break;
    if (!rh.cfg.enabled || rh.cfg.kind !== "ssh" || T.busy.get(rh.cfg.name)) continue;
    if (!force && now < (T.due.get(rh.cfg.name) ?? 0)) continue;
    if (rh.feed.start(now) || rh.feed.poll(now).busy) { running++; T.busy.set(rh.cfg.name, true); }
    else { const f = (T.fails.get(rh.cfg.name) ?? 0) + 1; T.fails.set(rh.cfg.name, f); T.due.set(rh.cfg.name, nextDue(now, false, f, FLEET.intervalMs)); }
  }
}
// ── the live stream (spec 16): per host with watch: true once it delivered an exact report (its agentglass has fleet watch) ──
const WF = new Map<string, WatchFeed>();
const NOTIFIED = new Set<string>(); const TURN_AT = new Map<string, number>(); const SPOLL = new Map<string, number>();
export const TURN_SOON_MS = 5000; export const TURN_GAP_MS = 10000;
// a closed remote turn moved its costs: the host's next snapshot within 5 s, at most one per 10 s
export function turnDue(due: number, now: number, lastTurn: number): number { const t = Math.max(now + TURN_SOON_MS, lastTurn + TURN_GAP_MS); return Math.min(due, t); }
// the toast of an alert line and whether it goes to the desktop: critical fire/escalate, once per host|key|rule|at
export function alertOut(host: string, title: string, a: Obj, seen: Set<string>): { msg: string; notify: boolean } {
  const msg = host + " · " + (title || str(a["key"])) + ": " + str(a["message"]);
  const st = str(a["state"]); const k = host + "|" + str(a["key"]) + "|" + str(a["rule"]) + "|" + String(a["at"] ?? "");
  const crit = str(a["severity"]) === "critical" && (st === "fire" || st === "escalate");
  if (!crit || seen.has(k)) return { msg, notify: false };
  seen.add(k); if (seen.size > 5000) seen.clear();
  return { msg, notify: true };
}
function titleOf(rh: RemoteHost, key: string): string { for (const s of rh.rows) if (s.h + ":" + s.id === key) return s.title; return ""; }
function streams(now: number): boolean {
  let moved = false;
  for (const rh of FLEET.hosts) {
    const c = rh.cfg;
    if (!watcher(rh)) { const w = WF.get(c.name); if (w) { w.stop(); WF.delete(c.name); rh.beatAt = 0; } continue; } // one stream per host: its first exact ssh feed
    const p = primaryOf(rh);
    let w = WF.get(c.name);
    if (!w) { w = watchFeed(c, keyOf(c.name, redactOf(c)), redactOf(c), hostControlPath(c), detachedPid); WF.set(c.name, w); }
    if (!w.running()) w.start(now);
    if (now - (SPOLL.get(c.name) ?? 0) < 1000) continue; // the stream is read once a second (its lines are state, not events)
    SPOLL.set(c.name, now);
    const ev: WatchEv = w.poll(now); const was = liveFresh(rh, now); rh.beatAt = w.beatAt();
    for (const l of ev.rows) rh.live.set(l.key, l);
    if (rh.live.size > 5000) rh.live.clear();
    if (was !== liveFresh(rh, now)) { if (overlay(p, now)) moved = true; } // the host's rows (another feed's entry may show them)
    else if (ev.rows.length) { const ks: string[] = []; for (const l of ev.rows) ks.push(l.key); if (overlay(p, now, ks)) moved = true; }
    for (const a of ev.alerts) {
      const o = alertOut(p.cfg.name, titleOf(p, str(a["key"])), a, NOTIFIED);
      say(o.notify ? "err" : "warn", o.msg);
      if (o.notify && process.env["AGENTGLASS_NOTIFY"] !== "0") OS.notify("agentglass", p.cfg.name + " · " + str(a["rule"]), o.msg);
    }
    if (ev.turns.length && !T.busy.get(c.name)) { const lt = TURN_AT.get(c.name) ?? 0; const d = turnDue(T.due.get(c.name) ?? now + FLEET.intervalMs, now, lt); T.due.set(c.name, d); TURN_AT.set(c.name, d); }
  }
  return moved;
}
// the debug footer's fleet part (AGENTGLASS_DEBUG_REFRESH=1): ms spent per 10 s in the feeds (t), the streams (s), the
// figures (m: of which merging and summing)
const FD = { t: 0, s: 0, m: 0, at: 0, line: "" };
function fdRoll(now: number): void { if (!FD.at) FD.at = now; if (now - FD.at < 10000) return; const mm = mergeMs(); FD.line = "fleet " + String(Math.round(FD.t)) + "/" + String(Math.round(FD.s)) + "/" + String(Math.round(FD.m)) + " (merge " + String(mm[0] ?? 0) + " ≤" + String(mm[2] ?? 0) + ", sums " + String(mm[1] ?? 0) + " ≤" + String(mm[3] ?? 0) + ")ms/10s · index " + String(MSTAT.full) + " built " + String(MSTAT.grown) + " grown"; FD.t = 0; FD.s = 0; FD.m = 0; FD.at = now; }
DEBUG_PARTS.push((): string => T.on ? FD.line : "");
H.start.push(init);
H.onTick.push((): void => { const t0 = Date.now(); tick(); const t1 = Date.now(); FD.t += t1 - t0; fdRoll(t1); });
H.onTick.push((): void => { if (!T.on || T.nossh) return; const t0 = Date.now(); if (streams(t0)) { T.gen++; S.dirty = true; } FD.s += Date.now() - t0; });
H.onQuit.push((): void => { for (const rh of FLEET.hosts) rh.feed.stop(); for (const w of WF.values()) w.stop(); }); // running pulls and streams: shared ssh masters persist (fleet status --close)
// ── the exact merge in slices (fleet follow-ups): ≤ 50 ms a tick (12 ms while typing), the tick at the indexing burst
// cadence meanwhile; the figures follow when it is done ──
export const MERGE_SLICE_MS = 50;
const MG = { chip: "" }; // the chip last drawn (a new percent repaints)
H.onTick.push((): void => {
  if (!T.on) return;
  const t0 = Date.now(); if (!merging(t0)) return;
  if (mergeTick(t0 + (S.mode === "input" ? 12 : MERGE_SLICE_MS))) { T.rgen++; MG.chip = ""; S.dirty = true; }
  else { const c = mergeChip(Date.now()); if (c !== MG.chip) { MG.chip = c; S.dirty = true; } }
  FD.m += Date.now() - t0;
});
H.backlog.push((): boolean => T.on && merging(Date.now()) !== null);
// "merging 34%" while a merge runs: the first one (until then the exact hosts count as their own cost objects, marked ≈),
// or a later one that takes more than a second (a price change re-prices every entry); "" otherwise
export function mergeText(p: Progress | null, have: boolean): string { return p && (!have || p.ms >= 1000) ? "merging " + String(Math.min(99, Math.floor(p.done * 100 / p.total))) + "%" : ""; }
function mergeChip(now: number): string { return T.on ? mergeText(merging(now), merged0()) : ""; }

// ── rows: the host tag before the title ──
// ≈ after it (local rows: alone) when the session is also on another host: its cost may count twice (spec 7.2)
export function hostTag(s: Sess): string {
  const ov = T.on && FN.ov.size > 0 && FN.ov.has(s.h + ":" + s.id) ? fg(C.yellow) + "≈" + RST : "";
  if (!s.host) return ov ? ov + " " : "";
  return fg(FRESH.ok(s.host) ? C.accent : C.dim) + s.host.slice(0, 4) + RST + ov + " ";
}
H.rowPrefix.push(hostTag);
REMOTE.hint = (s: Sess): string => sshHint(s);
// a host of a hub source (otlp-hub) pushes its export: nothing here can reach it, so no command is offered
export function hubHost(name: string): boolean { const rh = hostByName(name); return !!rh && rh.cfg.kind === "otlp"; }
export const HUB_OPEN = "open it on that host: it pushes to the hub, nothing reaches it from here";
export function sshHint(s: Sess): string {
  if (hubHost(s.host)) return HUB_OPEN;
  const h = FLEET.cfg ? hostNamed(FLEET.cfg, s.host) : null;
  return openCmd(h ?? { name: s.host, ssh: s.host, agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "", snapshot: true, watch: true }, s.h + ":" + s.id);
}

// ── fleet figures for the header and Stats (cached per rows generation and 5 s) ──
// est: the exact hosts' figures are their own cost objects (no merge result yet): every host's figure is marked ≈
interface FleetNow { at: number; gen: number; xg: number; cn: CostNow | null; hdr: FleetHdr | null; ov: Set<string>; per: { name: string; usd: number; wk: number; stale: boolean; age: number; local: boolean }[]; approx: boolean; est: boolean }
const OV = { k: "", v: new Set<string>() };
const FN: FleetNow = { at: 0, gen: -1, xg: -1, cn: null, hdr: null, ov: new Set<string>(), per: [], approx: false, est: false };
function fleetNow(cn: CostNow): FleetNow {
  const now = Date.now(); const c = FLEET.cfg;
  const away = AWAY.on; // nobody looks: the fleet figures follow a minute behind, the merge every 5 minutes (a report still merges at once)
  if (!c || (FN.gen === T.rgen && FN.xg === mergeGen() && (away || FN.cn === cn) && now - FN.at < (away ? 60000 : 5000))) return FN;
  const hs = merged();
  const ok = String(FLEET.rowsGen) + "|" + String(sessions.size) + "|" + String(SG.gen);
  if (OV.k !== ok) { OV.k = ok; const loc: Sess[] = []; for (const s of sessions.values()) if (!s.parent) loc.push(s); OV.v = overlap(loc, hs); } // the session sets moved
  const ov = OV.v; const fc = fleetCost(cn, hs, now, c, ov.size, away ? 300000 : 30000, false); const bs = fleetBudget(fc); FD.m += Date.now() - now;
  FN.at = now; FN.gen = T.rgen; FN.xg = mergeGen(); FN.cn = cn; FN.ov = ov; FN.approx = fc.approx; FN.est = !fc.exact && fc.merging !== null;
  FN.hdr = { today: fc.today, state: bs.state, approx: fc.marked };
  FN.per = fc.perHost.map((p) => ({ name: p.name, usd: p.today, wk: p.week, stale: p.stale, age: p.age, local: p.local }));
  return FN;
}
FLEET_HOOK.header = (cn: CostNow): FleetHdr | null => T.on && merged().length ? fleetNow(cn).hdr : null;
FLEET_HOOK.line = (w: number, week: boolean): string => {
  if (!T.on) return "";
  const f = fleetNow(costNow("")); const usd = (x: number): string => "$" + (x < 1000 ? x.toFixed(2) : grp(x));
  const parts: string[] = [];
  for (const p of f.per) parts.push(fg(p.local ? C.text : C.accent) + p.name + RST + " " + fg(C.yellow) + (p.stale || (f.est && !p.local) ? "≈" : "") + usd(week ? p.wk : p.usd) + RST + (p.stale ? fg(C.dim) + " (" + ago(Date.now() - p.age) + " old)" + RST : ""));
  for (const rh of FLEET.hosts) if (rh.cfg.enabled && (rh.cfg.kind === "ssh" || rh.cfg.kind === "dir") && !rh.report) parts.push(fg(C.dim) + rh.cfg.name + " —" + RST);
  const mc = mergeChip(Date.now());
  let l = fg(C.dim) + "fleet  " + RST + (mc ? fg(C.yellow) + mc + RST + fg(C.dim) + " · " + RST : "") + parts.join(fg(C.dim) + " · " + RST);
  if (f.ov.size) l += fg(C.dim) + " · " + RST + fg(C.yellow) + String(f.ov.size) + " session" + (f.ov.size === 1 ? "" : "s") + " on 2+ hosts ≈" + RST;
  return vwidth(l) <= w ? l : fitStyled(l, w);
};
// allowance across hosts: per account the newest fetch (the fullest account shows), Codex the newest event. Per rows
// generation and 5 s, as the cost figures: the header draws every frame, and this machine's part stats ~/.claude.json
const AL = { at: 0, gen: -1, claude: null as Allow | null, codex: null as RlWin[] | null };
function allowNow(): void {
  const now = Date.now(); if (AL.gen === T.rgen && now - AL.at < 5000) return;
  AL.at = now; AL.gen = T.rgen; const hs = merged();
  AL.claude = hs.length ? claudeOf(hs, now) : null; AL.codex = hs.length ? codexOf(hs) : null;
}
FLEET_HOOK.claude = (): Allow | null => { if (!T.on) return null; allowNow(); return AL.claude; };
FLEET_HOOK.codex = (): RlWin[] | null => { if (!T.on) return null; allowNow(); return AL.codex; };
// skill-usage 6.15: the Stats skills panel's host column (one table per merge, ledger version, days and sort: the panel
// asks every frame); the TUI takes the last finished merge (a new one runs in the tick's slices)
const SKF = { sig: "", rows: [] as HostRow[] };
SKILL_FLEET.on = (): boolean => T.on && merged().length > 0;
SKILL_FLEET.rows = (days: string[] | null, by: string): HostRow[] => {
  const c = FLEET.cfg; const hs = merged(); if (!c || !hs.length) return [];
  let exact = false; for (const rh of hs) if (rh.report && rh.report.exact) exact = true;
  const x = exact ? exactMerge(hs, c.reprice, 30000, false) : null;
  const sig = String(mergeGen()) + "|" + String(L.ver) + "|" + (days ? days.join(",") : "all") + "|" + by + "|" + hs.map((rh: RemoteHost) => rh.cfg.name + "@" + String(rh.okAt)).join(",") + "|" + String(x !== null);
  if (sig === SKF.sig) return SKF.rows;
  SKF.sig = sig; SKF.rows = hostRows(skillSets(hs, x, c.localName, days), days, by);
  return SKF.rows;
};
function claudeOf(hs: RemoteHost[], now: number): Allow | null {
  const a = fleetAllowance(allowanceInfo(now), hs); if (!a) return null;
  let best: Allow | null = null; let top = -1;
  for (const v of arr(a["claude"])) {
    const o = obj(v); if (!o) continue;
    const w = (x: unknown): { pct: number; reset: number } | null => { const q = obj(x); if (!q) return null; const r = typeof q["reset"] === "number" ? q["reset"] as number : 0; return r > now ? { pct: typeof q["pct"] === "number" ? q["pct"] as number : 0, reset: r } : null; };
    const h5 = w(o["h5"]); const d7 = w(o["d7"]); if (!h5 && !d7) continue;
    const m = Math.max(h5 ? h5.pct : 0, d7 ? d7.pct : 0);
    if (m > top) { top = m; best = { h5, d7, hi: h5 && (!d7 || h5.pct > d7.pct) ? "5h" : "7d" }; }
  }
  return best;
}
function codexOf(hs: RemoteHost[]): RlWin[] | null {
  const a = fleetAllowance({ claude: null, codex: codexWins() }, hs); const x = a ? obj(a["codex"]) : null; if (!x) return null;
  const ws: RlWin[] = []; for (const v of arr(x["wins"])) { const o = obj(v); if (o) ws.push({ pct: typeof o["pct"] === "number" ? o["pct"] as number : 0, min: typeof o["min"] === "number" ? o["min"] as number : 0, reset: typeof o["reset"] === "number" ? o["reset"] as number : 0 }); }
  return ws.length ? ws : null;
}

// ── header: "· 3 hosts" (this machine included), problems after it; narrow drops the details, then the segment ──
export interface HostMark { name: string; stale: boolean; ageMs: number; down: boolean }
// mg: the merge's progress chip ("merging 34%", "" = none): kept before the host marks while it fits
export function headerSeg(n: number, marks: HostMark[], w: number, nossh: boolean, mg = ""): string {
  if (nossh) { const t = fg(C.dim) + " · " + RST + fg(C.yellow) + "hosts: no ssh" + RST; return vwidth(t) <= w ? t : ""; }
  const base0 = fg(C.dim) + " · " + String(n) + " hosts" + RST;
  const base = mg && vwidth(base0) + 3 + vwidth(mg) <= w ? base0 + fg(C.dim) + " · " + RST + fg(C.yellow) + mg + RST : base0;
  let full = base;
  for (const m of marks) full += fg(C.dim) + " · " + RST + (m.down ? fg(C.red) + m.name + " ✗" : fg(C.yellow) + m.name + " stale " + ago(Date.now() - m.ageMs)) + RST;
  if (vwidth(full) <= w) return full;
  return vwidth(base) <= w ? base : vwidth(base0) <= w ? base0 : "";
}
function marks(now: number): HostMark[] {
  const c = FLEET.cfg; const o: HostMark[] = []; if (!c) return o;
  for (const rh of FLEET.hosts) {
    if (!rh.cfg.enabled || !counted(rh) || rh.dupOf) continue;
    if (!rh.report) { if (rh.st && rh.st.code && rh.st.code !== "ok") o.push({ name: rh.cfg.name, stale: false, ageMs: 0, down: true }); continue; }
    if (!freshOf(rh, now, c, FLEET.intervalMs)) o.push({ name: rh.cfg.name, stale: true, ageMs: now - rh.okAt, down: false });
  }
  return o;
}
// the hosts the header counts and marks: ssh and dir hosts, and the hosts a hub source found (a source entry itself
// never has a report of its own: it is a directory, not a host)
function counted(rh: RemoteHost): boolean { return rh.cfg.kind === "ssh" || rh.cfg.kind === "dir" || (rh.cfg.kind === "otlp" && rh.mine !== null); }
H.headerWidgets.push((w: number): string => {
  if (!T.on || !FLEET.cfg || w < 24) return ""; // narrow: the cost widget before it keeps its place (the tabs turn to numbers for it)
  let n = 1; for (const rh of FLEET.hosts) if (rh.cfg.enabled && counted(rh) && !rh.dupOf) n++;
  return headerSeg(n, marks(Date.now()), w, T.nossh, mergeChip(Date.now()));
});

// ── the preview of a remote row: its report's facts and the command that opens it on the host ──
H.remoteCard.push((s: Sess, w: number): string[] => {
  const o = rowObj(s); const rh = hostByName(s.host); const c = FLEET.cfg;
  const k = (t: string): string => fg(C.dim) + fit(t, 9) + RST;
  const fresh = FRESH.ok(s.host); const out: string[] = [];
  const h: HostCfg | null = c ? hostNamed(c, s.host) : null;
  out.push(k("host") + fg(C.accent) + s.host + RST + fg(C.dim) + (h ? " · ssh " + h.ssh : "") + " · report " + (rh ? ago(rh.okAt) + " ago" : "—") + (fresh ? "" : " · stale") + RST);
  if (hubHost(s.host)) out.push(k("open") + fg(C.dim) + "on " + s.host + " itself — a hub host pushes its export; nothing reaches it from here" + RST);
  else out.push(k("open") + fg(C.text) + sshHint(s) + RST + fg(C.dim) + "  (the transcript is on " + s.host + ")" + RST); // one line, second: a short preview still shows it
  const state = !fresh ? "unknown (stale report)" : s.rlive ? (s.status === "busy" ? "running · busy" : "running") : "not running";
  out.push(k("process") + (fresh && s.rlive ? fg(C.green) : fg(C.dim)) + state + RST);
  const ov = FN.ov.has(s.h + ":" + s.id);
  const cost = s.cost < 0 ? fg(C.dim) + "cost ?" : fg(C.yellow) + moneyTag(s.cost, asBill(s.bill)) + (ov ? " ≈" : "");
  out.push(k("usage") + fg(C.cyan) + "↑" + kfmt(s.inTok) + " " + RST + fg(C.purple) + "↓" + kfmt(s.outTok) + " " + RST + fg(C.accent) + "↻" + kfmt(s.cacheRTok + s.cacheWTok) + RST + fg(C.dim) + " · " + RST + cost + RST +
    fg(C.dim) + " · " + RST + fg(C.text) + grp(s.tools) + RST + fg(C.sub) + " tools" + RST + fg(C.dim) + " · " + RST + fg(C.green) + "+" + grp(s.linesAdd) + RST + " " + fg(C.red) + "−" + grp(s.linesDel) + RST);
  if (ov) out.push(k("") + fg(C.yellow) + "≈ this session is also on another host: its cost may count twice" + RST);
  if (fresh && o) for (const a of arr(o["alerts"])) { const x = obj(a); if (x) out.push(k("alert") + (str(x["severity"]) === "critical" ? fg(C.red) : fg(C.yellow)) + clean(str(x["message"])) + RST); }
  if (fresh && s.stuck) out.push(k("stuck") + fg(C.red) + clean(s.stuck) + RST);
  return out.map((l: string) => fitStyled(l, w));
});

// ── fleet status as a full-screen view ──
const VIEW = "fleet status";
const V = { lines: [] as string[], scroll: 0 };
function openStatus(): void {
  const c = FLEET.cfg; if (!c) { say("info", "no fleet hosts: add \"fleet\": {\"hosts\": [{\"name\": \"ws\", \"ssh\": \"…\"}]} to " + home(CONFIG_FILE)); return; }
  const loc: Sess[] = []; for (const s of sessions.values()) if (!s.parent) loc.push(s);
  const ov = overlap(loc, merged()); const now = Date.now();
  const xs = FLEET.hosts.map((rh: RemoteHost) => hostStatus(rh, now, ov));
  V.lines = statusLines(c, xs, ov.size); V.scroll = 0;
  S.prevMode = S.mode; S.mode = "view"; S.fview = VIEW;
}
H.views.push({ name: VIEW, render: (): void => {
  const W = S.W; const Ht = S.H; const h = Ht - 2;
  box(0, 1, W, h, "fleet status", "esc back · r refresh hosts", true);
  const vh = h - 2; V.scroll = Math.max(0, Math.min(V.scroll, Math.max(0, V.lines.length - vh)));
  for (let r = 0; r < vh; r++) { const l = V.lines[V.scroll + r] ?? ""; const st = l.startsWith("  ✗") ? fg(C.red) : l.startsWith("  ") ? fg(C.sub) : fg(C.text) + CSI + "1m"; const t = st + fit(clean(l), W - 4) + RST; put(1, 2 + r, " " + t + fillTo(t, W - 4) + " "); }
} });
H.keys.push((mode: string, k: string): boolean => {
  if (mode !== "view" || S.fview !== VIEW) return false;
  if (k === "?") return false;
  if (k === "esc" || k === "q" || k === "backspace" || k === "left") { S.mode = "list"; S.fview = ""; }
  else if (k === "up" || k === "k" || k === "wheelup") V.scroll = Math.max(0, V.scroll - 1);
  else if (k === "down" || k === "j" || k === "wheeldown") V.scroll++;
  else if (k === "r") { refreshNow(); }
  return true;
});
H.footerHints.push((mode: string): string[][] => mode === "view" && S.fview === VIEW ? [["↑↓", "scroll"], ["r", "refresh hosts"], ["esc", "back"]] : []);
function refreshNow(): void {
  if (!T.on) { say("info", "no fleet hosts configured (" + home(CONFIG_FILE) + ")"); return; }
  T.force = true; say("info", "fleet: pulling every host (at most " + String(MAX_PARALLEL) + " at once)");
}
addActions([
  { id: "fleet.refresh", title: "refresh hosts now", group: "Fleet", keys: "", when: (c: Ctx): boolean => T.on, run: (c: Ctx): void => refreshNow() },
  { id: "fleet.status", title: "status (what works per host)", group: "Fleet", keys: "", when: (c: Ctx): boolean => T.on, run: (c: Ctx): void => openStatus() },
]);
H.helpSections.push({ name: "fleet", ctx: "sessions", keys: [
  ["", "other machines' sessions: fleet.hosts in ~/.agentglass/config.json, over ssh or a synced folder (agentglass fleet --help)"],
  ["ws ", "host tag before the title: a session on another machine, pulled over ssh (dim: its report is stale)"],
  ["", "header: · N hosts (this machine included) · vm1 stale 2h (yellow) · vm1 ✗ (red: unreachable, no report)"],
  ["2h?", "a stale remote row: the age of its report; it counts as not running (no attention, no alarms)"],
  ["/", "host is local · host is ws · host is_one_of ws,vm1 (calls and days are not in a remote report)"],
  ["↵", "a remote row: its facts and the ssh command that opens it there; transcript, kill, send, compare need the host"],
  ["^K", "Fleet: refresh hosts now · Fleet: status (what works per host)"],
  ["", "Stats: the fleet line (≈ = stale, or a pulled host's session on 2+ hosts) · the cost widget sums the fleet"],
  ["", "exact hosts (snapshots): a message copied to several hosts counts once, priced with this machine's table and days"],
  ["", "header / Stats: merging 34% while the hosts' messages are matched in the background (≈ figures until the first merge is done)"],
  ["", "live stream (fleet watch): remote running / waiting within seconds; critical remote alerts reach the desktop"],
  ["", "dir hosts: snapshots a host drops into a synced folder (agentglass fleet drop); never shown as running"],
  ["", "one machine under several entries (ssh and a drop, the hub): one host, its rows once, under the first entry"],
  ["", "--no-fleet / AGENTGLASS_FLEET=0: this run without hosts · agentglass fleet status in a shell"]] });
export const FLEET_TUI_TEST = { T, tick, init };
