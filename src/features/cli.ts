// agentglass — machine-readable CLI: --json snapshot, --watch JSONL event stream, --help, --version (no TTY needed)
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, complete, screenOut, display } from "../hooks.ts";
import { sessions, scan, buildView, loadHead, loadTail, titleOf, activity, probeLive } from "../model/sessions.ts";
import { refreshProcs, refreshSlow } from "../model/procs.ts";
import { HARNESSES, harnessIds, isHarness, parseEvents, sourceOf, epochOf, window, harnessOf } from "../harness/index.ts";
import { type Obj, base } from "../util/json.ts";
import type { Ev, Sess } from "../model/types.ts";
import { S } from "../state.ts";
import { parse } from "./query/parse.ts";
import type { Clause } from "./query/types.ts";
import { BUILD } from "../build-info.ts";
import { versionInfo } from "./version.ts";
import { planLabel } from "./usage/billing.ts";
import { REDACT } from "./redact-on.ts";
import { paneOfPid } from "../mux/index.ts";
import { accsOf } from "./usage/ledger.ts";
import { type Acc, type SkLoad, newAcc } from "./usage/record.ts";
import { newRows } from "./usage/rows.ts";
import { skillVis } from "./skills/vis.ts";
import { skillsJson, skillLoadsJson } from "./skills/json.ts";
import { callVis, note, scrub } from "./skills/watchvis.ts";
import { estTopOf } from "./usage/costs.ts";
import { type CmdRec, type OptRec, addCmd, opt, textHelp, jsonHelp, cmdText, cmdOf } from "./clihelp.ts";
import { type Scope, agentHost, agentScope, visible, hostObj, cliError, parseDur } from "./agentenv.ts";
import { argVal, badArg } from "../util/argv.ts";
import { type Fmt, fmtArgs, formatRows } from "./format.ts";
import { identSync } from "./query/project.ts";
import { gitJson, gitCli, peers } from "./vcs/json.ts";
import { saveVcs } from "./vcs/enrich.ts";
import { labelOf } from "../model/project.ts";
import { keyShown, reposCli } from "./repos/cli.ts";
import { type CliFilter, cliFilter, cliSelect, cliWatchSession, cliWatchTrack, cliWatchEvent, cliWatchEv, cliWatchExit, filterKeysHelp } from "./query/cli.ts";
import { type EvX, livePid, evxOf, SKILL_EV } from "./query/eval.ts";
import { type Alert, stateOf, render, severityOf, flags } from "./rules/engine.ts";
import type { AlertT } from "./otlp/logs.ts";
import { rules } from "./rules/state.ts";
import { onTrans } from "./rules/notify.ts";
import { complete as ledgerComplete } from "./usage/ledger.ts";
import { relatedJson } from "./related/cli.ts";
import { relCfg } from "./related/model.ts";
import { section } from "../util/config.ts";
import { LIVE, collectLive } from "./wait/live.ts";
import { watched, looker, observeWith, watchStep, forgetSession, ruleOf, ledgerRule, alertsOf } from "./watchdog.ts";

const HARNESS_OPT = opt("--harness", harnessIds().join("|"), "only this harness", "", harnessIds());
const LIVE_OPT = opt("--live", "", "only sessions with a running agent process", "", []);
const LIMIT_OPT = opt("--limit", "N", "--json: at most N sessions", "", []);
const SUBS_OPT = opt("--subagents", "", "--json: include subagent sessions", "", []);
const FROM_OPT = opt("--from-start", "", "--watch: replay existing logs from the beginning (combine with a filter)", "", []);
export const FORMAT_OPT = opt("--format", "json|jsonl|csv|table", "--json: output format (default json)", "", ["json", "jsonl", "csv", "table"]);
export const FIELDS_OPT = opt("--fields", "a,b,c", "--json: only these fields, in this order (nested: tokens_in, git_commits; lists stay JSON arrays)", "", []);
const ALLP_OPT = opt("--all-projects", "", "inside an agent: every project (default: the current one only)", "", []);
const PONLY_OPT = opt("--project-only", "", "inside an agent: only the current project, over a configured agent.scope all", "", []);
export const FILTER_OPT = opt("--filter", "'<expr>'", "only what matches, e.g. 'repo is x and cost > 2', 'tool is Bash and status is error' (repeatable)", "", []);
const PINNED_OPT = opt("--pinned", "", "also apply the filter pinned in the TUI (P); without it pins are ignored", "", []);
const NOALERTS_OPT = opt("--no-alerts", "", "--watch: no alert lines (the rules engine does not run)", "", []);
const NOTIFY_OPT = opt("--notify", "", "--watch: also run rules.json's notify command on alert transitions", "", []);
const REPOS_OPT = opt("--repos", "", "--json: one object per project instead of sessions (worktrees and clones of one remote merge)", "", []);
const DAYS_OPT = opt("--days", "N", "--repos: the last N days (default 7, 0 = all history); day clauses of --filter narrow it", "7", []);
const FOR_OPT = opt("--for", "<dur>", "--watch: stop after this long (30s, 5m, 1h)", "", []);
const CONTENT_OPT = opt("--content", "", "--json --fields skillLoads: also each load's skill text (hidden by --redact and skills.hide)", "", []);
const OTLP_OPT = opt("--otlp", "<url>", "--watch: also send each finished turn to this OTLP/HTTP endpoint, plus a logs stream of live state (heartbeat, session state, turn.open, alerts) to its /v1/logs (--since, --filter, --pinned, --harness, --content, --detail, --no-subagents, --native, --compression, --batch as for export; the filter is judged again on every poll; JSONL lines then only with --jsonl)", "", []);
const NOLOGS_OPT = opt("--no-logs", "", "--watch --otlp: send no logs stream (also otlp.logs: false)", "", []);
const JSONL_OPT = opt("--jsonl", "", "--watch --otlp: also print the JSONL event lines", "", []);
const GIT_OPT = opt("--git", "", "--json: run git log for each listed session's commits (full sha, +add −del, present|missing|elsewhere)", "", []);
const RELATED_OPT = opt("--related", "<session>", "--json: everything ±N min around an event in the same project, all sessions and harnesses, conflicts flagged", "", []);
const EVENT_OPT = opt("--event", "<id>", "--related: anchor on this tool call id (default: the session's last event)", "", []);
const AT_OPT = opt("--at", "<iso>", "--related: anchor on the first event at/after this time", "", []);
const MINUTES_OPT = opt("--minutes", "N", "--related: window ±N minutes, 1–240 (default related.minutes, 10)", "10", []);
const IDLE_OPT = opt("--until-idle", "", "--watch: stop when no event arrived for 10 s (inside an agent: --for or this)", "", []);
export const JSON_FIELDS = ["id", "harness", "title", "cwd", "branch", "remote", "model", "path", "updated", "bytes", "live", "pid", "status", "mux", "parent", "kind", "subagents", "twins",
  "activity", "tokens", "costUsd", "costEstimatedUsd", "billing", "unpricedTokens", "unpricedCredits", "tools", "linesAdded", "linesRemoved", "attention", "stuck", "skills", "repo", "alerts", "git"];
