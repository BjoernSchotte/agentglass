// agentglass — git linkage UI: the preview's `git` line and the session git view (V): commits ✓/≈/? shared, PRs, issues, links
// SPDX-License-Identifier: Apache-2.0
// ≈ and ? shared commits are listed, never counted (the person may have made them). Opening the view is the only TUI path
// that spawns git (enrichment, gated in attrib.ts).
import { fit, fitStyled, clean, home } from "../../util/text.ts";
import type { Sess } from "../../model/types.ts";
import { S, say, type TV, type Mode } from "../../state.ts";
import { H, display } from "../../hooks.ts";
import { sessions, titleOf, current } from "../../model/sessions.ts";
import { C, CSI, RST, fg } from "../../ui/theme.ts";
import { put, box } from "../../ui/screen.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { copyText } from "../../actions.ts";
import { money } from "../usage/costs.ts";
import { asBill } from "../usage/billing.ts";
import { type GitInfo, type GCommit, type GLink, gitInfo, sessIn, gitRun, merged, sessGit, gitTouches, gitTouched } from "./attrib.ts";
export { merged, sessGit };
import { enrich, saveVcs, gitFailed, VF } from "./enrich.ts";
import { repoShas } from "./reflog.ts";

// ── pure (checks) ──
// "$0.84/commit" ("≈$" unless API spend), "?/commit" when only unpriced usage, "" without commits
export function perCommit(cost: number, unk: number, produced: number, bill: string): string {
  if (produced <= 0) return "";
  if (cost <= 0 && unk > 0) return "?/commit";
  return money(cost / produced, asBill(bill)) + "/commit";
}
function count(g: GitInfo, how: string): number { let n = 0; for (const c of g.commits) if (c.how === how) n++; return n; }
// `3 commits (✓3 · ≈1 · ?1 shared not counted) · PR #142 (created) · $0.84/commit` — parts omitted when zero; "" = nothing to say
export function previewLine(g: GitInfo, cost: number, unk: number, bill: string): string {
  const rl = count(g, "reflog"); const sh = count(g, "shared");
  const parts: string[] = [];
  if (g.commits.length) {
    let t = String(g.produced) + (g.produced === 1 ? " commit" : " commits");
    if (rl || sh) { const xs = ["✓" + String(g.produced)]; if (rl) xs.push("≈" + String(rl)); if (sh) xs.push("?" + String(sh) + " shared"); t += " (" + xs.join(" · ") + " not counted)"; }
    parts.push(t);
  }
  const pr = g.prs.length ? g.prs[0] : null; // created sort first
  if (pr) parts.push("PR #" + String(pr.n) + " (" + pr.how + ")" + (g.prs.length > 1 ? " +" + String(g.prs.length - 1) : ""));
  else if (g.issues.length) parts.push("issue #" + String(g.issues[0].n) + " (" + g.issues[0].how + ")");
  const pc = perCommit(cost, unk, g.produced, bill); if (pc) parts.push(pc);
  return parts.join(" · ");
}
// kind = commit | pr | issue | link; dim = listed, not counted; copy = what y copies; path/call/ts = the call ↵ opens
export interface Row { kind: string; text: string; dim: boolean; call: string; ts: string; copy: string; path: string; mark: string }
function two(n: number): string { return (n < 10 ? "0" : "") + String(n); }
// HH:MM today, else MM-DD HH:MM (local)
export function when(at: number, now: number): string {
  if (at <= 0) return "     ";
  const d = new Date(at); const t = two(d.getHours()) + ":" + two(d.getMinutes());
  const n = new Date(now);
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate() ? t : two(d.getMonth() + 1) + "-" + two(d.getDate()) + " " + t;
}
const MARK: Record<string, string> = { observed: "✓", reflog: "≈", shared: "?" };
function statusNote(c: GCommit): string {
  const xs: string[] = [];
  if (c.merge) xs.push("merge");
  if (c.status === "missing" || c.status === "amended" || c.status === "elsewhere") xs.push(c.status);
  if (c.how === "shared") xs.push("shared");
  if (!c.counted) xs.push("not counted");
  return xs.join(" · ");
}
function linkRow(kind: string, label: string, l: GLink): Row {
  return { kind, text: fit(label, 12) + " " + fit(l.how, 9) + " " + display("vcs", l.url, null), dim: l.how !== "created", call: l.call, ts: l.ts, copy: l.url, path: l.path, mark: kind === "pr" ? "⇡" : kind === "issue" ? "#" : "↗" };
}
// commits (✓ before ≈ before ? shared, oldest first within), then PRs/MRs, issues, other links (created first);
// w = the row width: narrow terminals get narrower branch/stat columns, a day-less time when every commit is today
export function viewRows(g: GitInfo, now: number, w: number): Row[] {
  const out: Row[] = [];
  let today = true; for (const c of g.commits) if (when(c.at, now).length > 5) today = false;
  const tW = today ? 5 : 11; const bW = w < 100 ? 10 : 14; const sW = w < 100 ? 9 : 11;
  const rank = (c: GCommit): number => c.how === "observed" ? 0 : c.how === "reflog" ? 1 : 2;
  const cs = g.commits.slice().sort((x: GCommit, y: GCommit) => rank(x) - rank(y) || x.at - y.at);
  for (const c of cs) {
    const st = c.add >= 0 && !c.merge ? "+" + String(c.add) + " −" + String(c.del) : ""; // a merge's diff is its branch's
    const note = statusNote(c);
    out.push({ kind: "commit", text: fit(c.sha.slice(0, 7), 7) + "  " + fit(when(c.at, now), tW) + "  " + fit(c.br ? display("branch", c.br, null) : "(detached)", bW) + " " + fit(st, sW) + " " + display("vcs", c.subj, null) + (note ? "  · " + note : ""),
      dim: !c.counted, call: c.call, ts: c.ts, copy: c.sha, path: c.path, mark: MARK[c.how] ?? "?" });
  }
  for (const l of g.prs) out.push(linkRow("pr", (l.url.indexOf("merge_requests") >= 0 ? "MR !" : "PR #") + String(l.n), l));
  for (const l of g.issues) out.push(linkRow("issue", "issue #" + String(l.n), l));
  for (const l of g.links) out.push(linkRow("link", "commit link", l));
  return out;
}
// cost and unpriced tokens of the session and its subagents
export function costOf(s: Sess): number[] {
  let c = s.cost > 0 ? s.cost : 0; let u = s.unkTok;
  for (const x of s.subs) { c += x.cost > 0 ? x.cost : 0; u += x.unkTok; }
  return [c, u];
}
// the preview's git line: the session's infos merged with its subagents' are kept while those infos are the same objects
// (a re-attribution makes new ones) and none was changed in place (gitTouches: fallback, enrichment); merging a busy
// repo's rows was most of a frame. The line itself is rebuilt each frame (cost moves while the session streams).
const PREV = new Map<string, { touch: number; gs: (GitInfo | null)[]; g: GitInfo | null }>();
function prevGit(s: Sess): GitInfo | null {
  const gs: (GitInfo | null)[] = [gitInfo(s)]; for (const x of s.subs) gs.push(gitInfo(x));
  const hit = PREV.get(s.path);
  if (hit && hit.touch === gitTouches() && hit.gs.length === gs.length) {
    let same = true; for (let i = 0; i < gs.length; i++) if (hit.gs[i] !== gs[i]) { same = false; break; }
    if (same) return hit.g;
  }
  const g = sessGit(s);
  if (PREV.size > 256) PREV.clear();
  PREV.set(s.path, { touch: gitTouches(), gs, g });
  return g;
}
H.previewSections.push((s: Sess, w: number): string[] => {
  const g = prevGit(s); if (!g) return [];
  const cu = costOf(s);
  const t = previewLine(g, cu[0] ?? 0, cu[1] ?? 0, s.bill);
  if (!t) return [];
  return [fg(C.dim) + fit("git", 9) + RST + fg(C.text) + fitStyled(t, Math.max(10, w - 9)) + RST + (w > 40 ? fg(C.dim) + "  V" + RST : "")];
});

