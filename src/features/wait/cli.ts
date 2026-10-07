// agentglass — `agentglass wait`: what agents wait on (wall time per command family, kind or tool), heavy commands
// running at once (history and now), and --check for an agent before it starts a test run (spec agent-wait §7)
// SPDX-License-Identifier: Apache-2.0
// It reports and never blocks. History is the call rows of the period (inside an agent: the current project); now and
// --check are always host-wide — machine resources are shared across projects.
import { writeSync } from "node:fs";
import { H, complete, screenOut } from "../../hooks.ts";
import { S } from "../../state.ts";
import type { Sess } from "../../model/types.ts";
import { sessions, loadHead } from "../../model/sessions.ts";
import type { Obj } from "../../util/json.ts";
import { argVal } from "../../util/argv.ts";
import { discover } from "../cli.ts";
import { agentHost, agentScope, cliError } from "../agentenv.ts";
import { opt, optTable, setOptions, helpOf, wantsHelp, addCmd } from "../clihelp.ts";
import { type Fmt, fmtArgs, formatRows } from "../format.ts";
import { parseSince } from "../queries.ts";
import { pct, fmtMs } from "../usage/calls.ts";
import { callDays, callCutoff } from "../usage/callcache.ts";
import { cliFilter } from "../query/cli.ts";
import { parse } from "../query/parse.ts";
import { projectClause } from "../query/project.ts";
import { HOSTQ, sessMatches } from "../query/eval.ts";
import { keyShown } from "../repos/cli.ts";
import { looker } from "../watchdog.ts";
import { rules } from "../rules/state.ts";
import { startOfDay } from "../usage/record.ts";
import { PULL_WAIT } from "../fleet/pull.ts";
import { execFileSync } from "node:child_process";
import { WANT, sshArgs, sshBin, hostControlPath } from "../fleet/ssh.ts";
import { loadFleet } from "../fleet/config.ts";
import { parseReport } from "../fleet/report.ts";
import { redactOf } from "../fleet/cli.ts";
import { obj, arr, str } from "../../util/json.ts";
import { mergeWait, reportOfObj } from "./merge.ts";
import { SHELL_KINDS, shownFam, waitCfg } from "./family.ts";
import { type WRow, type WaitReport, newWaitRun, stepWait, waitResult, trendOf, shareOf } from "./report.ts";
import { type GroupOverlap, ALL } from "./overlap.ts";
import { maxOf, overlapFor, groupOf, groupFor, rowsBy, cut, lp, rp, hours, pctTxt, trendTxt, whenTxt, splitTxt, periodTxt, nowTxt } from "./fmt.ts";
import { type LiveWait, LIVE, collectLive, heavyNow, famCounts } from "./live.ts";
export { overlapFor };

export const WAIT_FIELDS = ["key", "kind", "heavy", "calls", "timedCalls", "totalMs", "share", "p50Ms", "p95Ms", "maxMs", "errors", "errorRate", "prevTotalMs", "trend",
  "agents", "peak", "peakAt", "atLeast2Ms", "atLeast3Ms", "slowdown", "hist"];
