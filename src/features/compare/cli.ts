// agentglass — `agentglass compare`: two sessions or two expressions side by side, as a text table or --json (spec §7)
// SPDX-License-Identifier: Apache-2.0
// Pins are not applied (scripts stay reproducible, as with --json). Exit codes per the one table: 2 usage (a bad
// expression with its caret, a missing argument, an id prefix under 6 characters, A = B), 3 an unknown session,
// 4 an ambiguous id prefix (the candidates on stderr).
import { writeSync } from "node:fs";
import { H, complete, screenOut, display } from "../../hooks.ts";
import { S } from "../../state.ts";
import { sessions, loadHead } from "../../model/sessions.ts";
import type { Obj } from "../../util/json.ts";
import { width } from "../../util/text.ts";
import { C, RST, fg } from "../../ui/theme.ts";
import { discover } from "../cli.ts";
import { pct, mcpServer } from "../usage/calls.ts";
import { type ModeSum, total, single } from "../usage/costs.ts";
import { MODES } from "../usage/billing.ts";
import type { Clause } from "../query/types.ts";
import { parse, print, printClause } from "../query/parse.ts";
import { addAll } from "../query/scope.ts";
import { compile, sessMatches } from "../query/eval.ts";
import { cliFilter } from "../query/cli.ts";
import { shown } from "../triage/run.ts";
import { resolveSession, sessionOf, sessionErrCode } from "./key.ts";
import { type Group, type Side, type Cmp, groupOfSession, groupOfExpr, groupClauses, compareGroups } from "./metrics.ts";
import { toolRows, cntRows, fileLists } from "./sections.ts";

const HELP = `usage: agentglass compare <session> <session> [--no-subagents] [--json]
       agentglass compare --a '<expr>' --b '<expr>' [--filter '<scope>']… [--no-subagents] [--json]

  side-by-side diff of two runs or two groups: cost, turns, tokens, cache use, tool mix, errors, durations,
  lines, files and models, with Δ (B − A) and B/A.

  <session>           <harness>:<id> (claude:3f2a…) or a unique id prefix of at least 6 characters
  --a / --b '<expr>'  any filter expression per group, e.g. 'model ~ opus' vs 'model ~ sonnet',
                      'day >= -6d' vs 'day >= -13d and day < -6d' (this week vs the last)
  --filter '<scope>'  clauses both groups must also match (repeatable; pins are not applied)
  --no-subagents      leave subagents out (by default a session group includes its subagents)
  --json              {a:{expr, n, metrics}, b:{…}, subagents, tools[], programs[], files{onlyA, onlyB, both}};
                      metrics.cost is the total, costByMode its split (api = real spend, the rest list-price
                      estimates), billing the one mode or "mixed"; wallMs = first event → last activity,
                      activeMs = minutes with activity (a session: at most wallMs); unknown values (unpriced cost,
                      untimed calls) are null

  exit codes: 0 ok · 2 usage (bad expression or option, id prefix < 6, A = B) · 3 unknown session · 4 ambiguous prefix`;

function out(line: string): void { try { writeSync(1, screenOut(line) + "\n"); } catch (e) { process.exit(0); } }
function fail(msg: string, code = 2): never { process.stderr.write(screenOut("agentglass: compare: " + msg) + "\n"); process.exit(code); }

interface Opts { pos: string[]; a: string; b: string; hasA: boolean; hasB: boolean; filters: string[]; subs: boolean; json: boolean }
function parseArgs(args: string[]): Opts {
  const o: Opts = { pos: [], a: "", b: "", hasA: false, hasB: false, filters: [], subs: true, json: false };
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    const val = (): string => { if (i + 1 >= args.length) fail(a + " needs a value (see agentglass compare --help)"); i++; return args[i] ?? ""; };
    if (a === "--json") o.json = true;
    else if (a === "--no-subagents") o.subs = false;
    else if (a === "--a") { o.a = val(); o.hasA = true; }
    else if (a === "--b") { o.b = val(); o.hasB = true; }
    else if (a === "--filter") o.filters.push(val());
    else if (a === "--help" || a === "-h") { out(HELP); process.exit(0); }
    else if (a.startsWith("-")) fail("unknown option " + a + " (see agentglass compare --help)");
    else o.pos.push(a);
  }
  const ex = o.hasA || o.hasB;
  if (ex && o.pos.length) fail("give two sessions or --a and --b, not both");
  if (ex && !(o.hasA && o.hasB)) fail((o.hasA ? "--b" : "--a") + " is missing: compare needs both groups");
  if (!ex && o.pos.length !== 2) fail(o.pos.length < 2 ? "needs two sessions (or --a '<expr>' --b '<expr>'); see agentglass compare --help" : "takes two sessions, got " + String(o.pos.length));
  return o;
}
function sessGroup(v: string): Group {
  const r = resolveSession(v); if (r.err) fail(r.err, sessionErrCode(r.err));
  const s = sessionOf(r.v); if (!s) fail("session \"" + v + "\": no such session", 3);
  loadHead(s); // the title comes from the transcript's head for most harnesses
  return groupOfSession(s);
}
function exprGroup(src: string): Group {
  cliFilter([src], "", false, false, false); // parse errors: message + caret, exit 2
  const r = groupOfExpr(src); if (!r.g) fail(r.err ? r.err.msg : "invalid expression");
  return r.g;
}
// every session either group can count, indexed to its end (session and cheap clauses pick the candidates first)
function completeFor(g: Group, scope: Clause[], subs: boolean): void {
  const cs = groupClauses(g, scope, subs);
  const cf = cliFilter([print(cs)], "", false, false, false);
  const sc: Clause[] = []; for (const c of cs) if (c.key === "session") sc.push(c);
  const sf = compile(sc, "json").f;
  for (const s of sessions.values()) {
    if (cf.needsHead && !s.headDone) loadHead(s);
    if (!sessMatches(cf.cheap, s) || (sf && !sessMatches(sf, s))) continue;
    loadHead(s); complete(s);
  }
}

