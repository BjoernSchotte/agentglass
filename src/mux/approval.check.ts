// agentglass — self-check for herdr's blocked state as the approval signal (stub herdr adapter): sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";
import type { Ev } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";
import { setMuxes, muxReset } from "./index.ts";
import { looker, observeWith, approvalWait, approvalNote, approvalOf } from "../features/watchdog.ts";
import { lead } from "../features/rules/notify.ts";
import { builtins } from "../features/rules/config.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function ev(kind: string, text: string): Ev { return { kind, text, ts: "", id: "", full: "" }; }
const P: MuxPane = { kind: "herdr", id: "w1:p1", term: "t1", server: "/s", ws: "", wsId: "", tab: "", status: "blocked", at: 0 };
const ST = { status: "blocked", at: 0, dues: [] as boolean[], reads: 0 };
const stub: Mux = {
  id: "herdr", label: "herdr",
  present: (now: number): boolean => true,
  refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean => false,
  paneOf: (pid: number): MuxPane | null => pid === 7 || pid === 8 ? P : null,
  paneOfSession: (k: string, path: string): MuxPane | null => null,
  links: (): MuxLink[] => [],
  title: (p: MuxPane, look: number): string => "",
  status: (p: MuxPane, due: boolean, look: number, now: number): string => { ST.dues.push(due); if (due) { ST.reads++; P.status = ST.status; P.at = ST.at; } return P.status; },
  send: (p: MuxPane, msg: string): void => {},
  focus: (p: MuxPane): void => {},
  start: (h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean => false,
};
setMuxes([stub]); muxReset();
const now = Date.now();
// gemini hides its dialogs: due whenever its log is quiet
const s = newSess("gemini", "S1", "/p/S1.jsonl", false); s.pid = 7; s.mtime = now - 5000; s.evs = [ev("user", "go"), ev("tool", "Bash\u0000rm -rf build")];
sessions.set(s.path, s);
// fresh blocked: asserted on the first look
ST.status = "blocked"; ST.at = now; P.at = 0; P.status = "";
let o = observeWith(s, looker());
const a = approvalWait(o, 2, 7, 5);
ok("blocked: due on a quiet mid-turn log", ST.dues[ST.dues.length - 1] === true, ST.dues.join(","));
ok("blocked: first look, lv 1", a.lv === 1 && o.askBy === "herdr", JSON.stringify(a));
ok("blocked: note (herdr)", approvalNote(o) === "approval dialog open (herdr)", approvalNote(o));
const ap = builtins().filter((r) => r.id === "approval")[0];
ok("blocked: no guess prefix in the notification", !!ap && lead(ap, a) === ap.prefix, ap ? lead(ap, a) : "");
// stale: read before the log's last write → the heuristic decides (absent without CPU samples)
ST.at = s.mtime - 1; P.at = 0; P.status = "";
o = observeWith(s, looker());
ok("stale: not asserted", approvalWait(o, 2, 7, 5).lv === 0 && !o.asks, String(o.asks === true));
// a fresh non-blocked reading: herdr saw the screen — no Gemini guess
const g = newSess("gemini", "G1", "/p/G1.jsonl", false); g.pid = 8; g.mtime = now - 9000; g.evs = [ev("user", "go"), ev("assistant", "done")];
sessions.set(g.path, g);
ST.status = "idle"; ST.at = now; P.at = 0; P.status = "";
o = observeWith(g, looker());
ok("idle fresh: no guess", o.mayGuess === false && !o.asks, String(o.mayGuess));
// the log moving: not due (an agent at a dialog does not write), even for a harness hiding its dialogs
s.mtime = Date.now() - 1000; ST.dues = []; P.status = "idle"; P.at = now;
observeWith(s, looker());
ok("log moving: not due", ST.dues.length === 1 && ST.dues[0] === false, ST.dues.join(","));
// one-shot (--json, OTLP live): due for every herdr pane
ST.dues = [];
approvalOf(s);
ok("one-shot: due", ST.dues.length === 1 && ST.dues[0] === true, ST.dues.join(","));
// every harness (Decision 6): a fresh blocked reading mid-turn is the dialog — pi (noApproval) too: herdr sees its questions
// (the read is due mid-turn: Codex's turn marker; Claude's registry says "waiting" at a permission dialog, not "busy")
for (const h of ["claude", "codex", "pi", "kiro"]) {
  const x = newSess(h, "X-" + h, "/p/X-" + h + ".jsonl", false); x.pid = 7; x.mtime = Date.now() - 4000; x.evs = [ev("meta", "turn started"), ev("user", "go"), ev("tool", "Bash\u0000npm test")];
  if (h === "claude") x.status = "waiting";
  sessions.set(x.path, x);
  ST.status = "blocked"; ST.at = Date.now(); P.at = 0; P.status = "";
  const xo = observeWith(x, looker()); const xa = approvalWait(xo, 2, 7, 5);
  ok(h + ": blocked → ◆ on the first look", xa.lv === 1 && xo.askBy === "herdr" && approvalNote(xo) === "approval dialog open (herdr)", JSON.stringify(xa));
  sessions.delete(x.path);
}
console.log(bad ? bad + " failed" : "approval: all checks passed");
if (bad) process.exit(1);