function cmd(c: string, usage: string, summary: string, options: OptRec[], fields: string[]): CmdRec { return { cmd: c, usage, summary, options, fields, group: "cmd" }; }
function optRow(o: OptRec): CmdRec { return { cmd: o.flag, usage: o.flag + (o.arg ? " " + o.arg : ""), summary: o.summary, options: [], fields: [], group: "opt" }; }
addCmd(cmd("", "agentglass", "interactive TUI", [], []));
addCmd(cmd("--theme", "agentglass --theme <name>", "TUI with a color theme", [], []));
addCmd(cmd("--redact", "agentglass --redact", "privacy mode for screencasts: fake titles/projects/content, scrubbed names\n(also AGENTGLASS_REDACT=1; combinable with --json / --watch)", [], []));
addCmd(cmd("--json", "agentglass --json [opts]", "print a JSON snapshot of sessions (newest first) and exit", [LIVE_OPT, HARNESS_OPT, LIMIT_OPT, SUBS_OPT, FILTER_OPT, PINNED_OPT, FORMAT_OPT, FIELDS_OPT, REPOS_OPT, DAYS_OPT, RELATED_OPT, EVENT_OPT, AT_OPT, MINUTES_OPT, GIT_OPT, ALLP_OPT, PONLY_OPT, CONTENT_OPT], JSON_FIELDS));
addCmd(cmd("--watch", "agentglass --watch [opts]", "stream new events of all agents as JSONL (tail -f for every session)", [LIVE_OPT, HARNESS_OPT, FROM_OPT, FILTER_OPT, PINNED_OPT, NOALERTS_OPT, NOTIFY_OPT, FOR_OPT, IDLE_OPT, ALLP_OPT, PONLY_OPT, OTLP_OPT, JSONL_OPT, NOLOGS_OPT], []));
addCmd(cmd("cost", "agentglass cost [--json] [--check]", "costs today / 7 days / month by billing mode, unpriced usage, projection, budget\n(--harness h: one harness; --check: exit 3 when over budget)", [HARNESS_OPT], []));
addCmd(cmd("prices", "agentglass prices [--unpriced]", "model prices: list/set/alias/unset; every model seen with its price and source\n(user, alias, gateway, community, built-in, harness, unpriced)\n(--since today|<n>d|YYYY-MM-DD, --json; --unpriced exits 4 when a model has no price; see agentglass prices --help)", [], []));
addCmd(cmd("prices set", "agentglass prices set <model> --in <$> --out <$>", "price a model ($/Mtok) in prices.json (--cache-read, --cache-write, --cache-write-1h; history re-prices, no re-index)", [], []));
addCmd(cmd("prices alias", "agentglass prices alias <model> <target>", "price a model like another one (an estimate: its cost shows ≈)", [], []));
addCmd(cmd("prices unset", "agentglass prices unset <model>", "remove a model's price or alias from prices.json", [], []));
addCmd(cmd("triage", "agentglass triage [opts]", "what is different about a selection (errored calls, $5+ sessions, …) vs the rest or last period\n(--preset errors|slow|long|expensive|failing|period or --select '<expr>'; see agentglass triage --help)", [], []));
addCmd(cmd("compare", "agentglass compare <s1> <s2> [--json]", "A vs B: two sessions or periods side by side (cost, turns, tokens, tools, errors, files, models)\n(--a '<expr>' --b '<expr>' for any two groups, e.g. this week vs last; see agentglass compare --help)", [], []));
addCmd(cmd("rules check", "agentglass rules check [--json]", "validate ~/.agentglass/rules.json (alert rules): effective rules + line:col problems", [], []));
addCmd(cmd("rules defaults", "agentglass rules defaults [--examples]", "print the built-in alert rules as a ready-to-edit rules.json", [], []));
addCmd(cmd("export", "agentglass export --otlp <url> [opts]", "send sessions to an OpenTelemetry (OTLP/HTTP) backend as GenAI traces, one per turn\n(--since 7d|24h|30m|YYYY-MM-DD|all, --until, --harness h, --session id, --filter '<session clauses>',\n--no-subagents, --content (prompts/outputs/tool I/O, off by default), --detail none|meta (shell command, file path),\n--resend, --dry-run, --batch N, --compression gzip|none, --native warn|skip|include, --status, --json;\nre-runs send nothing twice; otlp.tls for a CA / client certificate)", [], []));
addCmd(cmd("--update-prices", "agentglass --update-prices", "fetch the opted-in community price list now (see ~/.agentglass/config.json)", [], []));
addCmd(cmd("--help", "agentglass --help | -h", "this text", [], []));
addCmd(cmd("update", "agentglass update [--channel stable|dev]", "update to the newest release (--tag T, --dry-run, --json, --yes, --rollback, status)", [], []));
addCmd(cmd("--version", "agentglass --version [--json]", "print the version (--json: version, channel, commit, date, platform, install method, contract = the CLI contract, docs/cli-contract.md)", [], ["version", "channel", "commit", "date", "platform", "installMethod", "contract"]));
for (const o of [LIVE_OPT, HARNESS_OPT, LIMIT_OPT, SUBS_OPT, FROM_OPT, FILTER_OPT, PINNED_OPT, REPOS_OPT, DAYS_OPT, RELATED_OPT, EVENT_OPT, AT_OPT, MINUTES_OPT, GIT_OPT, NOALERTS_OPT, NOTIFY_OPT, FORMAT_OPT, FIELDS_OPT, FOR_OPT, IDLE_OPT, ALLP_OPT, PONLY_OPT, OTLP_OPT, JSONL_OPT, NOLOGS_OPT]) addCmd(optRow(o));
function usage(): string {
  return textHelp(`agentglass ${BUILD.version} (${BUILD.channel}, ${BUILD.commit.slice(0, 8)}, ${BUILD.platform}) — browse, watch and steer coding-agent sessions (${HARNESSES.map((a) => a.label).join(", ")})`,
    `--json --repos fields: key label kind worktrees[{name,top}] sessions live last costUsd unpricedTokens tokens{in,out} calls errors
  errorRate activeMin agentMin files[{path,edits,add,del,harnesses}] outsideFiles byHarness[] branches[{branch,sessions,commits,costUsd}]
  commits costPerCommit spendWithoutCommits prs[]
  (activeMin = union of the sessions' active minutes, agentMin = their sum; errorRate null under 10 calls;
  commits = the sessions' own ✓ commits in the period, costPerCommit = cost of the sessions that committed ÷ commits)

--json --related <session> fields: anchor{session,harness,t,kind,text} project{key,label} from to more capped
  sessions[{id,harness,title,worktree}] events[{t,session,harness,title,kind,tool,text,files[],err,self,conflict}]
  (more = candidate sessions beyond the 40 read; capped = the 16 MB read budget ended reading early)
  (kind = prompt|write|shell|read|agent|web|mcp|alert|commit; session null = a reflog commit no session observed;
  conflict = {kind: conflict|overlap|clobber, with: [session ids]} or null; config related.minutes, related.conflictMinutes)

--json fields: id harness title cwd branch remote model path updated bytes live pid status mux{kind,pane,workspace,tab,status} parent kind subagents twins
  activity tokens{in,out,cacheRead,cacheWrite} costUsd costEstimatedUsd billing{mode,plan,source} unpricedTokens unpricedCredits
  tools linesAdded linesRemoved attention stuck skills[{name,source,n,loads,tokens,costUsd,carryUsd,tailUsd,size,tier,hash,scope,dir}]
  repo{key,label,kind,worktree,top,remote}
  alerts[{rule,severity,value,unit,threshold,since,message,labels,acked}] (live sessions; durations s, ratios 0–1, USD)
  git{commits[{sha,branch,subject,at,how,counted,status,merge,add,del}],produced,prs[{url,number,how}],issues[],links[{url,how}],
  costPerCommit,noReflog} (null = no git worktree; how = observed ✓ | reflog ≈ | shared — only observed is counted;
  status = present|missing|amended|elsewhere — without --git "unknown" (elsewhere: a banner sha not in the repo) and
  add/del null; subagents' commits count for the parent)
  (mux = the live agent's tmux or herdr pane, null = no live process or in neither; workspace/tab = herdr labels, null under
  --redact; status = herdr's idle|working|blocked|done|unknown; csv/--fields: mux_kind mux_pane mux_workspace mux_tab mux_status)
  (costUsd = API list price, null when only unpriced usage exists; costEstimatedUsd = its share priced through a
  prices.json alias (an estimate); twins = other rows of this session (Claude: one session under several project dirs,
  a resume elsewhere copies its log): they carry the same tokens and cost, each message once — count one row per
  harness:id, or sum agentglass cost; at most one of them is live; billing.mode = api|plan|metered|gateway|unknown,
  source = session|process|config — config = assumed from the current config files;
  skills source = command: a slash command / $mention, model: the agent chose it (or read its SKILL.md); tokens{load,carry,tail} and $
  of those loads (agentglass skills --help); --fields skillLoads adds the session's load timeline (its text with --content);
  repo = the project: worktrees and clones of one remote share key, kind = git|gitdir|path|none, null = no cwd known)
--watch lines: {ts,harness,session,title,project,parent,kind,kinds,tool,id,text}; kind = user|assistant|thinking|tool|result|meta,
  kinds = the event kinds the TUI filters on (prompt, reply, shell:test, edit, mcp:<server>, skill:load, error …),
  plus live|exit when an agent process appears or disappears, and alert (rules.json transitions: an alert object
  {rule,severity,state,value,threshold,labels}; state = fire|escalate|deescalate|resolve; off with --no-alerts);
  id = the tool call id on tool|result lines (what --related --event and open <ref>#call= take), else null
  skill|skill_end lines: a skill entered or left a context, with skill{name,trigger,size,tier,hash,scope,why}

filter: key op value [and …]; op = is = is_not != is_one_of is_not_one_of ~ !~ > >= < <=; not / - negates; bare words
  search title, path, id; --json lists sessions with a matching call, day or event; --watch filters events
  (event.kind is shell · event.kind is_one_of mcp, error · mcp.server is github · shell.family ~ test; the old
  event is tool|result|alert|… still works; agentglass events <ref> lists one session's events the same way)
${filterKeysHelp()}

OpenCode sessions are read from its SQLite database with the sqlite3 CLI (AGENTGLASS_SQLITE3 = another command);
  without it, 2.x sessions come from a running \`opencode service\` over HTTP with curl (AGENTGLASS_CURL); with neither
  they are not listed (a warning says so)
`);
}

