// agentglass — git linkage: a worktree's HEAD reflog (<gitdir>/logs/HEAD) read as plain text, no git spawn (spec git-linkage 3)
// SPDX-License-Identifier: Apache-2.0
// One line per HEAD move: `<old> <new> <name> <<email>> <epoch> <tz>\t<message>`. Name and email are skipped by the parser:
// they are never stored, shown or exported.
import { statSync } from "node:fs";
import { join } from "node:path";
import { readText, listDir } from "../../util/fs.ts";
import { own } from "../../util/own.ts";

// at = epoch ms; sha = the new HEAD (the spec's "new": a keyword here); op = commit | amend | merge | cherry-pick | revert |
// checkout | rebase | reset | other; branch = the branch HEAD was on ("" detached or unknown); amended = a later
// `commit (amend)` replaced this commit
export interface RefEv { at: number; old: string; sha: string; op: string; branch: string; subj: string; amended: boolean }

// the message's operation; `commit (<other>):` counts as a plain commit (git 2.51: initial, amend, merge, cherry-pick)
export function opOf(msg: string): string {
  if (msg.startsWith("commit (amend):")) return "amend";
  if (msg.startsWith("commit (merge):") || msg.startsWith("merge ")) return "merge";
  if (msg.startsWith("commit (cherry-pick):") || msg.startsWith("cherry-pick:")) return "cherry-pick";
  if (msg.startsWith("commit:") || /^commit \([^)]*\):/.test(msg)) return "commit";
  if (msg.startsWith("revert:")) return "revert";
  if (msg.startsWith("checkout:")) return "checkout";
  if (msg.startsWith("rebase")) return "rebase";
  if (msg.startsWith("reset:")) return "reset";
  return "other";
}
// new work made in this worktree (rebase, pull and reset only move HEAD to commits that exist or are rewritten)
export function isNew(e: RefEv): boolean { return e.op === "commit" || e.op === "amend" || e.op === "merge" || e.op === "cherry-pick" || e.op === "revert"; }
const HEAD_RE = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .*> (\d+) [+-]\d{4}$/;
const MOVE_RE = /^checkout: moving from (\S+) to (\S+)$/;
function branchName(x: string): string { return /^[0-9a-f]{7,64}$/.test(x) ? "" : own(x); } // a sha = detached HEAD

// the branch of each event by replay: before the first checkout `moving from A to B` HEAD was on A (else on head, the
// current branch); after it on B; `rebase (finish): returning to refs/heads/<b>` lands on b
export function parseReflog(text: string, head: string): RefEv[] {
  const out: RefEv[] = [];
  let cur = head; let first = true;
  const last = new Map<string, number>(); // sha → index of its newest event (amend marks it)
  for (const l of text.split("\n")) {
    const tab = l.indexOf("\t"); if (tab < 0) continue;
    const m = HEAD_RE.exec(l.slice(0, tab)); if (!m) continue;
    const msg = l.slice(tab + 1); const op = opOf(msg);
    const mv = op === "checkout" ? MOVE_RE.exec(msg) : null;
    if (mv && first) { // everything before the first checkout was on its "from" branch
      const from = branchName(mv[1] ?? "");
      for (const e of out) e.branch = from;
      cur = from;
    }
    if (mv) first = false;
    const c = msg.indexOf(": ");
    const e: RefEv = { at: Number(m[3] ?? "0") * 1000, old: own(m[1] ?? ""), sha: own(m[2] ?? ""), op, branch: cur, subj: (c >= 0 ? msg.slice(c + 2) : msg).slice(0, 80), amended: false };
    if (mv) { cur = branchName(mv[2] ?? ""); e.branch = cur; }
    const fin = /^rebase.*\(finish\): returning to refs\/heads\/(\S+)$/.exec(msg); if (fin) { cur = own(fin[1] ?? ""); e.branch = cur; }
    if (op === "amend") { const i = last.get(e.old) ?? -1; if (i >= 0 && i < out.length) out[i].amended = true; }
    last.set(e.sha, out.length);
    out.push(e);
  }
  return out;
}

// the branch <gitdir>/HEAD names ("" detached or unreadable)
export function headBranch(gitdir: string): string {
  const m = /^ref: refs\/heads\/(.+)$/m.exec(readText(join(gitdir, "HEAD"), 0, 1024));
  return m ? (m[1] ?? "").trim() : "";
}

export const MAX_READ = 8388608;
interface Hit { size: number; mtime: number; evs: RefEv[] }
const cache = new Map<string, Hit>();
// <gitdir>/logs/HEAD parsed, cached per gitdir by (size, mtime); over MAX_READ only the last MAX_READ bytes from a line
// start; missing → []
export function readReflog(gitdir: string): RefEv[] {
  if (!gitdir) return [];
  const f = join(gitdir, "logs", "HEAD");
  let size = 0; let mtime = 0;
  try { const st = statSync(f); size = st.size; mtime = st.mtimeMs; } catch (e) { cache.delete(gitdir); return []; }
  const hit = cache.get(gitdir);
  if (hit && hit.size === size && hit.mtime === mtime) return hit.evs;
  let text = "";
  if (size <= MAX_READ) text = readText(f, 0, size);
  else { text = readText(f, size - MAX_READ - 1, MAX_READ + 1); const nl = text.indexOf("\n"); text = nl >= 0 ? text.slice(nl + 1) : ""; } // one byte early: a tail that starts on a line start keeps that line
  const evs = parseReflog(text, headBranch(gitdir));
  if (cache.size > 256) cache.clear();
  cache.set(gitdir, { size, mtime, evs });
  return evs;
}
// size + mtime of the reflog (cache keys of what is derived from it); "" missing
export function reflogStamp(gitdir: string): string {
  if (!gitdir) return ""; // never relative to the process cwd
  try { const st = statSync(join(gitdir, "logs", "HEAD")); return String(st.size) + ":" + String(st.mtimeMs); } catch (e) { return ""; }
}
// the gitdirs of every worktree of a repo: the common dir (the main worktree's) and <common>/worktrees/<name>
export function worktreeGitdirs(common: string): string[] {
  if (!common) return [];
  const out = [common];
  for (const n of listDir(join(common, "worktrees")).sort()) out.push(join(common, "worktrees", n));
  return out;
}
// the new-work shas of all worktrees' reflogs of a repo (enrichment: missing vs elsewhere)
export function repoShas(gitdir: string, common: string): Set<string> {
  const out = new Set<string>();
  const ds = worktreeGitdirs(common); if (ds.indexOf(gitdir) < 0) ds.push(gitdir);
  for (const d of ds) for (const e of readReflog(d)) out.add(e.sha);
  return out;
}
