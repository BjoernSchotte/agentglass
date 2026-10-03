// agentglass — the project (repo) a working directory belongs to; repo-view later refines the identity behind these names
// SPDX-License-Identifier: Apache-2.0
import { existsSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { readText } from "../../util/fs.ts";

const roots = new Map<string, string>();
// the nearest dir with .git walking up from cwd; a worktree's .git file ("gitdir: X/.git/worktrees/N") resolves to X; "" none
export function projectRoot(cwd: string): string {
  if (!cwd) return "";
  const hit = roots.get(cwd); if (hit !== undefined) return hit;
  let dir = cwd; let root = "";
  for (let i = 0; i < 64; i++) {
    const g = join(dir, ".git");
    if (existsSync(g)) {
      root = dir;
      let isFile = false; try { isFile = statSync(g).isFile(); } catch (e) { isFile = false; }
      if (isFile) {
        const m = /gitdir:\s*(.+)/.exec(readText(g, 0, 4096));
        const gd = m ? (m[1] ?? "").trim() : "";
        const at = gd.indexOf("/.git/worktrees/");
        if (at > 0) root = gd.slice(0, at);
      }
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (roots.size > 4096) roots.clear();
  roots.set(cwd, root);
  return root;
}
// basename of the repo root, or of cwd itself without a repo; "" for ""
export function projectOf(cwd: string): string {
  if (!cwd) return "";
  const r = projectRoot(cwd);
  return basename(r || cwd.replace(/\/+$/, "")) || cwd;
}
