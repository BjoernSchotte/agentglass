// agentglass — session references for the CLI (and deep links): current, last, parent, <harness>:<id>, an id or a unique id prefix
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "./types.ts";
import { sessions, loadHead } from "./sessions.ts";
import { isHarness } from "../harness/index.ts";
import { realCwd } from "../hooks.ts";
import { currentSession, projectKey, realDir } from "../features/agentenv.ts";

// code 0 found, 2 usage (prefix too short), 3 not found, 4 ambiguous (cands newest first); err/msg/hint for the CLI error
export interface Found { s: Sess | null; code: number; cands: Sess[]; err: string; msg: string; hint: string }
export const MIN_PREFIX = 6;
function found(s: Sess): Found { return { s, code: 0, cands: [], err: "", msg: "", hint: "" }; }
function none(code: number, msg: string, hint: string): Found { return { s: null, code, cands: [], err: code === 2 ? "usage" : "not_found", msg, hint }; }
function pick(ms: Sess[], ref: string): Found {
  if (ms.length === 1) return found(ms[0]);
  const c = ms.slice().sort((a, b) => b.mtime - a.mtime);
  return { s: null, code: 4, cands: c, err: "ambiguous", msg: "session reference " + ref + " is ambiguous (" + String(c.length) + " sessions)", hint: "use more characters or <harness>:<id>" };
}
// matches of a reference: the ones in scope decide; only out-of-scope ones → not found without naming them (no ids leak)
function among(ms: Sess[], ref: string, ok: (s: Sess) => boolean): Found {
  const in_: Sess[] = []; for (const s of ms) if (ok(s)) in_.push(s);
  if (in_.length) return pick(in_, ref);
  const f = none(3, "session " + ref + " belongs to another project", "use --all-projects"); f.err = "out_of_scope"; return f;
}
// "<harness>:<id>", an exact id (any harness, subagents included), else a unique prefix of ≥ 6 characters; ok = the scope
export function findSession(ref: string, ok: (s: Sess) => boolean): Found {
  const i = ref.indexOf(":");
  if (i > 0 && /^[a-z0-9-]+$/.test(ref.slice(0, i))) {
    const h = ref.slice(0, i); const id = ref.slice(i + 1);
    if (!isHarness(h)) return none(3, "unknown harness " + h, "");
    const ms: Sess[] = []; for (const s of sessions.values()) if (s.h === h && s.id === id) ms.push(s);
    return ms.length ? among(ms, ref, ok) : none(3, "no " + h + " session " + id, "");
  }
  const ex: Sess[] = []; for (const s of sessions.values()) if (s.id === ref) ex.push(s);
  if (ex.length) return among(ex, ref, ok);
  if (ref.length < MIN_PREFIX) return none(2, "session reference " + ref + " is too short", "give at least " + String(MIN_PREFIX) + " characters of the id, or current / last / parent");
  const ms: Sess[] = []; for (const s of sessions.values()) if (s.id.startsWith(ref)) ms.push(s);
  return ms.length ? among(ms, ref, ok) : none(3, "no session " + ref, "agentglass sessions lists them");
}
// the newest top-level session in this directory's project (or exactly this directory), other than cur; heads are read
// newest first until one matches (a session's cwd is known only from its log)
export function lastSession(cwd: string, cur: Sess | null): Sess | null {
  const k = projectKey(realDir(cwd));
  const tops: Sess[] = [];
  for (const s of sessions.values()) if (!s.parent && s !== cur) tops.push(s);
  tops.sort((a, b) => b.mtime - a.mtime);
  for (const s of tops) {
    if (!s.cwd && !s.headDone) loadHead(s);
    const c = realCwd(s);
    if (c && projectKey(c) === k) return s;
  }
  return null;
}
// current (the default inside an agent), last, parent (= the current session's root), else findSession within ok; needs discover() first
export function resolveRef(ref: string, root: boolean, ok: (s: Sess) => boolean): Found {
  if (ref === "current" || ref === "parent") {
    const c = currentSession(root || ref === "parent");
    if (c.s) return found(c.s);
    const f = none(3, "no current session" + (c.via ? " (" + c.via + ")" : ""), c.hint); f.err = c.code; return f;
  }
  if (ref === "last") {
    const c = currentSession(true, true); // a subagent shell: its root is not "last" either
    const s = lastSession(process.cwd(), c.s);
    return s ? found(s) : none(3, "no other session in this project", "agentglass sessions --all-projects lists them all");
  }
  return findSession(ref, ok);
}
