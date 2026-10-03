// agentglass — self-check for git linkage scraping: scriptc build src/features/usage/vcs.check.ts -o vc && ./vc
// SPDX-License-Identifier: Apache-2.0
import { prefilter, unesc, banners, forgeUrls, isBannerCmd, isGitCall, createdBy, scrape, addRef, MAX_REFS } from "./vcs.ts";
import { type Acc, newAcc, bucket, tool, pend } from "./record.ts";
import { done } from "./calls.ts";
import { accOut, accIn } from "./codec.ts";
import { MQ_MSG } from "./facts.ts";
import { harnessOf } from "../../harness/index.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function yes(what: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + what); } }

// ── prefilter: ordinary lines miss, banner and forge-URL lines hit ──
const plain = [
  "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Done, the tests pass.\"}]}}",
  "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_9\",\"content\":\"a.ts\\nb.ts\\nREADME.md\"}]}}",
  "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_8\",\"content\":\"     1\\timport x from './y';\\n     2\\texport const z = 1;\"}]}}",
  "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_7\",\"name\":\"Read\",\"input\":{\"file_path\":\"/r/src/a.ts\"}}]}}",
  "{\"timestamp\":\"2026-10-02T10:00:00Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"reasoning\",\"summary\":[]}}",
  "{\"type\":\"progress\",\"data\":{\"type\":\"hook_progress\"}}",
  "{\"type\":\"user\",\"message\":{\"content\":\"please fix the build\"}}",
  "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":90}}}",
  "{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"PASS src/a.test.ts (3 tests)\"}]}}",
  "{\"type\":\"summary\",\"summary\":\"Refactor the parser\"}",
];
for (let i = 0; i < plain.length; i++) yes("prefilter rejects plain line " + String(i), !prefilter(plain[i] ?? ""));
yes("prefilter banner", prefilter("{\"content\":\"[main 0ec883d] one\\n 1 file changed, 1 insertion(+)\"}"));
yes("prefilter PR URL", prefilter("{\"content\":\"https://github.com/o/r/pull/12\"}"));
yes("prefilter escaped URL", prefilter("{\"content\":\"https:\\/\\/github.com\\/o\\/r\\/issues\\/5\"}"));

// ── unesc ──
eq("unesc slashes", unesc("https:\\/\\/github.com\\/o\\/r\\/pull\\/1"), "https://github.com/o/r/pull/1");
eq("unesc newline quote backslash", unesc("a\\nb\\\"c\\\\n"), "a\nb\"c\\n");

// ── banners ──
function bstr(t: string): string { const o: string[] = []; for (const b of banners(t)) o.push(b.br + "|" + b.sha + "|" + b.subj); return o.join(";"); }
eq("banner plain", bstr("[main 0ec883d] one\n 1 file changed"), "main|0ec883d|one");
eq("banner root", bstr("[main (root-commit) abc1234] x"), "main|abc1234|x");
eq("banner detached", bstr("[detached HEAD abc1234] y"), "|abc1234|y");
eq("banner not at line start", bstr("x [main abc1234] y"), "");
eq("banner after a JSON quote", bstr("{\"content\":\"[feat/x 1234567] add \"thing\" here"), "feat/x|1234567|add");
const capped = banners("[main abcdef1] " + "s".repeat(200));
eq("banner subject capped", String(capped.length ? capped[0].subj.length : 0), "80");
eq("banner needs hex sha", bstr("[main zzzzzzz] no"), "");

