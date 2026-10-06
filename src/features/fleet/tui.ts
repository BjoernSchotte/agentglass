// agentglass — the fleet in the TUI (fleet spec 8): pulls on the tick's cadence, other hosts' rows with a host tag, the
// header segment, the Stats fleet line and cost widget, the remote preview, alerts, palette actions, help
// SPDX-License-Identifier: Apache-2.0
import { H } from "../../hooks.ts";
import { S, say } from "../../state.ts";
import type { Sess } from "../../model/types.ts";
import { sessions, current, FRESH } from "../../model/sessions.ts";
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
import type { RlWin } from "../usage/record.ts";
import { kfmt, grp, moneyTag } from "../usage/costs.ts";
import { type CostNow, costNow } from "../usage/summary.ts";
import { allowanceInfo, codexWins } from "../usage/bill-live.ts";
import { type FleetHdr, FLEET_HOOK } from "../usage/stats.ts";
import { type FleetCfg, type HostCfg, loadFleet, fleetOn, hostNamed, openCmd } from "./config.ts";
import type { HostReport } from "./model.ts";
import { type RemoteHost, FLEET, setFleet, reapply, syncFresh, merged, overlap, fleetCost, fleetBudget, fleetAllowance, freshOf, freshAt, rowObj, hostByName } from "./hosts.ts";
import { sshBin } from "./ssh.ts";
import { forget } from "./store.ts";
import { makeFeeds, hostStatus, statusLines, MAX_PARALLEL } from "./cli.ts";

// on: hosts configured and this run pulls; force: the palette's "refresh now"; due/fails/doneAt per host name
const T = { on: false, force: false, due: new Map<string, number>(), fails: new Map<string, number>(), busy: new Map<string, boolean>(), seeded: new Set<string>(), gen: 0, nossh: false };
export const BACKOFF_MS = [30000, 60000, 120000, 240000, 480000, 900000];
// the interval a host is pulled at: refreshSeconds, at least 300 s while nobody looks
export function intervalMs(c: FleetCfg, away: boolean): number { return (away ? Math.max(c.refreshS, 300) : c.refreshS) * 1000; }
// after n failures in a row: 30 s doubling to 15 min (0 = none)
export function backoffMs(n: number): number { return n <= 0 ? 0 : BACKOFF_MS[Math.min(n, BACKOFF_MS.length) - 1] ?? 900000; }
// when a host is next due: interval after its last finished pull, the backoff after a failure
export function nextDue(doneAt: number, ok: boolean, fails: number, interval: number): number { return doneAt + (ok ? interval : backoffMs(fails)); }

// ── alerts: a transition seen in a new report toasts once (host|session|rule|severity|since) ──
export function alertKeys(host: string, r: HostReport): { key: string; msg: string }[] {
  const out: { key: string; msg: string }[] = [];
  for (const row of r.sessions) for (const a of arr(row.s["alerts"])) {
    const o = obj(a); if (!o || o["acked"] === true) continue;
    out.push({ key: host + "|" + row.key + "|" + str(o["rule"]) + "|" + str(o["severity"]) + "|" + str(o["since"]), msg: host + " · " + str(row.s["title"]) + ": " + str(o["message"]) });
  }
  return out;
}
// the toasts of a new report: alerts not seen before (the first report of a host only seeds: old alarms stay quiet)
export function newAlerts(rh: RemoteHost, r: HostReport, seed: boolean): string[] {
  const msgs: string[] = [];
  for (const k of alertKeys(rh.cfg.name, r)) { if (rh.alertsSeen.has(k.key)) continue; rh.alertsSeen.add(k.key); if (!seed) msgs.push(k.msg); }
  if (rh.alertsSeen.size > 5000) rh.alertsSeen.clear();
  return msgs;
}

