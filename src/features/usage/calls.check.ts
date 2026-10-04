// agentglass — self-check for the tool-call parsers: scriptc build src/features/usage/calls.check.ts -o ucc && ./ucc
// SPDX-License-Identifier: Apache-2.0
import { type Pend, newTS, newCnt, done, pct, hb, program, argv, execCmds, exitCodes, codexFailed, patchFiles, mcpServer } from "./calls.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }

eq("plain", program("git status --short"), "git");
eq("env + sudo", program("FOO=1 BAR=2 sudo -E npm test"), "npm");
eq("timeout N", program("timeout 30s ./build.sh"), "build.sh");
eq("cd chain", program("cd /x/y && env FOO=1 /usr/bin/python3 - <<'EOF'"), "python3");
eq("for loop", program("for i in 1 2; do tmux send-keys -t x; done"), "tmux");
eq("only cd", program("cd /tmp"), "cd");
eq("argv -lc", argv(["bash", "-lc", "ls -la"]), "ls -la");
eq("argv join", argv(["rg", "-n", "x"]), "rg -n x");
eq("exec wrapper", execCmds("const r = await Promise.allSettled([tools.exec_command({cmd:\"cat \\\"a b\\\"\",max_output_tokens:1}), tools.exec_command({workdir:\"/w\", cmd:'ls'})]);").join("|"), "cat \"a b\"|ls");
const raw = "{\"payload\":{\"type\":\"custom_tool_call_output\",\"output\":[{\"type\":\"input_text\",\"text\":\"{\\\"exit_code\\\":0,\\\"output\\\":\\\"x \\\\\\\"exit_code\\\\\\\":9\\\"}\\n{\\\"exit_code\\\":2}\"}]}}";
eq("exit codes (nested output ignored)", exitCodes(raw).join(","), "0,2");
eq("failed on nonzero", String(codexFailed(raw, exitCodes(raw))), "true");
eq("process exited", String(codexFailed("{\"output\":\"Process exited with code 1\\n\"}", [])), "true");
eq("clean run", String(codexFailed("{\"output\":\"Process exited with code 0\\n\"}", [])), "false");
const pf = patchFiles("*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n+z\n*** Add File: b.ts\n+1\n*** End Patch");
eq("patch files", pf.map((f) => f.p + ":" + f.add + "/" + f.del).join(" "), ":0/0 a.ts:2/1 b.ts:1/0");
eq("mcp server", mcpServer("mcp__claude_ai_Claude_Docs__read") + "|" + mcpServer("Bash"), "claude_ai_Claude_Docs|");
eq("histogram buckets", [hb(3), hb(10), hb(99), hb(3600000)].join(","), "0,1,3,15");
// durations + per-command error attribution
const st = newTS(); const p1 = newCnt(); const c1 = newCnt(); const p2 = newCnt(); const c2 = newCnt();
const pd: Pend = { t: 1000, ts: "", arg: "", st, sh: [p1, c1, p2, c2], row: null, sp: [], name: "Bash", cmd: "", id: "a", end: 0, dn: [] };
done(pd, 400, true, 10, "a", [0, 3]);
eq("per-command errors", [p1.err, p2.err].join(","), "0,1");
done({ t: 0, ts: "", arg: "", st, sh: [], row: null, sp: [], name: "Bash", cmd: "", id: "b", end: 0, dn: [] }, 2000, false, 0, "b", []);
eq("stats", [st.err, st.dn, st.max, st.slow.length, st.errs.length].join(","), "1,2,2000,2,1");
eq("p95 capped at max", String(pct(st.hist, 0.95, st.max)), "1581");
console.log(bad ? bad + " failed" : "usage calls: all checks passed");
if (bad) process.exit(1);
