// agentglass — filter language: the attribute catalogue (keys, aliases, entity, type, operators, enum values)
// SPDX-License-Identifier: Apache-2.0
// Metadata only; how a value is read from a session, day or call lives in eval.ts. Later specs register more keys.
import { HARNESSES, harnessIds } from "../../harness/index.ts";
import type { Attr, AType, Ent } from "./types.ts";

const REG: Attr[] = [];
const BY = new Map<string, Attr>(); // key and aliases, lowercase
export function register(a: Attr): void {
  const k = a.key.toLowerCase();
  const old = BY.get(k);
  if (old) REG.splice(REG.indexOf(old), 1); // re-registering refines a key (repo-view's repo)
  REG.push(a); BY.set(k, a);
  for (const x of a.aliases) BY.set(x.toLowerCase(), a);
}
export function attrOf(keyOrAlias: string): Attr | null { return BY.get(keyOrAlias.toLowerCase()) ?? null; }
// canonical keys in registry order (help text, completion)
export function keys(): string[] { return REG.map((a: Attr) => a.key); }
export function aliases(): string[] { const o: string[] = []; for (const a of REG) for (const x of a.aliases) o.push(x); return o; }

const WEEKDAYS = ["su", "mo", "tu", "we", "th", "fr", "sa"]; // Date.getDay() order
export function weekdayIndex(v: string): number { return WEEKDAYS.indexOf(v.slice(0, 2).toLowerCase()); }
export function enumValues(a: Attr): string[] {
  if (a.enumFn === "harness") return harnessIds();
  return a.enumVals;
}
// "OpenCode" → "opencode" (ids and labels); "" when invalid
export function canonEnum(a: Attr, v: string): string {
  const l = v.toLowerCase();
  if (a.enumFn === "harness") { for (const h of HARNESSES) if (h.id === l || h.label.toLowerCase() === l) return h.id; return ""; }
  if (a.key === "weekday") { const full = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]; const i = full.indexOf(l); if (i >= 0) return WEEKDAYS[i] ?? ""; }
  return a.enumVals.indexOf(l) >= 0 ? l : "";
}

export const NUMERIC: AType[] = ["usd", "tok", "num", "ratio", "dur", "size", "date"];
export function isNumeric(t: AType): boolean { return NUMERIC.indexOf(t) >= 0; }
const TEXT_OPS = ["is", "is_not", "is_one_of", "is_not_one_of", "~", "!~"];
const NUM_OPS = ["is", "is_not", ">", ">=", "<", "<="];
// operators an attribute accepts, in the order completion offers them
export function opsOf(a: Attr): string[] {
  if (a.ops.length) return a.ops;
  if (a.type === "bool") return ["is", "is_not"];
  return isNumeric(a.type) ? NUM_OPS : TEXT_OPS;
}
// the short suggestion in "… does not apply" errors
export function opHint(a: Attr): string {
  if (a.ops.length) return a.ops.join(", ");
  if (a.type === "bool") return "is, is_not";
  return isNumeric(a.type) ? "is, >, >=, <, <=" : "is, is_one_of, ~";
}

function r(key: string, aliases: string[], ent: Ent, type: AType, multi: boolean, enumVals: string[], enumFn: string, ops: string[]): void {
  register({ key, aliases, ent, type, multi, enumVals, enumFn, ops });
}
// spec §2, in table order
r("harness", ["h"], "session", "enum", false, [], "harness", []);
r("repo", ["project"], "session", "text", false, [], "", []);
r("cwd", [], "session", "path", false, [], "", []);
r("branch", [], "session", "text", false, [], "", []);
r("model", [], "session", "text", true, [], "", []);
r("title", [], "session", "text", false, [], "", []);
r("id", [], "session", "text", false, [], "", []);
r("agent", [], "session", "text", false, [], "", []);
r("subagent", [], "session", "bool", false, [], "", []);
r("live", [], "session", "bool", false, [], "", []);
r("archived", [], "session", "bool", false, [], "", []);
r("state", [], "session", "enum", false, ["stuck", "attention", "busy", "idle", "ended"], "", []);
r("cost", [], "session", "usd", false, [], "", []);
r("tokens", [], "session", "tok", false, [], "", []);
r("tokens.in", [], "session", "tok", false, [], "", []);
r("tokens.out", [], "session", "tok", false, [], "", []);
r("tokens.cache_read", [], "session", "tok", false, [], "", []);
r("tokens.cache_write", [], "session", "tok", false, [], "", []);
r("tools", [], "session", "num", false, [], "", []);
r("errors", [], "session", "num", false, [], "", []);
r("error_rate", [], "session", "ratio", false, [], "", []);
r("lines", [], "session", "num", false, [], "", []);
r("lines.added", [], "session", "num", false, [], "", []);
r("lines.removed", [], "session", "num", false, [], "", []);
r("age", [], "session", "dur", false, [], "", []);
r("text", [], "session", "text", false, [], "", []);
r("content", [], "session", "text", false, [], "", ["~", "!~"]);
r("day", [], "day", "date", false, [], "", []);
r("weekday", [], "day", "enum", false, ["mo", "tu", "we", "th", "fr", "sa", "su"], "", []);
r("day.cost", [], "day", "usd", false, [], "", []);
r("day.tokens", [], "day", "tok", false, [], "", []);
r("day.tools", [], "day", "num", false, [], "", []);
r("tool", [], "call", "text", false, [], "", []);
r("server", [], "call", "text", false, [], "", []);
r("program", [], "call", "text", true, [], "", []);
r("command", [], "call", "text", true, [], "", []);
r("file", [], "call", "path", true, [], "", []);
r("ext", [], "call", "text", true, [], "", []);
r("status", [], "call", "enum", false, ["ok", "error", "unknown"], "", []);
r("duration", [], "call", "dur", false, [], "", []);
r("out", [], "call", "size", false, [], "", []);
r("hour", [], "call", "num", false, [], "", []);
r("event", [], "event", "enum", false, ["user", "assistant", "thinking", "tool", "result", "meta", "live", "exit"], "", []);