const TABLE_COLS = ["key", "kind", "share", "totalMs", "calls", "p50Ms", "p95Ms", "errorRate", "trend", "peak"];
const BYS = ["family", "kind", "tool"];
const WAIT_OPTS = setOptions("wait", [
  opt("--since", "today|<n>d|<n>h|YYYY-MM-DD", "the period (compared with the period of equal length before it)", "7d", []),
  opt("--by", BYS.join("|"), "one row per command family, kind (test, typecheck, lint, …, user, agent) or non-shell tool", "family", BYS),
  opt("--filter", "'<expr>'", "only matching sessions and calls (the filter language; repeatable)", "", []),
  opt("--limit", "N", "at most N rows", "20", []),
  opt("--json", "", "the whole report as one JSON object", "", []),
  opt("--format", "json|jsonl|csv|table", "json: the report object; jsonl/csv/table: the rows", "json in an agent or with --json, else text", ["json", "jsonl", "csv", "table"]),
  opt("--fields", "a,b,c", "only these row columns", "", []),
  opt("--now", "", "only the heavy commands running now (host-wide; reads no history)", "", []),
  opt("--check", "", "exit 3 when ≥ --max heavy commands run now (host-wide), else 0", "", []),
  opt("--family", "f", "--check: count only this family (e.g. \"pnpm test\")", "", []),
  opt("--kind", "k", "--check: count only this kind (" + SHELL_KINDS.slice(0, 5).join(", ") + ")", "", SHELL_KINDS),
  opt("--max", "N", "--check: the limit (default: the contention rule's threshold, 3)", "3", []),
  opt("--fleet", "", "every fleet host too (fleet.hosts): sums and histograms merged, peaks and now per host", "", []),
  opt("--all-projects", "", "inside an agent: history of every project (default: the current one)", "", []),
  opt("--project-only", "", "inside an agent: only the current project, over a configured agent.scope all", "", []),
]);
export const WAIT_HELP = `usage: agentglass wait [--since today|<n>d|YYYY-MM-DD] [--by family|kind|tool] [--filter '<expr>']… [--limit N]
                       [--json | --format json|jsonl|csv|table] [--fields a,b]
       agentglass wait --now | --check [--family f | --kind k] [--max N]

  what your agents wait on: wall time per command family (pnpm test, tsc, gh run watch …) and per tool, its share of
  agent time, p50/p95, failures, trend against the previous period, and heavy commands (tests, type checks, lint,
  builds, installs) running at the same time — in history (peak, time at ≥ 2, slower when overlapped) and now.
  It only reports; it never waits or blocks.

` + optTable(WAIT_OPTS) + `
  for agents, before a test run:  agentglass wait --check --kind test || echo "3+ heavy runs here — wait or run a subset"
  inside a coding agent: JSON by default; history is the current project, now/--check the whole machine

  tool time includes approval dialogs (no record separates them); background runs end at launch and are not timed.
  config (~/.agentglass/config.json), read at start:
    { "wait": { "families": [{ "match": "make *", "family": "make $1", "kind": "build" }],
                "heavyKinds": ["test", "typecheck", "lint", "build", "install"], "minSec": 10 } }
  match: words; * = one word ($1…$9), a trailing ... = the rest, * inside a word = a glob; rules go first, in order.`;

let rc = 0;
function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(rc); } }
function fail(msg: string): never { cliError("usage", screenOut("wait: " + msg), "see agentglass wait --help", 2); }
function r4(x: number): number { return Math.round(x * 10000) / 10000; }
function iso(t: number): string { return new Date(t).toISOString(); }

export interface WaitOpts { since: string; sinceMs: number; by: string; filters: string[]; limit: number; json: boolean; f: Fmt; now: boolean; check: boolean; family: string; kind: string; max: number; fleet: boolean }
export function parseWaitArgs(args: string[]): WaitOpts {
  const o: WaitOpts = { since: "7d", sinceMs: 0, by: "family", filters: [], limit: 20, json: false, f: fmtArgs(args), now: false, check: false, family: "", kind: "", max: 0, fleet: false };
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    const val = (): string => { const v = argVal(args, i); if (v === null) fail(a + " needs a value"); i++; return v; };
    if (a === "--json") o.json = true;
    else if (a === "--now") o.now = true;
    else if (a === "--check") o.check = true;
    else if (a === "--fleet") o.fleet = true;
    else if (a === "--since") { o.since = val(); }
    else if (a === "--by") { o.by = val(); if (BYS.indexOf(o.by) < 0) fail("--by must be one of " + BYS.join(", ") + ", got \"" + o.by + "\""); }
    else if (a === "--filter") o.filters.push(val());
    else if (a === "--limit") { const v = val(); o.limit = Number(v); if (!/^\d+$/.test(v) || o.limit < 1) fail("--limit must be an integer ≥ 1, got \"" + v + "\""); }
    else if (a === "--family") o.family = val();
    else if (a === "--kind") { o.kind = val(); if (SHELL_KINDS.indexOf(o.kind) < 0) fail("--kind must be one of " + SHELL_KINDS.join(", ") + ", got \"" + o.kind + "\""); }
    else if (a === "--max") { const v = val(); o.max = Number(v); if (!/^\d+$/.test(v) || o.max < 1) fail("--max must be an integer ≥ 1, got \"" + v + "\""); }
    else if (a === "--format" || a === "--fields") i++; // fmtArgs read them
    else if (a === "--all-projects" || a === "--project-only" || a === "--redact" || a === "--agent" || a === "--no-agent") continue;
    else if (a.startsWith("-")) fail("unknown option " + a);
    else fail("unexpected argument \"" + a + "\"");
  }
  o.sinceMs = parseSince(o.since, Date.now());
  if (o.sinceMs < 0) fail("--since must be today, <n>d, <n>h or YYYY-MM-DD, got \"" + o.since + "\"");
  if ((o.family || o.kind || o.max) && !o.check) fail((o.family ? "--family" : o.kind ? "--kind" : "--max") + " needs --check");
  if (o.family && o.kind) fail("--family and --kind are exclusive: pick one");
  return o;
}

