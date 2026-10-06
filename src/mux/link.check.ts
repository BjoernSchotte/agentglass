// agentglass — self-check for exact links from a multiplexer (herdr agent_session) in linkSessions: sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";
import { setMuxes, muxReset } from "./index.ts";
import { applyRows, linkForCheck, linkSigForCheck, openForCheck, allProcs } from "../model/procs.ts";
import { newSess, type Proc, type Sess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
let LINKS: MuxLink[] = [];
function stub(kind: string, pids: number[], links: boolean): Mux {
  return {
    id: kind, label: kind,
    present: (now: number): boolean => true,
    refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean => false,
    paneOf: (pid: number): MuxPane | null => pids.indexOf(pid) >= 0 ? { kind, id: "x", term: "", server: "", ws: "", wsId: "", tab: "", status: "", at: 0 } : null,
    paneOfSession: (k: string, path: string): MuxPane | null => null,
    links: (): MuxLink[] => links ? LINKS : [],
    title: (p: MuxPane, look: number): string => "",
    status: (p: MuxPane, due: boolean, look: number, now: number): string => "",
    send: (p: MuxPane, msg: string): void => {},
    focus: (p: MuxPane): void => {},
    start: (h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean => false,
  };
}
setMuxes([stub("tmux", [71], false), stub("herdr", [], true)]); muxReset();
const now = Date.now();
applyRows([
  { pid: 41, ppid: 1, cpu: 0, rss: 0, etime: "10:00", tty: "", args: "node /x/pi.js", start: now - 600000 },
  { pid: 42, ppid: 1, cpu: 0, rss: 0, etime: "05:00", tty: "", args: "node /x/pi.js", start: now - 300000 },
  { pid: 61, ppid: 1, cpu: 0, rss: 0, etime: "05:00", tty: "", args: "codex", start: now - 300000 },
  { pid: 71, ppid: 1, cpu: 0, rss: 0, etime: "05:00", tty: "", args: "codex", start: now - 300000 },
  { pid: 81, ppid: 1, cpu: 0, rss: 0, etime: "05:00", tty: "", args: "codex", start: now - 300000 },
], now);
const roots: Proc[] = []; for (const p of allProcs.values()) { if (p.h === "pi") p.cwd = "/w"; roots.push(p); }
function sess(h: string, id: string, mtime: number, cwd: string): Sess { const s = newSess(h, id, "/s/" + h + "/" + id, false); s.mtime = mtime; s.cwd = cwd; s.headDone = true; sessions.set(s.path, s); return s; }
const A = sess("pi", "A", now - 60000, "/w"); const B = sess("pi", "B", now - 1000, "/w");
const C = sess("codex", "C", now - 2000, "/c");
const D = sess("codex", "D", now - 2000, "/d");
// the cwd guess alone: the newest session to the last started process
linkForCheck(roots);
ok("cwd guess links both", (B.pid === 41 && A.pid === 42) || (B.pid === 42 && A.pid === 41), "B " + String(B.pid) + " A " + String(A.pid));
const gb = B.pid; const ga = A.pid;
const g0 = linkSigForCheck();
// herdr knows better: crosswise to the guess
LINKS = [{ pid: gb, key: "", path: A.path }, { pid: ga, key: "", path: B.path }, { pid: 61, key: "codex:C", path: "" }, { pid: 71, key: "codex:D", path: "" }];
ok("a changed link changes the link signature (relink)", linkSigForCheck() !== g0, "");
linkForCheck(roots);
ok("herdr pairs win over the cwd guess", B.pid === ga && A.pid === gb, "B " + String(B.pid) + " A " + String(A.pid));
ok("a session nothing else links", C.pid === 61 && C.status === "open", String(C.pid));
ok("a pid tmux claims is not herdr's", D.pid === 0, String(D.pid));
// a session copied into a second project dir: the newest copy takes the link
const C2 = newSess("codex", "C", "/s/codex2/C", false); C2.mtime = now; C2.cwd = "/c"; C2.headDone = true; sessions.set(C2.path, C2);
linkForCheck(roots);
ok("copies: the newest", C2.pid === 61 && C.pid === 0, "C2 " + String(C2.pid) + " C " + String(C.pid));
// an open transcript already links the pid (exact): herdr naming another session for it (the one before /new) is not
// acted on — neither session loses or gains a link from it
const E = sess("codex", "E", now - 1000, "/e"); const F = sess("codex", "F", now - 90000, "/e");
openForCheck(E.path, 81);
LINKS = [{ pid: 81, key: "codex:F", path: "" }];
linkForCheck(roots);
ok("an open-transcript link is not overridden", E.pid === 81 && F.pid === 0, "E " + String(E.pid) + " F " + String(F.pid));
// herdr agreeing with it changes nothing either
LINKS = [{ pid: 81, key: "codex:E", path: "" }];
linkForCheck(roots);
ok("an agreeing herdr link", E.pid === 81 && F.pid === 0, "E " + String(E.pid) + " F " + String(F.pid));
openForCheck(E.path, 0);
console.log(bad ? bad + " failed" : "mux links: all checks passed");
if (bad) process.exit(1);
