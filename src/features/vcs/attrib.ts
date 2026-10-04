// agentglass — git linkage: which commits a session produced (✓ observed), saw nearby (≈ reflog) or shares (? shared) (spec git-linkage 4)
// SPDX-License-Identifier: Apache-2.0
// observed = the session's own banners, plus reflog commits of its worktree inside its own commit-making git calls (quiet
// commits). Everything else in a session's window is listed, never counted: the person may have made it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Sess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { sessions } from "../../model/sessions.ts";
import { type GitRun, P } from "../../model/project.ts";
import { intSetting } from "../../util/config.ts";
import { readText, run } from "../../util/fs.ts";
import { ledger } from "../usage/ledger.ts";
import { L } from "../usage/record.ts";
import type { VRef } from "../usage/vcs.ts";
import { livePid } from "../query/eval.ts";
import { identOf } from "../query/project.ts";
import { type RefEv, readReflog, reflogStamp, isNew, worktreeGitdirs } from "./reflog.ts";

// pad = git.tailPadMin (minutes after the last activity that still belong to the session: agents commit after a long test run);
// spawn = git spawns allowed in the TUI; cli = allowed in a CLI run (--json --git only); gate = at most one per 500 ms (TUI);
// last = time of the last spawn
export const GIT = { pad: 10, spawn: true, cli: false, gate: true, last: 0 };
export const HEAD_MS = 120000; // the window opens 2 min before the first activity
export const SPAN_SLACK = 5000; // a git call's span ends 5 s after its result (and starts 1 s early: reflog seconds)
// one git spawn allowed now (TUI: ≤ 1 per 500 ms; CLI: ungated); true books it
export function spawnOk(): boolean {
  if (S.cli ? !GIT.cli : !GIT.spawn) return false;
  const now = Date.now();
  if (GIT.gate && now - GIT.last < 500) return false;
  GIT.last = now; return true;
}

// key = project key; t0/t1 = the window (epoch ms; t1 ≤ t0 = no window); sub = a subagent (its parent's window covers it)
export interface SessIn { path: string; gitdir: string; common: string; key: string; top: string; branch: string; t0: number; t1: number; live: boolean; sub: boolean; refs: VRef[] }
// how = observed | reflog | shared; status = present | missing | amended | elsewhere | unknown (enrichment fills it in)
// path = the session whose transcript holds call (a parent's view lists its subagents' rows too); add/del/files -1 = unknown
export interface GCommit { sha: string; br: string; subj: string; at: number; how: string; counted: boolean; status: string; merge: boolean; add: number; del: number; files: number; call: string; ts: string; path: string }
export interface GLink { url: string; n: number; how: string; call: string; ts: string; path: string }
// produced = counted commits; byBranch = counted commits per branch ("" = detached / unknown)
// fb = the no-reflog fallback ran (or does not apply)
export interface GitInfo { commits: GCommit[]; prs: GLink[]; issues: GLink[]; links: GLink[]; produced: number; noReflog: boolean; byBranch: Map<string, number>; fb: boolean }

export function newInfo(): GitInfo { return { commits: [], prs: [], issues: [], links: [], produced: 0, noReflog: false, byBranch: new Map<string, number>(), fb: false }; }
// [first activity − 2 min, (live ? now : last activity) + pad]; [] without activity
export function windowOf(af: number, al: number, live: boolean, padMin: number, now: number): number[] {
  if (af <= 0) return [];
  return [af - HEAD_MS, (live ? Math.max(now, al) : al) + padMin * 60000];
}
function spans(refs: VRef[]): number[] {
  const out: number[] = [];
  for (const r of refs) {
    if (r.k !== "gcall") continue;
    const i = r.v.indexOf("-"); const a = Number(r.v.slice(0, i)); const b = Number(r.v.slice(i + 1));
    if (a > 0 && b >= a) { out.push(a - 1000); out.push(b + SPAN_SLACK); } // reflog times are whole seconds
  }
  return out;
}
function inSpans(sp: number[], t: number): boolean { for (let i = 0; i + 1 < sp.length; i += 2) if (t >= (sp[i] ?? 0) && t <= (sp[i + 1] ?? 0)) return true; return false; }
function covers(s: SessIn, t: number): boolean { return s.t1 > s.t0 && t >= s.t0 && t <= s.t1; }
function links(refs: VRef[], k: string, path: string): GLink[] {
  const out: GLink[] = [];
  for (const r of refs) if (r.k === k) {
    let n = 0; if (k !== "link") { const m = /\/(\d+)$/.exec(r.v); n = m ? Number(m[1] ?? "0") : 0; }
    out.push({ url: r.v, n, how: r.how, call: r.call, ts: r.ts, path });
  }
  out.sort((x: GLink, y: GLink) => (x.how === "created" ? 0 : 1) - (y.how === "created" ? 0 : 1)); // stable: first sighting order within each
  return out;
}
function row(sha: string, br: string, subj: string, at: number, how: string, call: string, ts: string, path: string): GCommit {
  return { sha, br, subj, at, how, counted: how === "observed", status: "unknown", merge: false, add: -1, del: -1, files: -1, call, ts, path };
}
function evIndex(evs: RefEv[], sha: string): number { // a printed (short) sha → its newest new-work event in the reflog
  for (let i = evs.length - 1; i >= 0; i--) { const e = evs[i]; if (isNew(e) && e.sha.startsWith(sha)) return i; }
  return -1;
}

