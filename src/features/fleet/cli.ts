// agentglass — `agentglass fleet …`: every host's sessions and cost in one list, the hosts' status, and the remote side
// (fleet pull, fleet serve, fleet authorize). Fleet spec 10
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { H, complete, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import { sessions, loadHead, loadTail } from "../../model/sessions.ts";
import type { Sess } from "../../model/types.ts";
import { type Obj, str } from "../../util/json.ts";
import { CONFIG_FILE } from "../../util/config.ts";
import { hostId } from "../../util/hostid.ts";
import { ago, clean } from "../../util/text.ts";
import { detachedPid } from "../../platform/posix.ts";
import { REDACT } from "../redact-on.ts";
import { agentHost, cliError, errLine } from "../agentenv.ts";
import { type CmdRec, type OptRec, addCmd, opt, cmdOf, cmdText, helpOf, wantsHelp } from "../clihelp.ts";
import { type Fmt, fmtArgs, formatRows } from "../format.ts";
import { discover, jsonSess, JSON_FIELDS, FILTER_OPT, FORMAT_OPT, FIELDS_OPT } from "../cli.ts";
import { json, summary } from "../cost-cli.ts";
import { cliFilter, cliSelect } from "../query/cli.ts";
import { peers } from "../vcs/json.ts";
import { MODES } from "../usage/billing.ts";
import { type ModeSum, type BState, grp } from "../usage/costs.ts";
import { budget } from "../usage/summary.ts";
import { type FleetCfg, type HostCfg, loadFleet, hostNamed, openCmd, splitHostRef } from "./config.ts";
import { type OpenArgs, REMOTE_OPEN } from "../palette/open.ts";
import { SELF, parseRef } from "../palette/ref.ts";
import type { HostFeed, FeedState } from "./model.ts";
import { type RemoteHost, type FleetCost, FLEET, setFleet, reapply, merged, overlap, fleetCost, fleetBudget, freshOf, rowObj } from "./hosts.ts";
import { sshFeed, idleFeed, sshBin, hostControlPath } from "./ssh.ts";
import { forget } from "./store.ts";
import { pullCli, pullSessions } from "./pull.ts";
import { snapshotCli } from "./snapshot.ts";
import { dirFeed } from "./dirfeed.ts";
import { dropCli } from "./drop.ts";
import { watchCli } from "./watch.ts";
import { pricesSig } from "../usage/pricing.ts";
import { serveCli, authorizeCli } from "./serve.ts";
import { argVal } from "../../util/argv.ts";

function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
function warn(msg: string): void { errLine("agentglass", "warning", msg, ""); }
export const SUBS = ["cost", "status", "pull", "snapshot", "watch", "drop", "serve", "authorize"];
export const MAX_PARALLEL = 4;
// the --json row fields: --json's, with host after harness and stale after live
export const FLEET_FIELDS: string[] = [];
for (const f of JSON_FIELDS) { FLEET_FIELDS.push(f); if (f === "harness") FLEET_FIELDS.push("host"); if (f === "live") FLEET_FIELDS.push("stale"); }
const TABLE = ["updated", "host", "harness", "title", "cwd", "costUsd", "tools", "status"];
const STRICT_EXIT = 5;

// ── the hosts of this run: feeds, cached reports, due pulls ──
export function redactOf(h: HostCfg): boolean { return REDACT || h.redact; } // a viewer under --redact pulls and reads only redacted reports
export function makeFeeds(c: FleetCfg, spawn: (cmd: string, args: string[]) => number, lines: number): HostFeed[] {
  const fs: HostFeed[] = [];
  const me = hostId();
  for (const h of c.hosts) fs.push(!h.enabled ? idleFeed(h.kind) : h.kind === "ssh" ? sshFeed(h, c, redactOf(h), (): number => Date.now(), spawn, lines, me) : h.kind === "dir" ? dirFeed(h, c, lines) : idleFeed(h.kind));
  return fs;
}
function sleep(s: string): void { try { execFileSync("sleep", [s]); } catch (e) { /* interrupted */ } }
// polls until the feed's report read settles (a CLI run reads a report whole: no frames to keep)
function settle(fd: HostFeed): FeedState {
  let st = fd.poll(Date.now()); let same = 0;
  for (let i = 0; i < 100000 && same < 3; i++) { const okAt = st.okAt; const code = st.code; st = fd.poll(Date.now()); same = st.okAt === okAt && st.code === code ? same + 1 : 0; }
  return st;
}
function loadCached(): void { for (const rh of FLEET.hosts) rh.st = settle(rh.feed); }
export interface Failed { name: string; msg: string; age: number }
// pulls the due hosts (cache older than refreshSeconds, or force), at most MAX_PARALLEL at once, and waits for them (each
// pull is killed at timeoutSeconds by its feed); then every report applies in config order
export function pullAll(f: FleetCfg, force: boolean, now: number): { ok: string[]; failed: Failed[] } {
  loadCached();
  const queue: RemoteHost[] = [];
  for (const rh of FLEET.hosts) {
    if (!rh.cfg.enabled || (rh.cfg.kind !== "ssh" && rh.cfg.kind !== "dir")) continue;
    const st = rh.st; const fresh = st !== null && st.report !== null && now - st.okAt < f.refreshS * 1000;
    if (force || !fresh) queue.push(rh);
  }
  const running: RemoteHost[] = [];
  const deadline = now + f.timeoutS * 1000 + 5000;
  while ((queue.length || running.length) && Date.now() < deadline) {
    while (running.length < MAX_PARALLEL && queue.length) { const rh = queue.shift(); if (!rh) break; if (rh.feed.start(Date.now()) || rh.feed.poll(Date.now()).busy) running.push(rh); else rh.st = settle(rh.feed); }
    for (let i = running.length - 1; i >= 0; i--) {
      const rh = running[i]; if (!rh) continue;
      if (!rh.feed.poll(Date.now()).busy) { rh.st = settle(rh.feed); running.splice(i, 1); }
    }
    if (queue.length || running.length) sleep("0.1");
  }
  for (const rh of running) { rh.feed.stop(); rh.st = settle(rh.feed); }
  for (const rh of FLEET.hosts) if (rh.st && rh.st.report) { rh.mine = rh.st.report; rh.mineAt = rh.st.okAt; }
  reapply();
  const ok: string[] = []; const failed: Failed[] = [];
  for (const rh of FLEET.hosts) {
    if (!rh.cfg.enabled || (rh.cfg.kind !== "ssh" && rh.cfg.kind !== "dir")) continue;
    const st = rh.st;
    if (st && st.code === "ok" && rh.report && freshOf(rh, Date.now(), f, f.refreshS * 1000)) ok.push(rh.cfg.name);
    else failed.push({ name: rh.cfg.name, msg: st && st.err ? st.err : rh.report ? "the report is stale" : "no report yet", age: rh.report ? rh.okAt : -1 });
  }
  return { ok, failed };
}
// the fleet of this run, from the config; exits 2 without hosts
function setup(needSsh: boolean): FleetCfg {
  S.cli = true;
  const c = loadFleet();
  for (const w of c.warns) warn("config " + w);
  let any = false; for (const h of c.hosts) if (h.enabled && (h.kind === "ssh" || h.kind === "dir")) any = true;
  if (!any) cliError("usage", "no hosts configured", "add \"fleet\": {\"hosts\": [{\"name\": \"ws\", \"ssh\": \"…\"}]} to " + CONFIG_FILE, 2);
  let ssh = false; for (const h of c.hosts) if (h.enabled && h.kind === "ssh") ssh = true;
  if (needSsh && ssh && !sshBin()) cliError("usage", "fleet needs ssh (AGENTGLASS_SSH)", "install OpenSSH's client, or point AGENTGLASS_SSH at it", 2);
  const names: string[] = []; for (const h of c.hosts) names.push(h.name);
  forget(names); // a host removed from the config: its spool files go
  setFleet(c, hostId(), makeFeeds(c, detachedPid, 0)); // a CLI run reads each report whole
  return c;
}
function failedLines(fs: Failed[]): void {
  for (const x of fs) warn(x.name + ": " + x.msg + (x.age >= 0 ? " — showing the report from " + ago(x.age) + " ago" : " — no report"));
}
// --strict: 5 when a host failed or is stale
export function strictCode(failed: number, stale: number): number { return failed > 0 || stale > 0 ? STRICT_EXIT : 0; }

// ── fleet [--json …]: every host's sessions ──
// the --json object with host after harness and stale after live (key order is the output order)
export function withHost(o: Obj, host: string, stale: boolean): Obj {
  const r: Obj = {};
  for (const k of Object.keys(o)) { r[k] = o[k]; if (k === "harness") r["host"] = host; if (k === "live") r["stale"] = stale; }
  if (r["host"] === undefined) r["host"] = host;
  if (r["stale"] === undefined) r["stale"] = stale;
  return r;
}
function upd(o: Obj): number { const t = Date.parse(str(o["updated"])); return t > 0 ? t : 0; }
function list(args: string[]): void {
  const filters: string[] = []; let refresh = false; let strict = false; const f: Fmt = fmtArgs(args); const asJson = args.indexOf("--json") >= 0;
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--filter") { const v = argVal(args, i); if (v === null) cliError("usage", "--filter needs an expression", "e.g. --filter 'host is ws'", 2); filters.push(String(v)); i++; }
    else if (a === "--format" || a === "--fields") i++; // fmtArgs checks the value
    else if (a === "--refresh") refresh = true;
    else if (a === "--strict") strict = true;
    else if (a !== "--json") cliError("usage", "unknown option " + a + " for fleet", "agentglass fleet [--json] [--filter …] [--format …] [--fields …] [--refresh] [--strict]", 2);
  }
  const c = setup(true);
  const cf = cliFilter(filters, "", false, false, false);
  const r = pullAll(c, refresh, Date.now());
  discover();
  const now = Date.now();
  const cands: Sess[] = pullSessions(c.days, now); // this machine: the same window the hosts send
  const stale = new Map<string, boolean>(); // remote path → its host is stale
  for (const rh of merged()) { const st = !freshOf(rh, now, c, c.refreshS * 1000); for (const s of rh.rows) { cands.push(s); stale.set(s.path, st); } }
  const sel = cliSelect(cf, cands);
  for (const s of sel) if (!s.host) { loadHead(s); loadTail(s, true); complete(s); for (const x of s.subs) complete(x); peers(s); }
  const rows: Obj[] = [];
  for (const s of sel) { const o = s.host ? rowObj(s) : jsonSess(s); if (o) rows.push(withHost(o, s.host || c.localName, s.host ? stale.get(s.path) ?? true : false)); }
  rows.sort((a: Obj, b: Obj) => upd(b) - upd(a));
  failedLines(r.failed);
  out(formatRows(rows, f, false, TABLE, FLEET_FIELDS, asJson));
  process.exit(strict ? strictCode(r.failed.length, 0) : 0);
}

