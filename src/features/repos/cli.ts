// agentglass — repo-view CLI: `agentglass --json --repos [--days N] [--filter …]`, one object per project
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import { H, complete, display, screenOut } from "../../hooks.ts";
import { sessions, scan, buildView, loadHead, loadTail } from "../../model/sessions.ts";
import { refreshProcs, refreshSlow } from "../../model/procs.ts";
import { REDACT } from "../redact-on.ts";
import { lastDays, startOfDay } from "../usage/record.ts";
import { type Compiled, EMPTY, sessMatches } from "../query/eval.ts";
import { type RepoAgg, repoAgg, allDays, topFiles } from "./agg.ts";

export interface JRepo {
  key: string; label: string; kind: string; worktrees: { name: string; top: string }[]; sessions: number; live: number; last: string;
  costUsd: number | null; unpricedTokens: number; tokens: { in: number; out: number }; calls: number; errors: number; errorRate: number | null;
  activeMin: number; agentMin: number; files: { path: string; edits: number; add: number; del: number; harnesses: string[] }[]; outsideFiles: number;
  byHarness: { harness: string; sessions: number; costUsd: number | null }[]; branches: { branch: string; sessions: number; costUsd: number | null }[];
}
// a project key under --redact: its path part faked like labels and cwds
export function keyShown(key: string): string {
  if (!REDACT) return key;
  if (key.startsWith("git:file/")) return "git:file" + display("cwd", key.slice(8), null);
  if (key.startsWith("git:")) { const i = key.indexOf("/"); return i > 0 ? key.slice(0, i + 1) + display("repo", key.slice(i + 1), null) : key; }
  const c = key.indexOf(":"); return c > 0 && key.slice(c + 1).startsWith("/") ? key.slice(0, c + 1) + display("cwd", key.slice(c + 1), null) : key;
}
function usd(cost: number, unk: number): number | null { return cost === 0 && unk > 0 ? null : Math.round(cost * 1e6) / 1e6; }
// files: top 50 (outside the repo counted apart); errorRate null under 10 calls; labels and paths through display()
export function repoJson(r: RepoAgg): JRepo {
  const wts: { name: string; top: string }[] = [];
  for (const [n, top] of r.worktrees) wts.push({ name: display("repo", n, null), top: display("cwd", top, null) });
  const files: { path: string; edits: number; add: number; del: number; harnesses: string[] }[] = [];
  for (const e of topFiles(r, 50)) if (e[0]) files.push({ path: display("file", e[0], null), edits: e[1].n, add: e[1].add, del: e[1].del, harnesses: [...e[1].by].sort() });
  const bh: { harness: string; sessions: number; costUsd: number | null }[] = [];
  for (const [h, x] of r.byHarness) bh.push({ harness: h, sessions: x.sess, costUsd: usd(x.cost, x.unk) });
  bh.sort((x, y) => (y.costUsd ?? 0) - (x.costUsd ?? 0) || y.sessions - x.sessions);
  const br: { branch: string; sessions: number; costUsd: number | null }[] = [];
  for (const [b, x] of r.branches) br.push({ branch: b, sessions: x.sess, costUsd: usd(x.cost, x.unk) });
  br.sort((x, y) => (y.costUsd ?? 0) - (x.costUsd ?? 0) || y.sessions - x.sessions);
  return {
    key: keyShown(r.key), label: display("repo", r.label, null), kind: r.kind, worktrees: wts, sessions: r.sessions, live: r.live, last: r.last > 0 ? new Date(r.last).toISOString() : "",
    costUsd: usd(r.cost, r.unk), unpricedTokens: r.unk, tokens: { in: r.inTok, out: r.outTok }, calls: r.calls, errors: r.err, errorRate: r.calls < 10 ? null : Math.round((r.err / r.calls) * 10000) / 10000,
    activeMin: r.activeMin, agentMin: r.agentMin, files, outsideFiles: r.outside.n, byHarness: bh, branches: br,
  };
}
// days 0 = all history; session clauses pick the sessions (heads read when needed), day clauses narrow the period
export function reposCli(days: number, f: Compiled | null, cheap: Compiled | null): void {
  scan(); refreshProcs(); refreshSlow(); buildView();
  const from = days > 0 ? startOfDay() - (days - 1) * 86400000 : 0;
  for (const s of sessions.values()) {
    if (s.mtime < from) continue; // nothing written since before the period: no activity in it
    if (!s.headDone) loadHead(s); // Claude/Codex cwd lives in the head
    if (!s.cwd) loadTail(s); // …or, behind huge first lines, in the tail
    if (cheap && cheap !== EMPTY && !sessMatches(cheap, s)) continue; // the ledger is completed only for survivors
    complete(s);
  }
  const dks = days > 0 ? lastDays(days) : allDays();
  const rows = repoAgg(dks, f ?? EMPTY).slice().sort((x: RepoAgg, y: RepoAgg) => y.cost - x.cost || y.unk - x.unk || (x.label < y.label ? -1 : 1));
  const out: JRepo[] = []; for (const r of rows) out.push(repoJson(r));
  const body = process.stdout.isTTY ? JSON.stringify(out, null, 2) : JSON.stringify(out);
  try { writeSync(1, screenOut(body) + "\n"); } catch (e) { /* closed pipe */ }
  for (const q of H.onQuit) q(); // keep the indexing work for the next run (a no-op without call rows)
  process.exit(0);
}
