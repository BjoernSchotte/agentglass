// agentglass events <ref>: one session's events with their kinds, filtered the way every event view filters them (the
// same controller, skill-usage §5a.7): {session, filter, matched, total, events: [event | {gap, kinds}]}
// SPDX-License-Identifier: Apache-2.0
// Text (prompts, replies, tool output, command lines) only with --content, like the MCP server's rule; without it an
// event names its kinds, tool and a target that holds no content (a shell call's family, a file tool's path).
import { writeSync } from "node:fs";
import type { Ev, Sess } from "../model/types.ts";
import { type Obj } from "../util/json.ts";
import { H, complete, display, screenOut } from "../hooks.ts";
import { S } from "../state.ts";
import { loadHead, titleOf } from "../model/sessions.ts";
import { type Found, resolveRef } from "../model/sessref.ts";
import { sourceOf, parseEvents, window } from "../harness/index.ts";
import { kindIds, kindSet, shellFam } from "../model/kinds.ts";
import { famOf, marksOf } from "../model/marks.ts";
import { toolName, toolArg } from "./callgraph/model.ts";
import { caret } from "./query/parse.ts";
import { addCmd, opt } from "./clihelp.ts";
import { type Scope, agentHost, agentScope, visible, cliError } from "./agentenv.ts";
import { argVal } from "../util/argv.ts";
import { localHM } from "../util/text.ts";
import { canonicalUrl } from "./palette/ref.ts";
import { discover } from "./cli.ts";
import { type Gap, VF_STORE, vfSet, vfOf, preset, mask, runs, resetForTest } from "../ui/evfilter.ts";

const VIEW = "events"; // its own controller state: never the TUI's saved or linked filters
export const EVENT_FIELDS = ["i", "ts", "kind", "kinds", "tool", "id", "target", "text", "link"];
const PRESET_NAMES = ["all", "skills", "mcp", "shell", "errors", "prompts"];
function out(t: string): void { try { writeSync(1, screenOut(t) + "\n"); } catch (e) { process.exit(0); } }
function oneLine(t: string, n: number): string { const l = t.replace(/\s+/g, " ").trim(); return l.length > n ? l.slice(0, n) + "…" : l; }