// ── fleet cost ──
function round(c: number): number { return Math.round(c * 1e6) / 1e6; }
function byMode(m: ModeSum): Obj { const o: Obj = {}; for (let i = 0; i < MODES.length; i++) o[MODES[i] ?? ""] = round(m.by[i] ?? 0); return o; }
function unpriced(m: ModeSum): Obj { const bm: Obj = {}; for (const [k, n] of m.um) bm[k] = n; return { tokens: m.unk, byModel: bm, credits: m.uc }; }
function period(m: ModeSum): Obj { return { byMode: byMode(m), estimatedUsd: round(m.est), unpriced: unpriced(m) }; }
// the `cost --json` shape over the fleet
export function totalJson(fc: FleetCost, bs: BState): Obj {
  const pb: Obj = {}; let pt = 0; for (let i = 0; i < MODES.length; i++) { const v = fc.projByMode[i] ?? 0; pb[MODES[i] ?? ""] = round(v); pt += v; }
  const m = period(fc.month); m["projected"] = { byMode: pb, total: round(pt) };
  return { today: period(fc.today), week: period(fc.week), month: m,
    budget: budget.usd > 0 ? { monthlyUsd: budget.usd, counts: budget.counts, used: round(bs.used), projected: bs.projected >= 0 ? round(bs.projected) : null, state: bs.state, approx: bs.approx } : null };
}
function tot(m: ModeSum): number { let t = 0; for (const x of m.by) t += x; return t; }
function pad(s: string, w: number): string { return s.length >= w ? s : " ".repeat(w - s.length) + s; }
function usd(c: number, ap: boolean): string { return (ap ? "≈$" : "$") + (c < 1000 ? c.toFixed(2) : grp(c)); }
function cost(args: string[]): void {
  let refresh = false; let strict = false; let check = false; const asJson = args.indexOf("--json") >= 0 || fmtArgs(args).fmt === "json";
  for (let i = 2; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--refresh") refresh = true; else if (a === "--strict") strict = true; else if (a === "--check") check = true;
    else if (a === "--format") i++;
    else if (a !== "--json") cliError("usage", "unknown option " + a + " for fleet cost", "agentglass fleet cost [--json] [--refresh] [--strict] [--check]", 2);
  }
  const c = setup(true);
  const r = pullAll(c, refresh, Date.now());
  discover();
  const local = summary("");
  const now = Date.now(); const hs = merged();
  const loc: Sess[] = []; for (const s of sessions.values()) if (!s.parent) loc.push(s);
  const ov = overlap(loc, hs).size;
  const fc = fleetCost(local, hs, now, c, ov); const bs = fleetBudget(fc);
  let stale = 0; for (const p of fc.perHost) if (p.stale) stale++;
  failedLines(r.failed);
  const code = check && bs.state === "over" ? 3 : strict ? strictCode(r.failed.length, stale) : 0;
  if (asJson) {
    const hosts: Obj[] = [{ name: c.localName, ok: true, stale: false, ageSec: 0, cost: json(local) }];
    for (const rh of hs) hosts.push({ name: rh.cfg.name, ok: r.ok.indexOf(rh.cfg.name) >= 0, stale: !freshOf(rh, now, c, c.refreshS * 1000), ageSec: Math.round((now - rh.okAt) / 1000), cost: rh.report ? rh.report.cost : null });
    out(JSON.stringify({ hosts, total: totalJson(fc, bs), overlap: ov, approx: fc.approx, exact: fc.exact, removed: fc.removed }));
    process.exit(code);
  }
  const L = 16; const W = 12;
  out("".padEnd(L) + pad("today", W) + pad("7 days", W) + pad("month", W) + pad("report", W));
  for (const p of fc.perHost) out(p.name.padEnd(L) + pad(usd(p.today, false), W) + pad(usd(p.week, false), W) + pad(usd(p.month, false), W) + pad(p.local ? "here" : ago(now - p.age) + " ago" + (p.stale ? " ≈" : ""), W));
  out("fleet".padEnd(L) + pad(usd(tot(fc.today), fc.approx), W) + pad(usd(tot(fc.week), fc.approx), W) + pad(usd(tot(fc.month), fc.approx), W));
  if (ov > 0) out(String(ov) + " session" + (ov === 1 ? "" : "s") + " seen on 2+ hosts may be counted twice (≈)");
  if (fc.exact) out("(exact merge: " + String(fc.removed) + " message copies on 2+ hosts counted once; " + (c.reprice ? "priced with this machine's table" : "each host's own prices") + ", this machine's days)");
  else out("(list prices by each host's own table and day boundaries; agentglass cost on a host splits them by billing mode)");
  if (budget.usd > 0) out("budget: $" + grp(budget.usd) + "/month (fleet, counts " + budget.counts.join(", ") + "): " + bs.state + " · used " + usd(bs.used, bs.approx) +
    (bs.projected >= 0 ? " · projected " + usd(bs.projected, bs.approx) : ""));
  else out("budget: none — set budget.monthlyUsd in " + CONFIG_FILE + " (it applies to the fleet)");
  process.exit(code);
}

