// agentglass — self-check for send, jump and resume through the multiplexer port (stub adapters): sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";
import { setMuxes, muxReset, NOPANE } from "./index.ts";
import { sendPrompt, resume, ACT_IO } from "../actions.ts";
import { newSess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";
import { S } from "../state.ts";
import { HELP } from "../ui/help.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const LOG: string[] = [];
let startOk = true;
function stub(kind: string, pids: number[]): Mux {
  return {
    id: kind, label: kind,
    present: (now: number): boolean => true,
    refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean => { LOG.push(kind + " refresh " + (force ? "forced" : "")); return false; },
    paneOf: (pid: number): MuxPane | null => pids.indexOf(pid) >= 0 ? { kind, id: kind + String(pid), term: "", server: "", ws: "", wsId: "", tab: "", status: "", at: 0 } : null,
    paneOfSession: (k: string, path: string): MuxPane | null => null,
    links: (): MuxLink[] => [],
    title: (p: MuxPane, look: number): string => "",
    status: (p: MuxPane, due: boolean, look: number, now: number): string => "",
    send: (p: MuxPane, msg: string): void => { LOG.push(kind + " send " + p.id + " " + msg); },
    focus: (p: MuxPane): void => { LOG.push(kind + " focus " + p.id); },
    start: (h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean => { if (kind === "herdr") LOG.push(kind + " start " + h + " " + id + " " + args.join(" ") + " | " + label); return kind === "herdr" && startOk; },
  };
}
setMuxes([stub("tmux", [10]), stub("herdr", [10, 20])]); muxReset();
let term = 0; ACT_IO.inTerminal = (cmd: string, args: string[], cwd: string): void => { term++; };
const has = (p: string): boolean => LOG.some((l: string) => l.indexOf(p) >= 0);
const s = newSess("claude", "S1", "/p/S1.jsonl", false); sessions.set(s.path, s);
s.pid = 20; sendPrompt(s, "hello");
ok("herdr pane: herdr send", has("herdr send herdr20 hello") && !has("tmux send"), LOG.join(" / "));
ok("forced refresh before send", LOG.indexOf("herdr refresh forced") >= 0 && LOG.indexOf("herdr refresh forced") < LOG.indexOf("herdr send herdr20 hello"), LOG.join(" / "));
LOG.length = 0; s.pid = 10; sendPrompt(s, "x");
ok("both claim: tmux (innermost)", has("tmux send tmux10 x") && !has("herdr send"), LOG.join(" / "));
NOPANE.env = (pid: number): Uint8Array => new TextEncoder().encode(pid === 40 ? "HERDR_PANE_ID=w1:p2\u0000" : "HOME=/x\u0000");
LOG.length = 0; s.pid = 30; sendPrompt(s, "x");
ok("nobody: warn", S.toastKind === "warn" && S.toast === "Claude (pid 30) runs outside tmux and herdr — send and jump unavailable" && !has(" send "), S.toast);
const g = newSess("gemini", "G1", "/p/G1.json", false); sessions.set(g.path, g); g.pid = 40;
LOG.length = 0; sendPrompt(g, "x");
ok("a herdr pane herdr lists no agent in: says so", S.toast === "herdr does not list Gemini as an agent yet (pane w1:p2) — send and jump unavailable" && !has(" send "), S.toast);
LOG.length = 0; resume(g);
ok("jump there: says so too", S.toast === "herdr does not list Gemini as an agent yet (pane w1:p2) — send and jump unavailable" && !has(" focus "), S.toast);
LOG.length = 0; s.pid = 20; resume(s);
ok("resume live herdr: focus", has("herdr focus herdr20"), LOG.join(" / "));
LOG.length = 0; s.pid = 30; resume(s);
ok("resume live elsewhere: why it cannot jump", S.toast === "Claude (pid 30) runs outside tmux and herdr — send and jump unavailable", S.toast);
LOG.length = 0; s.pid = 0; resume(s);
ok("resume ended: started in herdr", has("herdr start claude S1 --resume S1 | S1") && term === 0, LOG.join(" / ") + " term " + String(term)); // --redact (check.sh): the id as the label
startOk = false; LOG.length = 0; resume(s);
ok("resume ended, herdr cannot: in the terminal", term === 1, String(term));
let jump = ""; for (const sec of HELP) if (sec.name === "processes") for (const k of sec.keys) if (k[0] === "a") jump = k[1] ?? "";
ok("help: jump", jump === "jump to the agent's pane (tmux, herdr)", jump);
console.log(bad ? bad + " failed" : "send: all checks passed");
if (bad) process.exit(1);
