// agentglass — machine-readable CLI: --json snapshot, --watch JSONL event stream, --help, --version (no TTY needed)
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, complete, screenOut } from "../hooks.ts";
import { sessions, scan, buildView, loadHead, loadTail, titleOf, activity, parentOf } from "../model/sessions.ts";
import { refreshProcs, refreshSlow } from "../model/procs.ts";
import { HARNESSES, harnessIds, isHarness, parseEvents, sourceOf, epochOf } from "../harness/index.ts";
import { base } from "../util/json.ts";
import type { Ev, Sess } from "../model/types.ts";
import { S } from "../state.ts";
import { BUILD } from "../build-info.ts";
import { versionInfo } from "./version.ts";
import { planLabel } from "./usage/billing.ts";
import { REDACT } from "./redact-on.ts";

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
];
function table(rows: string[][], col: number): string { return rows.map((r: string[]) => "  " + (r[0] ?? "").padEnd(col) + (r[1] ?? "")).join("\n"); }
function usage(): string {
  let col = 0; for (const r of CMDS.concat(OPTS)) col = Math.max(col, (r[0] ?? "").length + 2);
  return `agentglass ${BUILD.version} (${BUILD.channel}, ${BUILD.commit.slice(0, 8)}, ${BUILD.platform}) — browse, watch and steer coding-agent sessions (${HARNESSES.map((a) => a.label).join(", ")})

usage:
${table(CMDS, col)}

options for --json / --watch:
${table(OPTS, col)}

--json fields: id harness title cwd branch model path updated bytes live pid status parent kind subagents
  activity tokens{in,out,cacheRead,cacheWrite} costUsd billing{mode,plan,source} unpricedTokens unpricedCredits
  tools linesAdded linesRemoved attention stuck
  (costUsd = API list price, null when only unpriced usage exists; billing.mode = api|plan|metered|gateway|unknown,
  source = session|process|config — config = assumed from the current config files)
--watch lines: {ts,harness,session,title,project,parent,kind,tool,text}; kind = user|assistant|thinking|tool|result|meta,
  plus live|exit when an agent process appears or disappears

OpenCode sessions are read from its SQLite database with the sqlite3 CLI (AGENTGLASS_SQLITE3 = another command);
  without it, 2.x sessions come from a running \`opencode service\` over HTTP with curl (AGENTGLASS_CURL); with neither
  they are not listed (a warning says so)
`;
}

interface Opts { live: boolean; harness: string; limit: number; subs: boolean; fromStart: boolean }
interface JTok { in: number; out: number; cacheRead: number; cacheWrite: number }
interface JBill { mode: string; plan: string; source: string }
interface JSess {
  id: string; harness: string; title: string; cwd: string; branch: string; model: string; path: string; updated: string; bytes: number;
  live: boolean; pid: number; status: string; parent: string | null; kind: string; subagents: number; activity: string; tokens: JTok;
  costUsd: number | null; billing: JBill; unpricedTokens: number; unpricedCredits: number; tools: number; linesAdded: number; linesRemoved: number; attention: boolean; stuck: string | null;
}
interface WEv { ts: string; harness: string; session: string; title: string; project: string; parent: string | null; kind: string; tool: string | null; text: string }

// sync write: a closed reader (| head) surfaces as EPIPE here → quiet exit
function out(line: string): void {
  try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); }
}
function fail(msg: string): never { process.stderr.write("agentglass: " + msg + "\n"); process.exit(2); }

function opts(args: string[]): Opts {
  const o: Opts = { live: false, harness: "", limit: 0, subs: false, fromStart: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--live") o.live = true;
    else if (a === "--subagents") o.subs = true;
    else if (a === "--from-start") o.fromStart = true;
    else if (a === "--harness") { o.harness = args[i + 1] ?? ""; i++; if (!isHarness(o.harness)) fail("--harness must be one of " + harnessIds().join(", ")); }
    else if (a === "--limit") { o.limit = Number(args[i + 1] ?? ""); i++; if (!(o.limit > 0)) fail("--limit needs a positive number"); }
  }
  return o;
}
// subagents have no process of their own: they are live while their parent is
function livePid(s: Sess): number {
  if (s.pid) return s.pid;
  const p = parentOf(s);
  return p ? p.pid : 0;
}
function wanted(s: Sess, o: Opts): boolean {
  if (o.harness && s.h !== o.harness) return false;
  return !o.live || livePid(s) > 0;
}
export function discover(): void { scan(); refreshProcs(); refreshSlow(); buildView(); }

function snapshot(o: Opts): void {
  discover();
  const list: Sess[] = [];
  for (const s of sessions.values()) if ((o.subs || s.depth === 0) && wanted(s, o)) list.push(s);
  list.sort((a, b) => b.mtime - a.mtime);
  const res: JSess[] = [];
  for (const s of o.limit > 0 ? list.slice(0, o.limit) : list) {
    loadHead(s); loadTail(s); complete(s);
    res.push({
      id: s.id, harness: s.h, title: titleOf(s), cwd: s.cwd, branch: s.branch, model: s.model, path: s.path,
      updated: new Date(s.mtime).toISOString(), bytes: s.size, live: livePid(s) > 0, pid: s.pid, status: s.status,
      parent: s.parent ? s.parent : null, kind: s.kind, subagents: s.subs.length, activity: activity(s),
      tokens: { in: s.inTok, out: s.outTok, cacheRead: s.cacheRTok, cacheWrite: s.cacheWTok },
      costUsd: s.cost < 0 ? null : s.cost, billing: { mode: s.bill || "unknown", plan: planLabel(s.plan, REDACT), source: s.billSrc },
      unpricedTokens: s.unkTok, unpricedCredits: s.unkCr, tools: s.tools, linesAdded: s.linesAdd, linesRemoved: s.linesDel,
      attention: s.attention, stuck: s.stuck ? s.stuck : null,
    });
  }
  out(process.stdout.isTTY ? JSON.stringify(res, null, 2) : JSON.stringify(res));
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
function emitEv(s: Sess, e: Ev): void {
  if (e.kind !== "tool") { emit(s, e.kind, null, e.text, e.ts); return; }
  const i = e.text.indexOf("\u0000");
  emit(s, "tool", i >= 0 ? e.text.slice(0, i) : e.text, i >= 0 ? e.text.slice(i + 1) : "", e.ts);
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
      if (!s.pid || live.get(s.path) === s.pid || (o.harness && s.h !== o.harness)) continue;
      live.set(s.path, s.pid);
      emit(s, "live", null, "pid " + s.pid, "");
    }
    for (const [p, pid] of [...live.entries()]) {
      const s = sessions.get(p);
      if (s && s.pid === pid) continue;
      live.delete(p);
      if (s && !(o.harness && s.h !== o.harness)) emit(s, "exit", null, "pid " + pid, "");
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
      for (const e of evs) emitEv(s, e);
    }
  };
  poll();
  let tick = 0;
  setInterval(() => {
    tick++;
    if (tick % 4 === 0) scan();
    if (tick % 3 === 0) { refreshProcs(); liveDiff(); }
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
