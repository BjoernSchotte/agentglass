// agentglass — self-check for the reflog reader: scriptc build src/features/vcs/reflog.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { type RefEv, parseReflog, readReflog, headBranch, isNew, opOf, MAX_READ } from "./reflog.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function yes(what: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + what); } }
function sha(n: number): string { const h = "0123456789abcdef"; let s = ""; for (let i = 0; i < 40; i++) s += h.slice((n + i) % 16, (n + i) % 16 + 1); return s; }
const Z = "0".repeat(40);
function ln(o: string, n: string, at: number, msg: string): string { return o + " " + n + " n <a@b> " + String(at) + " +0200\t" + msg; }
// the shapes git 2.51 wrote in a scratch repo (Task 0), with made-up shas
const L = [
  ln(Z, sha(1), 1000, "commit (initial): one"),
  ln(sha(1), sha(2), 1010, "commit: e"),
  ln(sha(2), sha(2), 1020, "checkout: moving from main to f"),
  ln(sha(2), sha(3), 1030, "commit: fc"),
  ln(sha(3), sha(2), 1040, "checkout: moving from f to main"),
  ln(sha(2), sha(4), 1050, "merge f: Merge made by the 'ort' strategy."),
  ln(sha(4), sha(5), 1060, "commit (cherry-pick): e"),
  ln(sha(5), sha(6), 1070, "commit (amend): a2"),
  ln(sha(6), sha(6), 1080, "rebase (finish): returning to refs/heads/main"),
  ln(sha(6), sha(4), 1090, "reset: moving to HEAD~1"),
];
const evs = parseReflog(L.join("\n") + "\n", "zzz");
function col(f: (e: RefEv) => string): string { const o: string[] = []; for (const e of evs) o.push(f(e)); return o.join(","); }
eq("ops", col((e) => e.op), "commit,commit,checkout,commit,checkout,merge,cherry-pick,amend,rebase,reset");
eq("branches (before the first checkout: its from-branch)", col((e) => e.op === "checkout" ? "-" : e.branch), "main,main,-,f,-,main,main,main,main,main");
eq("amended flag (the cherry-pick the amend replaced)", col((e) => e.amended ? "A" : "."), ".,.,.,.,.,.,A,.,.,.");
eq("isNew", col((e) => isNew(e) ? "N" : "."), "N,N,.,N,.,N,N,N,.,.");
eq("times in ms", String(evs.length ? evs[0].at : 0), "1000000");
eq("subjects", col((e) => e.subj), "one,e,moving from main to f,fc,moving from f to main,Merge made by the 'ort' strategy.,e,a2,returning to refs/heads/main,moving to HEAD~1");
let leak = false; for (const e of evs) if ((e.subj + e.branch + e.old + e.sha + e.op).indexOf("a@b") >= 0) leak = true;
yes("no email in any field", !leak);
eq("head branch without checkout", parseReflog(ln(Z, sha(1), 1, "commit (initial): x"), "dev").map((e: RefEv) => e.branch).join(","), "dev");
eq("detached checkout", parseReflog(ln(sha(1), sha(2), 1, "checkout: moving from main to " + sha(2)) + "\n" + ln(sha(2), sha(3), 2, "commit: d"), "").map((e: RefEv) => e.branch).join(","), ",");
eq("other commit forms", opOf("commit (initial): x") + " " + opOf("commit (merge): x") + " " + opOf("pull: Fast-forward") + " " + opOf("rebase -i (pick): x"), "commit merge other rebase");
yes("garbage lines skipped", parseReflog("nonsense\n\tx\n" + sha(1) + " short 1 +0000\tcommit: y", "").length === 0);

// ── files: main repo gitdir and a linked worktree's gitdir, HEAD, cache, 8 MB tail ──
const dir = "/tmp/agentglass-reflog-check-" + String(process.pid);
function write(p: string, s: string): void { const fd = openSync(p, "w"); writeSync(fd, s); closeSync(fd); }
const g1 = dir + "/r1/.git"; const w1 = g1 + "/worktrees/w1";
mkdirSync(g1 + "/logs", { recursive: true }); mkdirSync(w1 + "/logs", { recursive: true });
write(g1 + "/HEAD", "ref: refs/heads/main\n"); write(w1 + "/HEAD", sha(9) + "\n");
write(g1 + "/logs/HEAD", L.slice(0, 2).join("\n") + "\n");
write(w1 + "/logs/HEAD", ln(sha(2), sha(7), 2000, "commit: w") + "\n");
eq("head branch", headBranch(g1) + "|" + headBranch(w1), "main|");
const r1 = readReflog(g1);
eq("main gitdir events", String(r1.length), "2");
eq("worktree gitdir events", readReflog(w1).map((e: RefEv) => e.subj).join(","), "w");
yes("cached: same array while size/mtime unchanged", readReflog(g1) === r1);
eq("missing reflog", String(readReflog(dir + "/nope").length), "0");
// 9 MB of fixed-length lines (distinct times): the tail starts on a line boundary and ends at the last line
const pad = "x".repeat(60); const one = ln(sha(1), sha(2), 1000000, "commit: " + pad).length + 1; // bytes per line incl. \n (ASCII)
const n = Math.ceil(9437184 / one); const parts: string[] = [];
for (let i = 0; i < n; i++) { const t = String(1000000 + i); parts.push(ln(sha(1), sha(2), Number(t), "commit: " + pad.slice(0, 60 - (t.length - 7)))); }
const big = parts.join("\n") + "\n";
write(g1 + "/logs/HEAD", big);
const tail = readReflog(g1);
const skip = Math.ceil((big.length - MAX_READ) / one);
eq("tail starts at a line", String(tail.length ? tail[0].at / 1000 : 0), String(1000000 + skip));
eq("tail ends at the last line", String(tail.length ? tail[tail.length - 1].at / 1000 : 0), String(1000000 + n - 1));
eq("tail count", String(tail.length), String(n - skip));
rmSync(dir, { recursive: true, force: true });

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("reflog ok");
