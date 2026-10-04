// agentglass — self-check for attribute values, compile and lifting: scriptc build src/features/query/eval.check.ts -o ec && ./ec
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { accOf } from "../usage/ledger.ts";
import { bucket, tool } from "../usage/record.ts";
import { DICT, nameOf, localOf, MQ_MSG } from "../usage/facts.ts";
import { setCallDaysForTest } from "../usage/callcache.ts";
import { parse, printClause } from "./parse.ts";
import { register } from "./attrs.ts";
import { type Compiled, EMPTY, compile, matchSession, sessMatches, dayMatches, callMatches, eachCall, extend, numOf, weekdayOf, beyondRetention } from "./eval.ts";
import { projectOf, projectRoot } from "./project.ts";
import { real } from "../../model/project.ts";
import { fxBase, pathOf, isoAt } from "./fixture.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function F(src: string, ctx: string): Compiled { const p = parse(src); if (p.err) { eq("parse " + src, p.err.msg, ""); return EMPTY; } const r = compile(p.cs, ctx === "stats" ? "stats" : "list"); return r.f ?? EMPTY; }
function S0(src: string): string {
  const p = parse(src); if (p.err) return "ERR " + p.err.msg;
  const r = compile(p.cs, "list"); if (!r.f) return "ERR " + (r.err ? r.err.msg : "");
  const out: string[] = []; for (const s of sessions.values()) if (matchSession(r.f, s, null)) out.push(s.id);
  return out.sort().join(",");
}