const NAME = "git";
const V = { s: null as Sess | null, sel: 0, top: 0, rows: [] as Row[], g: null as GitInfo | null, backMode: "list" as Mode, backTv: null as TV | null, inTx: false, at: 0 };
// the git view of a session (V; the Repos detail); esc returns to where it was opened
export function openGit(s: Sess): void { open(s); }
function open(s: Sess): void {
  if (!sessGit(s)) { say("info", "no git worktree known for this session (cwd outside a repository, or not resolved yet)"); return; }
  V.s = s; V.sel = 0; V.top = 0; V.backMode = S.mode; V.backTv = S.tv; V.inTx = false; V.at = 0;
  S.fview = NAME; S.mode = "view"; S.dirty = true;
  refresh();
}
function back(): void { S.mode = V.backMode; S.tv = V.backTv; V.s = null; V.g = null; V.rows = []; S.dirty = true; }
// closed = no process and the window ended more than 10 min ago: enrichment results are kept for good
function closedNow(x: Sess): boolean { const i = sessIn(x, Date.now()); return !!i && !i.live && i.t1 > 0 && Date.now() - i.t1 > 600000; }
function refresh(): void {
  const s = V.s; if (!s) return;
  const g = sessGit(s);
  if (g) for (const x of [s].concat(s.subs)) { // one gated spawn per session view: the rest follow on later ticks
    const gi = gitInfo(x); const i = sessIn(x, Date.now()); if (!gi || !i || !gi.commits.length) continue;
    const rl = repoShas(i.gitdir, i.common);
    enrich(x.path, gi, i.top, closedNow(x), rl, gitRun());
  }
  if (g) gitTouched(); // enrichment may have changed counted rows: the preview line's memo
  V.g = g ? sessGit(s) : null; // re-merge: enrichment wrote into the per-session infos
  V.rows = V.g ? viewRows(V.g, Date.now(), S.W - 6) : [];
  if (V.sel >= V.rows.length) V.sel = Math.max(0, V.rows.length - 1);
  V.at = Date.now();
}
function rowAt(i: number): Row | null { return i >= 0 && i < V.rows.length ? V.rows[i] : null; }
function render(): void {
  const s = V.s; if (!s) return;
  if (Date.now() - V.at > 2000) refresh();
  const W = S.W; const Ht = S.H; const g = V.g;
  const top = sessIn(s, Date.now());
  box(0, 1, W, Ht - 2, "git · " + titleOf(s), top ? home(display("cwd", top.top, s)) : "", true);
  const iw = W - 4; let y = 2;
  const cu = costOf(s);
  const head = g ? previewLine(g, cu[0] ?? 0, cu[1] ?? 0, s.bill) : "";
  put(2, y++, fg(C.text) + fit(head || "no commits, PRs or issues seen yet", iw) + RST);
  const notes: string[] = [];
  if (g && g.noReflog) notes.push("no reflog — matched by time");
  if (top && gitFailed(top.top)) notes.push("git unavailable — short shas, no diff stats");
  notes.push("✓ counted · ≈ in this worktree while the session ran, not counted · ? shared by several sessions, not counted");
  put(2, y++, fg(C.dim) + fit(notes.join(" · "), iw) + RST);
  y++;
  const h = Ht - 3 - y;
  if (!V.rows.length) { put(2, y, fg(C.dim) + fit("nothing linked to this session yet: commits appear after `git commit`, PR links when the agent prints them", iw) + RST); return; }
  if (V.sel < V.top) V.top = V.sel;
  if (V.sel >= V.top + h) V.top = V.sel - h + 1;
  for (let i = 0; i < h; i++) {
    const r = rowAt(V.top + i); if (!r) break;
    const on = V.top + i === V.sel;
    const mc = r.kind !== "commit" ? C.accent : r.mark === "✓" ? C.green : r.mark === "≈" ? C.yellow : C.purple;
    const body = fg(r.dim ? C.dim : C.text) + fit(clean(r.text), iw - 2) + RST;
    put(2, y + i, (on ? CSI + "7m" : "") + fg(mc) + r.mark + " " + RST + (on ? CSI + "7m" : "") + body + RST);
  }
}
function jump(r: Row): void {
  const s = sessions.get(r.path);
  if (!s) { say("warn", "that session is no longer on disk"); return; }
  if (!r.call) { say("info", "no tool call to open: this commit was seen in the reflog only"); return; }
  openTranscript(s);
  const t = S.tv;
  if (t) { t.focusKind = "tool"; t.focusTs = r.ts; t.focusText = r.call; } // focusText may name the event id
  V.inTx = true;
}

