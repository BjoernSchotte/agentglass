// agentglass — machine-readable CLI: --json snapshot, --watch JSONL event stream, --help, --version (no TTY needed)
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, complete, screenOut, display } from "../hooks.ts";
import { sessions, scan, buildView, loadHead, loadTail, titleOf, activity } from "../model/sessions.ts";
import { refreshProcs, refreshSlow } from "../model/procs.ts";
import { HARNESSES, harnessIds, isHarness, parseEvents, sourceOf, epochOf } from "../harness/index.ts";
import { type Obj, base } from "../util/json.ts";
import type { Ev, Sess } from "../model/types.ts";
import { S } from "../state.ts";
import { BUILD } from "../build-info.ts";
import { versionInfo } from "./version.ts";
import { planLabel } from "./usage/billing.ts";
import { REDACT } from "./redact-on.ts";
import { accOf } from "./usage/ledger.ts";
import { type SkillUse, skillUses } from "./usage/record.ts";
import { type CmdRec, type OptRec, addCmd, opt, textHelp, jsonHelp, cmdText, cmdOf } from "./clihelp.ts";
import { type Scope, agentHost, agentScope, visible, hostObj, cliError, parseDur } from "./agentenv.ts";
import { type Fmt, fmtArgs, formatRows } from "./format.ts";
import { identSync } from "./query/project.ts";
import { labelOf } from "../model/project.ts";
import { keyShown, reposCli } from "./repos/cli.ts";
import { type CliFilter, cliFilter, cliSelect, cliWatchSession, cliWatchEvent, cliWatchExit, filterKeysHelp } from "./query/cli.ts";
import { livePid } from "./query/eval.ts";
import { type Alert, stateOf, render, severityOf } from "./rules/engine.ts";
import { rules } from "./rules/state.ts";
import { onTrans } from "./rules/notify.ts";
import { complete as ledgerComplete } from "./usage/ledger.ts";
import { watched, looker, observeWith, watchStep, forgetSession, ruleOf, ledgerRule, alertsOf } from "./watchdog.ts";

const HARNESS_OPT = opt("--harness", harnessIds().join("|"), "only this harness", "", harnessIds());
const LIVE_OPT = opt("--live", "", "only sessions with a running agent process", "", []);
const LIMIT_OPT = opt("--limit", "N", "--json: at most N sessions", "", []);
const SUBS_OPT = opt("--subagents", "", "--json: include subagent sessions", "", []);
const FROM_OPT = opt("--from-start", "", "--watch: replay existing logs from the beginning (combine with a filter)", "", []);
export const FORMAT_OPT = opt("--format", "json|jsonl|csv|table", "--json: output format (default json)", "", ["json", "jsonl", "csv", "table"]);
export const FIELDS_OPT = opt("--fields", "a,b,c", "--json: only these fields, in this order (tokens_in for nested ones)", "", []);
const ALLP_OPT = opt("--all-projects", "", "inside an agent: every project (default: the current one only)", "", []);
const PONLY_OPT = opt("--project-only", "", "inside an agent: only the current project, over a configured agent.scope all", "", []);
export const FILTER_OPT = opt("--filter", "'<expr>'", "only what matches, e.g. 'repo is x and cost > 2', 'tool is Bash and status is error' (repeatable)", "", []);
const PINNED_OPT = opt("--pinned", "", "also apply the filter pinned in the TUI (P); without it pins are ignored", "", []);
const NOALERTS_OPT = opt("--no-alerts", "", "--watch: no alert lines (the rules engine does not run)", "", []);
const NOTIFY_OPT = opt("--notify", "", "--watch: also run rules.json's notify command on alert transitions", "", []);
const REPOS_OPT = opt("--repos", "", "--json: one object per project instead of sessions (worktrees and clones of one remote merge)", "", []);
const DAYS_OPT = opt("--days", "N", "--repos: the last N days (default 7, 0 = all history); day clauses of --filter narrow it", "7", []);
const FOR_OPT = opt("--for", "<dur>", "--watch: stop after this long (30s, 5m, 1h)", "", []);
const OTLP_OPT = opt("--otlp", "<url>", "--watch: also send each finished turn to this OTLP/HTTP endpoint (--since, --content, --no-subagents, --native, --compression, --batch as for export; JSONL lines then only with --jsonl)", "", []);
const JSONL_OPT = opt("--jsonl", "", "--watch --otlp: also print the JSONL event lines", "", []);
const IDLE_OPT = opt("--until-idle", "", "--watch: stop when no event arrived for 10 s (inside an agent: --for or this)", "", []);
export const JSON_FIELDS = ["id", "harness", "title", "cwd", "branch", "remote", "model", "path", "updated", "bytes", "live", "pid", "status", "parent", "kind", "subagents",
  "activity", "tokens", "costUsd", "billing", "unpricedTokens", "unpricedCredits", "tools", "linesAdded", "linesRemoved", "attention", "stuck", "skills", "repo", "alerts"];