// ── fleet status ──
export interface HostStatus { name: string; kind: string; target: string; enabled: boolean; okAgeSec: number; err: string; code: string; version: string; hostId: string; redact: boolean; tzOffsetMin: number; sessions: number; live: number; overlap: number; sharing: string; dupOf: string; skewSec: number; os: string; exact: boolean; priceSig: string; liveAgeSec: number;
  feedOf: string; feeds: string[]; via: string } // spec 17: feedOf = the entry this one's host shows under; feeds = this entry's host's other feeds; via = the feed whose report its rows show ("" = its own)
function cpOf(rh: RemoteHost): string { return rh.cfg.kind === "ssh" && rh.cfg.enabled ? hostControlPath(rh.cfg) : ""; }
// the other entries that reach rh's host (spec 17), config order
function feedsOf(rh: RemoteHost): string[] { const o: string[] = []; if (rh.dupOf) return o; for (const x of FLEET.hosts) if (x.merged && x.dupOf === rh.cfg.name) o.push(x.cfg.name); return o; }
export function hostStatus(rh: RemoteHost, now: number, ovKeys: Set<string>): HostStatus {
  const r = rh.report; const st: FeedState | null = rh.st;
  let live = 0; let ov = 0; for (const s of rh.rows) { if (s.rlive) live++; if (ovKeys.has(s.h + ":" + s.id)) ov++; }
  return { name: rh.cfg.name, kind: rh.cfg.kind, target: rh.cfg.kind === "ssh" ? rh.cfg.ssh : rh.cfg.path, enabled: rh.cfg.enabled, okAgeSec: r ? Math.round((now - rh.okAt) / 1000) : -1,
    err: st ? st.err : "", code: !rh.cfg.enabled ? "disabled" : rh.dupOf && !rh.merged ? "duplicate" : st && st.code ? st.code : r ? "ok" : "none", version: r ? r.hello.version : "", hostId: r ? r.hello.hostId : "",
    redact: r ? r.hello.redact : redactOf(rh.cfg), tzOffsetMin: r ? r.hello.tzOffsetMin : 0, sessions: rh.rows.length, live, overlap: ov,
    sharing: rh.cfg.kind !== "ssh" || !rh.cfg.enabled ? "" : cpOf(rh) ? "on" : "off: the run directory path is too long or not owner-only", dupOf: rh.merged ? "" : rh.dupOf,
    skewSec: r ? Math.round((r.hello.now - rh.okAt) / 1000) : 0, os: r ? r.hello.os : "", exact: !!r && r.exact, priceSig: r ? r.hello.priceSig : "",
    liveAgeSec: rh.beatAt > 0 ? Math.round((now - rh.beatAt) / 1000) : -1, feedOf: rh.merged ? rh.dupOf : "", feeds: feedsOf(rh), via: rh.dupOf ? "" : rh.via };
}
function tz(min: number): string { const a = Math.abs(min); return "UTC" + (min < 0 ? "−" : "+") + String(Math.floor(a / 60)) + (a % 60 ? ":" + String(a % 60).padStart(2, "0") : ""); }
function problem(x: HostStatus): boolean { return x.code !== "ok" && x.code !== "disabled"; }
function statusText(x: HostStatus, c: FleetCfg, localTz: number): string[] {
  const o = [x.name + "  " + x.kind + " " + x.target + (x.enabled ? "" : "  (disabled)")];
  if (x.feedOf) o.push("  another feed of " + x.feedOf + " (the same host id " + x.hostId + "): its sessions show under " + x.feedOf);
  if (x.feeds.length) o.push("  feeds: " + [x.name].concat(x.feeds).join(" · ") + " (one host: its rows come from " + (x.via || x.name) + ", the best report)");
  if (x.dupOf) o.push("  ✗ the same machine as " + x.dupOf + " (host id " + x.hostId + "): not merged — give one of them its own ~/.agentglass/host-id");
  else if (problem(x)) o.push("  ✗ " + (x.err || (x.code === "none" ? "no report yet: agentglass fleet --refresh pulls now" : x.code)));
  else if (x.err) o.push("  note: " + x.err);
  if (x.okAgeSec >= 0) o.push("  last report " + ago(Date.now() - x.okAgeSec * 1000) + " ago · " + String(x.sessions) + " sessions, " + String(x.live) + " live" + (x.overlap ? ", " + String(x.overlap) + " also on another host (≈)" : "") +
    (x.okAgeSec * 1000 > 2 * c.refreshS * 1000 + c.timeoutS * 1000 ? " · stale" : ""));
  if (x.version) o.push("  agentglass " + x.version + " · " + x.os + " · " + tz(x.tzOffsetMin) + (x.tzOffsetMin !== localTz ? " (here " + tz(localTz) + (x.exact ? ": re-bucketed into this machine's days)" : ": its days differ)") : "") + (x.redact ? " · redacted" : "") + " · host id " + x.hostId);
  if (x.okAgeSec >= 0 && x.enabled) o.push(x.exact ? "  exact: yes (snapshots; message copies on several hosts count once" + (c.reprice ? ", priced with this machine's table)" : ")") + (!c.reprice && x.priceSig !== pricesSig() ? " · prices differ" : "")
    : "  exact: no" + (x.kind === "ssh" ? " (update agentglass on " + x.name + " for an exact merge, or it has snapshot: false)" : "") + (x.priceSig !== pricesSig() ? " · prices differ" : ""));
  if (x.liveAgeSec >= 0) o.push("  live stream: " + (x.liveAgeSec <= 90 ? "on (last beat " + String(x.liveAgeSec) + " s ago)" : "stale (last beat " + ago(Date.now() - x.liveAgeSec * 1000) + " ago)"));
  if (Math.abs(x.skewSec) > 120) o.push("  clock skew " + String(x.skewSec) + " s (ages use this machine's clock)");
  if (x.sharing && x.sharing !== "on") o.push("  connection sharing " + x.sharing);
  return o;
}
function status(args: string[]): void {
  let close = false; let refresh = false; const asJson = args.indexOf("--json") >= 0 || fmtArgs(args).fmt === "json";
  for (let i = 2; i < args.length; i++) { const a = args[i] ?? ""; if (a === "--close") close = true; else if (a === "--refresh") refresh = true; else if (a === "--format") i++; else if (a !== "--json") cliError("usage", "unknown option " + a + " for fleet status", "agentglass fleet status [--json] [--close] [--refresh]", 2); }
  const c = setup(false);
  if (refresh && sshBin()) pullAll(c, true, Date.now());
  else { loadCached(); for (const rh of FLEET.hosts) if (rh.st && rh.st.report) { rh.mine = rh.st.report; rh.mineAt = rh.st.okAt; } reapply(); }
  const now = Date.now();
  const loc: Sess[] = []; if (merged().length) { discover(); for (const s of sessions.values()) if (!s.parent) loc.push(s); }
  const ov = overlap(loc, merged());
  const xs: HostStatus[] = []; for (const rh of FLEET.hosts) xs.push(hostStatus(rh, now, ov));
  let closed = 0;
  if (close) {
    const b = sshBin();
    for (const rh of FLEET.hosts) { const cp = cpOf(rh); if (!b || !cp) continue; try { execFileSync(b, ["-O", "exit", "-o", "ControlPath=" + cp, "--", rh.cfg.ssh], { stdio: "ignore", timeout: 5000 }); closed++; } catch (e) { /* no master running */ } }
  }
  if (asJson) {
    const o: Obj[] = [];
    for (const x of xs) o.push({ name: x.name, kind: x.kind, target: x.target, enabled: x.enabled, okAgeSec: x.okAgeSec >= 0 ? x.okAgeSec : null, code: x.code, err: x.err, version: x.version, hostId: x.hostId, redact: x.redact,
      tzOffsetMin: x.tzOffsetMin, os: x.os, sessions: x.sessions, live: x.live, overlap: x.overlap, sharing: x.sharing, dupOf: x.dupOf || null, skewSec: x.skewSec, exact: x.exact, liveAgeSec: x.liveAgeSec >= 0 ? x.liveAgeSec : null,
      feedOf: x.feedOf || null, feeds: x.feeds, via: x.via || null });
    out(JSON.stringify(close ? { localName: c.localName, hostId: hostId(), hosts: o, closed } : { localName: c.localName, hostId: hostId(), hosts: o }));
    process.exit(0);
  }
  for (const l of statusLines(c, xs, ov.size)) out(l);
  if (close) { out(""); out("closed " + String(closed) + " shared ssh connection" + (closed === 1 ? "" : "s")); }
  process.exit(0);
}
// the text of fleet status (also the TUI's "fleet: status" view): this machine, then every host, problems first
export function statusLines(c: FleetCfg, xs: HostStatus[], ov: number): string[] {
  const localTz = -new Date().getTimezoneOffset(); const o: string[] = [];
  const ys = xs.slice(); ys.sort((a: HostStatus, b: HostStatus) => (problem(b) ? 1 : 0) - (problem(a) ? 1 : 0));
  o.push("this machine: " + c.localName + " · host id " + hostId() + " · " + tz(localTz));
  for (const x of ys) { o.push(""); for (const l of statusText(x, c, localTz)) o.push(l); }
  if (ov) { o.push(""); o.push(String(ov) + " session" + (ov === 1 ? "" : "s") + " seen on 2+ hosts: their cost may be counted twice (≈)"); }
  return o.map((l: string) => clean(l)); // version, os, errors: the remote's own text, never a terminal escape
}

