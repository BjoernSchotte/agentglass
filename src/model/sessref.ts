// agentglass — session references for the CLI (and deep links): current, last, parent, <harness>:<id>, an id or a unique id prefix
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "./types.ts";
import { sessions } from "./sessions.ts";
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
// "<harness>:<id>", an exact id (any harness, subagents included), else a unique prefix of ≥ 6 characters
export function findSession(ref: string): Found {
  const i = ref.indexOf(":");
  if (i > 0 && /^[a-z0-9-]+$/.test(ref.slice(0, i))) {
    const h = ref.slice(0, i); const id = ref.slice(i + 1);
    if (!isHarness(h)) return none(3, "unknown harness " + h, "");
    const ms: Sess[] = []; for (const s of sessions.values()) if (s.h === h && s.id === id) ms.push(s);
    return ms.length ? pick(ms, ref) : none(3, "no " + h + " session " + id, "");
  }
  const ex: Sess[] = []; for (const s of sessions.values()) if (s.id === ref) ex.push(s);
  if (ex.length) return pick(ex, ref);
  if (ref.length < MIN_PREFIX) return none(2, "session reference " + ref + " is too short", "give at least " + String(MIN_PREFIX) + " characters of the id, or current / last / parent");
  const ms: Sess[] = []; for (const s of sessions.values()) if (s.id.startsWith(ref)) ms.push(s);
  return ms.length ? pick(ms, ref) : none(3, "no session " + ref, "agentglass sessions lists them");
}
// the newest top-level session in this directory's project (or exactly this directory), other than cur
export function lastSession(cwd: string, cur: Sess | null): Sess | null {
  const k = projectKey(realDir(cwd)); let best: Sess | null = null;
  for (const s of sessions.values()) {
    const cwd = realCwd(s);
    if (s.parent || s === cur || !cwd || projectKey(cwd) !== k) continue;
    if (!best || s.mtime > best.mtime) best = s;
  }
  return best;
}
// current (the default inside an agent), last, parent (= the current session's root), else findSession; needs discover() first
export function resolveRef(ref: string, root: boolean): Found {
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
  return findSession(ref);
}
