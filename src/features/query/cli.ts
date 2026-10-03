// agentglass — filter language for --json and --watch: --filter (repeatable), --pinned, --harness/--live sugar (spec §8)
// SPDX-License-Identifier: Apache-2.0
// Pins are applied only with --pinned: scripts must be reproducible whatever the TUI has pinned.
import { complete, screenOut } from "../../hooks.ts";
import type { Sess } from "../../model/types.ts";
import { loadHead } from "../../model/sessions.ts";
import type { Clause } from "./types.ts";
import { parse, caret } from "./parse.ts";
import { keys } from "./attrs.ts";
import { type Compiled, EMPTY, compile, matchSession, sessMatches } from "./eval.ts";
import { addAll } from "./scope.ts";
import { contentSet } from "./content.ts";
import { S } from "../../state.ts";

function die(msg: string, src: string, col: number): never {
  const c = src ? "\n  " + caret(src, { msg, col }).split("\n").join("\n  ") : "";
  process.stderr.write(screenOut("agentglass: filter: " + msg + c) + "\n");
  process.exit(2);
}
// "filter keys: harness repo …" wrapped at 100 columns (the --help footer)
export function filterKeysHelp(): string {
  const out: string[] = []; let line = "filter keys:";
  for (const k of keys()) { if (line.length + 1 + k.length > 100) { out.push(line); line = "  "; } line += (line === "  " ? "" : " ") + k; }
  out.push(line);
  return out.join("\n");
}
export interface CliFilter { f: Compiled; cheap: Compiled; ended: Compiled /* cheap clauses but live: an exit event's session */; needsLedger: boolean; needsHead: boolean; content: boolean }
// keys whose values need no ledger and no transcript: they pick the candidates before complete(s) runs
// (cwd, branch, title and agent come from a transcript's head for some harnesses: loaded first when a clause names them)
const CHEAP = ["harness", "id", "subagent", "live", "archived"];
const HEAD = ["repo", "cwd", "branch", "agent", "title", "text"];
// --filter values (merged with the same-scope rules), --harness / --live sugar, --pinned; a bad expression exits 2 with a caret
export function cliFilter(exprs: string[], harness: string, live: boolean, pinned: boolean, watch: boolean): CliFilter {
  let cs: Clause[] = [];
  const extra: Clause[] = [];
  if (harness) extra.push({ key: "harness", op: "is", vals: [harness], neg: false, pinned: false });
  if (live) extra.push({ key: "live", op: "is", vals: ["true"], neg: false, pinned: false });
  if (pinned) cs = addAll(cs, S.pins).cs;
  for (const e of exprs) { const p = parse(e); if (p.err) die(p.err.msg, e, p.err.col); cs = addAll(cs, p.cs).cs; }
  cs = addAll(cs, extra).cs;
  const ctx = watch ? "watch" : "json";
  const r = compile(cs, ctx); if (r.err || !r.f) die(r.err ? r.err.msg : "invalid filter", "", 0);
  const ch: Clause[] = []; let ledgerKeys = false; let head = false;
  for (const c of cs) {
    if (CHEAP.indexOf(c.key) >= 0) ch.push(c);
    else if (HEAD.indexOf(c.key) >= 0) { ch.push(c); head = true; }
    else if (c.key !== "content" && c.key !== "event") { ledgerKeys = true; head = true; }
    if (c.key === "state" && !watch) process.stderr.write("agentglass: state needs process info; run without --json or use live\n");
  }
  const cheap = compile(ch, ctx).f ?? EMPTY;
  const nl: Clause[] = []; for (const c of ch) if (c.key !== "live") nl.push(c);
  return { f: r.f ?? EMPTY, cheap, ended: compile(nl, ctx).f ?? EMPTY, needsLedger: ledgerKeys, needsHead: head, content: (r.f ?? EMPTY).content.length > 0 };
}
// --json: the sessions (among cands) the filter keeps; the ledger is completed only for the cheap clauses' survivors
export function cliSelect(cf: CliFilter, cands: Sess[]): Sess[] {
  const out: Sess[] = [];
  for (const s of cands) {
    if (cf.needsHead && !s.headDone) loadHead(s);
    if (!sessMatches(cf.cheap, s)) continue;
    if (cf.needsLedger) complete(s);
    if (matchSession(cf.f, s, null)) out.push(s);
  }
  if (!cf.content) return out;
  let keep = out;
  for (const c of cf.f.content) {
    const ps: string[] = []; for (const s of keep) ps.push(s.path);
    const r = contentSet(c.vals.join(" "), ps.length <= 200 ? ps : null);
    if (r.timedOut) { process.stderr.write("agentglass: full-text search timed out after 30 s — content clause matches nothing\n"); return []; }
    const neg = c.op === "!~"; const next: Sess[] = [];
    for (const s of keep) if (r.paths.has(s.path) !== neg) next.push(s);
    keep = next;
  }
  return keep;
}
// --watch: does this session pass? ledger clauses re-evaluated at most every 10 s per session (complete() is incremental)
const lastCheck = new Map<string, { at: number; ok: boolean }>();
export function cliWatchSession(cf: CliFilter, s: Sess): boolean {
  if (cf.needsHead && !s.headDone) loadHead(s);
  if (!sessMatches(cf.cheap, s)) return false;
  if (!cf.needsLedger && !cf.content) return true;
  const hit = lastCheck.get(s.path);
  if (hit && Date.now() - hit.at < 10000) return hit.ok;
  if (cf.needsLedger) complete(s);
  const ok = cliSelect(cf, [s]).length > 0;
  lastCheck.set(s.path, { at: Date.now(), ok });
  return ok;
}
// --watch: an agent process went away — its session is not live any more, the other cheap clauses still apply
export function cliWatchExit(cf: CliFilter, s: Sess): boolean { return sessMatches(cf.ended, s) && cliWatchEvent(cf, s, "exit", "", ""); }
// --watch: one event (kind, tool name, call arguments) against the event and call clauses
export function cliWatchEvent(cf: CliFilter, s: Sess, kind: string, tool: string, args: string): boolean {
  for (const p of cf.f.event) if (!p(s, kind, tool, args)) return false;
  return true;
}