// ── open <ref>@<host>: the transcript is on that host — print the ssh command that opens it there (spec 7.1) ──
export function remoteOpen(o: OpenArgs, c: FleetCfg): { cmd: string; host: string; ref: string } | null {
  const sp = splitHostRef(o.ref); if (!sp.host) return null;
  if (sp.host === c.localName) { o.ref = sp.ref; return null; } // this machine: a local ref
  const r = parseRef(sp.ref);
  if (!r.ok) cliError("usage", r.err, "agentglass open --help shows the link forms", 2);
  if (r.trace || (!r.harness && SELF.indexOf(r.sess) >= 0)) cliError("usage", "a fleet host's session needs its id: <harness>:<id>@" + sp.host, "agentglass fleet --json lists them (harness, id, host)", 2);
  const h = hostNamed(c, sp.host);
  if (!h) { const ns: string[] = []; for (const x of c.hosts) ns.push(x.name); cliError("not_found", "no fleet host " + sp.host, ns.length ? "the hosts: " + c.localName + ", " + ns.join(", ") : "add \"fleet\": {\"hosts\": [{\"name\": \"" + sp.host + "\", \"ssh\": \"…\"}]} to " + CONFIG_FILE, 3); }
  if (h.kind !== "ssh") cliError("unsupported", sp.host + " is a " + h.kind + " host: its sessions are not opened over ssh", "", 2);
  return { cmd: openCmd(h, sp.ref), host: h.name, ref: sp.ref };
}
REMOTE_OPEN.run = (o: OpenArgs): boolean => {
  const x = remoteOpen(o, loadFleet()); if (!x) return false;
  S.cli = true;
  if (o.print) out(JSON.stringify({ host: x.host, ref: x.ref, command: x.cmd }));
  else { out(x.cmd); if (process.stdout.isTTY === true && !agentHost().on) warn("the session is on " + x.host + ": the command above opens it there"); }
  process.exit(0);
};

