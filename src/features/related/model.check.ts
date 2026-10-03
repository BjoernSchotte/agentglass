// agentglass — self-check for the related-events model: scriptc build src/features/related/model.check.ts -o rm && ./rm
// SPDX-License-Identifier: Apache-2.0
import type { Ev } from "../../model/types.ts";
import { type RelEv, type RelSt, type Spawn, newSt, shellCmd, fileRef, toRel, markConflicts, clobberCmd, relCfg, KIND_SETS } from "./model.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const T = Date.parse("2026-09-30T14:00:00Z");
function at(s: number): string { return new Date(T + s * 1000).toISOString(); }
function ev(kind: string, text: string, s: number, id: string, full: string): Ev { return { kind, text, ts: s < 0 ? "" : at(s), id, full }; }
function tool(name: string, arg: string, s: number, id: string, full: string): Ev { return ev("tool", name + "\u0000" + arg, s, id, full); }
const W0 = T - 3600000; const W1 = T + 3600000;
function rows(evs: Ev[], sess: string, cwd: string, top: string): RelEv[] { const out: RelEv[] = []; toRel(evs, sess, "claude", cwd, top, true, W0, W1, newSt(), out); return out; }
function show(r: RelEv[]): string { return r.map((x: RelEv) => x.kind + ":" + x.tool + ":" + (x.err ? "err" : "ok")).join(" "); }

// ── kinds, folded results, file refs ──
const edit = [tool("Edit", "/w/main/src/a.ts", 0, "t1", "{\"file_path\":\"/w/main/src/a.ts\",\"old_string\":\"a\\nb\",\"new_string\":\"a\\nb\\nc\"}"), ev("result", "The file /w/main/src/a.ts has been updated.", 1, "t1", "")];
const r1 = rows(edit, "A", "/w/main", "/w/main");
eq("edit: one write row", show(r1), "write:Edit:ok");
eq("edit: file ref", JSON.stringify(r1[0]?.files ?? []), JSON.stringify([{ top: "/w/main", rel: "src/a.ts" }]));
eq("edit: +a −d", String(r1[0]?.add) + "/" + String(r1[0]?.del), "3/2");
eq("edit: locates its event", (r1[0]?.evKind ?? "") + "|" + (r1[0]?.evId ?? ""), "tool|t1");
const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n+more\n*** End Patch";
const r2: RelEv[] = []; toRel([tool("apply_patch", "src/a.ts", 5, "c1", patch)], "B", "codex", "/w/wt2", "/w/wt2", false, W0, W1, newSt(), r2);
eq("codex patch: rel", r2[0]?.files[0]?.rel ?? "", "src/a.ts");
eq("codex patch: top", r2[0]?.files[0]?.top ?? "", "/w/wt2");
eq("codex patch: +2 −1", String(r2[0]?.add) + "/" + String(r2[0]?.del), "2/1");
eq("codex patch: not self", String(r2[0]?.self), "false");
const misc = rows([
  tool("Bash", "npm test", 10, "b1", "{\"command\":\"npm test\"}"), ev("result", "Exit code 1\nfailed", 11, "b1", ""),
  tool("Read", "/w/main/src/b.ts", 12, "r1", "{\"file_path\":\"/w/main/src/b.ts\"}"), ev("result", "ok", 13, "r1", ""),
  tool("Task", "explore", 14, "k1", "{\"prompt\":\"x\"}"),
  tool("Write", "/etc/hosts", 15, "w1", "{\"file_path\":\"/etc/hosts\",\"content\":\"x\\ny\"}"),
  ev("user", "fix the login\nplease", 16, "", ""),
  ev("assistant", "sure", 17, "", ""),
], "A", "/w/main", "/w/main");
eq("kinds", show(misc), "shell:Bash:err read:Read:ok agent:Task:ok write:Write:ok prompt::ok");
eq("fileRef through a symlinked spelling of the top", JSON.stringify([fileRef("/tmp/w/src/a.ts", "/private/tmp/w", "/tmp/w"), fileRef("/private/tmp/w/b.ts", "/private/tmp/w", "/tmp/w"), fileRef("/tmp/x/c.ts", "/private/tmp/w", "/tmp/w")]),
  JSON.stringify([{ top: "/private/tmp/w", rel: "src/a.ts" }, { top: "/private/tmp/w", rel: "b.ts" }, { top: "", rel: "/tmp/x/c.ts" }]));
