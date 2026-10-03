// agentglass — self-check for the --json --repos shape: scriptc build src/features/repos/cli.check.ts -o rcc && AGENTGLASS_REDACT=1 ./rcc
// SPDX-License-Identifier: Apache-2.0
import { newCnt } from "../usage/calls.ts";
import { newSum } from "../usage/costs.ts";
import { type RepoAgg, type FileAgg, type HarnessAgg } from "./agg.ts";
import { repoJson, keyShown } from "./cli.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function fa(n: number): FileAgg { const by = new Set<string>(); by.add("codex"); by.add("claude"); return { n, add: n, del: 1, by }; }
function repo(cost: number, unk: number, calls: number, err: number, nFiles: number): RepoAgg {
  const files = new Map<string, FileAgg>(); for (let i = 0; i < nFiles; i++) files.set("src/f" + String(i) + ".ts", fa(i + 1));
  const byHarness = new Map<string, HarnessAgg>(); byHarness.set("claude", { sess: 2, cost, unk }); 
  const worktrees = new Map<string, string>(); worktrees.set("secretproj", "/home/x/code/secretproj"); worktrees.set("secretproj-wt", "/home/x/code/secretproj-wt");
  return { key: "git:github.com/acmecorp/secretproj", label: "acmecorp/secretproj", kind: "git", worktrees, sessions: 2, live: 1, last: 1767225600000, cost, unk, modes: newSum(), inTok: 10, outTok: 5, calls, err, activeMin: 90, agentMin: 120,
    files, outside: { n: 3, add: 0, del: 0, by: new Set<string>() }, tools: new Map(), progErr: new Map(), byHarness, branches: new Map<string, HarnessAgg>(), paths: [], remote: "", via: "", unread: false, days: [] };
}
const j = repoJson(repo(1.5, 0, 60, 6, 60));
eq("files top 50", String(j.files.length), "50"); eq("files sorted by edits", String(j.files[0] ? j.files[0].edits : 0), "60");
eq("harnesses sorted", j.files[0] ? j.files[0].harnesses.join(",") : "", "claude,codex");
eq("outsideFiles", String(j.outsideFiles), "3"); eq("cost", String(j.costUsd), "1.5"); eq("errorRate", String(j.errorRate), "0.1");
eq("activeMin/agentMin", String(j.activeMin) + "/" + String(j.agentMin), "90/120"); eq("last iso", j.last, "2026-01-01T00:00:00.000Z");
const u = repoJson(repo(0, 500, 9, 3, 0));
eq("unpriced → null", String(u.costUsd), "null"); eq("under 10 calls → null", String(u.errorRate), "null"); eq("byHarness null cost", String(u.byHarness[0] ? u.byHarness[0].costUsd : "x"), "null");
// --redact (checks run with AGENTGLASS_REDACT=1): no real names in the output
const txt = JSON.stringify(j);
eq("redacted label/key/paths", txt.indexOf("secretproj") < 0 && txt.indexOf("acmecorp") < 0 ? "clean" : txt.slice(0, 300), "clean");
eq("key keeps its host", keyShown("git:github.com/acmecorp/secretproj").startsWith("git:github.com/") ? "y" : "n", "y");
eq("worktree names faked", j.worktrees[0] && j.worktrees[0].name !== "secretproj" ? "y" : "n", "y");
console.log(bad ? bad + " failed" : "repos cli ok");
if (bad) process.exit(1);