// every event of a session's log, read from the start in ≤ 4 MB windows (a longer record widens the window)
export function readAll(s: Sess): Ev[] {
  const src = sourceOf(s.h); const st = src.stat(s); const end = st ? st.size : s.size; const evs: Ev[] = [];
  for (let p = 0; p < end;) {
    let w = window(src, 4194304); let r = src.lines(s, p, Math.min(end, p + w));
    while (r.next <= p && p + w < end && w < window(src, 67108864)) { w *= 4; r = src.lines(s, p, Math.min(end, p + w)); }
    if (r.next <= p) break;
    for (const l of r.lines) parseEvents(s.h, l, evs, s);
    p = r.next;
  }
  return evs;
}
// a call's target without content: a shell call's family, a file or web tool's path / url / pattern, an MCP tool's name,
// the skill a skill tool loaded (sk: call id → its name through skillVis, from the skill marks)
function target(s: Sess, e: Ev, call: Ev | null, kinds: string[], sk: Map<string, string>): string {
  const c = e.kind === "tool" ? e : call; if (!c) return "";
  const name = toolName(c); const arg = toolArg(c);
  for (const k of kinds) if (k.startsWith("shell:")) return display("prog", shellFam(name, arg), s);
  for (const k of kinds) if (k.startsWith("mcp:")) return display("tool", name, s);
  for (const k of kinds) if (k === "edit" || k === "read" || k === "read:search") return display("file", oneLine(arg, 200), s);
  if (kinds.indexOf("skill:load") >= 0 && c.id) return sk.get(c.id) ?? "";
  return "";
}
export interface EvList { matched: number; total: number; events: Obj[] }
// the listing over evs with the controller's view "events" already set: shown events and one {gap, kinds} per hidden run;
// limit > 0: the last limit shown events (one gap before them for everything earlier); content: the event text too
export function listEvents(s: Sess, evs: Ev[], limit: number, content: boolean): EvList {
  const m = mask(VIEW, s, evs); const ids = kindIds(s, evs);
  let matched = 0; for (let i = 0; i < evs.length; i++) matched += m[i] + 0;
  let from = 0;
  if (limit > 0 && matched > limit) { let k = 0; from = evs.length; while (from > 0 && k < limit) { from--; if (m[from] + 0 === 1) k++; } }
  const calls = new Map<string, number>(); for (let i = 0; i < evs.length; i++) { const e = evs[i]; if (e.kind === "tool" && e.id) calls.set(e.id, i); }
  const sk = new Map<string, string>(); for (const mk of marksOf(s, ["skill"])) if (mk.kind === "skill:load" && mk.anchor.startsWith("call=")) sk.set(mk.anchor.slice(5), mk.label);
  const gapObj = (g: Gap): Obj => { const ks: Obj = {}; const names: string[] = []; for (const k of g.kinds.keys()) names.push(k); names.sort((a: string, b: string): number => (g.kinds.get(b) ?? 0) - (g.kinds.get(a) ?? 0) || (a < b ? -1 : 1)); for (const k of names) ks[k] = g.kinds.get(k) ?? 0; return { gap: g.hidden, kinds: ks }; };
  const o: Obj[] = [];
  if (from > 0) { // everything before the last limit matches, shown or not, as one gap
    const ks = new Map<string, number>();
    for (let i = 0; i < from; i++) { const fs: string[] = []; for (const k of kindSet(ids[i] + 0)) { const f = famOf(k); if (fs.indexOf(f) < 0) fs.push(f); } for (const f of fs) ks.set(f, (ks.get(f) ?? 0) + 1); }
    o.push(gapObj({ i: 0, hidden: from, kinds: ks }));
  }
  for (let i = from; i < evs.length;) {
    if (m[i] + 0 === 0) { let j = i; while (j < evs.length && m[j] + 0 === 0) j++; const g = runs(VIEW, s, evs, i, j)[0]; if (g) o.push(gapObj(g)); i = j; continue; }
    const e = evs[i]; const ks = kindSet(ids[i] + 0);
    let call: Ev | null = null; if (e.kind === "result" && e.id) { const j = calls.get(e.id); if (j !== undefined && j + 0 < evs.length) call = evs[j + 0]; }
    const c = e.kind === "tool" ? e : call; const id = (e.kind === "tool" || e.kind === "result") && e.id ? e.id : "";
    o.push({ i, ts: e.ts || null, kind: e.kind, kinds: ks.slice(), tool: c ? display("tool", toolName(c), s) : null, id: id || null, target: target(s, e, call, ks, sk) || null,
      text: content ? oneLine(e.kind === "tool" ? toolArg(e) : e.text, 500) : null, link: canonicalUrl(s, id ? "call" : e.ts ? "ts" : "", id || e.ts) });
    i++;
  }
  return { matched, total: evs.length, events: o };
}
// the CLI's view state: no saved file, no link to the TUI's filters
export function cliView(): void { VF_STORE.path = "-"; VF_STORE.remember = false; resetForTest(); }