// ── the tick ──
function init(): void {
  const c = loadFleet();
  for (const w of c.warns) say("warn", "config " + w);
  if (!fleetOn(c)) return;
  T.on = true;
  if (!sshBin()) { T.nossh = true; say("warn", "fleet needs ssh (AGENTGLASS_SSH): hosts are not pulled"); }
  const names: string[] = []; for (const h of c.hosts) names.push(h.name);
  forget(names);
  setFleet(c, hostId(), makeFeeds(c, detachedPid, 256)); // ≤ 256 parsed lines per host and tick
}
function tick(): void {
  const c = FLEET.cfg; if (!T.on || !c) return;
  const now = Date.now(); FLEET.intervalMs = intervalMs(c, AWAY.on);
  let fresh = false; let running = 0; const toasts: string[] = [];
  for (const rh of FLEET.hosts) {
    if (!rh.cfg.enabled || rh.cfg.kind !== "ssh") continue;
    const st = rh.feed.poll(now); rh.st = st; const n = rh.cfg.name;
    if ((st.code === "dir" || st.code === "nossh") && !T.seeded.has(st.code)) { T.seeded.add(st.code); say("warn", "fleet: " + st.err); } // no pulls at all: say why once
    if (st.busy) { running++; T.busy.set(n, true); continue; }
    if (T.busy.get(n)) { // a pull finished: the next one is due an interval later, or after the backoff
      T.busy.set(n, false);
      const ok = st.code === "ok"; const f = ok ? 0 : (T.fails.get(n) ?? 0) + 1; T.fails.set(n, f);
      T.due.set(n, nextDue(now, ok, f, FLEET.intervalMs));
    }
    if (st.report && st.report !== rh.report) {
      const seed = !T.seeded.has(n); T.seeded.add(n);
      for (const m of newAlerts(rh, st.report, seed || !freshAt(st.okAt, now, c, FLEET.intervalMs))) toasts.push(m); // a stale report (the cache at start) only seeds
      rh.report = st.report; rh.okAt = st.okAt; fresh = true;
      if (!T.due.has(n)) T.due.set(n, st.okAt + FLEET.intervalMs); // a cached report: the next pull when it would be due
    }
  }
  if (fresh) { reapply(); for (const rh of FLEET.hosts) if (rh.dupOf && !T.seeded.has("dup:" + rh.cfg.name)) { T.seeded.add("dup:" + rh.cfg.name); say("warn", "fleet host " + rh.cfg.name + " is the same machine as " + rh.dupOf + ": not merged (agentglass fleet status)"); } }
  if (syncFresh(now) || fresh) { T.gen++; S.dirty = true; }
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
H.start.push(init);
H.onTick.push(tick);
H.onQuit.push((): void => { for (const rh of FLEET.hosts) rh.feed.stop(); }); // running pulls only: shared ssh masters persist (fleet status --close)

// ── rows: the host tag before the title ──
// ≈ after it (local rows: alone) when the session is also on another host: its cost may count twice (spec 7.2)
export function hostTag(s: Sess): string {
  const ov = T.on && FN.ov.size > 0 && FN.ov.has(s.h + ":" + s.id) ? fg(C.yellow) + "≈" + RST : "";
  if (!s.host) return ov ? ov + " " : "";
  return fg(FRESH.ok(s.host) ? C.accent : C.dim) + s.host.slice(0, 4) + RST + ov + " ";
}
H.rowPrefix.push(hostTag);
REMOTE.hint = (s: Sess): string => sshHint(s);
export function sshHint(s: Sess): string {
  const h = FLEET.cfg ? hostNamed(FLEET.cfg, s.host) : null;
  return openCmd(h ?? { name: s.host, ssh: s.host, agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "" }, s.h + ":" + s.id);
}

// ── fleet figures for the header and Stats (cached per rows generation and 5 s) ──
interface FleetNow { at: number; gen: number; cn: CostNow | null; hdr: FleetHdr | null; ov: Set<string>; per: { name: string; usd: number; wk: number; stale: boolean; age: number; local: boolean }[]; approx: boolean }
const FN: FleetNow = { at: 0, gen: -1, cn: null, hdr: null, ov: new Set<string>(), per: [], approx: false };
function fleetNow(cn: CostNow): FleetNow {
  const now = Date.now(); const c = FLEET.cfg;
  if (!c || (FN.gen === T.gen && FN.cn === cn && now - FN.at < 5000)) return FN;
  const hs = merged(); const loc: Sess[] = []; for (const s of sessions.values()) if (!s.parent) loc.push(s);
  const ov = overlap(loc, hs); const fc = fleetCost(cn, hs, now, c, ov.size); const bs = fleetBudget(fc);
  FN.at = now; FN.gen = T.gen; FN.cn = cn; FN.ov = ov; FN.approx = fc.approx;
  FN.hdr = { today: fc.today, state: bs.state, approx: fc.marked };
  FN.per = fc.perHost.map((p) => ({ name: p.name, usd: p.today, wk: p.week, stale: p.stale, age: p.age, local: p.local }));
  return FN;
}
FLEET_HOOK.header = (cn: CostNow): FleetHdr | null => T.on && merged().length ? fleetNow(cn).hdr : null;
FLEET_HOOK.line = (w: number, week: boolean): string => {
  if (!T.on) return "";
  const f = fleetNow(costNow("")); const usd = (x: number): string => "$" + (x < 1000 ? x.toFixed(2) : grp(x));
  const parts: string[] = [];
  for (const p of f.per) parts.push(fg(p.local ? C.text : C.accent) + p.name + RST + " " + fg(C.yellow) + (p.stale ? "≈" : "") + usd(week ? p.wk : p.usd) + RST + (p.stale ? fg(C.dim) + " (" + ago(Date.now() - p.age) + " old)" + RST : ""));
  for (const rh of FLEET.hosts) if (rh.cfg.enabled && rh.cfg.kind === "ssh" && !rh.report) parts.push(fg(C.dim) + rh.cfg.name + " —" + RST);
  let l = fg(C.dim) + "fleet  " + RST + parts.join(fg(C.dim) + " · " + RST);
  if (f.ov.size) l += fg(C.dim) + " · " + RST + fg(C.yellow) + String(f.ov.size) + " session" + (f.ov.size === 1 ? "" : "s") + " on 2+ hosts ≈" + RST;
  return vwidth(l) <= w ? l : fitStyled(l, w);
};
// allowance across hosts: per account the newest fetch (the fullest account shows), Codex the newest event. Per rows
// generation and 5 s, as the cost figures: the header draws every frame, and this machine's part stats ~/.claude.json
const AL = { at: 0, gen: -1, claude: null as Allow | null, codex: null as RlWin[] | null };
function allowNow(): void {
  const now = Date.now(); if (AL.gen === T.gen && now - AL.at < 5000) return;
  AL.at = now; AL.gen = T.gen; const hs = merged();
  AL.claude = hs.length ? claudeOf(hs, now) : null; AL.codex = hs.length ? codexOf(hs) : null;
}
FLEET_HOOK.claude = (): Allow | null => { if (!T.on) return null; allowNow(); return AL.claude; };
FLEET_HOOK.codex = (): RlWin[] | null => { if (!T.on) return null; allowNow(); return AL.codex; };
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
export function headerSeg(n: number, marks: HostMark[], w: number, nossh: boolean): string {
  if (nossh) { const t = fg(C.dim) + " · " + RST + fg(C.yellow) + "hosts: no ssh" + RST; return vwidth(t) <= w ? t : ""; }
  const base = fg(C.dim) + " · " + String(n) + " hosts" + RST;
  let full = base;
  for (const m of marks) full += fg(C.dim) + " · " + RST + (m.down ? fg(C.red) + m.name + " ✗" : fg(C.yellow) + m.name + " stale " + ago(Date.now() - m.ageMs)) + RST;
  if (vwidth(full) <= w) return full;
  return vwidth(base) <= w ? base : "";
}
function marks(now: number): HostMark[] {
  const c = FLEET.cfg; const o: HostMark[] = []; if (!c) return o;
  for (const rh of FLEET.hosts) {
    if (!rh.cfg.enabled || rh.cfg.kind !== "ssh" || rh.dupOf) continue;
    if (!rh.report) { if (rh.st && rh.st.code && rh.st.code !== "ok") o.push({ name: rh.cfg.name, stale: false, ageMs: 0, down: true }); continue; }
    if (!freshOf(rh, now, c, FLEET.intervalMs)) o.push({ name: rh.cfg.name, stale: true, ageMs: now - rh.okAt, down: false });
  }
  return o;
}
H.headerWidgets.push((w: number): string => {
  if (!T.on || !FLEET.cfg || w < 24) return ""; // narrow: the cost widget before it keeps its place (the tabs turn to numbers for it)
  let n = 1; for (const rh of FLEET.hosts) if (rh.cfg.enabled && rh.cfg.kind === "ssh" && !rh.dupOf) n++;
  return headerSeg(n, marks(Date.now()), w, T.nossh);
});

// ── the preview of a remote row: its report's facts and the command that opens it on the host ──
H.remoteCard.push((s: Sess, w: number): string[] => {
  const o = rowObj(s); const rh = hostByName(s.host); const c = FLEET.cfg;
  const k = (t: string): string => fg(C.dim) + fit(t, 9) + RST;
  const fresh = FRESH.ok(s.host); const out: string[] = [];
  const h: HostCfg | null = c ? hostNamed(c, s.host) : null;
  out.push(k("host") + fg(C.accent) + s.host + RST + fg(C.dim) + (h ? " · ssh " + h.ssh : "") + " · report " + (rh ? ago(rh.okAt) + " ago" : "—") + (fresh ? "" : " · stale") + RST);
  out.push(k("open") + fg(C.text) + sshHint(s) + RST + fg(C.dim) + "  (the transcript is on " + s.host + ")" + RST); // one line, second: a short preview still shows it
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
  ["", "other machines' sessions: fleet.hosts in ~/.agentglass/config.json, pulled over ssh (agentglass fleet --help)"],
  ["ws ", "host tag before the title: a session on another machine, pulled over ssh (dim: its report is stale)"],
  ["", "header: · N hosts (this machine included) · vm1 stale 2h (yellow) · vm1 ✗ (red: unreachable, no report)"],
  ["2h?", "a stale remote row: the age of its report; it counts as not running (no attention, no alarms)"],
  ["/", "host is local · host is ws · host is_one_of ws,vm1 (calls and days are not in a remote report)"],
  ["↵", "a remote row: its facts and the ssh command that opens it there; transcript, kill, send, compare need the host"],
  ["^K", "Fleet: refresh hosts now · Fleet: status (what works per host)"],
  ["", "Stats: the fleet line (each host's own figures; ≈ = stale or on 2+ hosts) · the cost widget sums the fleet"],
  ["", "--no-fleet / AGENTGLASS_FLEET=0: this run without hosts · agentglass fleet status in a shell"]] });
export const FLEET_TUI_TEST = { T, tick, init };
