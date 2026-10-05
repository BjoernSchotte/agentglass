// agentglass — the palette's standing of a session or project: a small bonus that decides between comparable fuzzy scores
// (live/recent over old, existing over gone, the main repo over a removed worktree or clone); pure
// SPDX-License-Identifier: Apache-2.0

// live: a running agent; last: newest activity (ms); gone: its directory no longer exists (every session's, for a
// project); remote: identified by its git remote, the main repo (its worktrees and clones with that remote are the same
// item; a removed worktree or a clone without one is named by its directory); worktree: a session in a linked worktree
export interface Standing { live: boolean; last: number; gone: boolean; remote: boolean; worktree: boolean }
const HOUR = 3600000; const DAY = 24 * HOUR;
// at most +9, at least -6: below what a clearly better match earns (a word boundary is +10 per typed character, a
// contiguous run ≥ +4, a skipped column -1), so it only orders matches of about the same quality
export function standing(st: Standing, now: number): number {
  const age = now - st.last;
  let b = (st.live ? 4 : 0) + (age < HOUR ? 3 : age < DAY ? 2 : age < 7 * DAY ? 1 : 0);
  if (st.gone) b -= 6; else if (st.remote) b += 2;
  if (st.worktree) b -= 2;
  return b;
}