// ── now ──
// one look at the live agents of this machine (the TUI's tick does the same every 1.5 s)
export function liveLook(): LiveWait {
  const ws: Sess[] = []; for (const s of sessions.values()) if (s.pid && !s.parent && !s.host) { complete(s); ws.push(s); } // open calls (sessions without a visible tree)
  const now = Date.now(); LIVE.want = now + 5000;
  return collectLive(ws, looker().kids, now);
}
function n1(x: number): number | null { return x < 0 ? null : x; }
export function nowJson(lw: LiveWait): Obj {
  const rs: Obj[] = [];
  for (const r of lw.running) rs.push({ session: r.path ? (sessions.get(r.path)?.id ?? "") : "", harness: r.h, family: r.family, kind: r.kind, heavy: r.heavy, ageSec: r.ageSec,
    rssMb: r.rssKb < 0 ? null : Math.round(r.rssKb / 102.4) / 10, bg: r.bg });
  return { at: iso(lw.at || Date.now()), host: HOSTQ.local, load1: n1(lw.load1), cpus: n1(lw.cpus), memAvailPct: n1(lw.memAvailPct), running: rs, heavyRunning: heavyNow(lw, "", "").length };
}
export function contentionMax(): number { return maxOf(rules()); }
// ── history ──
export function rowJson(w: WRow, g: GroupOverlap | null, rep: WaitReport): Obj {
  const p50 = pct(w.hist, 0.5, w.max); const p95 = pct(w.hist, 0.95, w.max); const tr = trendOf(w, rep.complete);
  return {
    key: shownFam(w.key, w.generic), kind: w.kind, heavy: w.heavy, calls: w.n, timedCalls: w.timed, totalMs: w.ms, share: r4(shareOf(w, rep.split)),
    p50Ms: p50 < 0 ? null : p50, p95Ms: p95 < 0 ? null : p95, maxMs: w.timed ? w.max : null, errors: w.err, errorRate: w.n ? r4(w.err / w.n) : null,
    prevTotalMs: rep.complete ? w.prevMs : null, trend: tr === null ? null : r4(tr), agents: w.agents,
    peak: g ? g.peak : null, peakAt: g ? iso(g.peakAt) : null, atLeast2Ms: g ? g.atLeast[0] ?? 0 : null, atLeast3Ms: g ? g.atLeast[1] ?? 0 : null,
    slowdown: g && g.slowdown >= 0 ? { aloneP50Ms: g.aloneP50, overlapP50Ms: g.overP50, ratio: r4(g.slowdown), alone: g.n - g.over, overlapped: g.over } : null,
    hist: w.hist.slice(),
  };
}
// the spec §7 object (fleet pull --wait prints it too); live null = no now block
export function waitJson(rep: WaitReport, ov: GroupOverlap[], live: LiveWait | null, scope: Obj, by: string, limit: number): Obj {
  const rows: Obj[] = [];
  for (const w of rowsBy(rep, by).slice(0, limit)) rows.push(rowJson(w, groupFor(ov, w, by), rep));
  const all = groupOf(ov, ALL);
  const sp = rep.split;
  return {
    period: { since: iso(rep.since), until: iso(rep.until), days: rep.days }, previous: rep.complete ? { since: iso(rep.prevSince), until: iso(rep.since) } : null,
    scope, retention: { days: callDays(), complete: rep.complete },
    agentTime: { activeMs: sp.activeMs, toolMs: sp.toolMs, userMs: sp.userMs, modelMs: sp.modelMs, pollingMs: sp.pollMs },
    rows,
    heavy: all ? { peak: all.peak, peakAt: iso(all.peakAt), atLeastMs: all.atLeast.slice(), slowdown: all.slowdown >= 0 ? r4(all.slowdown) : null } : { peak: 0, peakAt: null, atLeastMs: [0, 0, 0, 0, 0, 0, 0], slowdown: null },
    now: live ? nowJson(live) : null,
    guard: rep.since < callCutoff() ? "retention" : rows.length ? null : "empty",
    warnings: waitCfg().diags.slice(),
  };
}
// every session that can hold a row of either window, indexed to its end (cheap clauses of the filter pick them first);
// a session with nothing new keeps its rows on disk: the report scans its calls file (report.ts)
export function indexFor(since: number, until: number, exprs: string[]): void {
  const cf = cliFilter(exprs, "", false, false, false);
  const from = since - (until - since) - 3600000;
  for (const s of sessions.values()) {
    if (s.host || s.mtime < from) continue;
    if (cf.needsHead && !s.headDone) loadHead(s);
    if (!sessMatches(cf.cheap, s)) continue;
    loadHead(s); complete(s);
  }
}
export function runReport(since: number, until: number, exprs: string[]): WaitReport {
  indexFor(since, until, exprs);
  const r = newWaitRun(cliFilter(exprs, "", false, false, false).f, since, until);
  while (!stepWait(r, 1e9)) { /* to the end */ }
  return waitResult(r);
}

