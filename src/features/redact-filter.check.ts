// agentglass — self-check for filters under --redact: scriptc build src/features/redact-filter.check.ts -o rfc && AGENTGLASS_REDACT=1 ./rfc
// SPDX-License-Identifier: Apache-2.0
// Filters match the REAL values (a pin saved without --redact keeps matching), the screen shows the fakes. cwd, branch
// and repo also match the session's own shown fake, exactly (a value taken off the redacted screen, e.g. a triage
// include), never by ~ (fake titles and branches come from shared pools: a typed word would hit unrelated sessions).
import type { Sess } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { HOME } from "../util/fs.ts";
import { applyMeta } from "../hooks.ts";
import { REDACT } from "./redact.ts";
import { parse } from "./query/parse.ts";
import { compile, matchSession } from "./query/eval.ts";

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
console.log(bad ? bad + " failed" : "redact filters: all checks passed");
process.exit(bad ? 1 : 0);