// ── JSON (unknown → null) ──
function r6(x: number): number { return Math.round(x * 1e6) / 1e6; }
function orNull(x: number): number | null { return x < 0 ? null : x; }
function unpriced(sd: Side): boolean { return sd.m.unk > 0 || sd.m.uc > 0; }
// per billing mode, as `agentglass cost --json` writes it
function byMode(m: ModeSum): Obj { const o: Obj = {}; for (let i = 0; i < MODES.length; i++) o[MODES[i] ?? ""] = r6(m.by[i] ?? 0); return o; }
function metricsOf(sd: Side): Obj {
  const t = sd.t; const c = total(sd.m); const den = t.inTok + t.cr + t.cw; const bill = single(sd.m);
  const models: string[] = []; for (const u of sd.mu) if (u.inTok + u.outTok + u.cr + u.cw > 0 && u.model !== "unknown" && models.indexOf(u.model) < 0) models.push(u.model);
  for (const m of t.models) if (m !== "unknown" && models.indexOf(m) < 0) models.push(m);
  models.sort();
  return {
    cost: c === 0 && unpriced(sd) ? null : r6(c), unpriced: unpriced(sd), billing: bill ? bill : c > 0 ? "mixed" : null, costByMode: byMode(sd.m),
    wallMs: orNull(sd.wall), activeMs: sd.err ? null : sd.active, turns: sd.turns,
    tokens: { in: t.inTok, out: t.outTok, cacheRead: t.cr, cacheWrite: t.cw }, cacheHit: den > 0 ? r6(t.cr / den) : null,
    tools: t.tools, errors: t.errors, errorRate: t.tools > 0 ? r6(t.errors / t.tools) : null,
    p50Ms: t.dn > 0 ? pct(t.hist, 0.5, t.max) : null, p95Ms: t.dn > 0 ? pct(t.hist, 0.95, t.max) : null, maxMs: t.dn > 0 ? t.max : null, timed: t.dn,
    linesAdded: t.add, linesRemoved: t.del, filesTouched: t.files.size, models,
    subagents: { n: t.subs, cost: t.subsCost === 0 && t.subsUnk > 0 ? null : r6(t.subsCost) },
  };
}
function toJson(c: Cmp): Obj {
  const all = new Set<string>(); for (const t of [c.a.t, c.b.t]) for (const n of t.perTool.keys()) { const sv = mcpServer(n); if (sv) all.add("mcp__" + sv); } // per tool, MCP servers unfolded
  const tools: Obj[] = [];
  for (const r of toolRows(c, all).rows) {
    if (r.server) continue;
    tools.push({ tool: display("tool", r.kid ? r.key : r.label, null), a: { n: r.nA, err: r.errA, p50: orNull(r.p50A), p95: orNull(r.p95A) }, b: { n: r.nB, err: r.errB, p50: orNull(r.p50B), p95: orNull(r.p95B) }, shareDiff: r6(r.shB - r.shA), chi2: r.chi2 < 0 ? null : Math.round(r.chi2 * 10) / 10 });
  }
  const programs: Obj[] = []; for (const r of cntRows(c, "prog")) programs.push({ program: shown("program", r.key), a: { n: r.nA, err: r.errA }, b: { n: r.nB, err: r.errB } });
  const fl = fileLists(c); const names = (xs: { shown: string }[]): string[] => xs.map((f: { shown: string }): string => display("file", f.shown, null));
  return {
    a: { expr: print(c.A.cs), n: c.a.n, metrics: metricsOf(c.a) }, b: { expr: print(c.B.cs), n: c.b.n, metrics: metricsOf(c.b) }, subagents: c.subs,
    tools, programs, files: { onlyA: names(fl.onlyA), onlyB: names(fl.onlyB), both: names(fl.both) },
  };
}