// ── help and dispatch ──
function rec(c: string, usage: string, summary: string, options: OptRec[], fields: string[]): CmdRec { return { cmd: c, usage, summary, options, fields, group: "cmd" }; }
const FIRST = "--update-prices"; // the fleet rows go before the maintenance commands in --help
const REFRESH = opt("--refresh", "", "pull every host now (default: only reports older than fleet.refreshSeconds)", "", []);
const STRICT = opt("--strict", "", "exit 5 when a host could not be pulled or its report is stale", "", []);
addCmd(rec("fleet", "agentglass fleet [--json] [--filter …] [--refresh] [--strict]", "every host's sessions (fleet.hosts in ~/.agentglass/config.json, pulled over ssh) and this machine's,\nnewest first, with a host column (--json: host and stale fields; --strict: exit 5 when a host failed)",
  [opt("--json", "", "the rows as JSON", "", []), FILTER_OPT, FORMAT_OPT, FIELDS_OPT, REFRESH, STRICT], FLEET_FIELDS), FIRST);
addCmd(rec("fleet cost", "agentglass fleet cost [--json] [--check]", "costs per host and over the fleet (today / 7 days / month, projection, the budget over the fleet);\n≈ when a host is stale or a session is on 2+ hosts (--refresh, --strict; --check: exit 3 over budget)",
  [opt("--json", "", "{hosts, total (the cost --json shape), overlap, approx, exact, removed}", "", []), REFRESH, STRICT, opt("--check", "", "exit 3 when the fleet is over budget", "", [])], []), FIRST);
