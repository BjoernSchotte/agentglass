// agentglass — the repos read model (local-web-api §2): `agentglass --json --repos` — one row per project (worktrees and
// clones of one remote merged): sessions, cost, commits, cost per commit, active time, files, branches — as repos.list
// serves it. serve walks the sessions in slices (a first ask reads many heads), then aggregates; lazy: a log the
// background index is far behind on counts as booked so far (pending), an indexed one is not read again.
// SPDX-License-Identifier: Apache-2.0
import type { Obj } from "../util/json.ts";
import type { Sess } from "../model/types.ts";
import { filterOf } from "../features/query/cli.ts";
import { type RepoPrep, repoPrep, repoPrepStep, repoOut } from "../features/repos/cli.ts";
import { LAZY, farBehind, indexed } from "./row.ts";
import { type Err } from "./sessions.ts";

export interface ReposR { prep: RepoPrep | null; err: Err | null; pending: number }
// days: the last N days (0 = all history), as --days
export function reposStart(days: number, filter: string): ReposR {
  if (!(Number.isInteger(days) && days >= 0 && days <= 3650)) return { prep: null, err: { code: "bad_param", msg: "days must be 0 (all history) to 3650", hint: "" }, pending: 0 };
  const fr = filterOf(filter ? [filter] : [], "", false, false, false); const cf = fr.cf;
  if (!cf) { const e = fr.err; const col = e ? e.col : 0; return { prep: null, err: { code: "bad_filter", msg: "filter: " + (e ? e.msg : "invalid filter") + " at column " + String(col + 1), hint: fr.src ? fr.src + "\n" + " ".repeat(Math.max(0, col)) + "^" : "" }, pending: 0 }; }
  const r: ReposR = { prep: null, err: null, pending: 0 };
  r.prep = repoPrep(days, filter ? cf.f : null, filter ? cf.cheap : null, { name: "all", key: "", cwd: "", warn: "" },
    (s: Sess): boolean => { if (!LAZY.on) return false; if (farBehind(s)) { r.pending++; return true; } return indexed(s); });
  return r;
}
export function reposStep(r: ReposR, ms: number): boolean { const p = r.prep; return !p || repoPrepStep(p, ms); }
export function reposOut(r: ReposR): Obj { const p = r.prep; return { rows: p ? repoOut(p) : [], days: p ? p.days : 0, pending: r.pending }; }