fxBase();
eq("harness", S0("harness is codex"), "x1");
eq("harness label", S0("h is Kiro"), "k1");
eq("repo (basename fallback, no .git on disk)", S0("repo is agentglass"), "c1,c1s");
eq("same-call lifting", S0("tool is Bash and status is error"), "c1");
eq("same-call: error was a Grep, not a Bash", S0("tool is Read and status is error"), "");
eq("model per call", S0("model ~ sonnet and tool is Bash"), "c1");
eq("model per call: x1 never ran Bash", S0("model ~ unpriced and tool is Bash"), "");
eq("model session-level alone", S0("model ~ gpt"), "x1");
eq("model unknown", S0("model is unknown"), "k1");
eq("cost unknown", S0("cost is unknown"), "x1");
eq("numeric never matches unknown", S0("cost < 1000"), "c1,c1s,k1");
eq("not numeric matches unknown", S0("not cost > 1000"), "c1,c1s,k1,x1");
eq("day lifting", S0("day is yesterday"), "c1");
eq("day + call same day", S0("day is yesterday and tool is Bash"), "");
eq("day + call same day (Read)", S0("day is yesterday and tool is Read"), "c1");
eq("duration unknown", S0("tool is Bash and duration is unknown"), "c1");
eq("duration range", S0("duration >= 2s"), "c1,x1");
eq("program", S0("program is npm and status is error"), "x1");
eq("command", S0("command ~ \"git st\""), "x1");
eq("ext", S0("ext is ts"), "c1");
eq("file glob (changed files only: Read books none)", S0("file is *.ts") + "/" + S0("file is *.md"), "c1/");
eq("file glob dir", S0("file is \"/w/**/a.ts\""), "c1");
eq("subagent", S0("subagent is true"), "c1s");
eq("agent", S0("agent is general-purpose"), "c1s");
eq("is_not multi none", S0("tool is_not_one_of Bash Read Grep Edit"), "k1,x1");
eq("text haystack", S0("agentglass"), "c1,c1s");
eq("text negated", S0("-agentglass"), "k1,x1");
eq("error_rate", S0("error_rate > 40%"), "c1s,x1");
eq("errors", S0("errors >= 1"), "c1,c1s,x1");
eq("tools", S0("tools > 2"), "c1");
eq("lines", S0("lines.added is 2"), "c1");
eq("weekday today", S0("weekday is " + ["su", "mo", "tu", "we", "th", "fr", "sa"][new Date().getDay()]), "c1,c1s,k1,x1");
eq("day.tools", S0("day.tools >= 4"), "c1");
eq("status ok on kiro (untimed)", S0("status is ok and duration is unknown"), "k1");
eq("hour", S0("hour is 10"), new Date().getHours() === 10 ? "k1,x1" : "x1"); // kiro rows carry no time: booked now
eq("state", S0("state is ended"), "c1,c1s,k1,x1");
eq("live", S0("live is true"), "");
eq("age", S0("age < 1h"), "c1,c1s,k1,x1");
const fb = F("model ~ sonnet and status is error", "list");
const c1 = sessions.get(pathOf("c1")); const rowsOk: string[] = [];
if (c1) for (const c of accOf(c1).calls) if (callMatches(fb, c1, c)) rowsOk.push(nameOf(DICT.tool, c.tool));
eq("callMatches per row", rowsOk.join(","), "Bash");
eq("sessMatches ignores call clauses", c1 && sessMatches(F("harness is claude and tool is Nope", "list"), c1) ? "yes" : "no", "yes");
const fd = F("day is yesterday and harness is codex", "stats"); const dks: string[] = [];
if (c1) for (const [k, dd] of accOf(c1).days) if (dayMatches(fd, c1, k, dd)) dks.push(k);
eq("dayMatches: day clauses only, ignores session clauses", dks.join(","), localOf(Date.parse(isoAt(1, 9, 0))).day);
eq("dayKeys", fd.dayKeys ? fd.dayKeys.join(",") : "null", localOf(Date.parse(isoAt(1, 9, 0))).day);
eq("no dayKeys without day clauses", F("tool is Bash", "list").dayKeys === null ? "null" : "set", "null");
const each: string[] = []; eachCall(F("program is npm", "stats"), [localOf(Date.now()).day], (s: Sess, c) => { each.push(s.id + ":" + nameOf(DICT.tool, c.tool)); });
eq("eachCall", each.sort().join(","), "x1:exec,x1:shell");
const em: string[] = []; eachCall(F("model ~ sonnet", "stats"), [localOf(Date.parse(isoAt(1, 9, 0))).day], (s: Sess, c) => { em.push(nameOf(DICT.tool, c.tool)); });
eq("eachCall: model per row, day", em.join(","), "Read,Read");
const w = compile(parse("duration > 1s").cs, "watch"); eq("watch rejects duration", w.err ? w.err.msg : "", "--watch: duration is known only after the call's result; filter result events with event is result instead");
const we = compile(parse("tool is Bash and event is tool").cs, "watch"); const wf = we.f ?? EMPTY;
let ev = true; if (c1) for (const p of wf.event) if (!p(c1, "tool", "Bash", "ls")) ev = false;
eq("watch event preds", String(ev) + "/" + String(wf.event.length), "true/2");
let ev2 = true; if (c1) for (const p of wf.event) if (!p(c1, "tool", "Read", "/a")) ev2 = false;
eq("watch event preds reject", String(ev2), "false");
const pw = compile(parse("program is npm").cs, "watch").f ?? EMPTY; let ev3 = true; if (c1) for (const p of pw.event) if (!p(c1, "tool", "Bash", "npm test && ls")) ev3 = false;
eq("watch program from args", String(ev3), "true");
const p = compile(parse("harness is pi and cost > 2").cs, "procs"); eq("procs dims", p.f ? p.f.dimmed.map(printClause).join("|") : "", "cost > 2");
eq("event outside watch", compile(parse("event is tool").cs, "list").err ? "err" : "ok", "err");
// units
eq("units", [numOf("tok", "40k"), numOf("tok", "1.5M"), numOf("size", "100KB"), numOf("size", "1MB"), numOf("dur", "500ms"), numOf("dur", "2m"), numOf("dur", "1h"), numOf("ratio", "20%"), numOf("usd", "$0.50")].join(","), "40000,1500000,102400,1048576,500,120000,3600000,0.2,0.5");
eq("weekdayOf", [weekdayOf("2026-10-03"), weekdayOf("2024-02-29"), weekdayOf("2000-01-01")].join(","), "6,4,6");
// projectOf: a worktree's .git file resolves to the main repo
const TMP = "/tmp/agentglass-eval-check"; rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP + "/mainrepo/.git/worktrees/wt", { recursive: true }); mkdirSync(TMP + "/wt/sub", { recursive: true });
writeFileSync(TMP + "/wt/.git", "gitdir: " + TMP + "/mainrepo/.git/worktrees/wt\n"); writeFileSync(TMP + "/mainrepo/.git/worktrees/wt/commondir", "../..\n");
const WT = TMP + "/wt/sub";
eq("projectOf unresolved = basename", projectOf(WT), "sub");
eq("projectRoot worktree (resolves now, real path: /tmp is /private/tmp on macOS)", projectRoot(WT), real(TMP + "/mainrepo"));
eq("projectOf worktree", projectOf(WT), "mainrepo");
eq("projectOf main", projectOf(TMP + "/mainrepo"), "mainrepo");
eq("projectOf plain", projectOf("/nonexistent/abc"), "abc");
rmSync(TMP, { recursive: true, force: true });
// extension seam: later specs register metadata + behaviour
register({ key: "zz", aliases: [], ent: "session", type: "text", multi: false, enumVals: [], enumFn: "", ops: ["is"] });
extend("zz", { sess: (s: Sess) => ({ n: 0, ss: [s.id === "c1" ? "yes" : "no"], unk: false }), resolve: (v: string) => ({ v: v.toLowerCase(), err: v === "bad" ? "zz: bad value" : "" }) });
eq("extend: accessor + resolve", S0("zz is YES"), "c1");
const zb = compile(parse("zz is bad").cs, "list"); eq("extend: resolve error", zb.err ? zb.err.msg : "", "zz: bad value");
const zo = parse("zz ~ y"); eq("registered ops", zo.err ? zo.err.msg : "", "\"~\" does not apply to zz; use is");
// retention: a 120-day-old row is gone for call clauses, its day bucket stays
if (c1) {
  const a = accOf(c1); const old = Date.now() - 120 * 86400000; const od = bucket(a, old, ""); tool(a, od, "Bash", "claude-sonnet-4-5", MQ_MSG);
  const ok = localOf(old).day; setCallDaysForTest(90);
  eq("retention: rows cut", S0("tool is Bash and day is " + ok), "");
  eq("retention: bucket stays", S0("day is " + ok), "c1");
}
// the "calls ≤ N d" chip: only when the period the view counts reaches before the oldest day that keeps call rows
const cut = "2026-07-06";
eq("7-day period inside retention", String(beyondRetention(null, ["2026-09-28", "2026-10-04"], "2025-01-01", cut)), "false");
eq("period reaching before", String(beyondRetention(null, ["2026-07-01", "2026-10-04"], "2025-01-01", cut)), "true");
eq("all history, old sessions", String(beyondRetention(null, [], "2025-01-01", cut)), "true");
eq("all history, nothing that old", String(beyondRetention(null, [], "2026-09-01", cut)), "false");
eq("all history, empty ledger", String(beyondRetention(null, [], "", cut)), "false");
eq("day clauses inside", String(beyondRetention(["2026-10-01", "2026-10-02"], [], "2025-01-01", cut)), "false");
eq("day clauses before", String(beyondRetention(["2026-01-01", "2026-10-02"], [], "2025-01-01", cut)), "true");
eq("day clauses ∩ period: the old day is outside the period", String(beyondRetention(["2026-01-01", "2026-10-02"], ["2026-09-28", "2026-10-02"], "2025-01-01", cut)), "false");
eq("no day left", String(beyondRetention([], [], "2025-01-01", cut)), "false");
console.log(bad ? bad + " failed" : "filter eval: all checks passed");
if (bad) process.exit(1);