function cmd(c: string, usage: string, summary: string, options: OptRec[], fields: string[]): CmdRec { return { cmd: c, usage, summary, options, fields, group: "cmd" }; }
function optRow(o: OptRec): CmdRec { return { cmd: o.flag, usage: o.flag + (o.arg ? " " + o.arg : ""), summary: o.summary, options: [], fields: [], group: "opt" }; }
addCmd(cmd("", "agentglass", "interactive TUI", [], []));
addCmd(cmd("--theme", "agentglass --theme <name>", "TUI with a color theme", [], []));
addCmd(cmd("--redact", "agentglass --redact", "privacy mode for screencasts: fake titles/projects/content, scrubbed names\n(also AGENTGLASS_REDACT=1; combinable with --json / --watch)", [], []));
addCmd(cmd("--json", "agentglass --json [opts]", "print a JSON snapshot of sessions (newest first) and exit", [LIVE_OPT, HARNESS_OPT, LIMIT_OPT, SUBS_OPT, FILTER_OPT, PINNED_OPT, FORMAT_OPT, FIELDS_OPT, REPOS_OPT, DAYS_OPT, ALLP_OPT, PONLY_OPT], JSON_FIELDS));
addCmd(cmd("--watch", "agentglass --watch [opts]", "stream new events of all agents as JSONL (tail -f for every session)", [LIVE_OPT, HARNESS_OPT, FROM_OPT, FILTER_OPT, PINNED_OPT, NOALERTS_OPT, NOTIFY_OPT, FOR_OPT, IDLE_OPT, ALLP_OPT, PONLY_OPT, OTLP_OPT, JSONL_OPT], []));
addCmd(cmd("cost", "agentglass cost [--json] [--check]", "costs today / 7 days / month by billing mode, unpriced usage, projection, budget\n(--harness h: one harness; --check: exit 3 when over budget)", [HARNESS_OPT], []));
addCmd(cmd("triage", "agentglass triage [opts]", "what is different about a selection (errored calls, $5+ sessions, …) vs the rest or last period\n(--preset errors|slow|long|expensive|failing|period or --select '<expr>'; see agentglass triage --help)", [], []));
addCmd(cmd("compare", "agentglass compare <s1> <s2> [--json]", "A vs B: two sessions or periods side by side (cost, turns, tokens, tools, errors, files, models)\n(--a '<expr>' --b '<expr>' for any two groups, e.g. this week vs last; see agentglass compare --help)", [], []));
addCmd(cmd("rules check", "agentglass rules check [--json]", "validate ~/.agentglass/rules.json (alert rules): effective rules + line:col problems", [], []));
addCmd(cmd("rules defaults", "agentglass rules defaults [--examples]", "print the built-in alert rules as a ready-to-edit rules.json", [], []));
addCmd(cmd("export", "agentglass export --otlp <url> [opts]", "send sessions to an OpenTelemetry (OTLP/HTTP) backend as GenAI traces, one per turn\n(--since 7d|24h|30m|YYYY-MM-DD|all, --until, --harness h, --session id, --filter '<session clauses>',\n--no-subagents, --content (prompts/outputs/tool I/O, off by default), --resend, --dry-run, --batch N,\n--compression gzip|none, --native warn|skip|include, --status, --json; re-runs send nothing twice)", [], []));
addCmd(cmd("--update-prices", "agentglass --update-prices", "fetch the opted-in community price list now (see ~/.agentglass/config.json)", [], []));
addCmd(cmd("--help", "agentglass --help | -h", "this text", [], []));
addCmd(cmd("update", "agentglass update [--channel stable|dev]", "update to the newest release (--tag T, --dry-run, --json, --yes, --rollback, status)", [], []));
addCmd(cmd("--version", "agentglass --version [--json]", "print the version (--json: version, channel, commit, date, platform, install method)", [], []));
for (const o of [LIVE_OPT, HARNESS_OPT, LIMIT_OPT, SUBS_OPT, FROM_OPT, FILTER_OPT, PINNED_OPT, REPOS_OPT, DAYS_OPT, NOALERTS_OPT, NOTIFY_OPT, FORMAT_OPT, FIELDS_OPT, FOR_OPT, IDLE_OPT, ALLP_OPT, PONLY_OPT, OTLP_OPT, JSONL_OPT]) addCmd(optRow(o));
function usage(): string {
  return textHelp(`agentglass ${BUILD.version} (${BUILD.channel}, ${BUILD.commit.slice(0, 8)}, ${BUILD.platform}) — browse, watch and steer coding-agent sessions (${HARNESSES.map((a) => a.label).join(", ")})`,
    `--json --repos fields: key label kind worktrees[{name,top}] sessions live last costUsd unpricedTokens tokens{in,out} calls errors
  errorRate activeMin agentMin files[{path,edits,add,del,harnesses}] outsideFiles byHarness[] branches[]
  (activeMin = union of the sessions' active minutes, agentMin = their sum; errorRate null under 10 calls)

--json fields: id harness title cwd branch remote model path updated bytes live pid status parent kind subagents
  activity tokens{in,out,cacheRead,cacheWrite} costUsd billing{mode,plan,source} unpricedTokens unpricedCredits
  tools linesAdded linesRemoved attention stuck skills[{name,source,n}] repo{key,label,kind,worktree,top,remote}
  alerts[{rule,severity,value,unit,threshold,since,message,labels,acked}] (live sessions; durations s, ratios 0–1, USD)
  (costUsd = API list price, null when only unpriced usage exists; billing.mode = api|plan|metered|gateway|unknown,
  source = session|process|config — config = assumed from the current config files;
  skills source = command: a slash command / $mention, model: the agent chose it;
  repo = the project: worktrees and clones of one remote share key, kind = git|gitdir|path|none, null = no cwd known)
--watch lines: {ts,harness,session,title,project,parent,kind,tool,text}; kind = user|assistant|thinking|tool|result|meta,
  plus live|exit when an agent process appears or disappears, and alert (rules.json transitions: an alert object
  {rule,severity,state,value,threshold,labels}; state = fire|escalate|deescalate|resolve; off with --no-alerts)

filter: key op value [and …]; op = is = is_not != is_one_of is_not_one_of ~ !~ > >= < <=; not / - negates; bare words
  search title, path, id; --json lists sessions with a matching call or day; --watch filters events (event is tool|result|…)
${filterKeysHelp()}

OpenCode sessions are read from its SQLite database with the sqlite3 CLI (AGENTGLASS_SQLITE3 = another command);
  without it, 2.x sessions come from a running \`opencode service\` over HTTP with curl (AGENTGLASS_CURL); with neither
  they are not listed (a warning says so)
`);
}

