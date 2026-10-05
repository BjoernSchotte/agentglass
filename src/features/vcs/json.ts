// agentglass — git linkage in --json: a session's commits, PRs, issues and links (spec git-linkage 7)
// SPDX-License-Identifier: Apache-2.0
// Refs and the reflog need no spawn and are always there; status/add/del only with --git, which allows the git log spawns.
import type { Sess } from "../../model/types.ts";
import { sessions, loadHead } from "../../model/sessions.ts";
import { display } from "../../hooks.ts";
import { complete as ledgerComplete } from "../usage/ledger.ts";
import { identOf } from "../query/project.ts";
import { type Obj } from "../../util/json.ts";
import { type GitInfo, type GLink, GIT, gitInfo, sessIn, sessGit, gitRun, gitStale } from "./attrib.ts";
import { enrich } from "./enrich.ts";
import { repoShas } from "./reflog.ts";

// --git: enrichment spawns allowed, ungated (one per listed session); without it no spawn at all (no window git log either)
export const GJ = { full: false };
export function gitCli(full: boolean): void { GJ.full = full; GIT.cli = full; GIT.gate = false; }
function enrichAll(s: Sess): void {
  for (const x of [s].concat(s.subs)) {
    const g = gitInfo(x); const i = sessIn(x, Date.now()); if (!g || !i || !g.commits.length) continue;
    const rl = repoShas(i.gitdir, i.common);
    enrich(x.path, g, i.top, !i.live && i.t1 > 0 && Date.now() - i.t1 > 600000, rl, gitRun());
  }
}
function linksJ(ls: GLink[], s: Sess): Obj[] { const o: Obj[] = []; for (const l of ls) o.push({ url: display("vcs", l.url, s), number: l.n, how: l.how }); return o; }
// cost incl. subagents ÷ ✓ commits; null without commits or when only unpriced usage exists
export function costPerCommit(cost: number, unk: number, produced: number): number | null {
  if (produced <= 0 || (cost <= 0 && unk > 0)) return null;
  return Math.round((cost / produced) * 1e6) / 1e6;
}
// ≈ vs ? shared needs every session of the worktree indexed: those written to since the window opened are completed
// (a one-shot run completes only the listed sessions). Sessions are indexed by worktree once, newest first and only as far
// back as the earliest window asked for; each worktree is completed back to the earliest window start done so far.
const PEER = { n: -1, order: [] as Sess[], next: 0, dirs: new Map<string, Sess[]>(), done: new Map<string, number>() };
export function peers(s: Sess): void {
  const me = sessIn(s, Date.now()); if (!me || !me.gitdir || me.t1 <= me.t0) return; // a removed worktree has no peers to read
  if (PEER.n !== sessions.size) { // another session set (a scan in between): start over
    PEER.n = sessions.size; PEER.order = [...sessions.values()].sort((a, b) => b.mtime - a.mtime); PEER.next = 0; PEER.dirs.clear(); PEER.done.clear();
  }
  const d = PEER.done.get(me.gitdir); if (d !== undefined && d <= me.t0) return;
  PEER.done.set(me.gitdir, me.t0);
  for (; PEER.next < PEER.order.length; PEER.next++) {
    const x = PEER.order[PEER.next]; if (x.mtime < me.t0) break;
    let id = identOf(x); // without its head when projects.json remembers its cwd
    if (!id && !x.headDone) { loadHead(x); id = identOf(x); gitStale(); }
    if (!id || !id.gitdir) continue;
    const l = PEER.dirs.get(id.gitdir); if (l) l.push(x); else PEER.dirs.set(id.gitdir, [x]);
  }
  for (const x of PEER.dirs.get(me.gitdir) ?? []) if (x !== s && x.mtime >= me.t0) ledgerComplete(x); // the ledger alone: no alert or billing work
  gitStale();
}
// null = no git worktree known for the session
export function gitJson(s: Sess): Obj | null {
  peers(s);
  if (GJ.full) enrichAll(s);
  const g: GitInfo | null = sessGit(s); if (!g) return null;
  const cs: Obj[] = [];
  for (const c of g.commits) {
    const st = GJ.full || c.status === "amended" || c.status === "elsewhere" ? c.status : "unknown"; // elsewhere: a banner on a branch the repo lacks
    cs.push({ sha: c.sha, branch: display("filter:branch", c.br, s), subject: display("vcs", c.subj, s), at: c.at > 0 ? new Date(c.at).toISOString() : null,
      how: c.how, counted: c.counted, status: st, merge: c.merge, add: GJ.full && c.add >= 0 ? c.add : null, del: GJ.full && c.del >= 0 ? c.del : null });
  }
  let cost = s.cost > 0 ? s.cost : 0; let unk = s.unkTok; for (const x of s.subs) { cost += x.cost > 0 ? x.cost : 0; unk += x.unkTok; }
  const lk: Obj[] = []; for (const l of g.links) lk.push({ url: display("vcs", l.url, s), how: l.how });
  return { commits: cs, produced: g.produced, prs: linksJ(g.prs, s), issues: linksJ(g.issues, s), links: lk, costPerCommit: costPerCommit(cost, unk, g.produced), noReflog: g.noReflog };
}
