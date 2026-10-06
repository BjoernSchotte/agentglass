// agentglass — self-check for the mux filter key and the --json mux field (stub adapters): sh scripts/check.sh
// SPDX-License-Identifier: Apache-2.0
import type { Mux, MuxPane, MuxProc, MuxLink } from "./types.ts";
import { setMuxes, muxReset } from "./index.ts";
import "./attr.ts";
import { newSess, type Sess } from "../model/types.ts";
import { sessions } from "../model/sessions.ts";
import { compile, sessMatches } from "../features/query/eval.ts";
import { parse as parseQ } from "../features/query/parse.ts";
import { jsonSess, JSON_FIELDS } from "../features/cli.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const herdrStub: Mux = {
  id: "herdr", label: "herdr",
  present: (now: number): boolean => true,
  refresh: (ps: MuxProc[], now: number, force: boolean, known: (key: string, path: string) => number): boolean => false,
  paneOf: (pid: number): MuxPane | null => pid === 5 ? { kind: "herdr", id: "w7:p1A", term: "t", server: "/s", ws: "webapp", wsId: "w7", tab: "2", status: "working", at: 1 } : null,
  paneOfSession: (k: string, path: string): MuxPane | null => null,
  links: (): MuxLink[] => [],
  title: (p: MuxPane, look: number): string => "",
  status: (p: MuxPane, due: boolean, look: number, now: number): string => p.status,
  send: (p: MuxPane, msg: string): void => {},
  focus: (p: MuxPane): void => {},
  start: (h: string, id: string, args: string[], cwd: string, top: string, label: string): boolean => false,
};
setMuxes([herdrStub]); muxReset();
function sess(id: string, pid: number, parent: string): Sess { const s = newSess("claude", id, "/s/" + id, false); s.pid = pid; s.parent = parent; s.headDone = true; sessions.set(s.path, s); return s; }
const live = sess("L1", 5, ""); const ended = sess("E1", 0, ""); const sub = sess("U1", 0, "L1"); sub.depth = 1;
function sel(q: string, s: Sess): boolean { const p = parseQ(q); const c = compile(p.cs, "list"); if (!c.f) { ok("compile " + q, false, c.err ? c.err.msg : ""); return false; } return sessMatches(c.f, s); }
ok("mux is herdr: the live herdr session", sel("mux is herdr", live) && !sel("mux is herdr", ended), "");
ok("mux is none: an ended one", sel("mux is none", ended) && !sel("mux is none", live), "");
ok("a subagent follows its parent", sel("mux is herdr", sub), "");
ok("mux is_not herdr", sel("mux is_not herdr", ended) && !sel("mux is_not herdr", live), "");
const j = jsonSess(live); const m = j["mux"] as { [k: string]: unknown } | null;
ok("--json mux", m !== null && m["kind"] === "herdr" && m["pane"] === "w7:p1A" && m["status"] === "working", JSON.stringify(m));
ok("--json mux labels hidden under --redact (check.sh sets it)", m !== null && m["workspace"] === null && m["tab"] === null, JSON.stringify(m));
ok("--json mux of an ended session: null", jsonSess(ended)["mux"] === null, "");
ok("mux right after status", JSON_FIELDS.indexOf("mux") === JSON_FIELDS.indexOf("status") + 1, JSON_FIELDS.join(","));
console.log(bad ? bad + " failed" : "mux attr: all checks passed");
if (bad) process.exit(1);
