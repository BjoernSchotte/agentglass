// agentglass — machine-readable CLI: --json snapshot, --watch JSONL event stream, --help, --version (no TTY needed)
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, complete, screenOut } from "../hooks.ts";
import { sessions, scan, buildView, loadHead, loadTail, titleOf, activity } from "../model/sessions.ts";
import { refreshProcs, refreshSlow } from "../model/procs.ts";
import { HARNESSES, harnessIds, isHarness, parseEvents, sourceOf, epochOf } from "../harness/index.ts";
import { base } from "../util/json.ts";
import type { Ev, Sess } from "../model/types.ts";
import { S } from "../state.ts";
import { BUILD } from "../build-info.ts";
import { versionInfo } from "./version.ts";
import { planLabel } from "./usage/billing.ts";
import { REDACT } from "./redact-on.ts";
import { accOf } from "./usage/ledger.ts";
import { type SkillUse, skillUses } from "./usage/record.ts";
import { type CliFilter, cliFilter, cliSelect, cliWatchSession, cliWatchEvent, cliWatchExit, filterKeysHelp } from "./query/cli.ts";
import { livePid } from "./query/eval.ts";
import { type Alert, stateOf, render, severityOf } from "./rules/engine.ts";
import { rules } from "./rules/state.ts";
import { onTrans } from "./rules/notify.ts";
import { complete as ledgerComplete } from "./usage/ledger.ts";
import { watched, looker, observeWith, watchStep, forgetSession, ruleOf, ledgerRule, alertsOf } from "./watchdog.ts";

// option rows [option, description] ("" = the description continues); one description column for both tables, past the longest option
const CMDS: string[][] = [
  ["agentglass", "interactive TUI"],
  ["agentglass --theme <name>", "TUI with a color theme"],
  ["agentglass --redact", "privacy mode for screencasts: fake titles/projects/content, scrubbed names"],
  ["", "(also AGENTGLASS_REDACT=1; combinable with --json / --watch)"],
  ["agentglass --json [opts]", "print a JSON snapshot of sessions (newest first) and exit"],
  ["agentglass --watch [opts]", "stream new events of all agents as JSONL (tail -f for every session)"],
  ["agentglass cost [--json] [--check]", "costs today / 7 days / month by billing mode, unpriced usage, projection, budget"],
  ["", "(--harness h: one harness; --check: exit 3 when over budget)"],
  ["agentglass rules check [--json]", "validate ~/.agentglass/rules.json (alert rules): effective rules + line:col problems"],
  ["agentglass rules defaults [--examples]", "print the built-in alert rules as a ready-to-edit rules.json"],
  ["agentglass --update-prices", "fetch the opted-in community price list now (see ~/.agentglass/config.json)"],
  ["agentglass --help | -h", "this text"],
  ["agentglass update [--channel stable|dev]", "update to the newest release (--tag T, --dry-run, --json, --yes, --rollback, status)"],
  ["agentglass --version [--json]", "print the version (--json: version, channel, commit, date, platform, install method)"],
];
const OPTS: string[][] = [
  ["--live", "only sessions with a running agent process"],
  ["--harness " + harnessIds().join("|"), "only this harness"],
  ["--limit N", "--json: at most N sessions"],
  ["--subagents", "--json: include subagent sessions"],
  ["--from-start", "--watch: replay existing logs from the beginning (combine with a filter)"],
  ["--filter '<expr>'", "only what matches, e.g. 'repo is x and cost > 2', 'tool is Bash and status is error' (repeatable)"],
  ["--pinned", "also apply the filter pinned in the TUI (P); without it pins are ignored"],
  ["--no-alerts", "--watch: no alert lines (the rules engine does not run)"],
  ["--notify", "--watch: also run rules.json's notify command on alert transitions"],
];
function table(rows: string[][], col: number): string { return rows.map((r: string[]) => "  " + (r[0] ?? "").padEnd(col) + (r[1] ?? "")).join("\n"); }
function usage(): string {
  let col = 0; for (const r of CMDS.concat(OPTS)) col = Math.max(col, (r[0] ?? "").length + 2);
  return `agentglass ${BUILD.version} (${BUILD.channel}, ${BUILD.commit.slice(0, 8)}, ${BUILD.platform}) — browse, watch and steer coding-agent sessions (${HARNESSES.map((a) => a.label).join(", ")})

usage:
${table(CMDS, col)}

options for --json / --watch:
${table(OPTS, col)}

--json fields: id harness title cwd branch remote model path updated bytes live pid status parent kind subagents
  activity tokens{in,out,cacheRead,cacheWrite} costUsd billing{mode,plan,source} unpricedTokens unpricedCredits
  tools linesAdded linesRemoved attention stuck skills[{name,source,n}]
  alerts[{rule,severity,value,unit,threshold,since,message,labels,acked}] (live sessions; durations s, ratios 0–1, USD)
  (costUsd = API list price, null when only unpriced usage exists; billing.mode = api|plan|metered|gateway|unknown,
  source = session|process|config — config = assumed from the current config files;
  skills source = command: a slash command / $mention, model: the agent chose it)
--watch lines: {ts,harness,session,title,project,parent,kind,tool,text}; kind = user|assistant|thinking|tool|result|meta,
  plus live|exit when an agent process appears or disappears, and alert (rules.json transitions: an alert object
  {rule,severity,state,value,threshold,labels}; state = fire|escalate|deescalate|resolve; off with --no-alerts)

filter: key op value [and …]; op = is = is_not != is_one_of is_not_one_of ~ !~ > >= < <=; not / - negates; bare words
  search title, path, id; --json lists sessions with a matching call or day; --watch filters events (event is tool|result|…)
${filterKeysHelp()}

OpenCode sessions are read from its SQLite database with the sqlite3 CLI (AGENTGLASS_SQLITE3 = another command);
  without it, 2.x sessions come from a running \`opencode service\` over HTTP with curl (AGENTGLASS_CURL); with neither
  they are not listed (a warning says so)
`;
}

