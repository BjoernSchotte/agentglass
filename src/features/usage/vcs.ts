// agentglass — git linkage, ledger side: commit banners, forge URLs and git-command spans scraped from tool output (spec git-linkage 2)
// SPDX-License-Identifier: Apache-2.0
// Runs on every transcript line right after the adapter's usage(): the calls that line closed (Acc.dn) name the command
// that produced the output. A cheap indexOf prefilter keeps regexes off nearly every line.
import { scrubRemote } from "../../util/giturl.ts";
import type { Pend } from "./calls.ts";
import type { Acc, VRef } from "./record.ts";
export type { VRef };

// ── pure matchers ──
// in raw JSON slashes may be escaped (\/pull): each needle also matches that form
const URL_SEGS = ["/pull", "merge_requests", "/issues", "/commit"];
// URLs are looked for in a line's first 64 KB: forge output is small; big lines are file dumps and huge outputs
export const HEAD_BYTES = 65536;
export function head(l: string): string { return l.length > HEAD_BYTES ? l.slice(0, HEAD_BYTES) : l; }
// the line's first 64 KB when a forge URL may be in it, else "": one "http" scan for nearly every line, the segment scans
// start at the first "http" and see only the head (a copy, for big lines: cheaper than four full scans). Walking each
// URL instead costs more on URL-rich output (registries, web pages) that holds no forge link
export function urlHead(l: string): string {
  const i = l.indexOf("http"); if (i < 0 || i >= HEAD_BYTES) return "";
  const h = head(l);
  for (const n of URL_SEGS) if (h.indexOf(n, i) >= 0) return h;
  return "";
}
// the end of the raw URL starting at i (≤ 600 chars): whitespace, a quote, < > ` or a backslash ends it, except the
// backslashes of an escaped slash (\/, or \\\/ in nested JSON)
function urlEnd(l: string, i: number): number {
  const z = Math.min(l.length, i + 600); let e = i;
  while (e < z) {
    const c = l.charCodeAt(e);
    if (c === 92) { let k = e; while (k < z && l.charCodeAt(k) === 92) k++; if (k < z && l.charCodeAt(k) === 47) { e = k + 1; continue; } break; }
    if (c <= 32 || c === 34 || c === 39 || c === 60 || c === 62 || c === 96) break;
    e++;
  }
  return e;
}
// the URLs in a line's first 64 KB that carry a forge segment, each whole and unescaped (≤ 400 looked at; no regex)
export function rawUrls(l: string): string[] {
  const out: string[] = [];
  let i = l.indexOf("http");
  for (let k = 0; i >= 0 && i < HEAD_BYTES && k < 400; k++) {
    const e = urlEnd(l, i);
    if (e - i > 10) { const u = l.slice(i, e); for (const n of URL_SEGS) if (u.indexOf(n) >= 0) { out.push(plain(u)); break; } }
    i = l.indexOf("http", e > i + 4 ? e : i + 4);
  }
  return out;
}
// true when the line may hold a forge URL or a commit banner (banners count only after a known git call)
export function prefilter(l: string): boolean { return l.indexOf(" changed") >= 0 || urlHead(l) !== ""; }
// one level of JSON string escapes: \/ \n \t \" \\ (one pass, so \\n stays a backslash + n); parts joined once: lines are big
export function unesc(s: string): string {
  if (s.indexOf("\\") < 0) return s;
  const o: string[] = []; let i = 0;
  while (i < s.length) {
    const j = s.indexOf("\\", i);
    if (j < 0 || j + 1 >= s.length) { o.push(s.slice(i)); break; }
    o.push(s.slice(i, j));
    const c = s.slice(j + 1, j + 2);
    o.push(c === "n" ? "\n" : c === "t" ? "\t" : c === "/" || c === "\"" || c === "\\" ? c : "\\" + c);
    i = j + 2;
  }
  return o.join("");
}
// raw JSON text: one level of escapes, two for nested JSON text (codex outputs)
function plain(s: string): string { const t = unesc(s); return t.indexOf("\\n") >= 0 || t.indexOf("\\/") >= 0 || t.indexOf("\\\"") >= 0 ? unesc(t) : t; }

export interface Banner { br: string; sha: string; subj: string }
const BANNER = /(?:^|")\[(detached HEAD|[^\]\s"]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.*)$/;
// `[<branch> <sha>] <subject>` at a line start (or a JSON string start); the subject ends at a quote (JSON) and is ≤ 80 chars
export function banners(text: string): Banner[] {
  const out: Banner[] = [];
  if (text.indexOf("] ") < 0) return out;
  for (const l of text.split("\n")) {
    if (l.indexOf("] ") < 0) continue;
    const m = BANNER.exec(l); if (!m) continue;
    const br = m[1] ?? ""; let subj = m[3] ?? "";
    const q = subj.indexOf("\""); if (q >= 0) subj = subj.slice(0, q);
    out.push({ br: br === "detached HEAD" ? "" : br, sha: m[2] ?? "", subj: subj.trim().slice(0, 80) });
  }
  return out;
}

