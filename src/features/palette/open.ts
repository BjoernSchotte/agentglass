// agentglass — agentglass open <ref>: start the TUI on a session and event (or print the resolution); applyTarget is
// also what a link handed to a running TUI does. Links only open views: nothing here sends, resumes, kills or exports.
// SPDX-License-Identifier: Apache-2.0
import { writeSync } from "node:fs";
import type { Sess } from "../../model/types.ts";
import { S, say } from "../../state.ts";
import { join } from "node:path";
import { H, screenOut, startTui, display } from "../../hooks.ts";
import { OS } from "../../platform/index.ts";
import { scan, buildView, loadHead, loadTail, titleOf, parentOf, expanded, collapsed } from "../../model/sessions.ts";
import { openTranscriptAt } from "../../ui/transcript.ts";
import { type Obj, str } from "../../util/json.ts";
import { type Ref, type Target, SELF, parseRef, resolve, canonicalUrl } from "./ref.ts";
import { resolveRef } from "../../model/sessref.ts";
import { refreshProcs, refreshSlow } from "../../model/procs.ts";
import { agentHost, cliError, errLine } from "../agentenv.ts";
import { addCmd, opt } from "../clihelp.ts";
import { type FInfo, type InfoFn, RUN_DIR, myUid, secureDir, lockHolder } from "./rundir.ts";
import { spoolSend, spoolAwait } from "./spool.ts";
import { singleInstance, isAlive, isOurs } from "./instance.ts";
import { pickTerminal, onPath, installHandler, uninstallHandler, handlerPath } from "./urlhandler.ts";
import { section } from "../../util/config.ts";

const info: InfoFn = (p: string): FInfo | null => OS.fileInfo(p);

// select a session's row in the Sessions list (its parent expanded); false = hidden by the filter
export function selectRow(s: Sess): boolean {
  S.tab = 0;
  const par = s.parent ? parentOf(s) : null;
  if (par) { expanded.add(par.path); collapsed.delete(par.path); }
  buildView();
  const i = S.view.indexOf(s);
  if (i >= 0) S.sel = i;
  return i >= 0;
}
// the link's view: its row selected, its transcript open (from the start cursor when the event is older than the tail)
// with the cursor on the event
export function applyTarget(t: Target): void {
  const s = t.s; if (!s) return;
  S.mode = "list"; S.prevMode = "list"; S.tv = null; S.dv = null; S.fview = "";
  selectRow(s);
  const tv = openTranscriptAt(s, t.cursor);
  if (t.kind) { tv.focusKind = t.kind; tv.focusTs = t.ts; tv.focusText = t.text; }
  if (t.warn) say("warn", t.warn);
}
// the resolution as JSON (--print, pipes, agent mode)
export function targetObj(t: Target, r: Ref): Obj {
  const s = t.s as Sess;
  return {
    harness: s.h, id: s.id, path: display("path", s.path, s), title: titleOf(s), cwd: s.cwd,
    anchor: t.kind ? { kind: t.kind, turn: t.turn >= 0 ? t.turn : null, ts: t.ts || null, callId: t.kind === "tool" || t.kind === "result" ? t.id || null : null } : null,
    url: canonicalUrl(s, t.ukey, t.uval),
  };
}
function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
// exit 3 / 4 with one stderr line (and the candidates)
export function failTarget(t: Target): never {
  if (t.code === 4) {
    const refs: string[] = []; for (const c of t.cands.slice(0, 5)) refs.push(c.h + ":" + c.id); // each resolves (twins are one session)
    errLine("agentglass", "ambiguous", t.msg, "use one of: " + refs.join(", ") + (t.cands.length > 5 ? ", …" : ""));
    if (!agentHost().on) for (const c of t.cands.slice(0, 20)) { try { writeSync(2, screenOut(c.h + ":" + c.id + "  " + titleOf(c)) + "\n"); } catch (e) { /* closed */ } }
    process.exit(4);
  }
  cliError("not_found", t.msg || "no such session", "agentglass sessions lists them", 3);
}
const FLAGS = ["--print", "--print-url", "--new-instance"];
// <ref>@<host> (fleet, features/fleet/cli.ts): true = handled (it printed how to open it there); it may rewrite o.ref
// (@ this machine's own name: a local ref)
export const REMOTE_OPEN = { run: (o: OpenArgs): boolean => false };
export interface OpenArgs { ref: string; print: boolean; printUrl: boolean; newInstance: boolean }
// the open command's own flags; anything else is a usage error (exit 2)
export function openArgs(args: string[]): OpenArgs {
  const o: OpenArgs = { ref: "", print: false, printUrl: false, newInstance: false };
  for (const a of args.slice(1)) {
    if (a === "--print") o.print = true;
    else if (a === "--print-url") o.printUrl = true;
    else if (a === "--new-instance") o.newInstance = true;
    else if (a.startsWith("--")) cliError("usage", "unknown option " + a + " for open", "agentglass open --help", 2);
    else if (o.ref) cliError("usage", "open takes one link", "quote it: agentglass open '<ref>'", 2);
    else o.ref = a;
  }
  if (!o.ref) cliError("usage", "open needs a link: a session id, <harness>:<id>[#anchor] or agentglass://open/…", "agentglass open --help", 2);
  return o;
}