addCmd(rec("fleet status", "agentglass fleet status [--json] [--close]", "per host: what works and what does not (last report, error, version, host id, time zone, connection sharing)",
  [opt("--json", "", "one object per host", "", []), opt("--close", "", "end the shared ssh connections (ControlMaster)", "", []), opt("--refresh", "", "pull every host first", "", [])], []), FIRST);
addCmd(rec("fleet pull", "agentglass fleet pull [--days N] [--redact]", "this host's report for a fleet viewer (JSON lines: hello, cost, allowance, sessions, end);\nwhat the viewer runs over ssh",
  [opt("--days", "N", "sessions updated within N days (1–90), plus every live one", "7", []), opt("--redact", "", "fake titles, projects and paths at the source", "", [])], []), FIRST);
addCmd(rec("fleet snapshot", "agentglass fleet snapshot [--peer <id>] [--ack <gen>] [--full] [--days N] [--redact]", "this host's exact state for a fleet viewer (agentglass-snapshot/v1 JSON lines: day rows, hashed message\nownership, cost); relative to the generation the viewer acknowledged (--ack), else full",
  [opt("--peer", "<id>", "the viewer's host id (16 hex): the host keeps that viewer's generations", "", []), opt("--ack", "<gen>", "the generation the viewer applied last: the snapshot is relative to it", "", []),
    opt("--full", "", "a full snapshot whatever was acknowledged", "", []), opt("--days", "N", "list sessions updated within N days (1–90); usage covers this month and 15 days", "7", []),
    opt("--redact", "", "fake titles, projects and paths at the source", "", [])], []), FIRST);