export interface Opts { git: boolean; live: boolean; harness: string; limit: number; subs: boolean; fromStart: boolean; forMs: number; idle: boolean; f: Fmt; json: boolean; sc: Scope; filters: string[]; pinned: boolean; alerts: boolean; notify: boolean; cf: CliFilter | null; days: number; jsonl: boolean; every: number[] }
// a consumer of the --watch poll loop (the OTLP live export): tick after every poll, stop before exit, alert per rules
// transition of a watched top-level session (the rules run for a sink unless --no-alerts, JSONL lines or not)
export interface Sink { tick: (now: number) => void; stop: () => void; alert: (s: Sess, a: AlertT) => void }
interface JAl { rule: string; severity: string; value: number; unit: string; threshold: number; since: string; message: string; labels: { [k: string]: string }; acked: boolean }
interface WAl { rule: string; severity: string; state: string; value: number; threshold: number; labels: { [k: string]: string } }
interface WAlert { ts: string; harness: string; session: string; title: string; project: string; parent: string | null; kind: string; kinds: string[]; tool: null; id: null; text: string; alert: WAl }
function jalerts(as: Alert[]): JAl[] {
  const o: JAl[] = [];
  for (const a of as) { const l: { [k: string]: string } = {}; for (const [k, v] of a.labels) l[k] = v; o.push({ rule: a.rule, severity: a.severity, value: a.value, unit: a.unit, threshold: a.threshold, since: new Date(a.since).toISOString(), message: a.message, labels: l, acked: a.acked }); }
  return o;
}
// id: the tool call id of a tool/result line (what --related --event and open #call= take), else null
// kinds: the event's kinds (skill-usage §5a: prompt, reply, shell:test, mcp:<server>, error …), the same as the TUI's filter
interface WEv { ts: string; harness: string; session: string; title: string; project: string; parent: string | null; kind: string; kinds: string[]; tool: string | null; id: string | null; text: string }

