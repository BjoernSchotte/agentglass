// agentglass — one session's --json row (the contract's session object) and the selection the session lists share: the CLI
// (--json, sessions), the read model (src/read) and serve --stdio build rows here only
// SPDX-License-Identifier: Apache-2.0
import { complete, display } from "../hooks.ts";
import { sessions, scan, buildView, loadHead, loadTail, titleOf, activity } from "../model/sessions.ts";
import { refreshProcs, refreshSlow } from "../model/procs.ts";
import { type Obj } from "../util/json.ts";
import type { Sess } from "../model/types.ts";
import { planLabel } from "../features/usage/billing.ts";
import { REDACT } from "../features/redact-on.ts";
import { paneOfPid } from "../mux/index.ts";
import { accsOf, ledger } from "../features/usage/ledger.ts";
import { type Acc } from "../features/usage/record.ts";
import { skillsJson, skillLoadsJson } from "../features/skills/json.ts";
import { scrub } from "../features/skills/watchvis.ts";
import { estTopOf } from "../features/usage/costs.ts";
import { identSync } from "../features/query/project.ts";
import { gitJson, peers } from "../features/vcs/json.ts";
import { labelOf } from "../model/project.ts";
import { keyShown } from "../features/repos/cli.ts";
import { type CliFilter, cliSelect } from "../features/query/cli.ts";
import { livePid, stateOf } from "../features/query/eval.ts";
import { type Alert } from "../features/rules/engine.ts";
import { alertsOf } from "../features/watchdog.ts";

export const JSON_FIELDS = ["id", "harness", "title", "cwd", "branch", "remote", "model", "path", "updated", "bytes", "live", "pid", "status", "state", "mux", "parent", "kind", "subagents", "twins",
  "activity", "tokens", "costUsd", "costEstimatedUsd", "billing", "unpricedTokens", "unpricedCredits", "tools", "linesAdded", "linesRemoved", "attention", "stuck", "skills", "repo", "alerts", "git"];
interface JAl { rule: string; severity: string; value: number; unit: string; threshold: number; since: string; message: string; labels: { [k: string]: string }; acked: boolean }
function jalerts(as: Alert[]): JAl[] {
  const o: JAl[] = [];
  for (const a of as) { const l: { [k: string]: string } = {}; for (const [k, v] of a.labels) l[k] = v; o.push({ rule: a.rule, severity: a.severity, value: a.value, unit: a.unit, threshold: a.threshold, since: new Date(a.since).toISOString(), message: a.message, labels: l, acked: a.acked }); }
  return o;
}
// the --json fields of one session (key order is the output order)
export function jsonSess(s: Sess): Obj {
  const skills = skillsJson(accsOf(s)); // first: a hidden skill's name is scrubbed from the title too
  return {
    id: s.id, harness: s.h, title: scrub(titleOf(s)), cwd: s.cwd, branch: s.branch, remote: s.remote ? s.remote : null, model: s.model, path: display("path", s.path, s),
    updated: new Date(s.mtime).toISOString(), bytes: s.size, live: livePid(s) > 0, pid: s.pid, status: s.status, state: stateOf(s), mux: muxJson(s),
    parent: s.parent ? s.parent : null, kind: s.kind, subagents: s.subs.length, twins: s.twins, activity: scrub(activity(s)),
    tokens: { in: s.inTok, out: s.outTok, cacheRead: s.cacheRTok, cacheWrite: s.cacheWTok },
    costUsd: s.cost < 0 ? null : s.cost, costEstimatedUsd: Math.round(estTopOf(accsOf(s)).usd * 1e6) / 1e6, billing: { mode: s.bill || "unknown", plan: planLabel(s.plan, REDACT), source: s.billSrc },
    unpricedTokens: s.unkTok, unpricedCredits: s.unkCr, tools: s.tools, linesAdded: s.linesAdd, linesRemoved: s.linesDel,
    attention: s.attention, stuck: s.stuck ? scrub(s.stuck) : null, skills, repo: repoJ(s), alerts: jalerts(alertsOf(s)), git: gitJson(s),
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
// one discovery pass: logs, processes, slow process facts, the view
export function discover(): void { scan(); refreshProcs(); refreshSlow(); buildView(); }
// the sessions a list shows: top-level (and subagents with subs), kept by keep and the filter, newest first (a stable
// sort: equal times keep the map's order, as --json always had)
export function pickSessions(cf: CliFilter | null, subs: boolean, keep: (s: Sess) => boolean): Sess[] {
  const cands: Sess[] = []; for (const s of sessions.values()) if ((subs || s.depth === 0) && keep(s)) cands.push(s);
  const list: Sess[] = []; for (const s of cf ? cliSelect(cf, cands) : cands) list.push(s);
  list.sort((a, b) => b.mtime - a.mtime);
  return list;
}
function sessByRef(id: string): Sess | null { const i = id.indexOf(":"); for (const x of sessions.values()) if (x.h === id.slice(0, i) && x.id === id.slice(i + 1)) return x; return null; }
// the rows of sel: everything indexed first (git: each worktree's peers too), then the rows — the git attribution is built
// once, not again for every session that changed the picture. loads: also each row's skillLoads (content: their text)
// lazy (serve, whose ledger indexes in the background): a session whose log is not indexed to its end yet comes as a row
// with pending: true and the figures booked so far (they grow as the index advances) — a cold start answers at once
export const LAZY = { on: false };
function indexed1(s: Sess): boolean { const a = ledger.get(s.path); return !!a && a.ep === s.ep && a.off >= s.size; }
// far behind: the index has more than FAR_BYTES of this log (or its subagents') still to read — history, not a live
// log's last appends (those a read catches up at once)
const FAR_BYTES = 1048576;
function left1(s: Sess): number { const a = ledger.get(s.path); return !a || a.ep !== s.ep ? s.size : Math.max(0, s.size - a.off); }
export function farBehind(s: Sess): boolean { let n = left1(s); for (const c of s.subs) n += left1(c); return n > FAR_BYTES; }
export function indexed(s: Sess): boolean { if (!indexed1(s)) return false; for (const c of s.subs) if (!indexed1(c)) return false; return true; }
export function rowsOf(sel: Sess[], loads: boolean, content: boolean): Obj[] {
  const wait = new Set<string>();
  for (const s of sel) { if (LAZY.on && !indexed(s)) { loadHead(s); wait.add(s.path); continue; } loadHead(s); loadTail(s, true); complete(s); for (const c of s.subs) complete(c); peers(s); }
  const res: Obj[] = [];
  for (const s of sel) {
    const r = jsonSess(s); if (wait.has(s.path)) r["pending"] = true;
    if (loads) { const as: Acc[] = []; const ids: string[] = []; const add = (x: Sess): void => { for (const a of accsOf(x)) { as.push(a); ids.push(x.h + ":" + x.id); } for (const c of x.subs) add(c); }; add(s); r["skillLoads"] = skillLoadsJson(s, as, ids, content, sessByRef); }
    res.push(r);
  }
  return res;
}