// the object a host sends in `fleet pull --wait` (unscoped): rows by family plus every kind and tool row (the viewer's
// v view), the now block of this host
export function hostWaitObj(days: number, now: number): Obj {
  const rep = runReport(startOfDay() - (days - 1) * 86400000, now + 1, []);
  const o = waitJson(rep, overlapFor(rep, "family"), liveLook(), { filter: null, project: null, now: "host" }, "family", 200);
  const ovK = overlapFor(rep, "kind"); const ks: Obj[] = []; const ts: Obj[] = [];
  for (const w of rep.kinds) ks.push(rowJson(w, groupFor(ovK, w, "kind"), rep));
  for (const w of rep.tools.slice(0, 100)) ts.push(rowJson(w, null, rep));
  o["kinds"] = ks; o["tools"] = ts;
  return o;
}
PULL_WAIT.fn = (days: number, now: number): Obj | null => hostWaitObj(days, now);

// ── text ──
function text(rep: WaitReport, ov: GroupOverlap[], lw: LiveWait, o: WaitOpts): void {
  const by = o.by; const rows = rowsBy(rep, by).slice(0, o.limit);
  out(cut("wait · " + periodTxt(o.since) + (rep.complete ? " vs the " + (o.since.startsWith("2") ? "period" : periodTxt(o.since)) + " before" : "") + " · " + String(rep.sessions) + (rep.sessions === 1 ? " session" : " sessions") + (o.filters.length ? " · filter " + o.filters.join(" and ") : ""), 80));
  out(cut(splitTxt(rep), 80));
  if (rep.since < callCutoff()) out("(call rows are kept " + String(callDays()) + " days: the period's older part is missing — filter.callDays)");
  if (!rows.length) { out("no " + (by === "tool" ? "tool calls" : "shell calls") + " in this period" + (o.filters.length ? " matching the filter" : "")); }
  else {
    out(lp(by, 18) + " " + lp("kind", 9) + rp("share", 6) + rp("total", 7) + rp("n", 7) + rp("p50", 7) + rp("p95", 7) + rp("err", 5) + rp("trend", 6) + rp("peak", 5));
    for (const w of rows) {
      const g = groupFor(ov, w, by);
      const p50 = pct(w.hist, 0.5, w.max); const p95 = pct(w.hist, 0.95, w.max);
      out(lp(shownFam(w.key, w.generic), 18) + " " + lp(w.kind, 9) + rp(pctTxt(shareOf(w, rep.split)), 6) + rp(hours(w.ms), 7) + rp(String(w.n), 7) +
        rp(p50 < 0 ? "·" : fmtMs(p50), 7) + rp(p95 < 0 ? "·" : fmtMs(p95), 7) + rp(w.n ? pctTxt(w.err / w.n) : "·", 5) + rp(trendTxt(trendOf(w, rep.complete)), 6) + rp(g && g.peak > 1 ? String(g.peak) : "·", 5));
    }
  }
  const all = groupOf(ov, ALL);
  if (all && all.peak > 1) out(cut("heavy at once: peak " + String(all.peak) + " at " + whenTxt(all.peakAt) + " · ≥2 " + hours(all.atLeast[0] ?? 0) + " · ≥3 " + hours(all.atLeast[1] ?? 0) +
    (all.slowdown >= 0 ? " · p50 ×" + all.slowdown.toFixed(1) + " when overlapped (correlation)" : ""), 80));
  else if (all) out("heavy at once: never (heavy calls ≥ " + String(waitCfg().minSec) + " s)");
  out(cut(nowTxt(lw, contentionMax()), 80));
  out("tool time includes approval dialogs; background runs are not timed");
}