// sync write: a closed reader (| head) surfaces as EPIPE here → quiet exit
function out(line: string): void {
  try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); }
}
export function fail(msg: string): never { cliError("usage", msg, "", 2); }

export function opts(args: string[]): Opts {
  const o: Opts = { git: args.indexOf("--git") >= 0, live: false, harness: "", limit: 0, subs: false, fromStart: false, forMs: 0, idle: false, f: fmtArgs(args), json: args.indexOf("--json") >= 0, sc: agentScope(args), filters: [], pinned: false, alerts: true, notify: false, cf: null, days: 7, jsonl: false, every: [4, 3, 10] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--live") o.live = true;
    else if (a === "--subagents") o.subs = true;
    else if (a === "--from-start") o.fromStart = true;
    else if (a === "--until-idle") o.idle = true;
    else if (a === "--for") { o.forMs = parseDur(argVal(args, i) ?? ""); i++; if (!(o.forMs > 0)) fail("--for needs a duration like 30s, 5m or 1h"); }
    else if (a === "--harness") { o.harness = argVal(args, i) ?? ""; i++; if (!isHarness(o.harness)) fail("--harness must be one of " + harnessIds().join(", ")); }
    else if (a === "--limit") { o.limit = Number(argVal(args, i) ?? ""); i++; if (!(o.limit > 0)) fail("--limit needs a positive number"); }
    else if (a === "--filter") { const v = argVal(args, i); if (v === null) fail("--filter needs an expression, e.g. --filter 'harness is codex'"); o.filters.push(String(v)); i++; }
    else if (a === "--pinned") o.pinned = true;
    else if (a === "--no-alerts") o.alerts = false;
    else if (a === "--notify") o.notify = true;
    else if (a === "--days") { const v = argVal(args, i) ?? ""; o.days = /^\d+$/.test(v) ? Number(v) : -1; i++; if (o.days < 0) fail("--days needs a number ≥ 0 (0 = all history), e.g. --days 30"); if (args.indexOf("--repos") < 0) fail("--days applies to --repos only: agentglass --json --repos --days " + v); }
    else if (a === "--jsonl") o.jsonl = true;
  }
  // a session clause resolves its value against the sessions (query/session.ts): they are discovered first, else every
  // reference is "no such session"
  if (o.filters.some((e: string) => parse(e).cs.some((c: Clause) => c.key === "session")) || (o.pinned && S.pins.some((c: Clause) => c.key === "session"))) discover();
  o.cf = cliFilter(o.filters, o.harness, o.live, o.pinned, args.indexOf("--watch") >= 0);
  return o;
}
// the filter (with --harness / --live as clauses); inside an agent also only the current project unless widened: titles,
// paths and events go to the agent's model provider
function wanted(s: Sess, o: Opts): boolean { const cf = o.cf; return (!cf || cliWatchSession(cf, s)) && visible(s, o.sc); }
export { usage };
// the --json fields of one session (key order is the output order)
export function jsonSess(s: Sess): Obj {
  const skills = skillsJson(accsOf(s)); // first: a hidden skill's name is scrubbed from the title too
  return {
    id: s.id, harness: s.h, title: scrub(titleOf(s)), cwd: s.cwd, branch: s.branch, remote: s.remote ? s.remote : null, model: s.model, path: display("path", s.path, s),
    updated: new Date(s.mtime).toISOString(), bytes: s.size, live: livePid(s) > 0, pid: s.pid, status: s.status, mux: muxJson(s),
    parent: s.parent ? s.parent : null, kind: s.kind, subagents: s.subs.length, twins: s.twins, activity: activity(s),
    tokens: { in: s.inTok, out: s.outTok, cacheRead: s.cacheRTok, cacheWrite: s.cacheWTok },
    costUsd: s.cost < 0 ? null : s.cost, costEstimatedUsd: Math.round(estTopOf(accsOf(s)).usd * 1e6) / 1e6, billing: { mode: s.bill || "unknown", plan: planLabel(s.plan, REDACT), source: s.billSrc },
    unpricedTokens: s.unkTok, unpricedCredits: s.unkCr, tools: s.tools, linesAdded: s.linesAdd, linesRemoved: s.linesDel,
    attention: s.attention, stuck: s.stuck ? s.stuck : null, skills, repo: repoJ(s), alerts: jalerts(alertsOf(s)), git: gitJson(s),
  };
}
// mux: the live agent's multiplexer pane (a subagent: its parent's); labels are user text, hidden under --redact
export const MUX_FLAT = ["mux_kind", "mux_pane", "mux_workspace", "mux_tab", "mux_status"]; // --fields names (csv columns), valid when every mux is null too
function muxJson(s: Sess): Obj | null {
  const pid = livePid(s); if (!pid) return null;
  const p = paneOfPid(pid); if (p.kind === "none") return null;
  return { kind: p.kind, pane: p.id, workspace: REDACT || !p.ws ? null : p.ws, tab: REDACT || !p.tab ? null : p.tab, status: p.kind === "herdr" && p.status ? p.status : null };
}
// repo: the session's project (repo-view); top = real repo top, remote scrubbed; faked through display() under --redact
function repoJ(s: Sess): Obj | null {
  const id = identSync(s); if (!id) return null;
  return { key: keyShown(id.key), label: display("repo", labelOf(id), s), kind: id.kind, worktree: id.worktree ? display("repo", id.worktree, s) : "",
    top: id.top ? display("cwd", id.top, s) : "", remote: id.remote ? display("remote", id.remote, s) : "" };
}
// table columns of a session list (project = the cwd's last part)
export const TABLE_COLS = ["updated", "harness", "title", "cwd", "costUsd", "tools", "status"];
function sessByRef(id: string): Sess | null { const i = id.indexOf(":"); for (const x of sessions.values()) if (x.h === id.slice(0, i) && x.id === id.slice(i + 1)) return x; return null; }
export function discover(): void { scan(); refreshProcs(); refreshSlow(); buildView(); }

