// agentglass — project identity: which project (repo) a working directory belongs to, from the filesystem only (spec repo-view 1)
// SPDX-License-Identifier: Apache-2.0
// Linked worktrees and clones of one remote are one project: key git:<host>/<path> from the chosen remote (origin →
// upstream → first), else gitdir:<common dir> (worktrees of one local repo merge), else path:<cwd>. Every remote goes
// through scrubRemote first; .git is read only; the one git spawn is `git remote get-url` for aliases and [include]s.
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { scrubRemote } from "../util/giturl.ts";
import { HOME, readText, listDir } from "../util/fs.ts";
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
