// agentglass — project identity: which project (repo) a working directory belongs to, from the filesystem only (spec repo-view 1)
// SPDX-License-Identifier: Apache-2.0
// Linked worktrees and clones of one remote are one project: key git:<host>/<path> from the chosen remote (origin →
// upstream → first), else gitdir:<common dir> (worktrees of one local repo merge), else path:<cwd>. Every remote goes
// through scrubRemote first; .git is read only; the one git spawn is `git remote get-url` for aliases and [include]s.
import { existsSync, realpathSync } from "node:fs";
import { scrubRemote } from "../util/giturl.ts";
import { HOME } from "../util/fs.ts";

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