// pure: sessions (each with its window, refs and gitdir) + each gitdir's reflog → per session path its git info. peers =
// common dir → the gitdirs of all its worktrees (their reflogs in logs): a banner made in a sibling worktree is found there
export function attribute(ss: SessIn[], logs: Map<string, RefEv[]>): Map<string, GitInfo> { return attributeWith(ss, logs, new Map<string, string[]>()); }
export function attributeWith(ss: SessIn[], logs: Map<string, RefEv[]>, pm: Map<string, string[]>): Map<string, GitInfo> {
  const out = new Map<string, GitInfo>();
  const owner = new Map<string, string[]>(); // "<gitdir>\t<event index>" → the sessions observing it
  const evOf = (s: SessIn): RefEv[] => { const e = logs.get(s.gitdir); return e ? e : []; };
  const seen = new Set<string>(); // sibling gitdirs holding a banner commit
  const own = (k: string, p: string): void => { const o = owner.get(k); if (!o) owner.set(k, [p]); else if (o.indexOf(p) < 0) o.push(p); };
  // 1. banners: observed wherever their sha is; spans: reflog new work inside the session's own git calls
  for (const s of ss) {
    const g = newInfo(); out.set(s.path, g);
    g.noReflog = s.gitdir !== "" && !logs.has(s.gitdir);
    g.prs = links(s.refs, "pr", s.path); g.issues = links(s.refs, "issue", s.path); g.links = links(s.refs, "link", s.path);
    const evs = evOf(s); const sp = spans(s.refs);
    for (const r of s.refs) {
      if (r.k !== "commit") continue;
      const i = evIndex(evs, r.v);
      if (i >= 0) { own(s.gitdir + "\t" + String(i), s.path); continue; }
      let pd = ""; let j = -1; // a sibling worktree of the same repo (cd ../wt && git commit)
      for (const d of pm.get(s.common) ?? []) { if (d === s.gitdir) continue; j = evIndex(logs.get(d) ?? [], r.v); if (j >= 0) { pd = d; break; } }
      if (pd) { own(pd + "\t" + String(j), s.path); seen.add(pd); continue; }
      // in no reflog of the repo: unknown, counted (a banner is observed work). Not "elsewhere" yet: removed worktrees take
      // their reflogs with them and unreachable entries expire, so only enrichment (the object DB) can tell
      const c = row(r.v, r.br, r.subj, r.t, "observed", r.call, r.ts, s.path);
      g.commits.push(c);
    }
    if (sp.length) for (let i = 0; i < evs.length; i++) { const e = evs[i]; if (isNew(e) && inSpans(sp, e.at)) own(s.gitdir + "\t" + String(i), s.path); }
  }
  const byPath = new Map<string, SessIn>(); for (const s of ss) byPath.set(s.path, s);
  const bannerOf = (s: SessIn, e: RefEv): VRef | null => { for (const r of s.refs) if (r.k === "commit" && e.sha.startsWith(r.v)) return r; return null; };
  const callOf = (s: SessIn, e: RefEv): VRef | null => { // the git call whose span holds the event
    for (const r of s.refs) { if (r.k !== "gcall") continue; const sp = spans([r]); if (inSpans(sp, e.at)) return r; }
    return null;
  };
  // 2. per gitdir: observed events go to their observers (several span observers without a banner = shared); the rest of
  // the new work goes to the windows covering it — one session ≈, several ? shared
  const dirs = new Set<string>(); for (const d of seen) dirs.add(d); for (const s of ss) if (s.gitdir && logs.has(s.gitdir)) dirs.add(s.gitdir);
  for (const gd of dirs) {
    const evs = logs.get(gd) ?? [];
    const here: SessIn[] = []; for (const s of ss) if (s.gitdir === gd) here.push(s);
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]; if (!isNew(e)) continue;
      const obs = owner.get(gd + "\t" + String(i)) ?? [];
      let who: SessIn[] = []; for (const p of obs) { const s = byPath.get(p); if (s && bannerOf(s, e)) who.push(s); }
      if (!who.length && obs.length === 1) { const s = byPath.get(obs[0] ?? ""); if (s) who = [s]; }
      if (who.length) {
        for (const s of who) {
          const b = bannerOf(s, e); const r = b ?? callOf(s, e);
          const c = row(e.sha, b && b.br ? b.br : e.branch, b && b.subj ? b.subj : e.subj, e.at, "observed", r ? r.call : "", r ? r.ts : "", s.path);
          c.status = "present"; c.merge = e.op === "merge";
          if (e.amended) c.status = "amended-?"; // resolved below once every observed row exists
          const g = out.get(s.path); if (g) g.commits.push(c);
        }
        continue;
      }
      const cov: SessIn[] = [];
      if (obs.length > 1) { for (const p of obs) { const s = byPath.get(p); if (s) cov.push(s); } } // two sessions' git calls at once
      else for (const s of here) if (!s.sub && covers(s, e.at)) cov.push(s);
      for (const s of cov) {
        const c = row(e.sha, e.branch, e.subj, e.at, cov.length > 1 ? "shared" : "reflog", "", "", s.path);
        c.status = "present"; c.merge = e.op === "merge"; c.counted = false;
        const g = out.get(s.path); if (g) g.commits.push(c);
      }
    }
  }
  // 3. amend chains count once: an observed commit whose amend result this session also observed is "amended", not counted
  for (const s of ss) {
    const g = out.get(s.path); if (!g) continue;
    const evs = evOf(s);
    for (const c of g.commits) {
      if (c.status !== "amended-?") continue;
      c.status = "present";
      for (const e of evs) if (e.op === "amend" && e.old === c.sha) { for (const d of g.commits) if (d.sha === e.sha && d.how === "observed") { c.status = "amended"; c.counted = false; } break; }
    }
    g.commits.sort((x: GCommit, y: GCommit) => x.at - y.at);
    tally(g);
  }
  return out;
}
// produced + per-branch counts from the counted rows
export function tally(g: GitInfo): void {
  g.produced = 0; g.byBranch.clear();
  for (const c of g.commits) if (c.counted) { g.produced++; g.byBranch.set(c.br, (g.byBranch.get(c.br) ?? 0) + 1); }
}