// ── forge URLs ──
function ustr(t: string): string { const o: string[] = []; for (const u of forgeUrls(t)) o.push(u.k + " " + String(u.n) + " " + u.url + (u.sha ? " " + u.sha : "")); return o.join(";"); }
eq("github pr + suffix + punctuation", ustr("see https://github.com/o/r/pull/12/files)."), "pr 12 https://github.com/o/r/pull/12");
eq("pull/new is no PR", ustr("https://github.com/o/r/pull/new/feat"), "");
eq("gitlab nested MR", ustr("https://gitlab.com/g/sub/p/-/merge_requests/7#note_1"), "pr 7 https://gitlab.com/g/sub/p/-/merge_requests/7");
eq("bitbucket PR", ustr("https://bitbucket.org/o/r/pull-requests/3"), "pr 3 https://bitbucket.org/o/r/pull-requests/3");
eq("gitea PR", ustr("https://gitea.example.com/o/r/pulls/9"), "pr 9 https://gitea.example.com/o/r/pulls/9");
eq("issue", ustr("https://github.com/o/r/issues/5"), "issue 5 https://github.com/o/r/issues/5");
eq("gitlab issue", ustr("https://gitlab.com/g/p/-/issues/5"), "issue 5 https://gitlab.com/g/p/-/issues/5");
const sha40 = "0123456789abcdef0123456789abcdef01234567";
eq("commit url", ustr("https://github.com/o/r/commit/" + sha40), "commit 0 https://github.com/o/r/commit/" + sha40 + " " + sha40);
eq("bitbucket commits url", ustr("https://bitbucket.org/o/r/commits/abc1234>"), "commit 0 https://bitbucket.org/o/r/commits/abc1234 abc1234");
eq("host case-insensitive", ustr("HTTPS://GitHub.com/o/r/pull/4"), "pr 4 https://github.com/o/r/pull/4");
const cred = ustr("https://x-access-token:ghs_SECRET@github.com/o/r/pull/3");
eq("credentials scrubbed", cred, "pr 3 https://github.com/o/r/pull/3");
yes("no secret kept", cred.indexOf("ghs_SECRET") < 0);
eq("query token dropped", ustr("https://github.com/o/r/pull/3?token=abc"), "pr 3 https://github.com/o/r/pull/3");
eq("token-shaped path dropped", ustr("https://github.com/ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/r/pull/3"), "");
eq("escaped JSON URL", ustr(unesc("https:\\/\\/github.com\\/o\\/r\\/issues\\/5")), "issue 5 https://github.com/o/r/issues/5");
eq("non-http scheme ignored", ustr("ssh://github.com/o/r/pull/3"), "");
eq("two urls", ustr("https://github.com/o/r/pull/1 and https://github.com/o/r/issues/2"), "pr 1 https://github.com/o/r/pull/1;issue 2 https://github.com/o/r/issues/2");

// ── command classes ──
yes("cat is no banner cmd", !isBannerCmd("cat log.txt"));
yes("git log is no banner cmd", !isBannerCmd("git log"));
yes("git log --grep commit is no banner cmd", !isBannerCmd("git log --grep commit"));
yes("git commit is a banner cmd", isBannerCmd("git commit -m x"));
yes("git -C dir commit", isBannerCmd("cd /x && git -C ../other commit -am y"));
yes("git cherry-pick / revert / merge", isBannerCmd("git cherry-pick abc") && isBannerCmd("git revert HEAD") && isBannerCmd("git merge f"));
yes("chained add && commit", isBannerCmd("git add -A && git commit -m \"feat: a; b\""));
yes("git commit --quiet is a git call", isGitCall("git commit --quiet -m q"));
yes("git am / rebase are git calls", isGitCall("git am x.patch") && isGitCall("git rebase main"));
yes("git amend-notes is no git call", !isGitCall("git amend-notes"));
yes("git status is no git call", !isGitCall("git status"));
yes("gh pr create", createdBy("gh pr create --fill", "Bash"));
yes("mcp create_pull_request", createdBy("", "mcp__github__create_pull_request"));
yes("gh pr view is no create", !createdBy("gh pr view 3", "Bash"));
yes("glab mr / tea prs / issue create", createdBy("glab mr create", "") && createdBy("tea prs create", "") && createdBy("gh issue create -t x", "") && createdBy("hub pull-request", ""));

