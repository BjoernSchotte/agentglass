// agentglass — the commits a worktree's HEAD reflog records (<gitdir>/logs/HEAD), read without spawning git
// SPDX-License-Identifier: Apache-2.0
// ponytail: TEMPORARY duplicate of git-linkage's reader (PR feat/git-linkage, src/features/vcs/reflog.ts, not merged
// when related-events was reviewed). Once it is on main: delete this file; in build.ts reflogRows use
// `readReflog(gd).filter(isNew)` (fields at, sha, subj are the same) and git-linkage's list of a repo's worktree gitdirs
// in place of worktreeGitdirs (build.check's reflog case covers the swap unchanged).
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readText } from "../../util/fs.ts";

// at = epoch ms, sha = the new commit, subj = the message after "<op>: " (name and email are never kept)
export interface RefCommit { at: number; sha: string; subj: string }
const MAX = 8388608;
interface Hit { size: number; mtime: number; cs: RefCommit[] }
const cache = new Map<string, Hit>();
// commit-like entries only: commit / commit (amend|initial|merge|cherry-pick…), merge, cherry-pick, revert
export function parseReflog(text: string): RefCommit[] {
  const out: RefCommit[] = [];
  for (const l of text.split("\n")) {
    const m = /^[0-9a-f]{7,64} ([0-9a-f]{7,64}) .*? (\d{9,11}) [+-]\d{4}\t(.*)$/.exec(l); if (!m) continue;
    const msg = m[3] ?? "";
    if (!/^(commit( \([^)]*\))?|merge [^:]*|cherry-pick|revert):/.test(msg)) continue;
    const c = msg.indexOf(": ");
    out.push({ at: Number(m[2] ?? "0") * 1000, sha: m[1] ?? "", subj: c >= 0 ? msg.slice(c + 2, c + 82) : "" });
  }
  return out;
}
// one gitdir's commits (the last 8 MB of its reflog), cached by size and mtime; [] when there is none
export function reflogCommits(gitdir: string): RefCommit[] {
  if (!gitdir) return [];
  const f = join(gitdir, "logs", "HEAD");
  let size = 0; let mtime = 0; try { const st = statSync(f); size = st.size; mtime = st.mtimeMs; } catch (e) { return []; }
  const hit = cache.get(gitdir); if (hit && hit.size === size && hit.mtime === mtime) return hit.cs;
  let text = size <= MAX ? readText(f, 0, size) : readText(f, size - MAX - 1, MAX + 1);
  if (size > MAX) { const nl = text.indexOf("\n"); text = nl >= 0 ? text.slice(nl + 1) : ""; } // one byte early: a tail starting on a line start keeps that line
  const cs = parseReflog(text);
  if (cache.size > 256) cache.clear();
  cache.set(gitdir, { size, mtime, cs });
  return cs;
}
// every worktree's gitdir of a repository: the common dir itself and <common>/worktrees/*
export function worktreeGitdirs(common: string): string[] {
  if (!common) return [];
  const out = [common];
  try { for (const n of readdirSync(join(common, "worktrees"))) out.push(join(common, "worktrees", n)); } catch (e) { /* no linked worktrees */ }
  return out;
}