function snapshot(o: Opts): void {
  discover();
  const list: Sess[] = [];
  const cands: Sess[] = []; for (const s of sessions.values()) if ((o.subs || s.depth === 0) && visible(s, o.sc)) cands.push(s);
  const cf = o.cf; for (const s of cf ? cliSelect(cf, cands) : cands) list.push(s);
  list.sort((a, b) => b.mtime - a.mtime);
  const res: Obj[] = [];
  const sel = o.limit > 0 ? list.slice(0, o.limit) : list;
  // everything indexed first (git: each worktree's peers too), then the rows: the git attribution is built once, not
  // again for every session that changed the picture
  for (const s of sel) { loadHead(s); loadTail(s, true); complete(s); for (const c of s.subs) complete(c); peers(s); }
  const loadsF = o.f.fields.indexOf("skillLoads") >= 0; const content = process.argv.indexOf("--content") >= 0;
  for (const s of sel) {
    const r = jsonSess(s);
    if (loadsF) { const as: Acc[] = []; const ids: string[] = []; const add = (x: Sess): void => { for (const a of accsOf(x)) { as.push(a); ids.push(x.h + ":" + x.id); } for (const c of x.subs) add(c); }; add(s); r["skillLoads"] = skillLoadsJson(s, as, ids, content, sessByRef); }
    res.push(r);
  }
  if (o.git) saveVcs(); // closed sessions' git log results: the next run reads them instead of spawning
  out(formatRows(res, o.f, false, TABLE_COLS, JSON_FIELDS.concat(MUX_FLAT, ["skillLoads"]), o.json));
  if (o.cf && o.cf.needsLedger) for (const f of H.onQuit) f(); // a ledger filter indexed every candidate: keep that work for the next run
  process.exit(0);
}

