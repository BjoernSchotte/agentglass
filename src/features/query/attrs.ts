// agentglass — filter language: the attribute catalogue (keys, aliases, entity, type, operators, enum values)
// SPDX-License-Identifier: Apache-2.0
// Metadata only; how a value is read from a session, day or call lives in eval.ts. Later specs register more keys.
import { HARNESSES, harnessIds } from "../../harness/index.ts";
import type { Attr, AType, Ent } from "./types.ts";
import { ALL_KINDS } from "../wait/family.ts";
import { FAMILIES, SUBKINDS, RAW_EVENT, validKind } from "../../model/kinds.ts";

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
// enum values known only at runtime (fleet: this machine's name + the configured hosts; features/fleet/hosts.ts sets it)
export const HOST_ENUM = { values: (): string[] => ["local"] };
// event kinds offered: those of the event view whose filter input is open (ui/evfilter.ts sets present), else every
// family and the kinds known without a session
// values: mcp.server / shell.family values of that view's session ([] = none known there)
export const EVK = { present: (): string[] => [] as string[], values: (key: string): string[] => [] as string[] };
export function evkindValues(): string[] { const p = EVK.present(); return p.length ? p : FAMILIES.concat(SUBKINDS); }
export function enumValues(a: Attr): string[] {
  if (a.enumFn === "harness") return harnessIds();
  if (a.enumFn === "host") return HOST_ENUM.values();
  if (a.enumFn === "evkind") return evkindValues();
  return a.enumVals;
}
// "OpenCode" → "opencode" (ids and labels); "" when invalid
export function canonEnum(a: Attr, v: string): string {
  const l = v.toLowerCase();
  if (a.enumFn === "harness") { for (const h of HARNESSES) if (h.id === l || h.label.toLowerCase() === l) return h.id; return ""; }
  if (a.enumFn === "host") { for (const x of HOST_ENUM.values()) if (x.toLowerCase() === l) return x; return ""; }
  if (a.enumFn === "evkind") return validKind(l) ? l : "";
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
r("host", [], "session", "enum", false, [], "host", []); // fleet: the machine a session runs on (this one: fleet.localName)
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
r("family", [], "call", "text", false, [], "", []); // agent-wait: the call's command family (non-shell tools: the tool, "mcp <server>")
r("kind", [], "call", "enum", false, ALL_KINDS, "", []); // agent-wait: test, typecheck, lint, build, … (non-shell tools: user, agent, file, …)
r("file", [], "call", "path", true, [], "", []);
r("ext", [], "call", "text", true, [], "", []);
r("status", [], "call", "enum", false, ["ok", "error", "unknown"], "", []);
r("duration", [], "call", "dur", false, [], "", []);
r("out", [], "call", "size", false, [], "", []);
r("hour", [], "call", "num", false, [], "", []);
// skill-usage §5a.3: an event's kinds (multi: a failing test run is shell:test and error; a family matches all its kinds);
// `event` is the old key, kept as its own entry (pins print it back as typed): the same kinds, and its old values (user,
// tool, result, meta …) keep matching the raw event kind (kinds.ts LEGACY_EVENT)
r("event.kind", [], "event", "enum", true, RAW_EVENT, "evkind", []);
r("event", [], "event", "enum", true, RAW_EVENT, "evkind", []);
r("mcp.server", [], "event", "text", false, [], "", []); // the server of an mcp:* event
r("shell.family", [], "event", "text", false, [], "", []); // a shell call's agent-wait family ("pnpm test")