addCmd(rec("fleet watch", "agentglass fleet watch [--redact]", "this host's live state for a fleet viewer, as JSON lines until the viewer goes: session state\n(live, busy, attention, approval, stuck), alert transitions, turn ends, a beat every 30 s; no event content",
  [opt("--redact", "", "redact at the source (alert messages name no real title)", "", [])], []), FIRST);
addCmd(rec("fleet drop", "agentglass fleet drop <dir> [--every 5m] [--days N] [--redact]", "write this host's snapshots into a synced directory (rsync, Syncthing, a share) for a viewer\nthat cannot reach it over ssh: a base, then deltas; once (cron, a timer) or --every <dur>",
  [opt("--every", "<dur>", "write again every 1m–24h until stopped (default: once)", "", []), opt("--days", "N", "list sessions updated within N days (1–90)", "7", []),
    opt("--redact", "", "fake titles, projects and paths (recommended for third-party sync)", "", [])], []), FIRST);
addCmd(rec("fleet serve", "agentglass fleet serve [--redact]", "the forced command of a viewer's key on a host (authorized_keys command=): runs only\nfleet pull/snapshot/watch and --version from SSH_ORIGINAL_COMMAND; exit 126 refused, 2 outside ssh",
  [opt("--redact", "", "answer every request redacted, whatever the viewer asks", "", [])], []), FIRST);
