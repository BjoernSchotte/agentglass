// agentglass — self-check for herdr's state in the row and the herdr workspace of sessions (stub adapter): sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";
import type { Ev } from "../model/types.ts";
import { newSess, type Sess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";
import { setMuxes, muxReset } from "./index.ts";
import { herdrRow, workspaceOf, WS_SRC, SEEN_DONE } from "./rowstate.ts";
import { rowTick } from "./attr.ts";
import { glyphKind } from "../ui/list.ts";
import { H } from "../hooks.ts";
import { S } from "../state.ts";
import { compile, sessMatches } from "../features/query/eval.ts";
import { parse as parseQ } from "../features/query/parse.ts";
import { sessDim } from "../features/query/agg.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function ev(kind: string, text: string): Ev { return { kind, text, ts: "", id: "", full: "" }; }
const P: MuxPane = { kind: "herdr", id: "w7:p1A", term: "t", server: "/s", ws: "webapp", wsId: "w7", tab: "2", status: "working", at: 0 };
let reads = 0;
const stub: Mux = {
  id: "herdr", label: "herdr",
  present: (now: number): boolean => true,
  refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean => false,
  paneOf: (pid: number): MuxPane | null => pid === 5 ? P : null,
  paneOfSession: (k: string, path: string): MuxPane | null => null,
  links: (): MuxLink[] => [],
  title: (p: MuxPane, look: number): string => "",
  status: (p: MuxPane, due: boolean, look: number, now: number): string => { if (due) { reads++; p.at = now; } return p.status; },
  send: (p: MuxPane, msg: string): void => {},
  focus: (p: MuxPane): void => {},
  start: (h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean => false,
};
setMuxes([stub]); muxReset();
WS_SRC.list = () => [{ id: "w1", label: "api", checkout: "/r/api", repoRoot: "/r/api" }, { id: "w2", label: "feat-x", checkout: "/h/wt/feat-x", repoRoot: "/r/api" }];
const now = Date.now();
function sess(id: string, pid: number, cwd: string): Sess { const s = newSess("codex", id, "/s/" + id, false); s.pid = pid; s.cwd = cwd; s.headDone = true; s.mtime = now - 60000; s.evs = [ev("user", "go"), ev("assistant", "ok")]; sessions.set(s.path, s); return s; }
const live = sess("L1", 5, "/r/api"); const ended = sess("E1", 0, "/h/wt/feat-x/src"); const other = sess("O1", 0, "/elsewhere");
// the glyph: herdr working with a quiet log → the spinner; stale (read before the log moved) → agentglass's own
P.status = "working"; P.at = now;
ok("working fresh: spinner", glyphKind(live) === "b", glyphKind(live));
P.at = live.mtime - 1;
ok("working stale: own glyph", glyphKind(live) === "l", glyphKind(live));
// done: ✓ unless an alert mark is there, and until the user looked here
P.status = "done"; P.at = now;
const badge = (s: Sess): string => { let b = ""; for (const f of H.rowBadges) b += f(s); return b; };
ok("done: ✓", herdrRow(live) === "done" && badge(live).indexOf("✓") >= 0, badge(live));
live.attention = true; ok("done + ◆: one mark (◆)", badge(live).indexOf("✓") < 0, badge(live)); live.attention = false;
// row-state reads: at most every 5 s while focused, none unfocused
S.mode = "list"; S.tab = 0; S.view = [live]; S.sel = 0; S.cli = false; S.unfocused = false;
P.at = now - 6000; reads = 0;
rowTick(now); rowTick(now + 1000);
ok("focused: one read per 5 s", reads === 1, String(reads));
S.unfocused = true; P.at = now - 60000; reads = 0; rowTick(now + 2000);
ok("unfocused: no read", reads === 0, String(reads)); S.unfocused = false;
// selected > 1 s: the ✓ goes (herdr is not told)
P.status = "done"; P.at = now + 3000;
rowTick(now + 3000); rowTick(now + 4500);
ok("looked at: ✓ gone", herdrRow(live) === "" && SEEN_DONE.has(live.path), herdrRow(live));
P.status = "working"; rowTick(now + 5000); ok("another state: forgotten", !SEEN_DONE.has(live.path), "");
// workspaces: a live pane's, an ended session's worktree (longest checkout path), none
ok("workspace live", workspaceOf(live).id === "w7" && workspaceOf(live).label === "webapp", JSON.stringify(workspaceOf(live)));
ok("workspace ended: worktree", workspaceOf(ended).id === "w2", JSON.stringify(workspaceOf(ended)));
ok("workspace none", workspaceOf(other).id === "", JSON.stringify(workspaceOf(other)));
function sel(q: string, s: Sess): boolean { const p = parseQ(q); const c = compile(p.cs, "list"); if (!c.f) { ok("compile " + q, false, c.err ? c.err.msg : ""); return false; } return sessMatches(c.f, s); }
ok("workspace is feat-x", sel("workspace is feat-x", ended) && !sel("workspace is feat-x", live), "");
ok("workspace ~ web", sel("workspace ~ web", live), "");
// the dimension: ids under --redact (check.sh sets it), (none)
ok("dimension", sessDim("workspace", ended)[0] === "w2" && sessDim("workspace", other)[0] === "(none)", sessDim("workspace", ended).join(","));
console.log(bad ? bad + " failed" : "rowstate: all checks passed");
if (bad) process.exit(1);
