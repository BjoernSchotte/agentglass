// agentglass — self-check for git-linkage enrichment: scriptc build src/features/vcs/enrich.check.ts -o ec && ./ec
// SPDX-License-Identifier: Apache-2.0
import { rmSync } from "node:fs";
import { type Stat, parseShow, applyStats, enrich, setVcsFile, saveVcs, gitFailed } from "./enrich.ts";
import { type GitInfo, type GCommit, GIT, newInfo, tally } from "./attrib.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function sha(c: string): string { return c.repeat(40).slice(0, 40); }
function gc(s: string, how: string, status: string): GCommit { return { sha: s, br: "main", subj: "x", at: 1, how, counted: how === "observed", status, merge: false, add: -1, del: -1, files: -1, call: "", ts: "", path: "/s" }; }
function info(cs: GCommit[]): GitInfo { const g = newInfo(); for (const c of cs) g.commits.push(c); tally(g); return g; }

const OUT = sha("a") + "\x1f" + sha("1") + " " + sha("2") + "\x1f1700000000\x1fMerge f\x1e\n" + sha("b") + "\x1f" + sha("1") + "\x1f1700000100\x1ffix it\x1e\n\n 3 files changed, 10 insertions(+), 2 deletions(-)\n" + sha("c") + "\x1f" + sha("b") + "\x1f1700000200\x1fadd\x1e\n\n 1 file changed, 4 insertions(+)\n";
const st = parseShow(OUT);
function sstr(s: Stat): string { return s.sha.slice(0, 1) + (s.merge ? "M" : "") + " " + String(s.at) + " " + s.subj + " " + String(s.files) + "/" + String(s.add) + "/" + String(s.del); }
eq("parseShow", st.map(sstr).join(" | "), "aM 1700000000000 Merge f 0/0/0 | b 1700000100000 fix it 3/10/2 | c 1700000200000 add 1/4/0");

const rl = new Set<string>(); rl.add(sha("d"));
let g = info([gc("bbbbbbb", "observed", "unknown"), gc("ddddddd", "observed", "present"), gc("eeeeeee", "observed", "unknown"), gc("ccccccc", "reflog", "present")]);
applyStats(g, st, rl);
function row(c: GCommit): string { return c.sha.slice(0, 1) + (c.sha.length === 40 ? "F" : "s") + ":" + c.status + (c.counted ? "+" : "") + (c.add >= 0 ? " +" + String(c.add) + "-" + String(c.del) : ""); }
eq("applyStats", g.commits.map(row).join(" | "), "bF:present+ +10-2 | ds:missing+ | es:elsewhere | cF:present +4-0");
eq("produced after: present + missing", String(g.produced), "2");

// enrich: stub git, gate, failure, cache in vcs.json for closed sessions
const tmp = "/tmp/agentglass-enrich-check-" + String(process.pid) + ".json"; setVcsFile(tmp);
let n = 0; let out = OUT;
const stub = (cmd: string, args: string[]): string => { n++; return out; };
GIT.gate = true; GIT.last = 0;
g = info([gc("bbbbbbb", "observed", "unknown")]);
eq("first enrich spawns", String(enrich("/s1", g, "/r", true, rl, stub)) + String(n), "true1");
g = info([gc("ccccccc", "observed", "unknown")]);
eq("second within 500 ms is gated", String(enrich("/s2", g, "/r", true, rl, stub)) + String(n), "false1");
GIT.last = 0; out = "";
g = info([gc("ccccccc", "observed", "unknown")]);
eq("git unavailable: no throw, short sha kept", String(enrich("/s3", g, "/r2", true, rl, stub)) + " " + (g.commits[0] ?? gc("", "", "")).sha + " " + String(gitFailed("/r2")), "false ccccccc true");
saveVcs(); setVcsFile(tmp); // a fresh process: the closed session's result comes from vcs.json
GIT.last = 0; out = OUT; n = 0;
g = info([gc("bbbbbbb", "observed", "unknown")]);
eq("closed session from vcs.json, no spawn", String(enrich("/s1", g, "/r", true, rl, stub)) + String(n) + " " + row(g.commits[0] ?? gc("", "", "")), "true0 bF:present+ +10-2");
rmSync(tmp, { force: true });

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("enrich ok");