export interface Opts { live: boolean; harness: string; limit: number; subs: boolean; fromStart: boolean; forMs: number; idle: boolean; f: Fmt; json: boolean; sc: Scope; filters: string[]; pinned: boolean; alerts: boolean; notify: boolean; cf: CliFilter | null; days: number; jsonl: boolean }
// a consumer of the --watch poll loop (the OTLP live export): tick after every poll, stop before exit
export interface Sink { tick: (now: number) => void; stop: () => void }
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
export function fail(msg: string): never { cliError("usage", msg, "", 2); }

export function opts(args: string[]): Opts {
  const o: Opts = { live: false, harness: "", limit: 0, subs: false, fromStart: false, forMs: 0, idle: false, f: fmtArgs(args), json: args.indexOf("--json") >= 0, sc: agentScope(args), filters: [], pinned: false, alerts: true, notify: false, cf: null, days: 7, jsonl: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--live") o.live = true;
    else if (a === "--subagents") o.subs = true;
    else if (a === "--from-start") o.fromStart = true;
    else if (a === "--until-idle") o.idle = true;
    else if (a === "--for") { o.forMs = parseDur(args[i + 1] ?? ""); i++; if (!(o.forMs > 0)) fail("--for needs a duration like 30s, 5m or 1h"); }
    else if (a === "--harness") { o.harness = args[i + 1] ?? ""; i++; if (!isHarness(o.harness)) fail("--harness must be one of " + harnessIds().join(", ")); }
    else if (a === "--limit") { o.limit = Number(args[i + 1] ?? ""); i++; if (!(o.limit > 0)) fail("--limit needs a positive number"); }
    else if (a === "--filter") { if (i + 1 >= args.length) fail("--filter needs an expression, e.g. --filter 'harness is codex'"); o.filters.push(args[i + 1] ?? ""); i++; }
    else if (a === "--pinned") o.pinned = true;
    else if (a === "--no-alerts") o.alerts = false;
    else if (a === "--notify") o.notify = true;
    else if (a === "--days") { const v = args[i + 1] ?? ""; o.days = /^\d+$/.test(v) ? Number(v) : -1; i++; if (o.days < 0) fail("--days needs a number ≥ 0 (0 = all history), e.g. --days 30"); if (args.indexOf("--repos") < 0) fail("--days applies to --repos only: agentglass --json --repos --days " + v); }
    else if (a === "--jsonl") o.jsonl = true;
  }
  o.cf = cliFilter(o.filters, o.harness, o.live, o.pinned, args.indexOf("--watch") >= 0);
  return o;
}
// the filter (with --harness / --live as clauses); inside an agent also only the current project unless widened: titles,
// paths and events go to the agent's model provider
function wanted(s: Sess, o: Opts): boolean { const cf = o.cf; return (!cf || cliWatchSession(cf, s)) && visible(s, o.sc); }
export { usage };
// the --json fields of one session (key order is the output order)
export function jsonSess(s: Sess): Obj {
  return {
    id: s.id, harness: s.h, title: titleOf(s), cwd: s.cwd, branch: s.branch, remote: s.remote ? s.remote : null, model: s.model, path: s.path,
    updated: new Date(s.mtime).toISOString(), bytes: s.size, live: livePid(s) > 0, pid: s.pid, status: s.status,
    parent: s.parent ? s.parent : null, kind: s.kind, subagents: s.subs.length, activity: activity(s),
    tokens: { in: s.inTok, out: s.outTok, cacheRead: s.cacheRTok, cacheWrite: s.cacheWTok },
    costUsd: s.cost < 0 ? null : s.cost, billing: { mode: s.bill || "unknown", plan: planLabel(s.plan, REDACT), source: s.billSrc },
    unpricedTokens: s.unkTok, unpricedCredits: s.unkCr, tools: s.tools, linesAdded: s.linesAdd, linesRemoved: s.linesDel,
    attention: s.attention, stuck: s.stuck ? s.stuck : null, skills: skillUses(accOf(s), null), repo: repoJ(s), alerts: jalerts(alertsOf(s)),
  };
}
// repo: the session's project (repo-view); top = real repo top, remote scrubbed; faked through display() under --redact
function repoJ(s: Sess): Obj | null {
  const id = identSync(s); if (!id) return null;
  return { key: keyShown(id.key), label: display("repo", labelOf(id), s), kind: id.kind, worktree: id.worktree ? display("repo", id.worktree, s) : "",
    top: id.top ? display("cwd", id.top, s) : "", remote: id.remote ? display("remote", id.remote, s) : "" };
}
// table columns of a session list (project = the cwd's last part)
export const TABLE_COLS = ["updated", "harness", "title", "cwd", "costUsd", "tools", "status"];
export function discover(): void { scan(); refreshProcs(); refreshSlow(); buildView(); }

