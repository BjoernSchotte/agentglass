// agentglass — the project (repo) a working directory or session belongs to, backed by repo-view's identity (src/model/project.ts)
// SPDX-License-Identifier: Apache-2.0
import { dirname } from "node:path";
import type { Sess } from "../../model/types.ts";
import { parentOf } from "../../model/sessions.ts";
import { type Ident, identOfCwd, identNow, labelOf, rememberSess, cwdOfSess, normRemote } from "../../model/project.ts";
import { base } from "../../util/json.ts";
import { realCwd } from "../redact.ts";
import { display } from "../../hooks.ts";
import { REDACT } from "../redact-on.ts";

// the main worktree of cwd's repo (a linked worktree resolves to its main repo; a submodule is its own); "" non-git
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
// a session's identity from its real cwd (a subagent without one: its parent's; after a restart: the remembered cwd);
// null while unresolved (cwd in an unread head, or queued). A vanished cwd with a recorded remote is keyed by that remote.
export function identOf(s: Sess): Ident | null {
  let cwd = realCwd(s);
  if (cwd) rememberSess(s.path, cwd);
  else { const p = s.parent ? parentOf(s) : null; cwd = p ? realCwd(p) : ""; if (!cwd) cwd = cwdOfSess(s.path); }
  if (!cwd && !s.headDone) return null;
  const id = identOfCwd(cwd); if (!id || !id.gone || !s.remote) return id;
  const n = normRemote(s.remote); if (!n) return id;
  return { key: n.key, label: n.label, kind: "git", top: id.top, common: "", gitdir: "", worktree: "", remote: n.url, via: "", gone: true, unread: false };
}
// the session's project label (dimension value, Stats/triage grouping); the cwd basename while unresolved
export function repoOf(s: Sess): string { const id = identOf(s); return id ? labelOf(id) : base(realCwd(s).replace(/\/+$/, "")) || "(no project)"; }
// the repo attribute's values (lowercase): label and key; the cwd basename too for non-git dirs (clauses written against
// basenames keep matching), and under --redact the faked label and cwd basename shown on screen
export function repoVals(s: Sess): string[] {
  const out: string[] = [];
  const add = (v: string): void => { const l = v.toLowerCase(); if (l && out.indexOf(l) < 0) out.push(l); };
  const id = identOf(s);
  if (id) { const lb = labelOf(id); add(lb); add(id.key); if (id.kind === "path" || id.kind === "none") add(base(realCwd(s))); add(display("repo", lb, s)); }
  else add(base(realCwd(s).replace(/\/+$/, "")));
  if (REDACT && s.cwd) add(base(s.cwd.replace(/\/+$/, "")));
  return out;
}