// k = pr | issue | commit; url = canonical and scrubbed; n = PR/issue number (0 for commits); sha = commit links only
export interface FUrl { k: string; url: string; n: number; sha: string }
// [kind, path segment]; the forge's own kind segment stays in the canonical URL; `/-/` forms before the plain ones
const FORMS: string[][] = [["pr", "/-/merge_requests/"], ["issue", "/-/issues/"], ["commit", "/-/commit/"], ["pr", "/pull/"], ["pr", "/pulls/"],
  ["pr", "/pull-requests/"], ["issue", "/issues/"], ["commit", "/commit/"], ["commit", "/commits/"]];
// credential-shaped path segments (GitHub, GitLab, Slack tokens): the whole URL is dropped
const TOKEN = /(^|\/)(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abpr]-[A-Za-z0-9-]{10,})(\/|$)/;
// PR/MR, issue and commit links (spec 2 table); every URL goes through scrubRemote, dropped on null or a token-shaped path;
// suffixes (/files, /diffs, #…, ?…) are cut, `/pull/new/<branch>` (the git push hint) is no PR
export function forgeUrls(text: string): FUrl[] {
  const out: FUrl[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>`\\]+/gi)) { const u = forgeUrl(m[0] ?? ""); if (u) out.push(u); }
  return out;
}
// one raw URL → its forge link (null: none)
export function forgeUrl(raw0: string): FUrl | null {
  const raw = raw0.replace(/[)\]>.,;:'*]+$/, "");
  const r = scrubRemote(raw); if (!r || !r.host || TOKEN.test(r.path)) return null;
  const scheme = r.url.slice(0, r.url.indexOf("://"));
  const p = "/" + r.path;
  for (const f of FORMS) {
    const k = f[0] ?? ""; const seg = f[1] ?? ""; const at = p.indexOf(seg); if (at <= 0) continue;
    const id = p.slice(at + seg.length).split("/")[0] ?? "";
    if (!(k === "commit" ? /^[0-9a-f]{7,40}$/.test(id) : /^\d+$/.test(id))) return null;
    const url = scheme + "://" + r.host + p.slice(0, at) + seg + id;
    return scrubRemote(url) ? { k, url, n: k === "commit" ? 0 : Number(id), sha: k === "commit" ? id : "" } : null;
  }
  return null;
}

// the git subcommands of a shell command line: the first word after each `git` word and its global options. indexOf
// finds the `git` words and only the few words after each are walked: commands can be long (commit messages), and
// per-char loops and regexes are slow on this runtime
const ARGOPTS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];
const SEP = ";|&`\n"; const BEFORE = SEP + "(\"'{/"; const CLOSE = "\"')}";
function ws(c: number): boolean { return c === 32 || c === 9 || c === 10 || c === 13; }
function trimR(x: string): string { let j = x.length; while (j > 0 && CLOSE.indexOf(x.charAt(j - 1)) >= 0) j--; return j < x.length ? x.slice(0, j) : x; }
export function gitSubs(cmd: string): string[] {
  const out: string[] = [];
  for (let i = cmd.indexOf("git"); i >= 0; i = cmd.indexOf("git", i + 3)) {
    if (i > 0 && !ws(cmd.charCodeAt(i - 1)) && BEFORE.indexOf(cmd.charAt(i - 1)) < 0) continue; // github, .git/, digit
    if (i + 3 < cmd.length && !ws(cmd.charCodeAt(i + 3))) continue;
    let k = i + 3; let skip = false;
    for (let n = 0; n < 16; n++) {
      while (k < cmd.length && ws(cmd.charCodeAt(k))) k++;
      if (k >= cmd.length || SEP.indexOf(cmd.charAt(k)) >= 0) break;
      let e = k; while (e < cmd.length && !ws(cmd.charCodeAt(e)) && SEP.indexOf(cmd.charAt(e)) < 0) e++;
      const w = cmd.slice(k, e); k = e;
      if (skip) { skip = false; continue; }
      if (w.startsWith("-")) { skip = ARGOPTS.indexOf(w) >= 0; continue; }
      out.push(trimR(w)); break;
    }
  }
  return out;
}
// substring checks first (no regex: slow here): most commands name none of the subcommands, and gitSubs allocates
function hasSub(cmd: string, subs: string[]): boolean {
  if (cmd.indexOf("git") < 0) return false;
  let any = false; for (const s of subs) if (s === "am" ? cmd.indexOf(" am") >= 0 || cmd.indexOf("\tam") >= 0 || cmd.indexOf("\nam") >= 0 : cmd.indexOf(s) >= 0) { any = true; break; }
  if (!any) return false;
  for (const s of gitSubs(cmd)) if (subs.indexOf(s) >= 0) return true;
  return false;
}
const BANNER_SUBS = ["commit", "merge", "cherry-pick", "revert"];
const CALL_SUBS = ["commit", "merge", "cherry-pick", "revert", "am", "rebase"];
// output of these commands may carry a commit banner (cat, git log and git show output never counts)
export function isBannerCmd(cmd: string): boolean { return hasSub(cmd, BANNER_SUBS); }
// these make commits, banner or not: the call's span is where the session's quiet commits land
export function isGitCall(cmd: string): boolean { return hasSub(cmd, CALL_SUBS); }
const CREATE = /\bgh\s+pr\s+create\b|\bglab\s+mr\s+create\b|\bhub\s+pull-request\b|\btea\s+prs?\s+create\b|\bgh\s+issue\s+create\b|\bglab\s+issue\s+create\b/;
// a URL in this call's output is one the session created (else: mentioned)
export function createdBy(cmd: string, tool: string): boolean {
  return (cmd.indexOf("create") >= 0 || cmd.indexOf("pull-request") >= 0) && CREATE.test(cmd) || tool.indexOf("create_") >= 0 && /create_(pull_request|merge_request|issue)/.test(tool);
}

// ── the ledger pass ──
export const MAX_REFS = 200;
// dedup by (k, v) (gcall spans never): the first sighting wins, created upgrades mentioned. When full a new mentioned ref
// is dropped (first sightings win; no churn on URL-heavy logs), anything else evicts the oldest mentioned, else the oldest
function key(r: VRef): string { return r.k + "\t" + r.v; }
function keys(a: Acc): Set<string> { // a.vk mirrors a.vcs; rebuilt when something else changed the list (load, checks)
  if (a.vkn !== a.vcs.length) { a.vk.clear(); for (const x of a.vcs) if (x.k !== "gcall") a.vk.add(key(x)); a.vkn = a.vcs.length; }
  return a.vk;
}
// a copy that keeps nothing else alive: on this runtime regex captures and slices of them can hold their whole source
// string (a transcript line, up to 1 MB) — measured ~8 KB per stored ref, ~90 MB on a full index
function fresh(s: string): string { return s ? JSON.parse(JSON.stringify(s)) as string : s; }
export function addRef(a: Acc, r: VRef): void {
  const rs = a.vcs; const ks = keys(a); const k = key(r);
  if (r.k !== "gcall" && ks.has(k)) {
    if (r.how === "created") for (const x of rs) if (x.k === r.k && x.v === r.v && x.how === "mentioned") { x.how = "created"; x.call = r.call; x.ts = r.ts; x.t = r.t; }
    return;
  }
  if (rs.length >= MAX_REFS) {
    if (r.how === "mentioned") return;
    let i = 0; while (i < rs.length && rs[i].how !== "mentioned") i++;
    const gone = rs.splice(i < rs.length ? i : 0, 1);
    for (const x of gone) if (x.k !== "gcall") ks.delete(key(x));
  }
  r.v = fresh(r.v); r.br = fresh(r.br); r.subj = fresh(r.subj); // kept for the session's life
  rs.push(r); if (r.k !== "gcall") ks.add(key(r)); a.vkn = rs.length;
}
function ref(k: string, v: string, p: Pend | null, t: number, how: string, br: string, subj: string): VRef {
  return { k, v, t, how, br, subj, call: p ? p.id : "", ts: p ? p.ts : "" };
}
// after the adapter's usage(a, l): the calls this line closed (a.dn) produced its output; lines that closed none are no
// tool output and are skipped unread. Banners count only after a commit-making git command; URLs are created when a
// create command or MCP create tool produced them; every commit-making git call leaves its [start, end] span for the
// session's quiet commits (attribution)
export function scrape(a: Acc, l: string): void {
  const dn = a.dn; if (!dn.length) return;
  let git = false; for (const p of dn) if (isGitCall(p.cmd)) { git = true; break; }
  const uh = urlHead(l); const us = uh ? rawUrls(uh) : [];
  if (!git && !us.length) { dn.length = 0; return; }
  const own: Pend[] = []; // the closed calls this line names (one record may close several)
  for (const p of dn) if (p.id && l.indexOf(p.id) >= 0) own.push(p);
  if (!own.length && dn.length === 1) own.push(dn[0]);
  dn.length = 0;
  let bp: Pend | null = null; let mp: Pend | null = null;
  for (const p of own) { if (!bp && isBannerCmd(p.cmd)) bp = p; if (!mp && createdBy(p.cmd, p.name)) mp = p; }
  const t = bp ? bp.t : own.length ? own[0].t : a.al;
  if (bp) for (const b of banners(plain(l.slice(0, 1048576)))) addRef(a, ref("commit", b.sha, bp, t, "observed", b.br, b.subj));
  const up = mp ? mp : own.length ? own[0] : null;
  for (const w of us) { const u = forgeUrl(w); if (u) addRef(a, ref(u.k === "commit" ? "link" : u.k, u.url, up, t, mp ? "created" : "mentioned", "", "")); }
  for (const p of own) {
    if (p.t <= 0 || !isGitCall(p.cmd)) continue;
    const t1 = Math.max(p.t, p.end > 0 ? p.end : a.al);
    addRef(a, ref("gcall", String(p.t) + "-" + String(t1), p, p.t, "observed", "", ""));
  }
}