// ── scraping in the ledger pass, per harness (hand-written lines in each adapter's real shape) ──
function feed(h: string, ls: string[]): Acc { const a = newAcc(); const ad = harnessOf(h); for (const l of ls) { ad.usage(a, l); scrape(a, l); } return a; }
function refs(a: Acc): string { const o: string[] = []; for (const r of a.vcs) o.push(r.k + ":" + (r.k === "gcall" ? "span" : r.v) + ":" + r.how + (r.call ? "@" + r.call : "")); return o.join(" "); }
function claudeUse(id: string, cmd: string, t: string): string {
  return "{\"parentUuid\":\"p0\",\"type\":\"assistant\",\"message\":{\"id\":\"msg_" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"Bash\",\"input\":{\"command\":" + JSON.stringify(cmd) + "}}],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}},\"uuid\":\"a1\",\"timestamp\":\"2026-10-02T10:00:" + t + ".000Z\"}";
}
function claudeRes(id: string, out: string, t: string): string {
  return "{\"parentUuid\":\"a1\",\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"tool_use_id\":\"" + id + "\",\"type\":\"tool_result\",\"content\":" + JSON.stringify(out) + ",\"is_error\":false}]},\"uuid\":\"u1\",\"timestamp\":\"2026-10-02T10:00:" + t + ".000Z\",\"toolUseResult\":{\"stdout\":" + JSON.stringify(out) + "}}";
}
const BAN = "[main 0ec883d] one\n 1 file changed, 1 insertion(+)";
let a = feed("claude", [claudeUse("toolu_1", "git add -A && git commit -m one", "01"), claudeRes("toolu_1", BAN, "03")]);
eq("claude banner + gcall", refs(a), "commit:0ec883d:observed@toolu_1 gcall:span:observed@toolu_1");
const gc = a.vcs.length > 1 ? a.vcs[1].v : "";
eq("gcall span from call start to result", gc, String(Date.parse("2026-10-02T10:00:01.000Z")) + "-" + String(Date.parse("2026-10-02T10:00:03.000Z")));
eq("banner branch + subject", a.vcs.length ? a.vcs[0].br + "|" + a.vcs[0].subj + "|" + a.vcs[0].ts : "", "main|one|2026-10-02T10:00:01.000Z");
eq("same text after cat: no commit", refs(feed("claude", [claudeUse("toolu_2", "cat out.txt", "01"), claudeRes("toolu_2", BAN, "02")])), "");
eq("same text after git log: no commit", refs(feed("claude", [claudeUse("toolu_3", "git log -1", "01"), claudeRes("toolu_3", BAN, "02")])), "");
eq("quiet commit: span only", refs(feed("claude", [claudeUse("toolu_4", "git commit --quiet -m q", "01"), claudeRes("toolu_4", "", "05")])), "gcall:span:observed@toolu_4");
eq("empty commit banner without 'changed'", refs(feed("claude", [claudeUse("toolu_5", "git commit --allow-empty -m e", "01"), claudeRes("toolu_5", "[main e43b754] e", "02")])), "commit:e43b754:observed@toolu_5 gcall:span:observed@toolu_5");
// codex: function_call + function_call_output (nested JSON output text in older versions)
a = feed("codex", [
  "{\"timestamp\":\"2026-10-02T10:00:01.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"arguments\":\"{\\\"command\\\":[\\\"bash\\\",\\\"-lc\\\",\\\"git commit -am c\\\"]}\",\"call_id\":\"call_c1\"}}",
  "{\"timestamp\":\"2026-10-02T10:00:02.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_c1\",\"output\":\"{\\\"output\\\":\\\"[main 1234abc] c\\\\n 2 files changed, 3 insertions(+)\\\\n\\\",\\\"metadata\\\":{\\\"exit_code\\\":0}}\"}}",
]);
eq("codex nested output", refs(a), "commit:1234abc:observed@call_c1 gcall:span:observed@call_c1");
// kiro: toolUse + ToolResults by toolUseId (no per-call time: no span)
a = feed("kiro", [
  "{\"version\":\"v1\",\"kind\":\"AssistantMessage\",\"data\":{\"message_id\":\"m1\",\"content\":[{\"kind\":\"toolUse\",\"data\":{\"toolUseId\":\"t1\",\"name\":\"execute_bash\",\"input\":{\"command\":\"git commit -m k\"}}}]}}",
  "{\"version\":\"v1\",\"kind\":\"ToolResults\",\"data\":{\"message_id\":\"m2\",\"content\":[{\"kind\":\"toolResult\",\"data\":{\"toolUseId\":\"t1\",\"status\":\"success\",\"content\":[{\"kind\":\"text\",\"data\":\"[main 5555aaa] k\\n 1 file changed, 1 insertion(+)\"}]}}]}}",
]);
eq("kiro by toolUseId", refs(a), "commit:5555aaa:observed@t1");
// fx: tool_call + tool_result by call_id
a = feed("fx", [
  "{\"seq\":1,\"timestamp_ms\":1791000000000,\"event\":{\"tool_call\":{\"tool_name\":\"shell\",\"call_id\":\"c1\",\"arguments_json\":\"{\\\"command\\\":\\\"git commit -m f\\\"}\"}}}",
  "{\"seq\":2,\"timestamp_ms\":1791000002000,\"event\":{\"tool_result\":{\"call_id\":\"c1\",\"status\":\"success\",\"output_bytes\":40,\"output\":\"[main 6666bbb] f\\n 1 file changed\"}}}",
]);
eq("fx by call_id", refs(a), "commit:6666bbb:observed@c1 gcall:span:observed@c1");
// pi: toolCall + toolResult by toolCallId
a = feed("pi", [
  "{\"type\":\"message\",\"timestamp\":\"2026-10-02T10:00:01.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"toolCall\",\"id\":\"p1\",\"name\":\"bash\",\"arguments\":{\"command\":\"git commit -m p\"}}],\"model\":\"m\",\"stopReason\":\"toolUse\"}}",
  "{\"type\":\"message\",\"timestamp\":\"2026-10-02T10:00:02.000Z\",\"message\":{\"role\":\"toolResult\",\"toolCallId\":\"p1\",\"toolName\":\"bash\",\"content\":[{\"type\":\"text\",\"text\":\"[main 7777ccc] p\\n 1 file changed\"}]}}",
]);
eq("pi by toolCallId", refs(a), "commit:7777ccc:observed@p1 gcall:span:observed@p1");
// gemini: call and result in one record
a = feed("gemini", ["{\"id\":\"m2\",\"timestamp\":\"2026-10-02T10:00:01.000Z\",\"type\":\"gemini\",\"content\":\"\",\"model\":\"gemini-2.5-pro\",\"toolCalls\":[{\"id\":\"g1\",\"name\":\"run_shell_command\",\"args\":{\"command\":\"git commit -m g\"},\"result\":[{\"functionResponse\":{\"id\":\"g1\",\"name\":\"run_shell_command\",\"response\":{\"output\":\"[main 8888ddd] g\\n 1 file changed\"}}}],\"status\":\"success\",\"timestamp\":\"2026-10-02T10:00:04.000Z\"}]}"]);
eq("gemini same record", refs(a), "commit:8888ddd:observed@g1 gcall:span:observed@g1");
// OpenCode-style record with its own command field and no closed call (adapter-independent fallback)
a = newAcc(); scrape(a, "{\"type\":\"tool\",\"state\":{\"input\":{\"command\":\"git commit -m x\"},\"output\":\"[main 9999eee] x\\n 1 file changed, 2 insertions(+)\\n\"}}");
eq("same-line command field", refs(a), "commit:9999eee:observed");
a = newAcc(); scrape(a, "{\"type\":\"tool\",\"state\":{\"input\":{\"command\":\"cat x\"},\"output\":\"[main 9999eee] x\\n 1 file changed, 2 insertions(+)\\n\"}}");
eq("same-line cat", refs(a), "");

