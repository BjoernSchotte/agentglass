// agentglass — session references for the CLI (and deep links): current, last, parent, <harness>:<id>, an id or a unique id prefix
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "./types.ts";
import { sessions, loadHead } from "./sessions.ts";
import { isHarness } from "../harness/index.ts";
import { realCwd, READ } from "../hooks.ts";
import { OWN } from "../features/usage/owners.ts";
import { currentSession, projectKey, realDir } from "../features/agentenv.ts";

// code 0 found, 2 usage (prefix too short), 3 not found, 4 ambiguous (cands newest first); err/msg/hint for the CLI error
// via: how s was found — the current session's resolution ("env:<VAR>", "ancestor:pid N", both joined by "+"), else "ref"
export interface Found { s: Sess | null; code: number; cands: Sess[]; err: string; msg: string; hint: string; via: string }
export const MIN_PREFIX = 6;
function found(s: Sess, via = "ref"): Found { READ.focus = s.h + ":" + (s.parent ? s.parent : s.id); return { s, code: 0, cands: [], err: "", msg: "", hint: "", via }; }
function none(code: number, msg: string, hint: string): Found { return { s: null, code, cands: [], err: code === 2 ? "usage" : "not_found", msg, hint, via: "" }; }
// copies of one session (same harness and id: a Claude session under two project dirs, a project moved or copied with its
// ~/.claude dir) stand for it as: the live copy (the one its process writes, procs.ts), then the one at home (owners.ts
// OWN.home, the rule that books their shared messages), then the newest. Every copy shows the session's figures (ledger.ts)
export function owns(a: Sess, b: Sess): boolean {
  if ((a.pid > 0) !== (b.pid > 0)) return a.pid > 0;
  const ha = OWN.home(a.path); if (ha !== OWN.home(b.path)) return ha;
  return a.mtime > b.mtime || (a.mtime === b.mtime && a.path < b.path);
}
// one per session (the copy that stands for twins), newest first
export function distinct(ms: Sess[]): Sess[] {
  const by = new Map<string, Sess>();
  for (const s of ms) { const k = s.h + ":" + s.id; const o = by.get(k); if (!o || owns(s, o)) by.set(k, s); }
  return [...by.values()].sort((a, b) => b.mtime - a.mtime);
}
function pick(ms: Sess[], ref: string): Found {
  const c = distinct(ms);
  if (c.length === 1) return found(c[0]);
  const refs: string[] = []; for (const x of c.slice(0, 5)) refs.push(x.h + ":" + x.id); // each resolves: twins are one session
  return { s: null, code: 4, cands: c, err: "ambiguous", msg: "session reference " + ref + " is ambiguous (" + String(c.length) + " sessions)", hint: "use one of: " + refs.join(", ") + (c.length > 5 ? ", …" : ""), via: "" };
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
    if (c.s) return found(c.s, c.via);
    const f = none(3, "no current session" + (c.via ? " (" + c.via + ")" : ""), c.hint); f.err = c.code; return f;
  }
  if (ref === "last") {
    const c = currentSession(true, true); // a subagent shell: its root is not "last" either
    const s = lastSession(process.cwd(), c.s);
    return s ? found(s) : none(3, "no other session in this project", "agentglass sessions --all-projects lists them all");
  }
  return findSession(ref, ok);
}