interface Opts { live: boolean; harness: string; limit: number; subs: boolean; fromStart: boolean; filters: string[]; pinned: boolean; alerts: boolean; notify: boolean; cf: CliFilter | null }
interface JTok { in: number; out: number; cacheRead: number; cacheWrite: number }
interface JBill { mode: string; plan: string; source: string }
interface JSess {
  id: string; harness: string; title: string; cwd: string; branch: string; remote: string | null; model: string; path: string; updated: string; bytes: number;
  live: boolean; pid: number; status: string; parent: string | null; kind: string; subagents: number; activity: string; tokens: JTok;
  costUsd: number | null; billing: JBill; unpricedTokens: number; unpricedCredits: number; tools: number; linesAdded: number; linesRemoved: number; attention: boolean; stuck: string | null; skills: SkillUse[];
  alerts: JAl[];
}
interface JAl { rule: string; severity: string; value: number; unit: string; threshold: number; since: string; message: string; labels: { [k: string]: string }; acked: boolean }
interface WAl { rule: string; severity: string; state: string; value: number; threshold: number; labels: { [k: string]: string } }
interface WAlert { ts: string; harness: string; session: string; title: string; project: string; parent: string | null; kind: string; tool: null; text: string; alert: WAl }
function jalerts(as: Alert[]): JAl[] {
  const o: JAl[] = [];
  for (const a of as) { const l: { [k: string]: string } = {}; for (const [k, v] of a.labels) l[k] = v; o.push({ rule: a.rule, severity: a.severity, value: a.value, unit: a.unit, threshold: a.threshold, since: new Date(a.since).toISOString(), message: a.message, labels: l, acked: a.acked }); }
  return o;
}
interface WEv { ts: string; harness: string; session: string; title: string; project: string; parent: string | null; kind: string; tool: string | null; text: string }

// sync write: a closed reader (| head) surfaces as EPIPE here → quiet exit
function out(line: string): void {
  try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); }
}
function fail(msg: string): never { process.stderr.write("agentglass: " + msg + "\n"); process.exit(2); }

function opts(args: string[]): Opts {
  const o: Opts = { live: false, harness: "", limit: 0, subs: false, fromStart: false, filters: [], pinned: false, alerts: true, notify: false, cf: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--live") o.live = true;
    else if (a === "--subagents") o.subs = true;
    else if (a === "--from-start") o.fromStart = true;
    else if (a === "--harness") { o.harness = args[i + 1] ?? ""; i++; if (!isHarness(o.harness)) fail("--harness must be one of " + harnessIds().join(", ")); }
    else if (a === "--limit") { o.limit = Number(args[i + 1] ?? ""); i++; if (!(o.limit > 0)) fail("--limit needs a positive number"); }
    else if (a === "--filter") { if (i + 1 >= args.length) fail("--filter needs an expression, e.g. --filter 'harness is codex'"); o.filters.push(args[i + 1] ?? ""); i++; }
    else if (a === "--pinned") o.pinned = true;
    else if (a === "--no-alerts") o.alerts = false;
    else if (a === "--notify") o.notify = true;
  }
  o.cf = cliFilter(o.filters, o.harness, o.live, o.pinned, args.indexOf("--watch") >= 0);
  return o;
}
function wanted(s: Sess, o: Opts): boolean { const cf = o.cf; return !cf || cliWatchSession(cf, s); }
export function discover(): void { scan(); refreshProcs(); refreshSlow(); buildView(); }

