// agentglass — git linkage, ledger side: commit banners, forge URLs and git-command spans scraped from tool output (spec git-linkage 2)
// SPDX-License-Identifier: Apache-2.0
// Runs on every transcript line right after the adapter's usage(): the calls that line closed (Acc.dn) name the command
// that produced the output. A cheap indexOf prefilter keeps regexes off nearly every line.
import { scrubRemote } from "../../util/giturl.ts";
import type { Pend } from "./calls.ts";
import type { Acc, VRef } from "./record.ts";
export type { VRef };

// ── pure matchers ──
const NEEDLES = [" changed, ", " changed\\n", " changed\n", "/pull", "merge_requests/", "/issues/", "/commit/", "/commits/", "pull-requests/",
  "\\/pull", "merge_requests\\/", "\\/issues\\/", "\\/commit\\/", "\\/commits\\/", "pull-requests\\/"];
// true when the line may hold a commit banner or a forge URL (raw JSON: slashes may be escaped)
export function prefilter(l: string): boolean {
  for (const n of NEEDLES) if (l.indexOf(n) >= 0) return true;
  return l.indexOf("] ") >= 0 && l.indexOf(" Date: ") >= 0; // cherry-pick / revert / amend banners of a known command
}
// one level of JSON string escapes: \/ \n \t \" \\ (a hand scan: one pass, so \\n stays a backslash + n)
export function unesc(s: string): string {
  if (s.indexOf("\\") < 0) return s;
  let o = ""; let i = 0;
  while (i < s.length) {
    const j = s.indexOf("\\", i);
    if (j < 0 || j + 1 >= s.length) { o += s.slice(i); break; }
    o += s.slice(i, j);
    const c = s.slice(j + 1, j + 2);
    o += c === "n" ? "\n" : c === "t" ? "\t" : c === "/" || c === "\"" || c === "\\" ? c : "\\" + c;
    i = j + 2;
  }
  return o;
}

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
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>`\\]+/gi)) {
    const raw = (m[0] ?? "").replace(/[)\]>.,;:'*]+$/, "");
    const r = scrubRemote(raw); if (!r || !r.host || TOKEN.test(r.path)) continue;
    const scheme = r.url.slice(0, r.url.indexOf("://"));
    const p = "/" + r.path;
    for (const f of FORMS) {
      const k = f[0] ?? ""; const seg = f[1] ?? ""; const at = p.indexOf(seg); if (at <= 0) continue;
      const id = p.slice(at + seg.length).split("/")[0] ?? "";
      if (!(k === "commit" ? /^[0-9a-f]{7,40}$/.test(id) : /^\d+$/.test(id))) break;
      const url = scheme + "://" + r.host + p.slice(0, at) + seg + id;
      if (scrubRemote(url)) out.push({ k, url, n: k === "commit" ? 0 : Number(id), sha: k === "commit" ? id : "" });
      break;
    }
  }
  return out;
}

// the git subcommands of a shell command line: the first word after `git` and its global options, per chain segment
const ARGOPTS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];
export function gitSubs(cmd: string): string[] {
  const out: string[] = [];
  if (cmd.indexOf("git") < 0) return out;
  for (const seg of cmd.split(/&&|\|\||;|\||\n|\$\(|`/)) {
    const w = seg.trim().split(/\s+/);
    for (let i = 0; i < w.length; i++) {
      const x = (w[i] ?? "").replace(/^[("'{]+/, "");
      if (x !== "git" && !x.endsWith("/git")) continue;
      let j = i + 1;
      while (j < w.length && (w[j] ?? "").startsWith("-")) j += ARGOPTS.indexOf(w[j] ?? "") >= 0 ? 2 : 1;
      if (j < w.length) out.push((w[j] ?? "").replace(/["')}]+$/, ""));
      break;
    }
  }
  return out;
}
function hasSub(cmd: string, subs: string[]): boolean { for (const s of gitSubs(cmd)) if (subs.indexOf(s) >= 0) return true; return false; }
const BANNER_SUBS = ["commit", "merge", "cherry-pick", "revert"];
const CALL_SUBS = ["commit", "merge", "cherry-pick", "revert", "am", "rebase"];
// output of these commands may carry a commit banner (cat, git log and git show output never counts)
export function isBannerCmd(cmd: string): boolean { return hasSub(cmd, BANNER_SUBS); }
// these make commits, banner or not: the call's span is where the session's quiet commits land
export function isGitCall(cmd: string): boolean { return hasSub(cmd, CALL_SUBS); }
const CREATE = /\bgh\s+pr\s+create\b|\bglab\s+mr\s+create\b|\bhub\s+pull-request\b|\btea\s+prs?\s+create\b|\bgh\s+issue\s+create\b|\bglab\s+issue\s+create\b/;
// a URL in this call's output is one the session created (else: mentioned)
export function createdBy(cmd: string, tool: string): boolean { return CREATE.test(cmd) || /create_(pull_request|merge_request|issue)/.test(tool); }

// ── the ledger pass ──
export const MAX_REFS = 200;
// dedup by (k, v) (gcall spans never): the first sighting wins, created upgrades mentioned; when full the oldest mentioned
// ref goes first, else the oldest
export function addRef(a: Acc, r: VRef): void {
  const rs = a.vcs;
  if (r.k !== "gcall") for (const x of rs) {
    if (x.k !== r.k || x.v !== r.v) continue;
    if (r.how === "created" && x.how === "mentioned") { x.how = "created"; x.call = r.call; x.ts = r.ts; x.t = r.t; }
    return;
  }
  if (rs.length >= MAX_REFS) {
    let i = 0; while (i < rs.length && rs[i].how !== "mentioned") i++;
    rs.splice(i < rs.length ? i : 0, 1);
  }
  rs.push(r);
}
// the "command"/"cmd" string field of a record that holds call and result in one (first 4 KB); "" none
function cmdField(l: string): string {
  const m = /"(?:command|cmd)"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(l.slice(0, 4096)); if (!m) return "";
  try { const v: unknown = JSON.parse(m[1] ?? ""); return typeof v === "string" ? v : ""; } catch (e) { return ""; }
}
function ref(k: string, v: string, p: Pend | null, t: number, how: string, br: string, subj: string): VRef {
  return { k, v, t, how, br, subj, call: p ? p.id : "", ts: p ? p.ts : "" };
}
// after the adapter's usage(a, l): the calls this line closed (a.dn) produced its output. Banners count only after a
// commit-making git command; URLs are created when a create command or MCP create tool produced them; every
// commit-making git call leaves its [start, end] span for the session's quiet commits (attribution)
export function scrape(a: Acc, l: string): void {
  const dn = a.dn;
  let git = false; for (const p of dn) if (isGitCall(p.cmd)) { git = true; break; }
  if (!git && !prefilter(l)) { if (dn.length) dn.length = 0; return; }
  const own: Pend[] = []; // the closed calls this line names (one record may close several)
  for (const p of dn) if (p.id && l.indexOf(p.id) >= 0) own.push(p);
  if (!own.length && dn.length === 1) own.push(dn[0]);
  dn.length = 0;
  let bp: Pend | null = null; let mp: Pend | null = null;
  for (const p of own) { if (!bp && isBannerCmd(p.cmd)) bp = p; if (!mp && createdBy(p.cmd, p.name)) mp = p; }
  const lone = own.length ? "" : cmdField(l); // no closed call: a record carrying its own command
  const made = mp !== null || (lone !== "" && createdBy(lone, ""));
  const t = bp ? bp.t : own.length ? own[0].t : a.al;
  let txt = unesc(l); if (txt.indexOf("\\n") >= 0 || txt.indexOf("\\/") >= 0) txt = unesc(txt); // nested JSON text (codex)
  if (bp || isBannerCmd(lone)) for (const b of banners(txt)) addRef(a, ref("commit", b.sha, bp, t, "observed", b.br, b.subj));
  const up = mp ? mp : own.length ? own[0] : null;
  for (const u of forgeUrls(txt)) addRef(a, ref(u.k === "commit" ? "link" : u.k, u.url, up, own.length ? t : a.al, made ? "created" : "mentioned", "", ""));
  for (const p of own) {
    if (p.t <= 0 || !isGitCall(p.cmd)) continue;
    const t1 = Math.max(p.t, p.end > 0 ? p.end : a.al);
    addRef(a, ref("gcall", String(p.t) + "-" + String(t1), p, p.t, "observed", "", ""));
  }
}
