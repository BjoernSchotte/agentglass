// agentglass — self-check for pins and subagent names under --redact: scriptc build src/features/redact-pins.check.ts -o rpc && AGENTGLASS_REDACT=1 ./rpc
// SPDX-License-Identifier: Apache-2.0
// Pinned values come back from the config on every start: shown as "…" (filters still match the real ones), a masked
// pin can be kept or deleted in the P editor but not edited. User-defined subagent names get stable same-length fakes,
// built-in agent types stay.
import type { Sess } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { S } from "../state.ts";
import { HOME } from "../util/fs.ts";
import { applyMeta, display, screenOut } from "../hooks.ts";
import { REDACT, scrubText, fakeAgent } from "./redact.ts";
import { parse, print } from "./query/parse.ts";
import { compile, matchSession } from "./query/eval.ts";
import { type PinStore, initPins, setPins, pinAll, setLocal, chipText, pinsText, shownClause } from "./query/scope.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": " + JSON.stringify(got)); } }
ok("active", REDACT, "set AGENTGLASS_REDACT=1");
function m(src: string, x: Sess): string { const p = parse(src); if (p.err) return "ERR " + p.err.msg; const r = compile(p.cs, "list"); return r.f ? String(matchSession(r.f, x, null)) : "ERR"; }

// ── pins restored from the config ──
let saved = "";
const store: PinStore = { load: () => "title ~ \"payment refactor\" and harness is claude and cost > 2 and cwd ~ ~/code/secretproj and tool is Bash and agent is_one_of Explore my-reviewer", save: (v: string) => { saved = v; }, remember: true };
const toast = initPins(store);
const LEAKS = ["payment", "refactor", "secretproj", "my-reviewer"];
function clean(what: string, t: string): void { for (const w of LEAKS) ok(what + " hides " + w, t.toLowerCase().indexOf(w) < 0, t); }
clean("toast", toast);
ok("toast: masked title", toast.indexOf("title ~ …") >= 0, toast);
ok("toast: masked cwd", toast.indexOf("cwd ~ …") >= 0, toast);
ok("toast: enums, numbers, built-in tool and agent stay", toast.indexOf("harness is claude") >= 0 && toast.indexOf("cost > 2") >= 0 && toast.indexOf("tool is Bash") >= 0 && toast.indexOf("agent is_one_of Explore …") >= 0, toast);
clean("chips", chipText(S.pins));
ok("pins stay real", print(S.pins).indexOf("payment refactor") >= 0 && print(S.pins).indexOf("~/code/secretproj") >= 0, print(S.pins));
ok("display masks a pinned value", display("filter:title", "payment refactor", null) === "…", display("filter:title", "payment refactor", null));
ok("display: an unpinned title is not masked", display("filter:title", "other words", null) !== "…", "");

// the pin still filters on the real value
const s = newSess("claude", "11111111-aaaa", "/tmp/p1.jsonl", false);
s.cwd = HOME + "/code/secretproj"; s.title = "Payment refactor for checkout"; applyMeta(s);
ok("session faked", s.title.toLowerCase().indexOf("payment") < 0, s.title);
ok("pinned title matches the real one", m("title ~ \"payment refactor\"", s) === "true", s.title);

// ── the P editor ──
const ed = pinsText();
clean("editor text", ed);
ok("editor text is masked", ed.indexOf("title ~ …") >= 0, ed);
saved = "";
ok("unchanged masked text keeps the real pins", setPins(ed) === null && print(S.pins).indexOf("payment refactor") >= 0 && print(S.pins).indexOf("my-reviewer") >= 0, print(S.pins));
ok("saved real values", saved.indexOf("payment refactor") >= 0, saved);
const e1 = setPins(ed.split("title ~ …").join("title ~ …x"));
ok("editing a masked value is refused", e1 !== null && e1.msg.indexOf("leave --redact to edit this pin") >= 0, e1 ? e1.msg : "null");
ok("refused edit keeps the pins", print(S.pins).indexOf("payment refactor") >= 0, print(S.pins));
const e2 = setPins(ed.split("cost > 2").join("cost > 5"));
ok("editing a visible part keeps masked ones real", e2 === null && print(S.pins).indexOf("payment refactor") >= 0 && print(S.pins).indexOf("cost > 5") >= 0, print(S.pins));
const e3 = setPins("harness is claude and title ~ …");
ok("deleting clauses works", e3 === null && print(S.pins) === "harness is claude and title ~ \"payment refactor\"", print(S.pins));
const e4 = setPins("branch is …");
ok("a … with no pin behind it is refused", e4 !== null, e4 ? e4.msg : "null");