eq("outside the repo: absolute, top \"\"", JSON.stringify(misc[3]?.files ?? []), JSON.stringify([{ top: "", rel: "/etc/hosts" }]));
eq("prompt text: first line", misc[4]?.text ?? "", "fix the login");
eq("prompt locates its event", (misc[4]?.evKind ?? "") + "|" + (misc[4]?.evText ?? ""), "user|fix the login\nplease");
eq("fileRef inside", JSON.stringify(fileRef("/w/main/x/y.ts", "/w/main")), JSON.stringify({ top: "/w/main", rel: "x/y.ts" }));
eq("fileRef prefix is not inside", JSON.stringify(fileRef("/w/main2/y.ts", "/w/main")), JSON.stringify({ top: "", rel: "/w/main2/y.ts" }));
// codex shell: raw JSON arguments → the command line; "Process exited with code 1" is a failure
const cxs: RelEv[] = []; toRel([tool("shell", "{\"command\":[\"bash\",\"-lc\",\"npm test\"]}", 70, "s1", ""), ev("result", "Process exited with code 1\nWall time: 1s", 71, "s1", "")], "B", "codex", "/w/wt2", "/w/wt2", false, W0, W1, newSt(), cxs);
eq("codex shell: command line, failed", (cxs[0]?.text ?? "") + " " + String(cxs[0]?.err), "npm test true");
eq("shellCmd plain", shellCmd("ls -la"), "ls -la");
eq("shellCmd cmd key", shellCmd("{\"cmd\":\"git status\"}"), "git status");
// ── denial: Claude's recorded refusal → the call's row plus an alert row at the result's time ──
const den = rows([tool("Edit", "/w/main/src/a.ts", 20, "d1", "{\"file_path\":\"/w/main/src/a.ts\"}"), ev("result", "The user doesn't want to proceed with this tool use. The tool use was rejected.", 25, "d1", "")], "A", "/w/main", "/w/main");
eq("denied: call + alert", show(den), "write:Edit:err alert::ok");
eq("denied: alert text", den[1]?.text ?? "", "denied Edit");
eq("denied: alert time", String((den[1]?.t ?? 0) - T), "25000");
// the other harnesses' recorded denials, as their parsers render the result (shapes from their sources)
for (const [h, name, txt] of [
  ["codex", "shell", "exec command rejected by user"], ["codex", "apply_patch", "patch rejected by user"],
  ["opencode", "bash", "[error] The user rejected permission to use this specific tool call."],
  ["opencode", "edit", "[error] The user rejected permission to use this specific tool call with the following feedback: use sed"],
  ["opencode", "bash", "[error] The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules []"],
  ["gemini", "run_shell_command", "[cancelled] [Operation Cancelled] Reason: User denied execution."],
  ["pi", "bash", "[error] Tool execution was blocked"],
]) {
  const o: RelEv[] = []; toRel([tool(name, "x", 20, "dn", ""), ev("result", txt, 21, "dn", "")], "A", h, "/w/main", "/w/main", true, W0, W1, newSt(), o);
  eq("denied " + h + ": " + txt.slice(0, 30), o.map((x: RelEv) => x.kind + ":" + x.text).join(" | ").replace(/^[a-z]+:x \| /, ""), "alert:denied " + name);
}
const nd: RelEv[] = []; toRel([tool("shell", "x", 20, "dn", ""), ev("result", "Wall time: 3.0 seconds\naborted by user", 21, "dn", "")], "A", "codex", "/w/main", "/w/main", true, W0, W1, newSt(), nd);
eq("an interrupt is no denial", String(nd.length), "1");
// ── commit banner in a shell result → a commit row ──
const cm = rows([tool("Bash", "git commit -m 'fix login'", 30, "g1", "{\"command\":\"git commit -m 'fix login'\"}"), ev("result", "[main 3f2a91c] fix login redirect\n 1 file changed, 2 insertions(+)", 31, "g1", "")], "A", "/w/main", "/w/main");
eq("banner: shell + commit rows", show(cm), "shell:Bash:ok commit::ok");
eq("banner: text", cm[1]?.text ?? "", "3f2a91c fix login redirect");
eq("banner: sha", cm[1]?.sha ?? "", "3f2a91c");
// ── dedup and window ──
const st = newSt(); const dd: RelEv[] = [];
toRel(edit, "A", "claude", "/w/main", "/w/main", true, W0, W1, st, dd);
toRel(edit, "A", "claude", "/w/main", "/w/main", true, W0, W1, st, dd); // compaction replay
eq("replay: once", String(dd.length), "1");
const st2 = newSt(); const d2: RelEv[] = [];
toRel([ev("user", "same", 40, "", ""), ev("user", "same", 40, "", ""), ev("user", "same", 41, "", "")], "A", "claude", "/w/main", "/w/main", true, W0, W1, st2, d2);
eq("no id: (ts, text) once", String(d2.length), "2");
const d3: RelEv[] = []; toRel([ev("user", "late", 3601, "", ""), ev("user", "early", -3601 + 0, "", "")], "A", "claude", "/w/main", "/w/main", true, W0, W1, newSt(), d3);
eq("t1 + 1 s dropped", String(d3.length), "0");
// a result in a later batch still folds into its call (the builder reads windows)
const st3 = newSt(); const d4: RelEv[] = [];
toRel([tool("Bash", "make", 50, "m1", "")], "A", "claude", "/w/main", "/w/main", true, W0, W1, st3, d4);
toRel([ev("result", "Exit code 2", 51, "m1", "")], "A", "claude", "/w/main", "/w/main", true, W0, W1, st3, d4);
eq("result across batches folds", show(d4), "shell:Bash:err");
// an event without ts takes the previous event's time
const d5: RelEv[] = []; toRel([ev("user", "a", 60, "", ""), tool("Bash", "ls", -1, "x1", "")], "A", "claude", "/w/main", "/w/main", true, W0, W1, newSt(), d5);
eq("untimed event: previous time", String((d5[1]?.t ?? 0) - T), "60000");
eq("kind sets", String(KIND_SETS.length) + " " + (KIND_SETS[2] ?? []).join(","), "3 write");

