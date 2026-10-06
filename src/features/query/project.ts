// agentglass — the project (repo) a working directory or session belongs to, backed by repo-view's identity (src/model/project.ts)
// SPDX-License-Identifier: Apache-2.0
import { dirname } from "node:path";
import type { Sess } from "../../model/types.ts";
import { EXACT } from "./types.ts";
import { parentOf, loadHead, loadTail } from "../../model/sessions.ts";
import { type Ident, identOfCwd, identNow, labelOf, rememberSess, cwdOfSess, normRemote } from "../../model/project.ts";
import { base } from "../../util/json.ts";
import { quoteVal } from "./parse.ts";
import { display, realCwd } from "../../hooks.ts";
import { REDACT } from "../redact-on.ts";

// the main worktree of cwd's repo as a real path (a linked worktree resolves to its main repo; a submodule is its own); "" non-git
export function projectRoot(cwd: string): string {
  if (!cwd) return "";
  const id = identNow(cwd);
  if (id.kind !== "git" && id.kind !== "gitdir") return "";
  return id.common.endsWith("/.git") ? dirname(id.common) : id.top;
}
// the project label of cwd; its basename until the identity is resolved (existing clauses keep matching); "" for ""
export function projectOf(cwd: string): string {
  if (!cwd) return "";
  const id = identOfCwd(cwd);
  return id ? labelOf(id) : base(cwd.replace(/\/+$/, "")) || cwd;
}
// a session's identity from its real cwd (after a restart: the cwd remembered in projects.json; a subagent whose head
// holds none: its parent's); null while unresolved: the cwd is in an unread head (or, behind huge first lines, an
// unread tail), or queued. A subagent's head is read before falling back, since a worktree-isolated subagent works
// elsewhere. A vanished cwd with a recorded remote is keyed by that remote.
// fleet: a remote row's project comes from its report (features/fleet/hosts.ts); its cwd is on another machine
export const REMOTE_IDENT = { of: (s: Sess): Ident | null => null };
export function identOf(s: Sess): Ident | null {
  if (s.host) return REMOTE_IDENT.of(s);
  let cwd = realCwd(s);
  if (cwd) rememberSess(s.path, cwd); else cwd = cwdOfSess(s.path);
  if (!cwd && (!s.headDone || (!s.parent && s.tailSize < 0 && s.size > 0))) return null;
  if (!cwd && s.parent) {
    const p = parentOf(s); cwd = p ? realCwd(p) || cwdOfSess(p.path) : "";
    if (!cwd && p && !p.headDone) return null;
    rememberSess(s.path, cwd); // after a restart it is placed without reading its head again
  }
  const id = identOfCwd(cwd); if (!id || !id.gone || !s.remote) return id;
  const n = normRemote(s.remote); if (!n) return id;
  return { key: n.key, label: n.label, kind: "git", top: id.top, common: "", gitdir: "", worktree: "", remote: n.url, via: "", gone: true, unread: false };
}
// identOf for one-off asks (the @ jump, --json): reads what the identity needs now (head, tail, the parent's head) and
// resolves the cwd at once instead of queueing it
export function identSync(s: Sess): Ident | null {
  if (s.host) return REMOTE_IDENT.of(s);
  if (!s.headDone) loadHead(s);
  if (!s.cwd && !s.parent && s.tailSize < 0) loadTail(s);
  const p = !s.cwd && s.parent ? parentOf(s) : null; if (p && !p.headDone) loadHead(p);
  const id = identOf(s); if (id) return id;
  const cwd = realCwd(s) || cwdOfSess(s.path) || (p ? realCwd(p) || cwdOfSess(p.path) : ""); if (cwd) identNow(cwd);
  return identOf(s);
}
// the session's project label (dimension value, Stats/triage grouping); the cwd basename while unresolved
export function repoOf(s: Sess): string { const id = identOf(s); return id ? labelOf(id) : base(realCwd(s).replace(/\/+$/, "")) || "(no project)"; }
// the repo attribute's values (lowercase): label and key; the cwd basename too for non-git dirs (clauses written against
// basenames keep matching), and under --redact the faked label and cwd basename shown on screen (exact matches only)
export function repoVals(s: Sess): string[] {
  const out: string[] = [];
  const add = (v: string): void => { const l = v.toLowerCase(); if (l && out.indexOf(l) < 0) out.push(l); };
  const fake = (v: string): void => { const l = v.toLowerCase(); if (l && out.indexOf(l) < 0) out.push(EXACT + l); };
  const id = identOf(s);
  if (id) { const lb = labelOf(id); add(lb); add(id.key); if (id.kind === "path" || id.kind === "none") add(base(realCwd(s))); if (REDACT) fake(display("repo", lb, s)); }
  else add(base(realCwd(s).replace(/\/+$/, "")));
  if (REDACT && s.cwd) fake(base(s.cwd.replace(/\/+$/, "")));
  return out;
}
// the project label as shown (faked under --redact): dimension values, cost rows
// (a directory without a repo is named by its last part, like a repo by owner/name; the Repos tab shows its ~/… path)
export function repoShown(s: Sess): string {
  const id = identOf(s); const b = base(realCwd(s).replace(/\/+$/, ""));
  return display("repo", id && id.kind !== "path" && id.kind !== "none" ? labelOf(id) : b || (id ? id.label : "(no project)"), s);
}
// the filter clause for "the project of this directory", by exact identity (key): a same-named repo or directory elsewhere
// does not match (agent-mode triage scope)
export function projectClause(cwd: string): string { return "repo is " + quoteVal(identNow(cwd).key.toLowerCase()); }