// p: a local clause pinned this run is masked like a restored one; merge notes masked too
setLocal("Sessions", parse("title ~ secretword and repo is acmecorp").cs);
const pt = pinAll("Sessions");
ok("p toast masks", pt.indexOf("secretword") < 0 && pt.indexOf("acmecorp") < 0 && pt.indexOf("title ~ …") >= 0, pt);
ok("shownClause masks", shownClause(parse("repo is acmecorp").cs[0]).indexOf("acmecorp") < 0, shownClause(parse("repo is acmecorp").cs[0]));

// ── subagent names ──
const c1 = newSess("claude", "22222222-bbbb", "/tmp/c1.jsonl", false); c1.parent = "11111111-aaaa"; c1.kind = "acme-billing-auditor"; applyMeta(c1);
const k1 = c1.kind;
ok("custom agent faked", k1 !== "acme-billing-auditor" && k1.length === "acme-billing-auditor".length, k1);
const c2 = newSess("claude", "33333333-cccc", "/tmp/c2.jsonl", false); c2.parent = "11111111-aaaa"; c2.kind = "acme-billing-auditor"; applyMeta(c2);
ok("same fake per real name", c2.kind === k1, c2.kind);
const c3 = newSess("claude", "44444444-dddd", "/tmp/c3.jsonl", false); c3.parent = "11111111-aaaa"; c3.kind = "zz-secret-helper"; applyMeta(c3);
ok("another name, another fake", c3.kind !== k1 && c3.kind !== "zz-secret-helper", c3.kind);
for (const [h, k] of [["claude", "Explore"], ["claude", "general-purpose"], ["claude", "Plan"], ["claude", "statusline-setup"], ["gemini", "codebase_investigator"], ["gemini", "generalist"], ["gemini", "cli_help"], ["opencode", "general"], ["opencode", "explore"], ["codex", "explorer"], ["codex", "worker"], ["pi", "scout"], ["kiro", "subagent"]]) {
  const b = newSess(h, "55555555-" + k, "/tmp/b-" + h + k + ".jsonl", false); b.parent = "11111111-aaaa"; b.kind = k; applyMeta(b);
  ok("built-in kept: " + h + " " + k, b.kind === k, b.kind);
}
const g = newSess("gemini", "66666666-eeee", "/tmp/g.jsonl", false); g.parent = "11111111-aaaa"; g.kind = "acme_ticket_triager"; applyMeta(g);
ok("gemini custom agent faked", g.kind !== "acme_ticket_triager", g.kind);
c1.kind = "acme-billing-auditor"; applyMeta(c1); ok("re-parsed kind faked again", c1.kind === k1, c1.kind);
ok("filter: the real agent name matches", m("agent is acme-billing-auditor", c1) === "true", c1.kind);
ok("filter: the own fake matches exactly", m("agent is " + k1, c1) === "true", k1);
ok("filter: a bare word finds the real name", m("billing", c1) === "true", "");
ok("fakeAgent stable", fakeAgent("acme-billing-auditor") === k1 && fakeAgent("Explore") === "Explore", fakeAgent("acme-billing-auditor"));
ok("scrubber swaps the name on screen", scrubText("invoke acme_ticket_triager now").indexOf("acme_ticket_triager") < 0 && screenOut("⑂ acme-billing-auditor").indexOf("acme-billing") < 0, scrubText("invoke acme_ticket_triager now"));
const cp = newSess("claude", "77777777-ffff", "/tmp/cp.jsonl", false); cp.parent = "11111111-aaaa"; cp.kind = "providers"; applyMeta(cp);
ok("a plain-word name inside a team subagent id", scrubText("agent-aproviders-36784878b70cbf7c.jsonl").indexOf("providers") < 0, scrubText("agent-aproviders-36784878b70cbf7c.jsonl"));
ok("inside a team subagent id", scrubText("agent-aacme-billing-auditor-38c013df92a65487.jsonl").indexOf("billing") < 0, scrubText("agent-aacme-billing-auditor-38c013df92a65487.jsonl"));
ok("a tool named after the agent", display("tool", "acme_ticket_triager", null) === g.kind && display("tool", "Bash", null) === "Bash", display("tool", "acme_ticket_triager", null));
ok("triage/compare dims show the fake", display("filter:agent", c1.kind, null) === k1, display("filter:agent", c1.kind, null));
console.log(bad ? bad + " failed" : "redact pins and agents: all checks passed");
process.exit(bad ? 1 : 0);