interface EOpts { ref: string; filters: string[]; preset: number; limit: number; content: boolean; json: boolean; pinned: boolean }
function opts(args: string[]): EOpts {
  const o: EOpts = { ref: "", filters: [], preset: -1, limit: 0, content: false, json: false, pinned: false };
  const bad = (m: string): never => cliError("usage", m, "agentglass events --help", 2);
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (!a.startsWith("-")) { if (o.ref) bad("unexpected argument " + a + " (one session ref)"); o.ref = a; continue; }
    if (a === "--json") o.json = true;
    else if (a === "--content") o.content = true;
    else if (a === "--pinned") o.pinned = true;
    else if (a === "--filter") { const v = argVal(args, i++); if (!v) bad("--filter needs an expression, e.g. --filter 'event.kind is skill'"); o.filters.push(String(v)); }
    else if (a === "--preset") { const v = argVal(args, i++) ?? ""; o.preset = PRESET_NAMES.indexOf(v); if (o.preset < 0) bad("--preset is one of " + PRESET_NAMES.join(", ")); }
    else if (a === "--limit") { const v = argVal(args, i++) ?? ""; o.limit = /^\d+$/.test(v) ? Number(v) : 0; if (o.limit < 1) bad("--limit needs a positive whole number, e.g. --limit 50"); }
    else if (a === "--agent" || a === "--no-agent" || a === "--redact" || a === "--all-projects" || a === "--project-only") continue;
    else bad("unknown option " + a);
  }
  if (o.preset >= 0 && o.filters.length) bad("--preset and --filter exclude each other (a preset is a filter)");
  return o;
}
function resolveOrFail(ref: string, sc: Scope): Sess {
  const f: Found = resolveRef(ref, false, (x: Sess): boolean => visible(x, sc));
  if (!f.s) {
    if (f.code === 4) cliError("ambiguous", f.msg, "candidates: " + f.cands.slice(0, 5).map((c: Sess) => c.h + ":" + c.id).join(", ") + (f.cands.length > 5 ? ", …" : ""), 4);
    cliError(f.err || "not_found", f.msg, f.hint, f.code || 3);
  }
  const s = f.s as Sess;
  if (ref !== "current" && ref !== "parent" && !visible(s, sc)) cliError("out_of_scope", "session " + s.id + " belongs to another project", "use --all-projects", 3);
  return s;
}
function run(args: string[]): void {
  const o = opts(args); const sc = agentScope(args);
  cliView();
  // the expression first: a typo exits 2 with a caret before any log is read
  let expr = o.filters.join(" and ");
  if (!o.pinned) S.pins = []; // reproducible: the TUI's pinned event clauses only with --pinned (the controller applies them)
  if (o.preset >= 0) { preset(VIEW, o.preset); expr = vfOf(VIEW).expr; }
  else if (expr) {
    const e = vfSet(VIEW, expr);
    if (e) { const col = vfOf(VIEW).errCol; cliError("usage", "filter: " + e, col >= 0 ? caret(expr, { msg: e, col }) : "agentglass events --help lists the event keys", 2); }
  }
  discover();
  const s = resolveOrFail(o.ref || (agentHost().on ? "current" : "last"), sc);
  loadHead(s); complete(s); // marks (skill loads …) come from the ledger
  const evs = readAll(s);
  const r = listEvents(s, evs, o.limit, o.content);
  const json = o.json || agentHost().on || process.stdout.isTTY !== true;
  if (json) { out(JSON.stringify({ session: { harness: s.h, id: s.id, title: titleOf(s) }, filter: vfOf(VIEW).expr || null, preset: o.preset >= 0 ? PRESET_NAMES[o.preset] ?? null : null, matched: r.matched, total: r.total, events: r.events })); return; }
  out(String(r.matched) + " of " + String(r.total) + " events · " + titleOf(s) + (vfOf(VIEW).expr ? " · " + vfOf(VIEW).expr : ""));
  for (const x of r.events) {
    if (x["gap"] !== undefined) { const ks = x["kinds"] as Obj; const p: string[] = []; for (const k of Object.keys(ks)) p.push(k + " " + String(ks[k])); out("  ┄ " + String(x["gap"]) + " hidden" + (p.length ? " · " + p.join(" · ") : "") + " ┄"); continue; }
    const ts = typeof x["ts"] === "string" ? localHM(String(x["ts"])) : "     ";
    const ks = (x["kinds"] as string[]).join(",");
    const tl = x["tool"] !== null ? String(x["tool"]) + (x["target"] !== null ? " " + String(x["target"]) : "") : String(x["kind"]);
    out(ts + "  " + (ks + " ".repeat(Math.max(0, 22 - ks.length))) + " " + oneLine(tl + (x["text"] !== null && x["kind"] !== "tool" ? " · " + String(x["text"]) : ""), 120));
  }
}
addCmd({ cmd: "events", usage: "agentglass events [<ref>] [--filter '<expr>'] [--json]", summary: "one session's events with their kinds (prompt, reply, shell:test, edit, mcp:<server>, skill:load, error …),\nfiltered like the TUI's event views (K, /); hidden runs as {gap, kinds}; text only with --content\n(<ref> = current | last | parent | <id> | <harness>:<id>; default current in an agent, else last)", options: [
  opt("--filter", "'<expr>'", "only these events: event.kind is skill · event.kind is_one_of mcp, error · mcp.server is github · shell.family ~ test (repeatable)", "", []),
  opt("--preset", PRESET_NAMES.join("|"), "a preset of the TUI's K bar (errors = failing calls and the reply before each; prompts = prompts, errors, each turn's last reply)", "", PRESET_NAMES),
  opt("--limit", "N", "the last N matching events (one gap before them for the rest)", "", []),
  opt("--content", "", "include the events' text (prompts, replies, commands, output)", "", []),
  opt("--pinned", "", "also apply the event clauses pinned in the TUI", "", []),
  opt("--json", "", "JSON (the default in an agent or a pipe)", "", []),
], fields: ["session", "filter", "preset", "matched", "total", "events"], group: "cmd" }, "cost");
H.cli.unshift((args: string[]): boolean => {
  if ((args[0] ?? "") !== "events" || args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) return false;
  S.cli = true; run(args); process.exit(0);
});
