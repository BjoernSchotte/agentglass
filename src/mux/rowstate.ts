// agentglass — herdr's view of a session: the state that changes its row (working, blocked, done-unseen) and the herdr
// workspace it belongs to (live: its pane's; ended: the workspace whose worktree holds its directory)
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../model/types.ts";
import { livePid } from "../features/query/eval.ts";
import { realCwd } from "../hooks.ts";
import { identOf } from "../features/query/project.ts";
import { paneOfPid } from "./index.ts";
import { herdrWorkspaces } from "./herdr.ts";
import { type HWs, rowState, workspaceFor } from "./herdr-parse.ts";

// sessions whose herdr "done" the user saw here (selected > 1 s): path → the reading's time (a later done shows again)
export const SEEN_DONE = new Map<string, number>();
// "working" | "blocked" | "done" | "": a fresh herdr reading that changes the row; done counts until herdr reports
// another state or the user looked at the session here
export function herdrRow(s: Sess): string {
  const pid = livePid(s); if (!pid) return "";
  const p = paneOfPid(pid); if (p.kind !== "herdr") return "";
  const r = rowState(p.status, p.at, s.mtime, Date.now());
  if (r === "done") { const a = SEEN_DONE.get(s.path); if (a !== undefined && a >= 0) return ""; }
  return r;
}
// checks: the workspace list instead of the adapter's
export const WS_SRC = { list: (): HWs[] => herdrWorkspaces() };
export interface WsRef { id: string; label: string }
export function workspaceOf(s: Sess): WsRef {
  const pid = livePid(s);
  if (pid) { const p = paneOfPid(pid); if (p.kind === "herdr" && p.wsId) return { id: p.wsId, label: p.ws }; }
  const ws = WS_SRC.list(); if (!ws.length) return { id: "", label: "" };
  const id = identOf(s);
  const i = workspaceFor(realCwd(s), id ? id.top : "", ws);
  const w = i >= 0 ? ws[i] : undefined;
  return w ? { id: w.id, label: w.label } : { id: "", label: "" };
}