// ── command ──
function wait(args: string[]): void {
  if (wantsHelp(args)) { out(helpOf("wait", args, WAIT_HELP)); process.exit(0); }
  S.cli = true;
  const o = parseWaitArgs(args);
  const agent = agentHost().on;
  const sc = agentScope(args);
  waitCfg(); // its problems on stderr once
  discover();
  if (o.now || o.check) {
    const lw = liveLook();
    if (o.check) {
      const max = o.max || contentionMax(); const hv = heavyNow(lw, o.family, o.kind);
      rc = hv.length >= max ? 3 : 0;
      if (agent || o.json || o.f.fmt === "json") out(JSON.stringify({ now: nowJson(lw), check: { family: o.family || null, kind: o.kind || null, max, running: hv.length, over: rc === 3 } }));
      else out((rc ? "busy: " : "ok: ") + String(hv.length) + " heavy" + (o.family ? " " + o.family : o.kind ? " " + o.kind : "") + " command" + (hv.length === 1 ? "" : "s") + " running (max " + String(max) + ")" + (hv.length ? ": " + famCounts(hv) : ""));
      process.exit(rc);
    }
    if (agent || o.json || o.f.fmt === "json") out(JSON.stringify({ now: nowJson(lw) }));
    else out(nowTxt(lw, contentionMax()));
    process.exit(0);
  }
  if (o.fleet) { fleetWait(o); return; }
  const exprs = o.filters.slice(); let project: string | null = null;
  if (agent && sc.name === "project") { const pc = projectClause(sc.cwd); exprs.push(pc); project = keyShown(parse(pc).cs[0]?.vals[0] ?? ""); }
  const until = Date.now() + 1;
  const rep = runReport(o.sinceMs, until, exprs);
  const ov = overlapFor(rep, o.by);
  const lw = liveLook();
  const scope: Obj = { filter: o.filters.length ? o.filters.join(" and ") : null, project, now: "host" };
  const fmt = o.f.fmt || (o.json || agent ? "json" : "");
  if (fmt === "json" && !o.f.fields.length) out(process.stdout.isTTY && !agent ? JSON.stringify(waitJson(rep, ov, lw, scope, o.by, o.limit), null, 2) : JSON.stringify(waitJson(rep, ov, lw, scope, o.by, o.limit)));
  else if (fmt) {
    const rows: Obj[] = []; for (const w of rowsBy(rep, o.by).slice(0, o.limit)) rows.push(rowJson(w, groupFor(ov, w, o.by), rep));
    out(formatRows(rows, { fmt, fields: o.f.fields }, false, TABLE_COLS, WAIT_FIELDS, false));
  } else text(rep, ov, lw, o);
  for (const f of H.onQuit) f(); // the indexing work is kept for the next run
  process.exit(0);
}

