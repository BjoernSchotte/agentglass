// agentglass — what the multiplexer port adds to the app: filter keys mux and workspace, the workspace dimension, the
// herdr "done" badge, row-state reads while someone looks, and the palette's "Sessions in this herdr workspace"
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../model/types.ts";
import type { Val, Clause } from "../features/query/types.ts";
import { S, say } from "../state.ts";
import { H } from "../hooks.ts";
import { sessions, current } from "../model/sessions.ts";
import { procView } from "../model/procs.ts";
import { register } from "../features/query/attrs.ts";
import { extend, livePid } from "../features/query/eval.ts";
import { DIMS } from "../features/query/agg.ts";
import { print } from "../features/query/parse.ts";
import { addClause, setPins, holds, alreadyPinned, pinToast, shownClause } from "../features/query/scope.ts";
import { addActions, inSessions } from "../features/palette/actions.ts";
import { REDACT } from "../features/redact-on.ts";
import { C, CSI, RST, fg } from "../ui/theme.ts";
import type { MuxPane } from "./types.ts";
import { paneOfPid, muxLook } from "./index.ts";
import { rowState } from "./herdr-parse.ts";
import { SEEN_DONE, herdrRow, workspaceOf } from "./rowstate.ts";

// mux: the pane kind of the live agent (a subagent: its parent's); none = not live or in neither multiplexer
register({ key: "mux", aliases: [], ent: "session", type: "enum", multi: false, enumVals: ["tmux", "herdr", "none"], enumFn: "", ops: [] });
extend("mux", { sess: (s: Sess): Val => ({ n: 0, ss: [paneOfPid(livePid(s)).kind], unk: false }), resolve: null });
// workspace: the herdr workspace label (live: its pane's; ended: the worktree workspace holding its directory; "" none).
// Matched on the real label; --redact masks pinned values in chips
register({ key: "workspace", aliases: [], ent: "session", type: "text", multi: false, enumVals: [], enumFn: "", ops: [] });
extend("workspace", { sess: (s: Sess): Val => ({ n: 0, ss: [workspaceOf(s).label.toLowerCase()], unk: false }), resolve: null });
// the dimension (aggregate, triage): the label, its id under --redact (labels are user text), "(none)"
DIMS.push({ dim: "workspace", f: (s: Sess): string[] => { const w = workspaceOf(s); return [!w.id ? "(none)" : REDACT ? w.id : w.label || w.id]; } });

// herdr's "finished, not seen yet": a green ✓ in the badge slot when no alert mark (⚠ ◆) is there — one mark per row
const B = CSI + "1m";
H.rowBadges.push((s: Sess): string => !s.stuck && !s.attention && herdrRow(s) === "done" ? fg(C.green) + B + "✓" + RST : "");

// row-state reads: while the terminal is focused and the Sessions list or Processes shows a herdr-hosted live agent,
// herdr's states are read again after 5 s (one agent list per server; a watchdog read in between counts: p.at)
const RS = { selPath: "", selSince: 0 };
function shownPanes(): MuxPane[] {
  const out: MuxPane[] = []; const seen = new Set<string>();
  const add = (pid: number): void => { const p = paneOfPid(pid); if (p.kind === "herdr" && !seen.has(p.server)) { seen.add(p.server); out.push(p); } };
  if (S.tab === 0) { for (const s of S.view) { const pid = livePid(s); if (pid) add(pid); } }
  else for (const p of procView) add(p.pid);
  return out;
}
export function rowTick(now: number): void {
  if (S.cli || S.mode !== "list" || (S.tab !== 0 && S.tab !== 1)) return;
  // the user looked at a "done" session here (selected > 1 s): its ✓ goes (herdr is not told: marking seen is its business)
  const cur = S.tab === 0 ? current() : null; const cp = cur ? cur.path : "";
  if (cp !== RS.selPath) { RS.selPath = cp; RS.selSince = now; }
  const gone: string[] = [];
  for (const [k, at] of SEEN_DONE) { const s = sessions.get(k); const p = s ? paneOfPid(livePid(s)) : null; if (!p || p.status !== "done" || p.at < at) gone.push(k); }
  for (const k of gone) SEEN_DONE.delete(k);
  if (cur && now - RS.selSince > 1000) { const p = paneOfPid(livePid(cur)); if (p.kind === "herdr" && rowState(p.status, p.at, cur.mtime, now) === "done" && !SEEN_DONE.has(cur.path)) SEEN_DONE.set(cur.path, 0); }
  if (S.unfocused) return; // nobody looks: the 30 s map refresh is enough
  const lk = muxLook(now);
  for (const p of shownPanes()) if (now - p.at >= 5000) lk.status(p, true);
}
H.onTick.push((): void => { rowTick(Date.now()); });

// palette (session context): pin this session's herdr workspace
function pinWorkspace(s: Sess | null): void {
  const w = s ? workspaceOf(s) : null; if (!w || !w.id) { say("warn", "not in a herdr workspace"); return; }
  const c: Clause = { key: "workspace", op: "is", vals: [w.label.toLowerCase()], neg: false, pinned: true };
  if (holds(S.pins, [c])) { say("info", alreadyPinned([c])); return; }
  const e = setPins(print(addClause(S.pins, c).cs)); if (e) { say("err", e.msg); return; }
  pinToast("pinned: " + shownClause(c) + " — P edits pins");
}
addActions([{ id: "session.workspace", title: "Sessions in this herdr workspace", group: "Session", keys: "",
  when: (c): boolean => inSessions(c) && c.sess !== null && workspaceOf(c.sess).id !== "", run: (c): void => { pinWorkspace(c.sess); } }]);