function snapshot(o: Opts): void {
  discover();
  const list: Sess[] = [];
  const cands: Sess[] = []; for (const s of sessions.values()) if ((o.subs || s.depth === 0) && visible(s, o.sc)) cands.push(s);
  const cf = o.cf; for (const s of cf ? cliSelect(cf, cands) : cands) list.push(s);
  list.sort((a, b) => b.mtime - a.mtime);
  const res: Obj[] = [];
  for (const s of o.limit > 0 ? list.slice(0, o.limit) : list) { loadHead(s); loadTail(s); complete(s); res.push(jsonSess(s)); }
  out(formatRows(res, o.f, false, TABLE_COLS, JSON_FIELDS, o.json));
  if (o.cf && o.cf.needsLedger) for (const f of H.onQuit) f(); // a ledger filter indexed every candidate: keep that work for the next run
  process.exit(0);
}

let lastOut = 0; // --until-idle: when the last line went out
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
  lastOut = Date.now();
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

const IDLE_MS = 10000;
// JSONL lines go to stdout unless a sink takes the stream (then only with --jsonl)
export function watch(o: Opts, sink: Sink | null): void {
  // an endless stream ties up the agent's tool call
  if (o.f.fmt || o.f.fields.length) cliError("usage", "--watch always prints JSONL: --format and --fields do not apply", "", 2);
  if (agentHost().on && !o.forMs && !o.idle) cliError("usage", "--watch needs --for <dur> or --until-idle inside an agent", "e.g. --watch --for 30s", 2);
  discover();
  const lines = !sink || o.jsonl;
  const t0 = Date.now(); lastOut = t0;
  const off = new Map<string, number>(); // path → next unread byte
  const eps = new Map<string, string>(); // path → the source's cursor epoch off counts in
  const headed = new Set<string>();
  const live = new Map<string, number>(); // path → pid, to report appear/disappear
  for (const s of sessions.values()) {
    off.set(s.path, o.fromStart ? 0 : s.size);
    if (s.pid) live.set(s.path, s.pid);
  }
  const quit = (): void => { if (sink) sink.stop(); process.exit(0); };
  process.on("SIGINT", quit); process.on("SIGTERM", quit);
  const liveDiff = (): void => {
    for (const s of sessions.values()) {
      if (!s.pid || live.get(s.path) === s.pid) continue;
      live.set(s.path, s.pid);
      if (lines && wanted(s, o) && (!o.cf || cliWatchEvent(o.cf, s, "live", "", ""))) emit(s, "live", null, "pid " + s.pid, "");
    }
    for (const [p, pid] of [...live.entries()]) {
      const s = sessions.get(p);
      if (s && s.pid === pid) continue;
      live.delete(p);
      if (lines && s && visible(s, o.sc) && (!o.cf || cliWatchExit(o.cf, s))) emit(s, "exit", null, "pid " + pid, "");
    }
  };
  const poll = (): void => {
    for (const s of sessions.values()) {
      let at = off.get(s.path);
      if (at === undefined) { at = 0; off.set(s.path, 0); } // appeared after start: read it whole
      if (o.cf && !cliWatchSession(o.cf, s)) continue;
      const src = sourceOf(s.h);
      const st = src.stat(s);
      if (!st) continue;
      const size = st.size; const ep = epochOf(s); const was = eps.get(s.path); eps.set(s.path, ep);
      if (size < at || (was !== undefined && was !== ep)) { off.set(s.path, size); continue; } // truncated/rewritten/other cursor: resync at the end
      if (size === at) continue;
      // scope after the size check: a log without a cwd yet is re-read only while it grows, and stays unread until it has one
      if (!visible(s, o.sc)) { if (s.cwd) off.set(s.path, size); continue; }
      if (!headed.has(s.path)) { headed.add(s.path); if (!s.headDone) loadHead(s); loadTail(s); } // title/cwd for the output
      const r = src.lines(s, at, size);
      off.set(s.path, r.next);
      const evs: Ev[] = [];
      for (const l of r.lines) parseEvents(s.h, l, evs, s);
      if (lines) for (const e of evs) emitEv(s, e, o.cf);
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
        out(JSON.stringify(w)); lastOut = Date.now();
        onTrans(s, r, t, a.acked, true, o.notify, rs.notify, a.v, msg, a.lvAt); // --watch: never bell/desktop; the command with --notify
      }
    }
  };
  if (lines) poll();
  if (o.alerts && lines) { refreshProcs(); alerts(); } // alert lines are JSONL too: with a sink only with --jsonl
  let tick = 0;
  setInterval(() => {
    tick++;
    const now = Date.now();
    if ((o.forMs > 0 && now - t0 >= o.forMs) || (o.idle && now - lastOut >= IDLE_MS)) quit(); // a sink flushes first
    if (tick % 4 === 0) scan();
    if (tick % 3 === 0) { refreshProcs(); liveDiff(); if (o.alerts && lines) alerts(); }
    if (tick % 10 === 0) { refreshSlow(); liveDiff(); }
    if (lines) poll();
    if (sink) sink.tick(Date.now());
  }, 500);
}