// ── created vs mentioned, dedup, upgrade, cap ──
a = feed("claude", [claudeUse("toolu_6", "gh pr create --fill", "01"), claudeRes("toolu_6", "https://github.com/o/r/pull/12\n", "02"),
  claudeUse("toolu_7", "gh pr view 12", "03"), claudeRes("toolu_7", "title: x\nurl: https://github.com/o/r/pull/12", "04")]);
eq("created PR, later view keeps it", refs(a), "pr:https://github.com/o/r/pull/12:created@toolu_6");
a = feed("claude", [claudeUse("toolu_8", "gh pr list", "01"), claudeRes("toolu_8", "https://github.com/o/r/pull/13", "02"),
  claudeUse("toolu_9", "gh pr create -t y", "03"), claudeRes("toolu_9", "https://github.com/o/r/pull/13", "04")]);
eq("mentioned upgraded to created", refs(a), "pr:https://github.com/o/r/pull/13:created@toolu_9");
a = newAcc(); scrape(a, "{\"text\":\"PR https://github.com/o/r/pull/14 by MCP\"}");
eq("assistant text is mentioned", refs(a), "pr:https://github.com/o/r/pull/14:mentioned");
a = newAcc();
{ const d = bucket(a, 0, "2026-10-02T10:00:00.000Z"); const st = tool(a, d, "mcp__github__create_pull_request", "m", MQ_MSG); pend(a, d, st, "mcp__github__create_pull_request", "mc1", 1, "", "{}", []);
  const p = a.pend.get("mc1"); if (p) { a.pend.delete("mc1"); done(p, 5, false, 0, "mc1", []); }
  scrape(a, "{\"tool_use_id\":\"mc1\",\"content\":\"{\\\"html_url\\\":\\\"https:\\\\/\\\\/github.com\\\\/o\\\\/r\\\\/pull\\\\/15\\\"}\"}"); }