// ── registration ──
H.views.push({ name: NAME, render });
H.keys.push((mode: string, k: string): boolean => {
  if (mode === "transcript" && V.inTx && (k === "esc" || k === "q" || k === "left")) { S.tv = null; S.mode = "view"; S.fview = NAME; V.inTx = false; return true; }
  if (k === "V" && (mode === "transcript" || (mode === "list" && S.tab === 0))) {
    const s = mode === "transcript" ? (S.tv ? S.tv.s : null) : current();
    if (s) open(s);
    return true;
  }
  if (mode !== "view" || S.fview !== NAME || !V.s) return false;
  if (k === "?") return false;
  const n = V.rows.length; const ph = Math.max(1, S.H - 9);
  if (k === "esc" || k === "q" || k === "backspace") back();
  else if (k === "up" || k === "k" || k === "wheelup") V.sel = Math.max(0, V.sel - 1);
  else if (k === "down" || k === "j" || k === "wheeldown") V.sel = Math.min(Math.max(0, n - 1), V.sel + 1);
  else if (k === "pgup") V.sel = Math.max(0, V.sel - ph);
  else if (k === "pgdn") V.sel = Math.min(Math.max(0, n - 1), V.sel + ph);
  else if (k === "g" || k === "home") V.sel = 0;
  else if (k === "G" || k === "end") V.sel = Math.max(0, n - 1);
  else if (k === "enter") { const r = rowAt(V.sel); if (r) jump(r); }
  else if (k === "y") { const r = rowAt(V.sel); if (r) copyText(r.copy, r.kind === "commit" ? "sha" : "url"); }
  S.dirty = true;
  return true;
});
H.mouse.push((mode: string, b: number, x: number, y: number, press: boolean): boolean => {
  if (mode !== "view" || S.fview !== NAME || !V.s || y === S.H - 1) return false;
  if (b === 64 || b === 65) { V.sel = Math.max(0, Math.min(V.rows.length - 1, V.sel + (b === 64 ? -3 : 3))); S.dirty = true; return true; }
  if (!press || b !== 0) return false;
  const i = V.top + (y - 5);
  if (y >= 5 && i < V.rows.length) { if (i === V.sel) { const r = rowAt(i); if (r) jump(r); } else V.sel = i; S.dirty = true; }
  return true;
});
H.onTick.push(() => {
  if (S.mode === "view" && S.fview === NAME && V.s) S.dirty = true; // live sessions: new commits and the gated enrichment land
  if (VF.dirty && Date.now() - VF.savedAt > 30000) saveVcs();
});
H.onQuit.push(() => { saveVcs(); });
H.footerHints.push((mode: string): string[][] => {
  if (mode === "view" && S.fview === NAME) return [["↑↓", "select"], ["↵", "open the call"], ["y", "copy sha/url"]]; // esc back: the footer adds it
  return mode === "transcript" || (mode === "list" && S.tab === 0) ? [["V", "git"]] : [];
});
H.helpSections.push({ name: NAME, ctx: NAME, keys: [
  ["V", "git view of the session: commits, PRs/MRs, issues (sessions list / transcript)"],
  ["↑↓ jk  g G", "select"], ["↵  click again", "open the transcript at the tool call that made it (esc comes back)"],
  ["y", "copy the sha or URL"], ["esc  q", "back"],
  ["", "✓ = the session's own commit (banner, or inside its git commit/merge call): counted"],
  ["", "≈ = made in the same worktree while the session ran · ? shared = several sessions ran: listed, not counted"],
  ["", "window = first activity − 2 min … last activity + git.tailPadMin (10 min, ~/.agentglass/config.json)"],
  ["", "local only: transcripts, .git files and a few `git log` calls; no forge APIs"]] });