// ── no reflog: commits in the session's window by `git log` (one spawn per session, cached) ──
const emails = new Map<string, string>();
// git config user.email, once per repo (in memory only: never persisted or shown)
export function userEmail(top: string, git: GitRun): string {
  const hit = emails.get(top); if (hit !== undefined) return hit;
  const e = git("git", ["-C", top, "config", "user.email"]).trim();
  emails.set(top, e); return e;
}
function hasBranch(common: string, b: string): boolean {
  if (!b || !common) return false;
  if (existsSync(join(common, "refs", "heads", b))) return true;
  return readText(join(common, "packed-refs"), 0, 4194304).indexOf(" refs/heads/" + b + "\n") >= 0;
}
export function parseLog(out: string): RefEv[] {
  const evs: RefEv[] = [];
  for (const rec of out.split("\x1e")) {
    const f = rec.trim().split("\x1f"); if (f.length < 3) continue;
    const sha = f[0] ?? ""; if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    evs.push({ at: Number(f[1] ?? "0") * 1000, old: "", sha, op: "commit", branch: "", subj: (f[2] ?? "").slice(0, 80), amended: false });
  }
  return evs.reverse(); // git log is newest first
}
const wlogs = new Map<string, RefEv[]>();
// the commits of the session's branch (else all branches) between t0 and t1 by the repo's user.email (spec 3, fallback)
export function windowLog(key: string, top: string, common: string, branch: string, t0: number, t1: number, git: GitRun): RefEv[] {
  const ck = key + "\t" + String(t0) + "\t" + String(t1);
  const hit = wlogs.get(ck); if (hit) return hit;
  const args = ["-C", top, "log", hasBranch(common, branch) ? "refs/heads/" + branch : "--branches", "--since=@" + String(Math.floor(t0 / 1000)), "--until=@" + String(Math.ceil(t1 / 1000))];
  const em = userEmail(top, git); if (em) args.push("--author=" + em);
  args.push("--format=%H%x1f%ct%x1f%s%x1e");
  const evs = parseLog(git("git", args));
  for (const e of evs) e.branch = hasBranch(common, branch) ? branch : "";
  if (wlogs.size > 1024) wlogs.clear();
  wlogs.set(ck, evs);
  return evs;
}
export function windowLogCached(key: string, t0: number, t1: number): boolean { return wlogs.has(key + "\t" + String(t0) + "\t" + String(t1)); }