// ── text ──
function rpad(s: string, w: number): string { const n = width(s); return n >= w ? s : " ".repeat(w - n) + s; }
function lpad(s: string, w: number): string { const n = width(s); return n >= w ? s : s + " ".repeat(w - n); }
function exprText(cs: Clause[]): string { const o: string[] = []; for (const c of cs) { const vs: string[] = []; for (const v of c.vals) vs.push(shown(c.key, v)); o.push(printClause({ key: c.key, op: c.op, vals: vs, neg: c.neg, pinned: false })); } return o.join(" and "); }
function text(c: Cmp, scope: Clause[], tty: boolean): void {
  const col = (s: string, k: string): string => tty ? fg(k) + s + RST : s;
  const head = (g: Group): string => g.single ? g.label + "  (" + exprText(g.cs) + ")" : exprText(g.cs);
  out("A: " + head(c.A)); out("B: " + head(c.B));
  out(col("subagents " + (c.subs ? "incl." : "excl.") + (scope.length ? " · scope: " + exprText(scope) : ""), C.dim));
  if (c.emptyA || c.emptyB) out(col((c.emptyA ? "group A" : "group B") + " matched nothing: " + exprText(c.emptyA ? c.A.cs : c.B.cs), C.yellow));
  let lw = 5; let aw = 1; let bw = 1; let dw = 1;
  for (const m of c.rows) { lw = Math.max(lw, width(m.label)); aw = Math.max(aw, width(m.a)); bw = Math.max(bw, width(m.b)); dw = Math.max(dw, width(m.d)); }
  aw = Math.min(aw, 40); bw = Math.min(bw, 40);
  out("");
  out(col(lpad("", lw) + "  " + rpad("A", aw) + "  " + rpad("B", bw) + "  " + rpad("Δ", dw) + "  " + "B/A", C.dim));
  for (const m of c.rows) {
    const d = rpad(m.d, dw);
    out(lpad(m.label, lw) + "  " + rpad(m.a, aw) + "  " + rpad(m.b, bw) + "  " + (m.tone > 0 ? col(d, C.red) : m.tone < 0 ? col(d, C.green) : d) + "  " + m.r);
  }
  const tr = toolRows(c, new Set<string>()); if (!tr.rows.length) return;
  out("");
  out(col("tools" + (tr.significance ? " · ● share differs (χ² ≥ 6.63)" : " · small samples, no significance"), C.dim));
  let tw = 4; for (const r of tr.rows.slice(0, 15)) tw = Math.min(30, Math.max(tw, width(shown("tool", r.label))));
  out(col(lpad("tool", tw) + "  " + rpad("calls A", 7) + "  " + rpad("calls B", 7) + "  " + rpad("share A", 7) + "  " + rpad("share B", 7) + "  " + rpad("Δpp", 7) + "  " + rpad("err A", 6) + "  " + rpad("err B", 6), C.dim));
  for (const r of tr.rows.slice(0, 15)) {
    const pp = (r.dpp > 0 ? "+" : r.dpp < 0 ? "−" : "") + Math.abs(r.dpp).toFixed(1);
    const er = (n: number, e: number): string => n > 0 ? ((e / n) * 100).toFixed(0) + "%" : "–";
    out(lpad((r.server ? "⧉ " : "") + shown("tool", r.label), tw) + "  " + rpad(String(r.nA), 7) + "  " + rpad(String(r.nB), 7) + "  " + rpad((r.shA * 100).toFixed(1) + "%", 7) + "  " + rpad((r.shB * 100).toFixed(1) + "%", 7) + "  " +
      rpad(pp, 7) + "  " + rpad(er(r.nA, r.errA), 6) + "  " + rpad(er(r.nB, r.errB), 6) + (r.sig ? "  ●" : ""));
  }
}

function compare(args: string[]): void {
  S.cli = true;
  const o = parseArgs(args);
  discover(); // session ids resolve against the scanned sessions
  for (const f of o.filters) cliFilter([f], "", false, false, false);
  let scope: Clause[] = []; for (const f of o.filters) scope = addAll(scope, parse(f).cs).cs;
  const A = o.pos.length ? sessGroup(o.pos[0] ?? "") : exprGroup(o.a);
  const B = o.pos.length ? sessGroup(o.pos[1] ?? "") : exprGroup(o.b);
  const fa = compile(groupClauses(A, scope, o.subs), "json").f; const fb = compile(groupClauses(B, scope, o.subs), "json").f;
  if (fa && fb && fa.key === fb.key) fail("A and B are the same");
  completeFor(A, scope, o.subs); completeFor(B, scope, o.subs);
  const c = compareGroups(A, B, scope, o.subs, null);
  if (o.json) out(process.stdout.isTTY ? JSON.stringify(toJson(c), null, 2) : JSON.stringify(toJson(c)));
  else text(c, scope, !!process.stdout.isTTY);
  for (const f of H.onQuit) f(); // the groups' sessions were indexed: keep that work for the next run
  process.exit(0);
}

H.cli.unshift((args: string[]): boolean => { // before cli.ts's flag handlers: `compare --json` is this command's flag
  if (args[0] !== "compare") return false;
  compare(args);
  return true;
});
