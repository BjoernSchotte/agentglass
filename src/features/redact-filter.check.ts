// agentglass — self-check for filters under --redact: scriptc build src/features/redact-filter.check.ts -o rfc && AGENTGLASS_REDACT=1 ./rfc
// SPDX-License-Identifier: Apache-2.0
// Filters match the REAL values (a pin saved without --redact keeps matching), the screen shows the fakes. cwd, branch
// and repo also match the session's own shown fake, exactly (a value taken off the redacted screen, e.g. a triage
// include), never by ~ (fake titles and branches come from shared pools: a typed word would hit unrelated sessions).
import type { Ev, Sess } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { HOME } from "../util/fs.ts";
import { H, applyMeta, display } from "../hooks.ts";
import { REDACT } from "./redact.ts";
import { parse } from "./query/parse.ts";
import { compile, matchSession, callVal } from "./query/eval.ts";
import { DICT, intern } from "./usage/facts.ts";
import { EXACT } from "./query/types.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": " + JSON.stringify(got)); } }
ok("active", REDACT, "set AGENTGLASS_REDACT=1");
function m(x: Sess, src: string): string { const p = parse(src); if (p.err) return "ERR " + p.err.msg; const r = compile(p.cs, "list"); return r.f ? String(matchSession(r.f, x, null)) : "ERR " + (r.err ? r.err.msg : ""); }

// a session with a harness title, a branch, a cwd
const s = newSess("claude", "11111111-2222", "/tmp/x.jsonl", false);
s.cwd = HOME + "/code/secretproj/src"; s.title = "Fix the thing for ACME"; s.branch = "acme/login";
applyMeta(s);
const t1 = s.title; const c1 = s.cwd; const b1 = s.branch;
ok("faked", t1 !== "Fix the thing for ACME" && c1.indexOf("secretproj") < 0 && b1.startsWith("feat/"), t1 + " " + c1 + " " + b1);
ok("real title", m(s, "title ~ \"thing for acme\"") === "true", t1);
ok("fake title: no", m(s, "title is \"" + t1 + "\"") === "false", t1);
ok("real cwd", m(s, "cwd is ~/code/secretproj/src") === "true", c1);
ok("own fake cwd, exact", m(s, "cwd is \"" + c1 + "\"") === "true", c1);
ok("own fake cwd, never by ~", m(s, "cwd ~ \"" + c1.slice(-12) + "\"") === "false", c1);
ok("real branch", m(s, "branch is acme/login") === "true", b1);
ok("own fake branch, exact", m(s, "branch is \"" + b1 + "\"") === "true", b1);
ok("own fake branch, never by ~", m(s, "branch ~ \"" + b1.slice(5, 10) + "\"") === "false", b1);
ok("other branch", m(s, "branch is main") === "false", b1);
ok("bare word: real title", m(s, "acme") === "true", "");
ok("bare word: real cwd segment", m(s, "secretproj") === "true", "");
// parsing writes the real values again before the next H.meta: still the real ones
s.title = "Fix the thing for ACME"; ok("fresh real title", m(s, "title ~ acme") === "true", "");
applyMeta(s); ok("faked again, still matches real", s.title === t1 && m(s, "title ~ acme") === "true", s.title);
// a second top-level session titled by its first prompt (pi, Gemini): the prompt is kept real before H.events fakes
// its event, then the faked text comes back as s.prompt and H.meta fakes the rest
const s2 = newSess("pi", "33333333-4444", "/tmp/y.jsonl", false);
s2.cwd = HOME + "/code/otherproj";
const evs: Ev[] = [{ kind: "user", text: "Build a secret todo app", ts: "", id: "", full: "Build a secret todo app" }];
for (const f of H.events) f(s2, evs, 0);
s2.prompt = (evs[0] as Ev).text; applyMeta(s2);
ok("second session faked", s2.cwd.indexOf("otherproj") < 0 && s2.prompt.indexOf("secret") < 0 && s2.prompt !== "", s2.prompt + " " + s2.cwd);
ok("second session: real first prompt", m(s2, "title ~ \"secret todo\"") === "true", s2.prompt);
ok("second session: real cwd", m(s2, "otherproj") === "true", s2.cwd);
ok("second session: the first one's values do not leak into it", m(s2, "acme") === "false" && m(s, "otherproj") === "false", "");
// a private program: the completion offers its shown fake, which selects the call exactly; a safe one stays real
{ const pid = intern(DICT.prog, "deploy-acme-prod"); const gid = intern(DICT.prog, "git");
  const fake = display("prog", "deploy-acme-prod", null);
  ok("program faked", fake !== "deploy-acme-prod" && fake.indexOf("acme") < 0, fake);
  ok("safe program stays", display("prog", "git", null) === "git", display("prog", "git", null));
  const v = callVal("program", s, { t: 0, tool: 0, model: -1, mq: 0, progs: [pid, gid], cmds: [], files: [], ms: 0, err: 0, out: 0, cid: "" }).ss.join(",");
  ok("program values: real, shown fake exact, safe once", v === "deploy-acme-prod," + EXACT + fake.toLowerCase() + ",git", JSON.stringify(v)); }
console.log(bad ? bad + " failed" : "redact filters: all checks passed");
process.exit(bad ? 1 : 0);