addCmd(rec("fleet authorize", "agentglass fleet authorize <key.pub> [--from <cidr>]", "print the authorized_keys line that limits the viewer's key to fleet serve\n(restrict,command=…); run it on the host and append the line yourself (--redact: the host answers redacted)",
  [opt("--from", "<cidr>", "only from these addresses (from=…), e.g. 100.64.0.0/10", "", []), opt("--redact", "", "the host answers redacted (fleet serve --redact)", "", [])], []), FIRST);
addCmd(rec("--no-fleet", "agentglass --no-fleet", "the TUI without pulling or showing fleet hosts this run (also AGENTGLASS_FLEET=0)", [], []), "--help");
H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: `fleet --json` is this command's flag
  if (args[0] !== "fleet") return false;
  const sub = args[1] ?? "";
  const name = SUBS.indexOf(sub) >= 0 ? "fleet " + sub : "fleet";
  if (wantsHelp(args)) { const r = cmdOf(name); if (!r) cliError("usage", "unknown command " + name, "agentglass --help lists the commands", 2); out(helpOf(name, args, cmdText(r))); process.exit(0); }
  if (sub === "pull") { pullCli(args); return true; }
  if (sub === "snapshot") { snapshotCli(args); return true; }
  if (sub === "watch") { watchCli(args); return true; }
  if (sub === "drop") { dropCli(args); return true; }
  if (sub === "serve") { serveCli(args); return true; }
  if (sub === "authorize") { authorizeCli(args); return true; }
  if (sub === "cost") { cost(args); return true; }
  if (sub === "status") { status(args); return true; }
  if (sub && !sub.startsWith("-")) cliError("usage", "unknown fleet command " + sub, "agentglass fleet --help (fleet, fleet cost, fleet status, fleet pull, fleet snapshot, fleet watch, fleet drop, fleet serve, fleet authorize)", 2);
  list(args);
  return true;
});