// --fleet: this machine's report and every ssh host's, each asked now with `fleet pull --wait` (whatever transport the
// TUI uses for it: snapshot hosts send no wait data in their snapshots), merged; now per host
function hostPull(args: string[], timeoutS: number): Obj | null {
  try {
    const t = execFileSync(sshBin(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutS * 1000, maxBuffer: 268435456 });
    const r = parseReport(t).r; return r ? r.wait : null;
  } catch (e) { return null; }
}
function fleetWait(o: WaitOpts): void {
  if (o.filters.length) fail("--fleet takes no --filter (hosts report their whole history)");
  const days = Math.max(1, Math.round((startOfDay() - o.sinceMs) / 86400000) + 1);
  const c = loadFleet(); let any = false; for (const h of c.hosts) if (h.enabled) any = true;
  if (!any) cliError("usage", "no fleet hosts configured", "add \"fleet\": {\"hosts\": [{\"name\": \"ws\", \"ssh\": \"…\"}]} to ~/.agentglass/config.json", 2);
  WANT.wait = Date.now() + 600000;
  const objs: Obj[] = [hostWaitObj(days, Date.now())]; const hosts: Obj[] = [{ name: HOSTQ.local, now: objs[0]?.["now"] ?? null }];
  for (const h of c.hosts) {
    if (!h.enabled) continue;
    const w = h.kind === "ssh" && sshBin() ? hostPull(sshArgs(h, days, redactOf(h), hostControlPath(h)), c.timeoutS) : null;
    if (!w) { hosts.push({ name: h.name, now: null, missing: h.kind === "ssh" ? "no wait report (unreachable, or an older agentglass there)" : "a " + h.kind + " host sends no wait data" }); continue; }
    objs.push(w); hosts.push({ name: h.name, now: w["now"] ?? null });
  }
  const m = mergeWait(objs);
  if (agentHost().on || o.json || o.f.fmt === "json") { out(JSON.stringify({ merged: m, hosts })); process.exit(0); }
  const rep = reportOfObj(m); const rows = rowsBy(rep, o.by).slice(0, o.limit);
  out(cut("wait · " + periodTxt(o.since) + " · " + String(objs.length) + " hosts merged (peaks stay per host)", 80));
  out(cut(splitTxt(rep), 80));
  out(lp(o.by, 18) + " " + lp("kind", 9) + rp("share", 6) + rp("total", 7) + rp("n", 7) + rp("p50", 7) + rp("p95", 7) + rp("err", 5) + rp("trend", 6));
  for (const w of rows) {
    const p50 = pct(w.hist, 0.5, w.max); const p95 = pct(w.hist, 0.95, w.max);
    out(lp(w.key, 18) + " " + lp(w.kind, 9) + rp(pctTxt(shareOf(w, rep.split)), 6) + rp(hours(w.ms), 7) + rp(String(w.n), 7) + rp(p50 < 0 ? "·" : fmtMs(p50), 7) + rp(p95 < 0 ? "·" : fmtMs(p95), 7) +
      rp(w.n ? pctTxt(w.err / w.n) : "·", 5) + rp(trendTxt(trendOf(w, rep.complete)), 6));
  }
  for (const h of hosts) {
    const nw = obj(h["now"]);
    if (!nw) { out(cut(str(h["name"]) + ": " + str(h["missing"]), 80)); continue; }
    const fams: string[] = []; for (const x of arr(nw["running"])) { const r = obj(x); if (r && r["heavy"] === true) fams.push(str(r["family"])); }
    out(cut(str(h["name"]) + ": " + (fams.length ? String(fams.length) + " heavy: " + fams.join(", ") : "no heavy command running"), 80));
  }
  process.exit(0);
}

addCmd({ cmd: "wait", usage: "agentglass wait [--since 7d] [--by family|kind|tool]", summary: "what agents wait on (wall time per command family / kind / tool, share of agent time, p50/p95, trend;\nheavy commands at the same time, in history and now; --now, --check exits 3 at ≥ 3 heavy runs)",
  options: WAIT_OPTS, fields: WAIT_FIELDS, group: "cmd" }, "prices");
H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: `wait --json` is this command's flag
  if (args[0] !== "wait") return false;
  wait(args);
  return true;
});
