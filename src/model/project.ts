// agentglass — project identity: which project (repo) a working directory belongs to, from the filesystem only (spec repo-view 1)
// SPDX-License-Identifier: Apache-2.0
// Linked worktrees and clones of one remote are one project: key git:<host>/<path> from the chosen remote (origin →
// upstream → first), else gitdir:<common dir> (worktrees of one local repo merge), else path:<cwd>. Every remote goes
// through scrubRemote first; .git is read only; the one git spawn is `git remote get-url` for aliases and [include]s.
import { existsSync, realpathSync, statSync, openSync, writeSync, closeSync, renameSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { scrubRemote } from "../util/giturl.ts";
import { HOME, readText, listDir } from "../util/fs.ts";
import { type Obj, obj, str } from "../util/json.ts";
import { home } from "../util/text.ts";

export interface RemoteEntry { name: string; url: string }
// path segments compare case-insensitively only on these exact hosts (spec decision 2)
export const CI_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"];
const DEF_PORTS = ["22", "443", "80"];

function unquote(v: string): string {
  let s = v.trim();
  if (s.startsWith('"')) { const e = s.indexOf('"', 1); return e > 0 ? s.slice(1, e) : s.slice(1); }
  const c = s.search(/\s[#;]/); if (c >= 0) s = s.slice(0, c);
  return s.trim();
}
// [remote "<name>"] sections with their first url, in file order (a minimal git-config reader: no includes, no escapes)
export function iniRemotes(text: string): RemoteEntry[] {
  const out: RemoteEntry[] = []; let cur = ""; let has = false;
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#") || l.startsWith(";")) continue;
    if (l.startsWith("[")) { const m = /^\[\s*remote\s+"([^"]*)"\s*\]/.exec(l); cur = m ? m[1] ?? "" : ""; has = false; continue; }
    if (!cur || has) continue;
    const m = /^url\s*=(.*)$/i.exec(l); if (!m) continue;
    const u = unquote(m[1] ?? ""); if (!u) continue;
    out.push({ name: cur, url: u }); has = true;
  }
  return out;
}
export function hasInclude(text: string): boolean { return /^\s*\[\s*include(If\s[^\]]*)?\s*\]/im.test(text); }
// origin, else upstream, else the first in file order (spec decision 1)
export function pickRemote(rs: RemoteEntry[]): RemoteEntry | null {
  for (const n of ["origin", "upstream"]) for (const r of rs) if (r.name === n) return r;
  return rs.length ? rs[0] : null;
}

export interface Norm { key: string; label: string; host: string; url: string } // url = scrubbed
// realpath (symlinks resolved); a path that does not exist → the input without // and trailing /
export function real(p: string): string {
  try { return realpathSync(p); } catch (e) { const n = p.replace(/\/{2,}/g, "/"); return n.length > 1 ? n.replace(/\/+$/, "") : n; }
}
function lastTwo(segs: string[]): string { const n = segs.length; return n >= 2 ? (segs[n - 2] ?? "") + "/" + (segs[n - 1] ?? "") : segs[0] ?? ""; }
// a remote URL → comparison key + label; null = dropped by the scrub, or no recognizable host (an alias like gh:o/r)
export function normRemote(raw: string): Norm | null {
  const r = scrubRemote(raw); if (!r) return null;
  if (!r.host) { // local repo as remote: the scrub stripped .git and wrote ~ for $HOME
    let p = r.url.slice(7); if (p.startsWith("~/")) p = HOME + p.slice(1);
    const rp = existsSync(p + ".git") ? real(p + ".git").replace(/\.git$/, "") : real(p);
    const segs = rp.split("/").filter((x) => x.length > 0);
    return { key: "git:file/" + segs.join("/"), label: segs[segs.length - 1] ?? rp, host: "", url: r.url };
  }
  let host = r.host.toLowerCase(); let port = "";
  const ci = host.lastIndexOf(":"); if (ci > 0 && /^\d+$/.test(host.slice(ci + 1))) { port = host.slice(ci + 1); host = host.slice(0, ci); }
  if (host.indexOf(".") < 0 && host !== "localhost" && !port) return null; // no dot, no port: an insteadOf alias
  const hp = host + (port && DEF_PORTS.indexOf(port) < 0 ? ":" + port : "");
  const segs = r.path.replace(/\.git$/, "").split("/").filter((x) => x.length > 0);
  if (!segs.length) return null;
  const path = segs.join("/");
  return { key: "git:" + hp + "/" + (CI_HOSTS.indexOf(host) >= 0 ? path.toLowerCase() : path), label: lastTwo(segs), host: hp, url: r.url };
}

// gitdir = the per-worktree git dir (<top>/.git or a .git file's target; "" non-git) for reflogs; worktree = linked
// worktree name ("" = main or non-git); via = the remote chosen; unread = .git exists but cannot be read (dim "?")
export interface Ident { key: string; label: string; kind: string /* git | gitdir | path | none */; top: string; common: string; gitdir: string; worktree: string; remote: string; via: string; gone: boolean; unread: boolean }
export type GitRun = (cmd: string, args: string[]) => string;
const MAX_UP = 40; const GITFILE_MAX = 1024; const CONFIG_MAX = 262144;
// set by resolveCwd: the last result is a path identity only because a .git file points to a missing gitdir (cache keeps the old one)
export const BROKEN = { v: false };

function ident(key: string, label: string, kind: string, top: string): Ident { return { key, label, kind, top, common: "", gitdir: "", worktree: "", remote: "", via: "", gone: false, unread: false }; }
function pathIdent(cwd: string): Ident { return ident("path:" + cwd, home(cwd), "path", cwd); }
function isDir(p: string): number { try { return statSync(p).isDirectory() ? 1 : 0; } catch (e) { return -1; } } // -1 missing
function sizeOf(p: string): number { try { return statSync(p).size; } catch (e) { return -1; } }
export function cfgMtime(common: string): number { try { return statSync(join(common, "config")).mtimeMs; } catch (e) { return 0; } }
// the `git remote get-url` fallback, once per (common dir, config mtime)
const gitHits = new Map<string, string>();
function askGit(git: GitRun, top: string, common: string, name: string): string {
  const k = common + "\t" + String(cfgMtime(common)) + "\t" + name;
  const hit = gitHits.get(k); if (hit !== undefined) return hit;
  const out = git("git", ["-C", top, "remote", "get-url", name]).trim().split("\n")[0] ?? "";
  if (gitHits.size > 512) gitHits.clear();
  gitHits.set(k, out); return out;
}

// spec 1 steps 1–7; pure apart from stat/read (and the git fallback through git)
export function resolveCwd(cwd: string, git: GitRun): Ident {
  BROKEN.v = false;
  if (!cwd) return ident("none", "(no project)", "none", "");
  if (isDir(cwd) < 0) { const g = ident("path:" + cwd, home(cwd) + " (gone)", "path", cwd); g.gone = true; return g; }
  const rc = real(cwd);
  let d = rc; let top = ""; let gitdir = "";
  for (let i = 0; i < MAX_UP; i++) {
    const g = join(d, ".git"); const t = isDir(g);
    if (t === 1) { top = d; gitdir = g; if (!listDir(g).length) { const u = pathIdent(rc); u.unread = true; return u; } break; }
    if (t === 0) {
      const sz = sizeOf(g); const txt = sz > 0 && sz <= GITFILE_MAX ? readText(g, 0, GITFILE_MAX) : "";
      const m = /^gitdir:\s*(.+)$/m.exec(txt);
      if (!m) { const u = pathIdent(rc); u.unread = true; return u; }
      const gd = resolve(d, (m[1] ?? "").trim());
      if (isDir(gd) !== 1) { BROKEN.v = true; return pathIdent(rc); }
      top = d; gitdir = real(gd); break;
    }
    const up = dirname(d); if (up === d) break; d = up;
  }
  if (!top) return pathIdent(rc);
  const cd = readText(join(gitdir, "commondir"), 0, GITFILE_MAX).trim();
  const common = cd ? real(resolve(gitdir, cd)) : gitdir;
  const mainTop = common.endsWith("/.git") ? dirname(common) : top;
  const id = ident("", "", "git", top);
  id.common = common; id.gitdir = gitdir;
  id.worktree = cd && top !== mainTop ? basename(top) : ""; // only linked worktrees have a commondir
  const csz = sizeOf(join(common, "config"));
  const text = csz > 0 && csz <= CONFIG_MAX ? readText(join(common, "config"), 0, CONFIG_MAX) : "";
  const pick = pickRemote(iniRemotes(text));
  let n = pick ? normRemote(pick.url) : null;
  const alias = pick !== null && n === null && scrubRemote(pick.url) !== null; // scrubbed fine, no host: an insteadOf alias
  if (n === null && (alias || (pick === null && hasInclude(text)))) n = normRemote(askGit(git, top, common, pick ? pick.name : "origin"));
  if (n) { id.key = n.key; id.label = n.label; id.remote = n.url; id.via = pick ? pick.name : "origin"; return id; }
  id.kind = "gitdir"; id.key = "gitdir:" + common;
  id.label = basename(mainTop === top && !common.endsWith("/.git") ? common.replace(/\.git$/, "") : mainTop);
  return id;
}
// the repo-relative dir of cwd ("" at the top or for non-git identities)
export function subOf(id: Ident, cwd: string): string {
  if ((id.kind !== "git" && id.kind !== "gitdir") || !id.top || !cwd) return "";
  const rc = real(cwd);
  return rc.startsWith(id.top + "/") ? rc.slice(id.top.length + 1) : "";
}

// ── cache: per cwd, resolved within a per-tick budget, revalidated after 10 min, persisted in projects.json ──
interface Ent { id: Ident; mt: number; checked: number } // mt = config mtime at resolve time
const cwds = new Map<string, Ent>();
const queue: string[] = []; const queued = new Set<string>();
const sessCwd = new Map<string, string>(); // session path → cwd (Claude/Codex heads need not be re-read after a restart)
const NONE = ident("none", "(no project)", "none", "");
const REVALIDATE_MS = 600000;
// ver: bumps when an identity is added or changes (aggregation cache key); todo: cwds still queued
export const P = { ver: 0, todo: 0, dirty: false };
// AGENTGLASS_CACHE_DIR: branch builds keep their caches apart (like the ledger)
export const PROJECTS_FILE = join(process.env.AGENTGLASS_CACHE_DIR || join(HOME, ".agentglass", "cache"), "projects.json");

export function identOfCwd(cwd: string): Ident | null {
  if (!cwd) return NONE;
  const e = cwds.get(cwd); if (e) return e.id;
  if (!queued.has(cwd)) { queued.add(cwd); queue.push(cwd); P.todo = queue.length; }
  return null;
}
function same(a: Ident, b: Ident): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function store(cwd: string, id: Ident, now: number): void {
  const old = cwds.get(cwd);
  cwds.set(cwd, { id, mt: id.common ? cfgMtime(id.common) : 0, checked: now });
  if (!old || !same(old.id, id)) P.ver++;
  P.dirty = true;
}
// a re-resolve: a vanished cwd is never re-resolved; a git identity survives a broken .git link (main repo deleted)
function revalidate(cwd: string, e: Ent, now: number, git: GitRun): void {
  e.checked = now;
  if (e.id.gone || isDir(cwd) !== 1) return;
  if (e.id.common && cfgMtime(e.id.common) === e.mt && isDir(e.id.common) === 1) return;
  const id = resolveCwd(cwd, git);
  if (BROKEN.v && (e.id.kind === "git" || e.id.kind === "gitdir")) return;
  store(cwd, id, now);
}
// resolves queued cwds, then revalidates stale entries, until maxMs (by now()) or maxN; returns the number resolved
let rvAt = 0; // revalidation resumes where the last tick stopped
export function resolveTick(maxMs: number, maxN: number, now: () => number, git: GitRun): number {
  const t0 = now(); let n = 0;
  while (queue.length && n < maxN && now() - t0 < maxMs) {
    const cwd = queue.shift() ?? ""; queued.delete(cwd);
    if (!cwds.has(cwd)) store(cwd, resolveCwd(cwd, git), now());
    n++;
  }
  P.todo = queue.length;
  if (queue.length) return n;
  const ks = [...cwds.keys()]; const t = now();
  for (let i = 0; i < ks.length && n < maxN && now() - t0 < maxMs; i++) {
    const k = ks[(rvAt + i) % ks.length] ?? ""; const e = cwds.get(k);
    if (!e || t - e.checked <= REVALIDATE_MS) continue;
    revalidate(k, e, now(), git); n++; rvAt = (rvAt + i + 1) % ks.length;
  }
  return n;
}
// label → distinct keys, rebuilt per P.ver: two keys with one label both get the host prefix
let lblVer = -1; const lblKey = new Map<string, string>(); const lblMany = new Map<string, boolean>();
export function labelOf(id: Ident): string {
  if (id.kind !== "git") return id.label;
  if (lblVer !== P.ver) {
    lblKey.clear(); lblMany.clear(); lblVer = P.ver;
    for (const e of cwds.values()) {
      if (e.id.kind !== "git") continue;
      const l = e.id.label.toLowerCase(); const k = lblKey.get(l);
      if (k === undefined) lblKey.set(l, e.id.key); else if (k !== e.id.key) lblMany.set(l, true);
    }
  }
  if (!lblMany.get(id.label.toLowerCase())) return id.label;
  const hp = id.key.slice(4); const sl = hp.indexOf("/");
  return (sl > 0 ? hp.slice(0, sl) : hp) + "/" + id.label;
}
export function rememberSess(path: string, cwd: string): void { if (path && cwd && sessCwd.get(path) !== cwd) { sessCwd.set(path, cwd); P.dirty = true; } }
export function cwdOfSess(path: string): string { return sessCwd.get(path) ?? ""; }
export function resetProjects(): void { cwds.clear(); queue.length = 0; queued.clear(); sessCwd.clear(); P.todo = 0; P.ver++; P.dirty = false; rvAt = 0; }

const FIELDS = ["key", "label", "kind", "top", "common", "gitdir", "worktree", "remote", "via"];
function identIn(o: Obj): Ident {
  const id = ident(str(o["key"]), str(o["label"]), str(o["kind"]), str(o["top"]));
  id.common = str(o["common"]); id.gitdir = str(o["gitdir"]); id.worktree = str(o["worktree"]); id.remote = str(o["remote"]); id.via = str(o["via"]);
  id.gone = o["gone"] === true; id.unread = o["unread"] === true;
  return id;
}
function num(v: unknown): number { return typeof v === "number" ? (v as number) : 0; }
export function loadProjects(file: string): void {
  const sz = sizeOf(file); if (sz <= 0) return;
  let root: Obj | null = null; try { root = obj(JSON.parse(readText(file, 0, sz))); } catch (e) { root = null; }
  if (!root || num(root["v"]) !== 1) return;
  const cs = obj(root["cwds"]);
  if (cs) for (const k of Object.keys(cs)) {
    const o = obj(cs[k]); if (!o || !str(o["key"]) || cwds.has(k)) continue;
    const id = identIn(o);
    if (id.remote && !scrubRemote(id.remote)) { id.remote = ""; } // never trust a stored remote that no longer passes the scrub
    cwds.set(k, { id, mt: num(o["cfgMtime"]), checked: num(o["checked"]) });
  }
  const ss = obj(root["sess"]);
  if (ss) for (const k of Object.keys(ss)) { const c = str(ss[k]); if (c && !sessCwd.has(k)) sessCwd.set(k, c); }
  P.ver++;
}
// atomic (tmp + rename); only when dirty; live = existing session paths (others are dropped); false = could not write
export function saveProjects(file: string, live: Set<string>): boolean {
  if (!P.dirty) return true;
  const cs: Obj = {};
  for (const [k, e] of cwds) {
    const o: Obj = {}; const id = e.id;
    const vals = [id.key, id.label, id.kind, id.top, id.common, id.gitdir, id.worktree, id.remote, id.via];
    for (let i = 0; i < FIELDS.length; i++) o[FIELDS[i] ?? ""] = vals[i] ?? "";
    o["gone"] = id.gone; o["unread"] = id.unread; o["cfgMtime"] = e.mt; o["checked"] = e.checked;
    cs[k] = o;
  }
  const ss: Obj = {};
  for (const [k, c] of sessCwd) { if (live.has(k)) ss[k] = c; else sessCwd.delete(k); }
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    const fd = openSync(tmp, "w"); writeSync(fd, JSON.stringify({ v: 1, cwds: cs, sess: ss })); closeSync(fd);
    renameSync(tmp, file);
  } catch (e) { return false; }
  P.dirty = false;
  return true;
}
