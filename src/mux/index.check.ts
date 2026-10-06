// agentglass — self-check for the multiplexer port: precedence, session panes, forced refresh, links, looks: sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";
import { NONE_PANE, NOPANE, setMuxes, muxReset, paneOfPid, paneOfSess, paneNow, muxSig, muxLook, sharedMuxLook, sendTo, muxRefresh, unreachable } from "./index.ts";
import { none } from "./none.ts";
import { newSess } from "../model/types.ts";
import { S } from "../state.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function pane(kind: string, id: string): MuxPane { return { kind, id, term: id, server: "", ws: "", wsId: "", tab: "", status: "", at: 0 }; }
const CNT = { forced: 0, titleLooks: [] as number[] };
let bLink: MuxLink = { pid: 20, key: "claude:S2", path: "" };
function stub(kind: string, pids: number[], key: string): Mux {
  return {
    id: kind, label: kind,
    present: (now: number): boolean => true,
    refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean => { if (force && kind === "herdr") CNT.forced++; return false; },
    paneOf: (pid: number): MuxPane | null => pids.indexOf(pid) >= 0 ? pane(kind, kind + String(pid)) : null,
    paneOfSession: (k: string, path: string): MuxPane | null => key && k === key ? pane(kind, kind + "-" + k) : null,
    links: (): MuxLink[] => kind === "herdr" ? [bLink] : [],
    title: (p: MuxPane, look: number): string => { CNT.titleLooks.push(look); return "t"; },
    status: (p: MuxPane, due: boolean, look: number, now: number): string => "",
    send: (p: MuxPane, msg: string): void => {},
    focus: (p: MuxPane): void => {},
    start: (h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean => false,
  };
}
setMuxes([stub("tmux", [10], ""), stub("herdr", [10, 20], "claude:S2")]);
muxReset();
ok("precedence: innermost (tmux) first", paneOfPid(10).kind === "tmux", paneOfPid(10).kind);
ok("herdr claims its own", paneOfPid(20).kind === "herdr", paneOfPid(20).kind);
ok("nobody → none", paneOfPid(30).kind === "none" && paneOfPid(0) === NONE_PANE, paneOfPid(30).kind);
const s = newSess("claude", "S2", "/p/S2.jsonl", false);
ok("session by key", paneOfSess(s).kind === "herdr", paneOfSess(s).kind);
s.pid = 30; ok("a live session by its pid only", paneOfSess(s).kind === "none", paneOfSess(s).kind); s.pid = 0;
muxRefresh([], 1, false, (k: string, p: string): number => 0);
ok("not forced", CNT.forced === 0, String(CNT.forced));
paneNow(s); ok("paneNow forces a refresh", CNT.forced === 1, String(CNT.forced));
const g1 = muxSig(); bLink = { pid: 21, key: "claude:S2", path: "" }; const g2 = muxSig();
ok("muxSig follows the links", g1 !== g2 && g2.indexOf("21 claude:S2") >= 0, g2);
const l1 = muxLook(1); l1.title(pane("tmux", "a")); l1.title(pane("tmux", "b")); const l2 = muxLook(2); l2.title(pane("tmux", "a"));
const tl = CNT.titleLooks;
ok("one look id per look", tl.length === 3 && tl[0] === tl[1] && tl[2] !== tl[0], tl.join(","));
CNT.titleLooks = [];
sharedMuxLook(1000).title(pane("tmux", "a")); sharedMuxLook(1500).title(pane("tmux", "a")); sharedMuxLook(2100).title(pane("tmux", "a"));
const sl = CNT.titleLooks;
ok("shared look for 1 s", sl.length === 3 && sl[0] === sl[1] && sl[2] !== sl[1], sl.join(","));
sendTo(NONE_PANE, "x");
ok("none: send warns", S.toastKind === "warn" && S.toast === "no tmux or herdr agent pane — cannot send safely", S.toast);
none.focus(NONE_PANE);
ok("none: focus warns", S.toast === "no tmux or herdr agent pane to jump to", S.toast);
// why a live agent has no pane: its environment names a herdr pane (herdr runs it, but lists no agent there), names
// none (outside both), or cannot be read (macOS) while herdr runs
const enc = (t: string): Uint8Array => new TextEncoder().encode(t);
NOPANE.env = (pid: number): Uint8Array => pid === 40 ? enc("HOME=/x\u0000HERDR_PANE_ID=w1:p2\u0000") : pid === 41 ? enc("HOME=/x\u0000") : new Uint8Array(0);
ok("unreachable: in a herdr pane herdr does not list as an agent", unreachable(40, "Gemini") === "herdr does not list Gemini as an agent yet (pane w1:p2) — send and jump unavailable", unreachable(40, "Gemini"));
ok("unreachable: outside both", unreachable(41, "Gemini") === "Gemini (pid 41) runs outside tmux and herdr — send and jump unavailable", unreachable(41, "Gemini"));
ok("unreachable: environment unknown, herdr runs", unreachable(42, "Gemini") === "Gemini (pid 42) is in no tmux pane and herdr does not list it as an agent — send and jump unavailable", unreachable(42, "Gemini"));
setMuxes([stub("tmux", [10], "")]);
ok("unreachable: environment unknown, no herdr", unreachable(42, "Gemini") === "Gemini (pid 42) runs outside tmux and herdr — send and jump unavailable", unreachable(42, "Gemini"));
console.log(bad ? bad + " failed" : "mux: all checks passed");
if (bad) process.exit(1);