// flags that go with any command (they do not name one)
const GLOBAL_FLAGS = ["--agent", "--no-agent", "--redact"];
// --help: text for people; JSON inside an agent or with --format json; "<cmd> --help" = that command only
function help(args: string[]): void {
  const rest = args.filter((a: string) => GLOBAL_FLAGS.indexOf(a) < 0);
  const c = rest.length && !(rest[0] ?? "").startsWith("-") ? rest[0] ?? "" : "";
  const fi = args.indexOf("--format");
  if (agentHost().on || (fi >= 0 && args[fi + 1] === "json")) {
    const j = jsonHelp(c, hostObj(true));
    if (!j) cliError("usage", "unknown command " + c, "agentglass --help lists the commands", 2);
    out(j); return;
  }
  if (!c) { out(usage().trimEnd()); return; }
  const r = cmdOf(c);
  if (!r) cliError("usage", "unknown command " + c, "agentglass --help lists the commands", 2);
  out(cmdText(r));
}
H.cli.push((args: string[]): boolean => {
  if (args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) { help(args); return true; }
  if (args.indexOf("--version") >= 0) { out(args.indexOf("--json") >= 0 ? JSON.stringify(versionInfo()) : BUILD.version); return true; }
  if (args.indexOf("--json") >= 0) { // no toast line: warnings go to stderr
    S.cli = true; const o = opts(args); const cf = o.cf;
    if (args.indexOf("--repos") >= 0) reposCli(o.days, cf ? cf.f : null, cf ? cf.cheap : null, o.sc, o.f, o.json); else snapshot(o);
    return true;
  }
  if (args.indexOf("--repos") >= 0) fail("--repos needs --json: agentglass --json --repos");
  if (args.indexOf("--watch") >= 0) { S.cli = true; watch(opts(args), null); return true; }
  return false;
});