function snapshot(o: Opts): void {
  discover();
  const list: Sess[] = [];
  const cands: Sess[] = []; for (const s of sessions.values()) if (o.subs || s.depth === 0) cands.push(s);
  const cf = o.cf; for (const s of cf ? cliSelect(cf, cands) : cands) list.push(s);
  list.sort((a, b) => b.mtime - a.mtime);
  const res: JSess[] = [];
  for (const s of o.limit > 0 ? list.slice(0, o.limit) : list) {
    loadHead(s); loadTail(s); complete(s);
    res.push({
      id: s.id, harness: s.h, title: titleOf(s), cwd: s.cwd, branch: s.branch, remote: s.remote ? s.remote : null, model: s.model, path: s.path,
      updated: new Date(s.mtime).toISOString(), bytes: s.size, live: livePid(s) > 0, pid: s.pid, status: s.status,
      parent: s.parent ? s.parent : null, kind: s.kind, subagents: s.subs.length, activity: activity(s),
      tokens: { in: s.inTok, out: s.outTok, cacheRead: s.cacheRTok, cacheWrite: s.cacheWTok },
      costUsd: s.cost < 0 ? null : s.cost, billing: { mode: s.bill || "unknown", plan: planLabel(s.plan, REDACT), source: s.billSrc },
      unpricedTokens: s.unkTok, unpricedCredits: s.unkCr, tools: s.tools, linesAdded: s.linesAdd, linesRemoved: s.linesDel,
      attention: s.attention, stuck: s.stuck ? s.stuck : null, skills: skillUses(accOf(s), null), alerts: jalerts(alertsOf(s)),
    });
  }
  out(process.stdout.isTTY ? JSON.stringify(res, null, 2) : JSON.stringify(res));
  if (o.cf && o.cf.needsLedger) for (const f of H.onQuit) f(); // a ledger filter indexed every candidate: keep that work for the next run
  process.exit(0);
}

function oneLine(t: string): string {
  const l = t.replace(/\s+/g, " ").trim();
  return l.length > 500 ? l.slice(0, 500) + "…" : l;
}
function emit(s: Sess, kind: string, tool: string | null, text: string, ts: string): void {
  const w: WEv = {
    ts: ts || new Date().toISOString(), harness: s.h, session: s.id, title: titleOf(s), project: base(s.cwd),
    parent: s.parent ? s.parent : null, kind, tool, text: oneLine(text),
  };
  out(JSON.stringify(w));
}
// a result is filtered with its call's name and arguments (call id → [tool, args]); bounded per run
const calls = new Map<string, string[]>();
function emitEv(s: Sess, e: Ev, cf: CliFilter | null): void {
  const i = e.text.indexOf("\u0000");
  const tool = e.kind === "tool" ? (i >= 0 ? e.text.slice(0, i) : e.text) : "";
  const args = e.kind === "tool" && i >= 0 ? e.text.slice(i + 1) : "";
  if (e.kind === "tool" && e.id) { if (calls.size > 20000) calls.clear(); calls.set(s.path + "\t" + e.id, [tool, args]); }
  const pc = e.kind === "result" && e.id ? calls.get(s.path + "\t" + e.id) : undefined;
  if (cf && !cliWatchEvent(cf, s, e.kind, pc ? pc[0] ?? "" : tool, pc ? pc[1] ?? "" : args)) return;
  if (e.kind !== "tool") { emit(s, e.kind, null, e.text, e.ts); return; }
  emit(s, "tool", tool, args, e.ts);
}

