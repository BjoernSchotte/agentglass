// agentglass — git remote URLs without credentials: every remote agentglass shows or exports goes through scrubRemote
// SPDX-License-Identifier: Apache-2.0
import { HOME } from "./fs.ts";

// url = scrubbed canonical form scheme://host[:port]/path (no userinfo, query, fragment, .git); owner/name = last two path segments
export interface Remote { url: string; host: string; path: string; owner: string; name: string }
const SCHEMES = ["https", "http", "ssh", "git", "git+ssh", "file"];

function build(scheme: string, host: string, path0: string): Remote | null {
  const p0 = path0.replace(/\/+$/, "").replace(/\.git$/, "");
  // whatever survived the userinfo/query/fragment cut must not still carry one (a:b@c smuggling, %40, \ paths)
  if (/[@?#\\]|%40|%3a/i.test(host + "/" + p0)) return null;
  if (host && !/^[a-z0-9._\-[\]]+(:\d+)?$/.test(host)) return null;
  const segs = p0.split("/").filter((x) => x.length > 0); // never dropped as tokens: userinfo/query/fragment are already gone
  const path = segs.join("/");
  const n = segs.length;
  const owner = n >= 2 ? segs[n - 2] ?? "" : ""; const name = n >= 2 ? segs[n - 1] ?? "" : "";
  if (scheme === "file") return path ? { url: "file://" + p0, host: "", path, owner, name } : null;
  return { url: scheme + "://" + host + (path ? "/" + path : ""), host, path, owner, name };
}
function local(p: string): Remote | null { return build("file", "", p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p); }

// null = dropped: unparseable, unknown scheme, or still suspicious after removing userinfo, query and fragment
export function scrubRemote(raw: string): Remote | null {
  const s = raw.trim();
  if (!s || s.length > 2048 || /[\x00-\x1f\x7f]/.test(s)) return null;
  const m = /^([A-Za-z][A-Za-z0-9+]*):\/\/(.*)$/.exec(s);
  if (m) {
    const scheme = (m[1] ?? "").toLowerCase(); if (SCHEMES.indexOf(scheme) < 0) return null;
    let rest = m[2] ?? "";
    const q = rest.search(/[?#]/); if (q >= 0) rest = rest.slice(0, q);
    if (scheme === "file") return rest.startsWith("/") ? local(rest) : rest.startsWith("~/") ? build("file", "", rest) : null; // ~: our own scrubbed form
    const sl = rest.indexOf("/");
    let auth = sl >= 0 ? rest.slice(0, sl) : rest; const path = sl >= 0 ? rest.slice(sl) : "";
    const at = auth.lastIndexOf("@"); if (at >= 0) auth = auth.slice(at + 1); // last @: a:b@c@host cannot smuggle a host
    if (!auth) return null;
    return build(scheme, auth.toLowerCase(), path);
  }
  if (s.startsWith("/")) return local(s);
  if (s.startsWith("~/")) return build("file", "", s);
  // [user@]host:path, user dropped; host:/abs/path too (ssh to that path); X:/… is a DOS drive (git's rule on Windows;
  // a one-letter host with a relative path, g:o/r, stays: an insteadOf alias that git resolves)
  const scp = /^(?:[^@/\s]+@)?([^:/\s@]+):([^\s]+)$/.exec(s);
  const sp = scp ? scp[2] ?? "" : "";
  if (scp && !sp.startsWith("\\") && !/^[A-Za-z]:\//.test(s)) return build("ssh", (scp[1] ?? "").toLowerCase(), sp);
  return null;
}
// preview form: github.com/o/r, a local path for file:// remotes
export function remoteLabel(r: Remote): string { return r.host ? r.host + (r.path ? "/" + r.path : "") : r.url.slice(7); }
