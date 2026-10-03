// agentglass — git linkage: full shas, diff stats and still-exists status by one `git log --no-walk` per session view (spec git-linkage 5)
// SPDX-License-Identifier: Apache-2.0
// Lazy: only the git view and `--json --git` ask. Gated (attrib.ts spawnOk: ≤ 1 spawn per 500 ms in the TUI); closed
// sessions' results persist in vcs.json, live ones refresh at most once a minute.
import { openSync, writeSync, closeSync, renameSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { GitRun } from "../../model/project.ts";
import { type Obj, obj, arr, str } from "../../util/json.ts";
import { readText } from "../../util/fs.ts";
import { CACHE_DIR } from "../usage/callcache.ts";
import { type GitInfo, spawnOk, tally } from "./attrib.ts";

// one commit as git knows it: full sha, merge (≥ 2 parents), commit time (ms), subject, --shortstat numbers
export interface Stat { sha: string; merge: boolean; at: number; subj: string; add: number; del: number; files: number }
const STAT_RE = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;
// `--format=%H%x1f%P%x1f%ct%x1f%s%x1e --shortstat` output: records end at \x1e, each record's shortstat line follows it
export function parseShow(out: string): Stat[] {
  const st: Stat[] = [];
  for (const chunk of out.split("\x1e")) for (const l of chunk.split("\n")) {
    if (l.indexOf("\x1f") >= 0) {
      const f = l.split("\x1f"); const sha = (f[0] ?? "").trim();
      if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
      st.push({ sha, merge: (f[1] ?? "").trim().split(" ").filter((x: string) => x.length > 0).length >= 2, at: Number(f[2] ?? "0") * 1000, subj: (f[3] ?? "").slice(0, 80), add: 0, del: 0, files: 0 });
      continue;
    }
    const m = STAT_RE.exec(l); if (!m || !st.length) continue;
    const s = st[st.length - 1]; s.files = Number(m[1] ?? "0"); s.add = Number(m[2] ?? "0"); s.del = Number(m[3] ?? "0");
  }
  return st;
}
function inLog(shas: Set<string>, sha: string): boolean { for (const x of shas) if (x.startsWith(sha)) return true; return false; }
// short → full sha with stats; not returned: missing (rewritten/squashed, still counted when observed) when this worktree's
// reflog knows it, else elsewhere (another repo: `git -C ../other commit`), never counted
export function applyStats(g: GitInfo, st: Stat[], inReflog: Set<string>): void {
  for (const c of g.commits) {
    let hit: Stat | null = null; for (const s of st) if (s.sha.startsWith(c.sha)) { hit = s; break; }
    if (hit) {
      c.sha = hit.sha; c.merge = hit.merge; c.add = hit.add; c.del = hit.del; c.files = hit.files;
      if (hit.subj) c.subj = hit.subj;
      if (c.at <= 0) c.at = hit.at;
      if (c.status !== "amended" && c.status !== "elsewhere") c.status = "present"; // elsewhere: another worktree of the same object store
    } else if (c.status === "amended") continue;
    else if (inLog(inReflog, c.sha)) c.status = "missing";
    else { c.status = "elsewhere"; c.counted = false; }
  }
  tally(g);
}

// ── cache: key = session path + sha list; closed sessions persisted ──
interface Ent { st: Stat[]; at: number; keep: boolean } // keep = closed: written to vcs.json
const ents = new Map<string, Ent>();
export const VF = { file: join(CACHE_DIR, "vcs.json"), loaded: false, dirty: false, savedAt: 0 };
export function setVcsFile(p: string): void { VF.file = p; VF.loaded = false; ents.clear(); }
function statOut(s: Stat): unknown[] { return [s.sha, s.merge ? 1 : 0, s.at, s.subj, s.add, s.del, s.files]; }
function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
function load(): void {
  if (VF.loaded) return; VF.loaded = true;
  let size = 0; try { size = statSync(VF.file).size; } catch (e) { return; }
  let root: Obj | null = null; try { root = obj(JSON.parse(readText(VF.file, 0, size))); } catch (e) { root = null; }
  if (!root || num(root["v"]) !== 1) return;
  const es = obj(root["e"]); if (!es) return;
  for (const k of Object.keys(es)) {
    const st: Stat[] = [];
    for (const x of arr(es[k])) { const t = arr(x); if (t.length >= 7) st.push({ sha: str(t[0]), merge: num(t[1]) === 1, at: num(t[2]), subj: str(t[3]), add: num(t[4]), del: num(t[5]), files: num(t[6]) }); }
    ents.set(k, { st, at: 0, keep: true });
  }
}
// atomic (tmp + rename), only when dirty; false = could not write
export function saveVcs(): boolean {
  if (!VF.dirty) return true;
  const e: Obj = {};
  for (const [k, v] of ents) if (v.keep) { const rs: unknown[] = []; for (const s of v.st) rs.push(statOut(s)); e[k] = rs; }
  try {
    mkdirSync(dirname(VF.file), { recursive: true });
    const tmp = VF.file + ".tmp";
    const fd = openSync(tmp, "w"); writeSync(fd, JSON.stringify({ v: 1, e })); closeSync(fd);
    renameSync(tmp, VF.file);
  } catch (e2) { return false; }
  VF.dirty = false; VF.savedAt = Date.now();
  return true;
}
export const MAX_SHAS = 100;
const LIVE_MS = 60000;
const failed = new Map<string, number>(); // top → when git last failed there (retry after a minute)
// git failed in this checkout within the last minute: the view says "git unavailable"
export function gitFailed(top: string): boolean { const f = failed.get(top) ?? 0; return f > 0 && Date.now() - f < LIVE_MS; }
// fills g from cache or one gated spawn; closed = no process and the window ended > 10 min ago; inReflog = this worktree's
// reflog shas; true = g changed. `HEAD` rides along: an empty output then means git failed (missing, timeout, no repo)
export function enrich(path: string, g: GitInfo, top: string, closed: boolean, inReflog: Set<string>, git: GitRun): boolean {
  load();
  const shas: string[] = [];
  for (const c of g.commits) if (c.how === "observed" && shas.length < MAX_SHAS) shas.push(c.sha);
  for (const c of g.commits) if (c.how !== "observed" && shas.length < MAX_SHAS) shas.push(c.sha);
  if (!shas.length || !top) return false;
  let key = path; for (const x of shas) key += "\t" + x.slice(0, 7); // stable once applyStats wrote the full shas
  const hit = ents.get(key);
  if (hit && (hit.keep || Date.now() - hit.at < LIVE_MS)) { applyStats(g, hit.st, inReflog); return true; }
  if (gitFailed(top)) return false;
  if (!spawnOk()) return false; // a later frame
  const out = git("git", ["-C", top, "log", "--no-walk=unsorted", "--ignore-missing", "--format=%H%x1f%P%x1f%ct%x1f%s%x1e", "--shortstat"].concat(shas).concat(["HEAD"]));
  if (!out) { failed.set(top, Date.now()); return false; }
  failed.delete(top);
  const st = parseShow(out);
  if (ents.size > 2048) ents.clear();
  ents.set(key, { st, at: Date.now(), keep: closed });
  if (closed) VF.dirty = true;
  applyStats(g, st, inReflog);
  return true;
}
