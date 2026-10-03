// agentglass — repo-view: session → project identity glue (budgeted resolve on the tick, projects.json, filter attributes)
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { H } from "../../hooks.ts";
import { sessions } from "../../model/sessions.ts";
import { run } from "../../util/fs.ts";
import { intSetting } from "../../util/config.ts";
import { P, resolveTick, labelOf, loadProjects, saveProjects, PROJECTS_FILE } from "../../model/project.ts";
import { identOf, repoOf } from "../query/project.ts";
import { register } from "../query/attrs.ts";
import { extend } from "../query/eval.ts";
import type { Val } from "../query/types.ts";
import { ACT } from "../usage/record.ts";
export { identOf, repoOf };

// the session's project label, "" while unresolved
export function repoLabel(s: Sess): string { const id = identOf(s); return id ? labelOf(id) : ""; }

ACT.gap = intSetting("repo", "idleGapMin", 1, 60, 5); // minutes between lines that still count as one stretch of work
P.sync = true; // one-shot CLI runs resolve on first ask; the TUI's first tick switches to the budgeted queue
loadProjects(PROJECTS_FILE);

const SAVE_MS = 30000;
let ticked = false; let savedAt = 0;
function livePaths(): Set<string> { const o = new Set<string>(); for (const p of sessions.keys()) o.add(p); return o; }
function now(): number { return Date.now(); }
H.onTick.push(() => {
  if (!ticked) { ticked = true; P.sync = false; savedAt = now(); }
  if (resolveTick(20, 25, now, run) > 0) S.dirty = true;
  if (now() - savedAt >= SAVE_MS) { savedAt = now(); saveProjects(PROJECTS_FILE, livePaths()); } // false (read-only home): keep going in memory
});
H.backlog.push(() => P.todo > 0);
H.onQuit.push(() => { if (ticked) saveProjects(PROJECTS_FILE, livePaths()); });

// filter attributes (filter-language registry): worktree, project.kind
function V(ss: string[]): Val { return { n: 0, ss, unk: false }; }
const UNK: Val = { n: 0, ss: ["unknown"], unk: true };
register({ key: "worktree", aliases: [], ent: "session", type: "text", multi: false, enumVals: [], enumFn: "", ops: [] });
register({ key: "project.kind", aliases: [], ent: "session", type: "enum", multi: false, enumVals: ["git", "gitdir", "path", "none"], enumFn: "", ops: [] });
extend("worktree", { sess: (s: Sess): Val => { const id = identOf(s); return id ? V([id.worktree.toLowerCase()]) : UNK; }, resolve: null });
extend("project.kind", { sess: (s: Sess): Val => { const id = identOf(s); return id ? V([id.kind]) : UNK; }, resolve: null });