eq("MCP create tool + escaped URL", refs(a), "pr:https://github.com/o/r/pull/15:created@mc1");
a = newAcc(); scrape(a, "{\"content\":\"https:\\/\\/github.com\\/o\\/r\\/issues\\/5\"}");
eq("escaped issue URL in raw JSON", refs(a), "issue:https://github.com/o/r/issues/5:mentioned");
a = newAcc();
for (let i = 0; i < 210; i++) { addRef(a, { k: "pr", v: "https://h.io/o/r/pull/" + String(i), t: i, how: "mentioned", br: "", subj: "", call: "", ts: "" }); if (i === 5) addRef(a, { k: "pr", v: "https://h.io/o/r/pull/c", t: i, how: "created", br: "", subj: "", call: "", ts: "" }); }
let kept = false; for (const r of a.vcs) if (r.how === "created") kept = true;
eq("cap", String(a.vcs.length), String(MAX_REFS)); yes("cap keeps the created ref", kept);
yes("cap drops the oldest mentioned", a.vcs.length > 0 && a.vcs[0].v !== "https://h.io/o/r/pull/0");

// ── persistence round trip ──
a = feed("claude", [claudeUse("toolu_1", "git commit -m one", "01"), claudeRes("toolu_1", BAN + "\nhttps://github.com/o/r/pull/12", "03")]);
const back = accIn(JSON.parse(JSON.stringify(accOut(a, 64))));
eq("round trip refs", refs(back), refs(a));
function full(x: Acc): string { const o: string[] = []; for (const r of x.vcs) o.push([r.k, r.v, String(r.t), r.how, r.br, r.subj, r.call, r.ts].join("|")); return o.join(" "); }
eq("round trip fields", full(back), full(a));
yes("round trip keeps t0", back.t0 === a.t0 && a.t0 > 0);

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("vcs ok");