function watch(o: Opts): void {
  discover();
  const off = new Map<string, number>(); // path → next unread byte
  const eps = new Map<string, string>(); // path → the source's cursor epoch off counts in
  const headed = new Set<string>();
  const live = new Map<string, number>(); // path → pid, to report appear/disappear
  for (const s of sessions.values()) {
    off.set(s.path, o.fromStart ? 0 : s.size);
    if (s.pid) live.set(s.path, s.pid);
  }
  const quit = (): void => process.exit(0);
  process.on("SIGINT", quit); process.on("SIGTERM", quit);
  const liveDiff = (): void => {
    for (const s of sessions.values()) {
      if (!s.pid || live.get(s.path) === s.pid) continue;
      live.set(s.path, s.pid);
      if (wanted(s, o) && (!o.cf || cliWatchEvent(o.cf, s, "live", "", ""))) emit(s, "live", null, "pid " + s.pid, "");
    }
    for (const [p, pid] of [...live.entries()]) {
      const s = sessions.get(p);
      if (s && s.pid === pid) continue;
      live.delete(p);
      if (s && (!o.cf || cliWatchExit(o.cf, s))) emit(s, "exit", null, "pid " + pid, "");
    }
  };
  const poll = (): void => {
    for (const s of sessions.values()) {
      let at = off.get(s.path);
      if (at === undefined) { at = 0; off.set(s.path, 0); } // appeared after start: read it whole
      if (!wanted(s, o)) continue;
      const src = sourceOf(s.h);
      const st = src.stat(s);
      if (!st) continue;
      const size = st.size; const ep = epochOf(s); const was = eps.get(s.path); eps.set(s.path, ep);
      if (size < at || (was !== undefined && was !== ep)) { off.set(s.path, size); continue; } // truncated/rewritten/other cursor: resync at the end
      if (size === at) continue;
      if (!headed.has(s.path)) { headed.add(s.path); if (!s.headDone) loadHead(s); loadTail(s); } // title/cwd for the output
      const r = src.lines(s, at, size);
      off.set(s.path, r.next);
      const evs: Ev[] = [];
      for (const l of r.lines) parseEvents(s.h, l, evs, s);
      for (const e of evs) emitEv(s, e, o.cf);
    }
  };
  // the alert rules on every live top-level session, after each process refresh; transitions become alert lines
  const ledAt = new Map<string, number>();
  const alerts = (): void => {
    const rs = rules(); const lk = looker(); const now = Date.now(); const led = ledgerRule(rs);
    for (const s of sessions.values()) {
      if (!watched(s) || !wanted(s, o)) { forgetSession(s.path); continue; }
      if (led && now - (ledAt.get(s.path) ?? 0) >= 10000) { ledAt.set(s.path, now); ledgerComplete(s); } // cost, tokens, call rows
      loadTail(s);
      for (const t of watchStep(s, observeWith(s, lk), rs, now)) {
        const r = ruleOf(rs, t.rule); const a = stateOf(s.path, t.rule); if (!r || !a) continue;
        const msg = render(r, a.v, t.to || t.from, s);
        const l: { [k: string]: string } = {}; for (const [k, v] of r.labels) l[k] = v;
        const w: WAlert = { ts: new Date(t.at).toISOString(), harness: s.h, session: s.id, title: titleOf(s), project: base(s.cwd), parent: s.parent ? s.parent : null, kind: "alert", tool: null,
          text: oneLine(msg), alert: { rule: r.id, severity: severityOf(t.to || t.from), state: t.state, value: t.v, threshold: t.thr, labels: l } };
        out(JSON.stringify(w));
        onTrans(s, r, t, a.acked, true, o.notify, rs.notify, a.v, msg, a.lvAt); // --watch: never bell/desktop; the command with --notify
      }
    }
  };
  poll();
  if (o.alerts) { refreshProcs(); alerts(); }
  let tick = 0;
  setInterval(() => {
    tick++;
    if (tick % 4 === 0) scan();
    if (tick % 3 === 0) { refreshProcs(); liveDiff(); if (o.alerts) alerts(); }
    if (tick % 10 === 0) { refreshSlow(); liveDiff(); }
    poll();
  }, 500);
}

H.cli.push((args: string[]): boolean => {
  if (args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) { out(usage().trimEnd()); return true; }
  if (args.indexOf("--version") >= 0) { out(args.indexOf("--json") >= 0 ? JSON.stringify(versionInfo()) : BUILD.version); return true; }
  if (args.indexOf("--json") >= 0) { S.cli = true; snapshot(opts(args)); return true; } // no toast line: warnings go to stderr
  if (args.indexOf("--watch") >= 0) { S.cli = true; watch(opts(args)); return true; }
  return false;
});