let lastOut = 0; // --until-idle: when the last line went out
function oneLine(t: string): string {
  const l = t.replace(/\s+/g, " ").trim();
  return l.length > 500 ? l.slice(0, 500) + "…" : l;
}
function emit(s: Sess, kind: string, tool: string | null, text: string, ts: string, id: string, kinds: string[]): void {
  const w: WEv = {
    ts: ts || new Date().toISOString(), harness: s.h, session: s.id, title: scrub(titleOf(s)), project: base(s.cwd),
    parent: s.parent ? s.parent : null, kind, kinds, tool: tool === null ? null : display("tool", tool, s), id: id ? id : null, text: scrub(oneLine(text)),
  };
  out(JSON.stringify(w));
  lastOut = Date.now();
}
// a result is filtered with its call's name and arguments (call id → [tool, args]); bounded per run. A call that loads a
// hidden skill (skills.hide, --redact) shows as callVis says: dropped, its name faked, its result's text hidden
const calls = new Map<string, string[]>();
function emitEv(s: Sess, e: Ev, cf: CliFilter | null): void {
  const i = e.text.indexOf("\u0000");
  const tool = e.kind === "tool" ? (i >= 0 ? e.text.slice(0, i) : e.text) : "";
  const args = e.kind === "tool" && i >= 0 ? e.text.slice(i + 1) : "";
  if (e.kind === "tool" && e.id) { if (calls.size > 20000) calls.clear(); calls.set(s.path + "\t" + e.id, [tool, args]); }
  const pc = e.kind === "result" && e.id ? calls.get(s.path + "\t" + e.id) : undefined;
  const call: Ev | null = pc ? { kind: "tool", text: (pc[0] ?? "") + "\u0000" + (pc[1] ?? ""), ts: "", id: e.id, full: "" } : null;
  const x = evxOf(e, call, null); // its kinds (a result: its call's, plus error when it failed)
  if (cf && !cliWatchEv(cf, s, x)) return;
  const id = e.kind === "tool" || e.kind === "result" ? e.id : "";
  const cv = callVis(e.kind === "tool" ? tool : pc ? pc[0] ?? "" : "", e.kind === "tool" ? args : pc ? pc[1] ?? "" : "");
  if (cv.drop) return;
  if (e.kind !== "tool") { emit(s, e.kind, null, cv.hide || e.text, e.ts, id, x.kinds); return; }
  emit(s, "tool", tool, cv.args, e.ts, id, x.kinds);
}

