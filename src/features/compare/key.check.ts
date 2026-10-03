// agentglass — self-check for the session filter key: scriptc build src/features/compare/key.check.ts -o kc && ./kc
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { parse, print, printClause } from "../query/parse.ts";
import { compile, matchSession } from "../query/eval.ts";
import { fxReset, fxSession } from "../query/fixture.ts";
import { sessionClause, sessionClauseList, sessionOf } from "./key.ts";

let bad = 0;
function idOf(s: Sess | null): string { return s ? s.id : "none"; }
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }

fxReset();
const a = fxSession("claude", "abc123def", "/w/app", "", "claude-sonnet-4-5", []);
fxSession("claude", "abc123zzz", "/w/app", "", "claude-sonnet-4-5", []);
fxSession("claude", "sub1", "/w/app", "abc123def", "claude-sonnet-4-5", []);
fxSession("codex", "ffffff01", "/w/x", "", "gpt-5", []);
fxSession("codex", "eeeeee", "/w/x", "", "gpt-5", []);
fxSession("codex", "eeeeee77", "/w/x", "", "gpt-5", []);
for (let i = 0; i < 7; i++) fxSession("pi", "dddddd" + String(i), "/w/x", "", "", []);
const ids = (src: string): string => {
  const p = parse(src); if (p.err) return "PARSE " + p.err.msg;
  const r = compile(p.cs, "list"); if (!r.f) return "ERR " + (r.err ? r.err.msg : "");
  const o: string[] = []; for (const s of sessions.values()) if (matchSession(r.f, s, null)) o.push(s.id);
  return o.sort().join(",");
};
eq("exact incl. subagents", ids("session is claude:abc123def"), "abc123def,sub1");
eq("excl. subagents", ids("session is claude:abc123def and subagent is false"), "abc123def");
eq("harness label case", ids("session is CLAUDE:abc123def and subagent is false"), "abc123def");
eq("unique prefix", ids("session is ffffff"), "ffffff01");
eq("ambiguous prefix", ids("session is abc123"), "ERR session \"abc123\" is ambiguous: claude:abc123def, claude:abc123zzz");
eq("exact id beats a longer one it prefixes", ids("session is eeeeee"), "eeeeee");
eq("ambiguous lists at most 5", ids("session is dddddd"), "ERR session \"dddddd\" is ambiguous: pi:dddddd0, pi:dddddd1, pi:dddddd2, pi:dddddd3, pi:dddddd4 +2");
eq("short prefix", ids("session is abc"), "ERR session \"abc\": id prefix needs at least 6 characters");
eq("unknown", ids("session is codex:nope"), "ERR session \"codex:nope\": no such session");
eq("is_not", ids("session is_not claude:abc123def and harness is claude"), "abc123zzz");
eq("is_one_of", ids("session is_one_of claude:abc123zzz ffffff"), "abc123zzz,ffffff01");
eq("no ~", ids("session ~ abc"), "PARSE \"~\" does not apply to session; use is, is_not, is_one_of, is_not_one_of");
eq("canonical after resolve", print(sessionClauseList("session is ffffff")), "session is codex:ffffff01");
eq("clause of a session", printClause(sessionClause(a)), "session is claude:abc123def");
eq("sessionOf", idOf(sessionOf("claude:abc123def")), "abc123def");
eq("sessionOf gone", idOf(sessionOf("claude:gone")), "none");
console.log(bad ? String(bad) + " failed" : "session key: all checks passed");
if (bad) process.exit(1);