// ── glue: sessions → SessIn, all attributed together ──
GIT.pad = intSetting("git", "tailPadMin", 0, 120, 10);
const GITS: GitRun[] = [run]; // the runner (checks swap in a stub)
export function setGitRun(g: GitRun): void { GITS[0] = g; }
export function gitRun(): GitRun { return GITS[0] ?? run; }
// a git session whose worktree was removed since (gitdir ""): no reflog, but its own banners and links still count
export function sessIn(s: Sess, now: number): SessIn | null {
  const id = identOf(s); if (!id || !(id.gitdir || (id.gone && id.kind === "git"))) return null;
  const a = ledger.get(s.path);
  const live = livePid(s) > 0;
  const w = a ? windowOf(a.t0, a.al, live, GIT.pad, now) : [];
  return { path: s.path, gitdir: id.gitdir, common: id.common, key: id.key, top: id.top, branch: s.branch, t0: w.length ? w[0] ?? 0 : 0, t1: w.length ? w[1] ?? 0 : 0, live, sub: s.parent !== "", refs: a ? a.vcs : [] };
}
// every session's attribution at once (one pass, per gitdir), rebuilt when sessions, identities or a reflog change, and
// at most once a second while only the ledger moved (live sessions write all the time). Whether anything changed takes a
// pass over every session and reflog too: at most once a second while the ledger stands still (seen = its last pass;
// a CLI asks once per listed session)
const ALL = { key: "", ver: -1, at: 0, seen: 0, info: new Map<string, GitInfo>(), proj: new Map<string, SessIn[]>(), ins: new Map<string, SessIn>() };
// sessions were indexed or placed outside the ledger's tick (a CLI completing a worktree's peers): look again at once
export function gitStale(): void { ALL.at = 0; ALL.seen = 0; }
export function allInfo(): Map<string, GitInfo> {
  const now = Date.now();
  const ss: SessIn[] = []; const dirs = new Set<string>(); let stamps = "";
  if (ALL.ver === L.ver && now - Math.max(ALL.at, ALL.seen) < 1000) return ALL.info;
  const peers = new Map<string, string[]>(); // common dir → its worktrees' gitdirs (banners made in a sibling worktree)
  for (const x of sessions.values()) {
    if (!ledger.has(x.path)) continue; const i = sessIn(x, now); if (!i) continue;
    ss.push(i); if (i.gitdir) dirs.add(i.gitdir);
    if (i.common && !peers.has(i.common)) { const ds = worktreeGitdirs(i.common); peers.set(i.common, ds); for (const d of ds) dirs.add(d); }
  }
  const logs = new Map<string, RefEv[]>();
  for (const d of dirs) { const st = reflogStamp(d); stamps += st + ","; if (st) logs.set(d, readReflog(d)); }
  const key = String(P.ver) + "|" + String(sessions.size) + "|" + String(ss.length) + "|" + stamps;
  if (key === ALL.key && (ALL.ver === L.ver || now - ALL.at < 1000)) { ALL.seen = now; return ALL.info; }
  ALL.info = attributeWith(ss, logs, peers); ALL.key = key; ALL.ver = L.ver; ALL.at = now;
  ALL.proj.clear(); ALL.ins.clear();
  for (const x of ss) { ALL.ins.set(x.path, x); if (x.sub) continue; const l = ALL.proj.get(x.key); if (l) l.push(x); else ALL.proj.set(x.key, [x]); }
  return ALL.info;
}
// the session's own git info (null: no git worktree known); without a reflog the window `git log` adds its ≈ rows (gated
// spawn, cached; asked sessions only: those rows are never counted, so aggregations need no spawns)
export function gitInfo(s: Sess): GitInfo | null {
  const g = allInfo().get(s.path); if (!g) return null;
  const me = ALL.ins.get(s.path);
  if (g.noReflog && !g.fb && me) fallback(me, g, ALL.proj.get(me.key) ?? []);
  return g;
}
// no reflog: the session's window commits by `git log`, kept only when no other session of the project covers the time
function fallback(s: SessIn, g: GitInfo, proj: SessIn[]): void {
  if (s.sub || s.t1 <= s.t0 || !s.top) { g.fb = true; return; }
  const t1 = s.live ? Math.ceil(s.t1 / 60000) * 60000 : s.t1; // live: the window end moves; one fetch per minute
  if (!windowLogCached(s.path, s.t0, t1) && !spawnOk()) return; // budgeted: a later frame fetches it
  g.fb = true;
  for (const e of windowLog(s.path, s.top, s.common, s.branch, s.t0, t1, gitRun())) {
    let n = 0; for (const o of proj) if (covers(o, e.at)) n++;
    if (n > 1) continue;
    let seen = false; for (const c of g.commits) if (e.sha.startsWith(c.sha)) { c.at = e.at; c.status = "present"; seen = true; }
    if (seen) continue;
    const c = row(e.sha, e.branch, e.subj, e.at, "reflog", "", "", s.path); c.counted = false; c.status = "present";
    g.commits.push(c);
  }
  g.commits.sort((x: GCommit, y: GCommit) => x.at - y.at);
  tally(g);
}
// ── a session with its subagents (parent totals include sub-agent commits, as cost does) ──
function copyOf(c: GCommit): GCommit { return { sha: c.sha, br: c.br, subj: c.subj, at: c.at, how: c.how, counted: c.counted, status: c.status, merge: c.merge, add: c.add, del: c.del, files: c.files, call: c.call, ts: c.ts, path: c.path }; }
// a new object (the cached per-session infos stay as they are); a subagent's ✓ beats its parent's ≈ of the same sha
export function merged(gs: GitInfo[]): GitInfo {
  const out = newInfo(); out.fb = true;
  const same = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
  const hasUrl = (ls: GLink[], u: string): boolean => { for (const l of ls) if (l.url === u) return true; return false; };
  for (const g of gs) {
    if (g.noReflog) out.noReflog = true;
    for (const c of g.commits) {
      let hit: GCommit | null = null; for (const d of out.commits) if (same(d.sha, c.sha)) { hit = d; break; }
      if (!hit) { out.commits.push(copyOf(c)); continue; }
      if (c.counted && !hit.counted) { hit.how = c.how; hit.counted = true; hit.path = c.path; hit.call = c.call; hit.ts = c.ts; hit.br = c.br; }
    }
    for (const l of g.prs) if (!hasUrl(out.prs, l.url)) out.prs.push(l);
    for (const l of g.issues) if (!hasUrl(out.issues, l.url)) out.issues.push(l);
    for (const l of g.links) if (!hasUrl(out.links, l.url)) out.links.push(l);
  }
  const cr = (l: GLink): number => l.how === "created" ? 0 : 1;
  out.prs.sort((x: GLink, y: GLink) => cr(x) - cr(y)); out.issues.sort((x: GLink, y: GLink) => cr(x) - cr(y));
  out.commits.sort((x: GCommit, y: GCommit) => x.at - y.at);
  tally(out);
  return out;
}
// the session's git info with its subagents'; null = no git worktree known for any of them
export function sessGit(s: Sess): GitInfo | null {
  const gs: GitInfo[] = [];
  const g = gitInfo(s); if (g) gs.push(g);
  for (const c of s.subs) { const x = gitInfo(c); if (x) gs.push(x); }
  return !gs.length ? null : gs.length === 1 && !s.subs.length ? gs[0] : merged(gs);
}