// skill loads in the stream: each watched log's new lines also go through its harness's usage() into a small per-log
// record (only lines that can start, carry or end a load); new loads print as kind "skill", ended ones as "skill_end"
interface WSk { name: string; trigger: string; size: number; tier: string; hash: string; scope: string; why: string }
interface WSkEv { ts: string; harness: string; session: string; title: string; project: string; parent: string | null; kind: string; kinds: string[]; tool: null; id: string | null; text: string; skill: WSk }
// a skill line as the event-kind filter sees it (event.kind is skill / skill:load / skill:unload)
// (tool = SKILL_EV + the real name, args = the trigger: the skill and skill.trigger keys match on it)
function skX(kind: string, name: string, trig: string): EvX { return { raw: kind, kinds: [kind === "skill" ? "skill:load" : "skill:unload"], tool: SKILL_EV + name, args: trig, server: "", fam: "", err: 0 }; }
const WSKILL = new Map<string, Acc>(); // log → its record
const SK_MARKS = ["kill", "SKILL.md", "ompact", "<command-name>", "<skills_instructions>"];
const WENDED = new Set<string>(); // "<log>\t<load index>" of unloads already printed
// the skill lines one log line makes (printed after that line's events; the names they load are noted first, so the
// line's own events and titles already hide them)
function skillWatch(s: Sess, l: string, show: boolean, cf: CliFilter | null): WSkEv[] {
  const outL: WSkEv[] = [];
  let a = WSKILL.get(s.path);
  if (!a) { if (WSKILL.size > 2000) WSKILL.clear(); a = newAcc(); a.ro = true; a.sub = s.parent !== ""; WSKILL.set(s.path, a); }
  let hit = a.skr.size > 0 || a.pk !== ""; if (!hit) for (const m of SK_MARKS) if (l.indexOf(m) >= 0) { hit = true; break; }
  if (!hit) return outL;
  const n0 = a.sk.length;
  harnessOf(s.h).usage(a, l);
  a.days.clear(); a.rows = newRows(); // only the skill state is kept
  for (let i = 0; i < a.sk.length; i++) {
    const x = a.sk[i] as SkLoad;
    const isNew = i >= n0; const k = s.path + "\t" + String(i); const isEnd = x.end !== 0 && !WENDED.has(k);
    if (!isNew && !isEnd) continue;
    if (isEnd) { if (WENDED.size > 100000) WENDED.clear(); WENDED.add(k); }
    note(x.name);
    const v = skillVis(x.name); if (!show || v.mode === "omit") continue;
    const sk: WSk = { name: v.shown, trigger: x.trig, size: x.S, tier: x.S < 0 ? "?" : x.est ? "≈" : "exact", hash: x.hash, scope: x.scope, why: x.why };
    if (isNew && (!cf || cliWatchEv(cf, s, skX("skill", x.name, x.trig)))) outL.push(wsk(s, "skill", x.t, sk, v.shown + " loaded (" + x.trig + ")"));
    if (isEnd && (!cf || cliWatchEv(cf, s, skX("skill_end", x.name, x.trig)))) outL.push(wsk(s, "skill_end", x.end, sk, v.shown + " out (" + x.why + ")"));
  }
  return outL;
}
function wsk(s: Sess, kind: string, t: number, sk: WSk, text: string): WSkEv {
  return { ts: t > 1 ? new Date(t).toISOString() : new Date().toISOString(), harness: s.h, session: s.id, title: titleOf(s), project: base(s.cwd), parent: s.parent ? s.parent : null, kind, kinds: [kind === "skill" ? "skill:load" : "skill:unload"], tool: null, id: null, text, skill: sk };
}
function printSk(ws: WSkEv[]): void { for (let i = 0; i < ws.length; i++) { const w = ws[i] as WSkEv; w.title = scrub(w.title); out(JSON.stringify(w)); lastOut = Date.now(); } }

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
      if (lines && wanted(s, o) && (!o.cf || cliWatchEvent(o.cf, s, "live", "", ""))) emit(s, "live", null, "pid " + s.pid, "", "", ["live"]);
    }
    for (const [p, pid] of [...live.entries()]) {
      const s = sessions.get(p);
      if (s && s.pid === pid) continue;
      live.delete(p);
      if (lines && s && visible(s, o.sc) && (!o.cf || cliWatchExit(o.cf, s))) emit(s, "exit", null, "pid " + pid, "", "", ["exit"]);
    }
  };
  const poll = (): void => {
    for (const s of sessions.values()) {
      let at = off.get(s.path);
      if (at === undefined) { at = 0; off.set(s.path, 0); } // appeared after start: read it whole
      // judged out: still read (it may come in; nothing is printed meanwhile); not judgeable yet: unread, printed once it is
      if (o.cf && !cliWatchSession(o.cf, s) && !cliWatchTrack(o.cf, s)) continue;
      const src = sourceOf(s.h);
      const st = src.stat(s);
      if (!st) continue;
      const size = st.size; const ep = epochOf(s); const was = eps.get(s.path); eps.set(s.path, ep);
      if (size < at || (was !== undefined && was !== ep)) { off.set(s.path, size); continue; } // truncated/rewritten/other cursor: resync at the end
      if (size === at) continue;
      // scope after the size check: a log without a cwd yet is re-read only while it grows, and stays unread until it has one
      if (!visible(s, o.sc)) { if (s.cwd) off.set(s.path, size); continue; }
      if (!headed.has(s.path)) { headed.add(s.path); if (!s.headDone) loadHead(s); loadTail(s); } // title/cwd for the output
      // in ≤ 4 MB windows (memory stays bounded on a big growth or --from-start); a longer line widens the window up to
      // 64 MB, a line over that is skipped (as the ledger skips one) instead of stalling the session
      for (let p = at; p < size;) {
        let w = window(src, 4194304); let r = src.lines(s, p, Math.min(size, p + w));
        while (r.next <= p && p + w < size && w < window(src, 67108864)) { w *= 4; r = src.lines(s, p, Math.min(size, p + w)); }
        if (r.next <= p) { if (p + w < size) { p = src.align(s, p + w); off.set(s.path, p); continue; } break; } // a partial last line: next poll
        p = r.next; off.set(s.path, p);
        const per: Ev[][] = [];
        for (const l of r.lines) { const evs: Ev[] = []; parseEvents(s.h, l, evs, s); per.push(evs); }
        // judged again on what these lines brought (an agent's log follows it to another cwd): none of a session the filter
        // no longer takes is printed. Skill loads and unloads go out right after the events of the line that made them
        const show = lines && (!o.cf || cliWatchSession(o.cf, s)) && visible(s, o.sc);
        for (let k = 0; k < r.lines.length; k++) { const ws = skillWatch(s, r.lines[k] ?? "", show, o.cf); if (show) for (const e of per[k] ?? []) emitEv(s, e, o.cf); printSk(ws); }
      }
    }
  };
  // the alert rules on every live top-level session, after each process refresh; transitions become alert lines
  const ledAt = new Map<string, number>();
  const alerts = (): void => {
    const rs = rules(); const lk = looker(); const now = Date.now(); const led = ledgerRule(rs);
    // agent-wait: heavy commands on this host, as the TUI's tick collects them (contention metrics are host-wide: every
    // watched session counts, whatever the filter shows)
    const ws: Sess[] = []; for (const s of sessions.values()) if (watched(s)) ws.push(s);
    LIVE.cur = collectLive(ws, lk.kids, now); LIVE.ver++;
    for (const s of sessions.values()) {
      if (!watched(s) || !wanted(s, o)) { if (s.attention || s.stuck) { s.attention = false; s.stuck = ""; } forgetSession(s.path); continue; } // as the TUI: an ended session keeps no flag
      if (led && now - (ledAt.get(s.path) ?? 0) >= 10000) { ledAt.set(s.path, now); ledgerComplete(s); } // cost, tokens, call rows
      loadTail(s);
      // judged again on what the tail brought (it may have left the filter since); event/call clauses: an alert line is an event too
      const shown = !o.cf || (cliWatchSession(o.cf, s) && cliWatchEvent(o.cf, s, "alert", "", ""));
      for (const t of watchStep(s, observeWith(s, lk), rs, now)) {
        const r = ruleOf(rs, t.rule); const a = stateOf(s.path, t.rule); if (!r || !a) continue;
        const msg = render(r, a.v, t.to || t.from, s);
        const l: { [k: string]: string } = {}; for (const [k, v] of r.labels) l[k] = v;
        const w: WAlert = { ts: new Date(t.at).toISOString(), harness: s.h, session: s.id, title: titleOf(s), project: base(s.cwd), parent: s.parent ? s.parent : null, kind: "alert", kinds: ["alert"], tool: null, id: null,
          text: oneLine(msg), alert: { rule: r.id, severity: severityOf(t.to || t.from), state: t.state, value: t.v, threshold: t.thr, labels: l } };
        if (shown && lines) { out(JSON.stringify(w)); lastOut = Date.now(); }
        if (sink) { const ls: string[][] = []; for (const [k, v] of r.labels) ls.push([k, v]); sink.alert(s, { rule: r.id, severity: w.alert.severity, state: t.state, value: t.v, threshold: t.thr, labels: ls, message: oneLine(msg) }); }
        onTrans(s, r, t, a.acked, true, o.notify, rs.notify, a.v, msg, a.lvAt); // --watch: never bell/desktop; the command with --notify
      }
      const f = flags(rs, s.path); s.attention = f[0] === "1"; s.stuck = f[1] ?? ""; // as the TUI's watchdog tick does: the state a sink reads
    }
  };
  if (lines) poll();
  if (o.alerts && (lines || sink)) { refreshProcs(); alerts(); } // alert lines only with JSONL; a sink gets every transition
  let tick = 0;
  setInterval(() => {
    tick++;
    const now = Date.now();
    if ((o.forMs > 0 && now - t0 >= o.forMs) || (o.idle && now - lastOut >= IDLE_MS)) quit(); // a sink flushes first
    // every: [scan, processes + rules, slow process facts] in 500 ms ticks (fleet watch polls less: a budget per host)
    if (tick % (o.every[0] ?? 4) === 0) scan();
    if (tick % (o.every[1] ?? 3) === 0) { refreshProcs(); if (!lines) probeLive(); liveDiff(); if (o.alerts && (lines || sink)) alerts(); } // a sink reads no logs: the live ones' sizes for their tails (busy)
    if (tick % (o.every[2] ?? 10) === 0) { refreshSlow(); liveDiff(); }
    if (lines) poll();
    if (sink) sink.tick(Date.now());
  }, 500);
}