// ── Task 3: conflicts, overlaps, clobbers ──
function w(sess: string, s: number, top: string, rel: string): RelEv {
  const o: RelEv[] = []; toRel([tool("Edit", top + "/" + rel, s, sess + String(s), "{\"file_path\":\"" + top + "/" + rel + "\"}")], sess, "claude", top, top, sess === "A", W0, W1 + 7200000, newSt(), o);
  return o[0] as RelEv;
}
function sh(sess: string, s: number, top: string, cmd: string): RelEv {
  const o: RelEv[] = []; toRel([tool("Bash", cmd, s, sess + "s" + String(s), "{\"command\":\"" + cmd + "\"}")], sess, "claude", top, top, false, W0, W1 + 7200000, newSt(), o);
  return o[0] as RelEv;
}
const C10 = 600000;
const a1 = w("A", 0, "/w/main", "src/a.ts"); const b1 = w("B", 70, "/w/main", "src/a.ts");
eq("conflict: count", String(markConflicts([a1, b1], C10, [])), "2");
eq("conflict: marks", a1.mark + " " + b1.mark, "conflict conflict");
eq("conflict: with", b1.withS.join(",") + " " + String(b1.dt), "A 70000");
const a2 = w("A", 0, "/w/main", "src/a.ts"); const b2 = w("B", 600, "/w/main", "src/a.ts");
markConflicts([a2, b2], C10, []); eq("C boundary: flagged", b2.mark, "conflict");
const a3 = w("A", 0, "/w/main", "src/a.ts"); const b3 = w("B", 600, "/w/main", "src/a.ts"); b3.t += 1;
markConflicts([a3, b3], C10, []); eq("C boundary + 1 ms: not", b3.mark, "");
const a4 = w("A", 0, "/w/main", "src/a.ts"); const b4 = w("B", 30, "/w/wt2", "src/a.ts");
markConflicts([a4, b4], C10, []); eq("other worktree: overlap", a4.mark + " " + b4.mark, "overlap overlap");
const a5 = w("A", 0, "/w/main", "src/a.ts"); const b5 = w("B", 30, "/w/main", "src/a.ts"); const c5 = w("C", 40, "/w/wt2", "src/a.ts");
markConflicts([a5, b5, c5], C10, []); eq("conflict wins over overlap", a5.mark + " " + b5.mark + " " + c5.mark, "conflict conflict overlap");
// parent P and its child K
function pk(pAt: number, kAt: number, sp: Spawn[]): string { const p = w("P", pAt, "/w/main", "src/a.ts"); const k = w("K", kAt, "/w/main", "src/a.ts"); markConflicts([p, k], C10, sp); return p.mark + "/" + k.mark + "/" + String(p.race); }
eq("child outside its interval: exempt", pk(300, 360, [{ parent: "P", child: "K", t0: T + 60000, t1: T + 240000 }]), "//false");
eq("parent wrote while child ran: race", pk(300, 360, [{ parent: "P", child: "K", t0: T + 240000, t1: T + 420000 }]), "conflict/conflict/true");
const k1 = w("K1", 0, "/w/main", "src/a.ts"); const k2 = w("K2", 60, "/w/main", "src/a.ts");
markConflicts([k1, k2], C10, [{ parent: "P", child: "K1", t0: T, t1: T + 100000 }, { parent: "P", child: "K2", t0: T, t1: T + 100000 }]);
eq("siblings flagged", k1.mark + " " + k2.mark, "conflict conflict");
// clobber
const cb = w("B", 60, "/w/main", "src/x.ts"); const ca = sh("A", 120, "/w/main", "git stash");
markConflicts([cb, ca], C10, []); eq("git stash after another's write: clobber", ca.mark + " " + ca.withS.join(","), "clobber B");
const lb = w("B", 60, "/w/main", "src/x.ts"); const la = sh("A", 120, "/w/main", "git stash list");
markConflicts([lb, la], C10, []); eq("git stash list: nothing", la.mark, "");
const ob = w("B", 60, "/w/wt2", "src/x.ts"); const oa = sh("A", 120, "/w/main", "git stash");
markConflicts([ob, oa], C10, []); eq("other top: no clobber", oa.mark, "");
const yes = ["git stash", "git stash push -m x", "git checkout -- .", "git checkout .", "git restore .", "git reset --hard", "git reset --hard HEAD~1", "git clean -fd", "git switch main", "git checkout main", "cd /w && git stash"];
const no = ["git stash list", "git stash show -p", "git checkout src/a.ts", "git switch -c x", "git checkout -b y", "git status", "echo git stash", "git checkout v1.2", "git checkout origin/main"];
for (const c of yes) eq("clobberCmd " + c, String(clobberCmd(c)), "true");
for (const c of no) eq("clobberCmd " + c, String(clobberCmd(c)), "false");
// ── config ──
const c1 = relCfg({ minutes: 5, conflictMinutes: 0 });
eq("relCfg partial", String(c1.minutes) + " " + String(c1.conflictMinutes) + " " + String(c1.warn.indexOf("conflictMinutes") >= 0), "5 10 true");
const c2 = relCfg({ minutes: "x" }); eq("relCfg string", String(c2.minutes) + " " + String(c2.warn !== ""), "10 true");
eq("relCfg 241", String(relCfg({ minutes: 241 }).minutes), "10");
const c3 = relCfg({}); eq("relCfg empty", String(c3.minutes) + " " + String(c3.conflictMinutes) + " " + JSON.stringify(c3.warn), "10 10 \"\"");
eq("relCfg 240", String(relCfg({ minutes: 240 }).minutes), "240");

console.log(bad ? bad + " failed" : "related model: all checks passed");
process.exit(bad ? 1 : 0);
