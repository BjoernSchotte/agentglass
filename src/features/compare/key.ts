// agentglass — the `session` filter key: one run by "<harness>:<id>" or a unique id prefix, its subagents included (spec §1, §6)
// SPDX-License-Identifier: Apache-2.0
// `session is claude:abc` matches the session and its subagents (their cost and calls are part of the run);
// `… and subagent is false` matches the session alone. Values resolve to the canonical "<harness>:<id>" at compile time.
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { isHarness } from "../../harness/index.ts";
import type { Clause, Val } from "../query/types.ts";
import { register } from "../query/attrs.ts";
import { extend } from "../query/eval.ts";
import { parse } from "../query/parse.ts";
import { owns } from "../../model/sessref.ts";

function hid(s: Sess): string { return s.h + ":" + s.id; }
// "<harness>:<id>" (lowercase) → session; rebuilt when a lookup misses or finds a session that left the scan
const idx = new Map<string, Sess>(); let idxN = -1;
// twins (one Claude session under two project dirs) map to the owning copy (sessref.ts owns)
function reindex(): void { idx.clear(); for (const s of sessions.values()) { const k = hid(s).toLowerCase(); const o = idx.get(k); if (!o || owns(s, o)) idx.set(k, s); } idxN = sessions.size; }
function lookup(k: string): Sess | null {
  const l = k.toLowerCase();
  let s = idx.get(l);
  if (!s || idxN !== sessions.size || sessions.get(s.path) !== s) { reindex(); s = idx.get(l); }
  return s ?? null;
}
// the session a resolved value names (null when it is gone)
export function sessionOf(v: string): Sess | null { return lookup(v); }

// "<harness>:<id>" exact, or a unique id prefix of ≥ 6 characters (an exact id wins over longer ids it prefixes)
export function resolveSession(v: string): { v: string; err: string } {
  const c = v.indexOf(":");
  if (c > 0 && isHarness(v.slice(0, c).toLowerCase())) {
    const s = lookup(v);
    return s ? { v: hid(s), err: "" } : { v, err: "session \"" + v + "\": no such session" };
  }
  if (v.length < 6) return { v, err: "session \"" + v + "\": id prefix needs at least 6 characters" };
  const l = v.toLowerCase(); const hits: string[] = []; const exact: string[] = [];
  for (const s of sessions.values()) {
    const id = s.id.toLowerCase();
    if (!id.startsWith(l)) continue;
    if (hits.indexOf(hid(s)) < 0) hits.push(hid(s));
    if (id === l && exact.indexOf(hid(s)) < 0) exact.push(hid(s));
  }
  if (exact.length === 1) return { v: exact[0] ?? v, err: "" };
  if (hits.length === 1) return { v: hits[0] ?? v, err: "" };
  if (!hits.length) return { v, err: "session \"" + v + "\": no such session" };
  hits.sort();
  return { v, err: "session \"" + v + "\" is ambiguous: " + hits.slice(0, 5).join(", ") + (hits.length > 5 ? " +" + String(hits.length - 5) : "") };
}
// the exit code of a resolveSession error, per the one table (agentglass --help): 4 ambiguous, 3 not found, 2 usage
export function sessionErrCode(err: string): number { return err.indexOf("\" is ambiguous: ") >= 0 ? 4 : err.endsWith(": no such session") ? 3 : 2; }
// a subagent's value list carries its parent's id: the parent's clause includes it
function sessValOf(s: Sess): Val {
  const ss = [hid(s).toLowerCase()];
  if (s.parent) ss.push((s.h + ":" + s.parent).toLowerCase());
  return { n: 0, ss, unk: false };
}
export function sessionClause(s: Sess): Clause { return { key: "session", op: "is", vals: [hid(s)], neg: false, pinned: false }; }
// checks and the CLI echo: parsed clauses with every session value resolved (unresolvable values stay as typed)
export function sessionClauseList(src: string): Clause[] {
  const o: Clause[] = [];
  for (const c of parse(src).cs) {
    if (c.key !== "session") { o.push(c); continue; }
    const vs: string[] = []; for (const v of c.vals) { const r = resolveSession(v); vs.push(r.err ? v : r.v); }
    o.push({ key: c.key, op: c.op, vals: vs, neg: c.neg, pinned: c.pinned });
  }
  return o;
}

register({ key: "session", aliases: [], ent: "session", type: "text", multi: true, enumVals: [], enumFn: "", ops: ["is", "is_not", "is_one_of", "is_not_one_of"] });
extend("session", { sess: sessValOf, resolve: (v: string) => resolveSession(v) });