// --json --related: the related-events timeline around one event (features/related)
function relatedCli(args: string[], sc: Scope): void {
  const val = (f: string): string => { const i = args.indexOf(f); const v = i >= 0 ? args[i + 1] ?? "" : ""; return v.startsWith("--") ? "" : v; };
  const ref = val("--related");
  if (!ref) fail("--related needs a session: an id (≥ 6 characters), <harness>:<id>, current or last");
  const f = fmtArgs(args); if ((f.fmt && f.fmt !== "json") || f.fields.length) fail("--related prints JSON only: --format and --fields do not apply");
  if (args.indexOf("--event") >= 0 && args.indexOf("--at") >= 0) fail("--event and --at exclude each other");
  if (args.indexOf("--event") >= 0 && !val("--event")) fail("--event needs a tool call id");
  if (args.indexOf("--at") >= 0 && !val("--at")) fail("--at needs an ISO time, e.g. --at 2026-09-30T14:06:43Z");
  let minutes = relCfg(section("related")).minutes;
  if (args.indexOf("--minutes") >= 0) { const v = val("--minutes"); minutes = /^\d+$/.test(v) ? Number(v) : 0; if (minutes < 1 || minutes > 240) fail("--minutes needs a whole number 1–240, e.g. --minutes 30"); }
  discover();
  const r = relatedJson(ref, val("--event"), val("--at"), minutes, (x: Sess): boolean => visible(x, sc));
  if (r.code) cliError(r.code === 4 ? "ambiguous" : r.code === 2 ? "usage" : "not_found", r.err, r.hint, r.code);
  out(r.json);
  process.exit(0);
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
// --json / --watch take only their options (and --watch --otlp the export options it reads, extra): anything else exits 2,
// never ignored — a misspelled or swallowed --filter would show or send every session
export function strictArgs(args: string[], c: string, extra: OptRec[]): void {
  const vals: string[] = []; const bools: string[] = [c];
  const r = cmdOf(c); const os = (r ? r.options : []).concat(extra);
  for (const o of os) { if (o.arg) vals.push(o.flag); else bools.push(o.flag); }
  const m = badArg(args, vals, bools, ["--otlp"]); // a bare --otlp: the endpoint from the config
  if (m) cliError("usage", m, "agentglass " + c + " --help lists its options", 2);
}
H.cli.push((args: string[]): boolean => {
  if (args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) { help(args); return true; }
  if (args.indexOf("--version") >= 0) { const m = badArg(args, [], ["--version", "--json"], []); if (m) fail(m); out(args.indexOf("--json") >= 0 ? JSON.stringify(versionInfo()) : BUILD.version); return true; }
  if (args.indexOf("--json") >= 0) { // no toast line: warnings go to stderr
    S.cli = true; strictArgs(args, "--json", []);
    if (args.indexOf("--related") >= 0) { relatedCli(args, agentScope(args)); return true; }
    const o = opts(args); const cf = o.cf;
    gitCli(o.git); if (o.git && args.indexOf("--repos") >= 0) fail("--git applies to session lists: agentglass --json --git");
    if (args.indexOf("--repos") >= 0) reposCli(o.days, cf ? cf.f : null, cf ? cf.cheap : null, o.sc, o.f, o.json); else snapshot(o);
    return true;
  }
  if (args.indexOf("--repos") >= 0) fail("--repos needs --json: agentglass --json --repos");
  if (args.indexOf("--git") >= 0) fail("--git needs --json: agentglass --json --git");
  if (args.indexOf("--related") >= 0) fail("--related needs --json: agentglass --json --related <session>");
  if (args.indexOf("--watch") >= 0) { S.cli = true; strictArgs(args, "--watch", []); watch(opts(args), null); return true; }
  return false;
});