addCmd({ cmd: "open", usage: "agentglass open <ref>", summary: "start the TUI on a session and event (a running agentglass shows it instead)\n(<ref> = current | last | parent | <id> | <id prefix ≥ 6> | <harness>:<id> [#call=<id> | #ts=<iso> | #turn=<start ts>[~k] | #turn=<n> | #span=<span id>] | agentglass://open/[<harness>/]<id>[#…] | <OTLP trace id>[/<span id>];\n<ref>@<host>: a fleet host's session — prints the ssh command that opens it there)", options: [
  opt("--print", "", "print the resolution as JSON instead of opening it (also in pipes and inside an agent)", "", []),
  opt("--print-url", "", "print the canonical agentglass:// link", "", []),
  opt("--new-instance", "", "always start a new TUI, never hand the link to a running one", "", []),
  opt("--install-handler", "", "Linux: open agentglass:// links (browser, chat) in a terminal (open.terminal, $TERMINAL or x-terminal-emulator)", "", []),
  opt("--uninstall-handler", "", "Linux: remove that handler", "", []),
], fields: ["harness", "id", "path", "title", "cwd", "anchor", "url"], group: "cmd" }, "cost");

H.cli.unshift((args: string[]): boolean => {
  if ((args[0] ?? "") !== "open" || args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) return false;
  if (args.indexOf("--install-handler") >= 0 || args.indexOf("--uninstall-handler") >= 0) { handler(args.indexOf("--install-handler") >= 0); return true; }
  const o = openArgs(args);
  if (REMOTE_OPEN.run(o)) return true;
  const r = parseRef(o.ref);
  if (!r.ok) cliError("usage", r.err, "agentglass open --help shows the link forms", 2); // nothing contacted, nothing scanned
  if (!r.harness && !r.trace && SELF.indexOf(r.sess) >= 0) { // current | last | parent: this process's view, then a plain link
    S.cli = true; scan(); refreshProcs(); refreshSlow(); buildView(); // as discover(): current needs processes linked to sessions
    const f = resolveRef(r.sess, false, (x: Sess): boolean => !!x);
    if (!f.s) cliError(f.err || "not_found", f.msg, f.hint, f.code || 3);
    const s = f.s as Sess; r.harness = s.h; r.sess = s.id;
    o.ref = canonicalUrl(s, r.akey, r.akey === "turn" && r.ak ? r.aval + "~" + String(r.ak) : r.aval);
    S.cli = false;
  }
  const tty = process.stdout.isTTY === true;
  if (o.print || o.printUrl || !tty || agentHost().on) {
    S.cli = true;
    scan(); buildView();
    const t = resolve(r);
    if (!t.s) failTarget(t);
    const s = t.s as Sess; loadHead(s); loadTail(s); // title, cwd and branch come from the log
    if (t.warn) errLine("agentglass", "warning", t.warn, "");
    out(o.printUrl ? canonicalUrl(t.s as Sess, t.ukey, t.uval) : JSON.stringify(targetObj(t, r)));
    process.exit(0);
  }
  if (o.newInstance || !singleInstance() || !handOff(o.ref)) ownTui(r);
  return true;
});
// --install-handler / --uninstall-handler (Linux): agentglass:// links from browsers and chat apps open here
function handler(install: boolean): void {
  if (process.platform !== "linux") cliError("unsupported", "the agentglass:// handler is Linux only for now", "macOS: point a URL router app at: agentglass open \"<url>\" (README: deep links)", 2);
  if (!install) { const e = uninstallHandler(); if (e) cliError("not_found", e, "", 1); warn("removed " + handlerPath()); return; }
  const term = pickTerminal(str(section("open")["terminal"]), { TERMINAL: process.env.TERMINAL ?? "" }, onPath);
  if (!term) cliError("usage", "no terminal to open links in", "set \"open\": {\"terminal\": \"kitty\"} in ~/.agentglass/config.json, or $TERMINAL", 2);
  const e = installHandler(term, process.execPath);
  if (e) cliError("runtime", e, "", 1);
  warn("agentglass:// links now open in " + term + " (" + handlerPath() + "); undo: agentglass open --uninstall-handler");
}
// a TUI of our own on the target (the hand-off was skipped or fell back); it then tries to become the server
function ownTui(r: Ref): void {
  scan(); buildView();
  const t = resolve(r);
  if (!t.s) failTarget(t);
  H.start.push(() => applyTarget(t)); // after the TUI's own scan (sessions keep their objects), before the first frame
  startTui();
}
function warn(msg: string): void { try { writeSync(2, "agentglass: " + screenOut(msg) + "\n"); } catch (e) { /* closed */ } }
// hand the link to the running TUI (the one holding tui.lock): false = none (or an unsafe run dir: warned), open it here
function handOff(ref: string): boolean {
  const uid = myUid();
  const why = secureDir(RUN_DIR, uid, info, false);
  if (why && OS.fileInfo(RUN_DIR) !== null) { warn("not handing the link to a running agentglass: " + why); return false; }
  if (why) return false; // no run dir: no server ever started
  const why2 = secureDir(join(RUN_DIR, "inbox"), uid, info, false);
  if (why2) { warn("not handing the link to a running agentglass: " + why2); return false; }
  const holder = lockHolder(RUN_DIR, uid, info, isAlive, isOurs);
  if (!holder || holder === process.pid) return false;
  const req = "open " + ref + "\n";
  const p = spoolSend(RUN_DIR, req, process.pid, Date.now(), uid, info, isAlive, isOurs);
  if (!p) return false;
  spoolAwait(p, 2000, uid, info, (reply: string): void => {
    if (reply === "ok" || reply === "ok palette") { warn("opened in running agentglass (pid " + String(holder) + ")"); process.exit(0); }
    if (reply === "err not-found") cliError("not_found", "no session " + ref + " (asked the running agentglass, pid " + String(holder) + ")", "agentglass sessions lists them", 3);
    // the link parsed here, so a refusal means an older running agentglass that lacks this link form (e.g. trace ids)
    if (reply === "err bad-request") warn("the running agentglass (pid " + String(holder) + ") does not know this link form (an older version?) — opening a new window");
    else if (reply === "err busy") warn("the running agentglass is busy (more than 10 links a minute) — opening a new window");
    else warn("the running agentglass (pid " + String(holder) + ") did not answer within 2 s — opening a new window");
    ownTui(parseRef(ref));
  });
  return true;
}
