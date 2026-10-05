// agentglass — self-check for the incremental git attribution (allInfo == a full rebuild, work only where inputs changed):
// scriptc build src/features/vcs/attrib-inc.check.ts -o ai && ./ai
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { type GitInfo, allInfo, fullRebuildForCheck, GIT_CLOCK, ATTR_STATS, gitGen, gitStale } from "./attrib.ts";
import { sessions } from "../../model/sessions.ts";
import { newSess, type Sess } from "../../model/types.ts";
import { P as PJ, setGit } from "../../model/project.ts";
import { ledger } from "../usage/ledger.ts";
import { newAcc, type Acc, L } from "../usage/record.ts";
import type { VRef } from "../usage/vcs.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function sha(c: string): string { return c.repeat(40).slice(0, 40); }
const Z = "0".repeat(40);
const T = 1700000000000; // fixture epoch (ms)
function ln(o: string, n: string, at: number, msg: string): string { return o + " " + n + " n <a@b> " + String(Math.floor(at / 1000)) + " +0000\t" + msg + "\n"; }

const dir = "/tmp/agentglass-attrib-inc-" + String(process.pid);
rmSync(dir, { recursive: true, force: true });
function repo(name: string, lines: string): string {
  const g = dir + "/" + name + "/.git"; mkdirSync(g + "/logs", { recursive: true }); mkdirSync(g + "/objects", { recursive: true });
  writeFileSync(g + "/HEAD", "ref: refs/heads/main\n");
  writeFileSync(g + "/config", '[remote "origin"]\n\turl = https://github.com/acme/' + name + '\n');
  writeFileSync(g + "/logs/HEAD", lines);
  return dir + "/" + name;
}
const ra = repo("a", ln(Z, sha("1"), T + 60000, "commit (initial): one") + ln(sha("1"), sha("2"), T + 120000, "commit: two"));
const rb = repo("b", ln(Z, sha("3"), T + 60000, "commit (initial): three"));
setGit((c: string, a: string[]): string => ""); PJ.sync = true;

function vr(k: string, v: string, t: number): VRef { return { k, v, t, how: "observed", br: "main", subj: "s", call: "c1", ts: "" }; }
function sess(id: string, cwd: string, t0: number, al: number, refs: VRef[]): Acc {
  const path = dir + "/" + id + ".jsonl";
  const s: Sess = newSess("claude", id, path, false); s.cwd = cwd; s.headDone = true; s.branch = "main"; s.mtime = al;
  sessions.set(path, s);
  const a = newAcc(); a.t0 = t0; a.al = al; for (const r of refs) a.vcs.push(r);
  ledger.set(path, a);
  return a;
}
const a1 = sess("a1", ra, T + 50000, T + 100000, [vr("commit", "1111111", T + 60000)]); // banner of commit 1
sess("a2", ra, T + 110000, T + 130000, []); // commit 2 lies in its window only: ≈
sess("a3", ra, T + 100000, T + 140000, []); // …and in a3's: ? shared on both
sess("b1", rb, T + 50000, T + 70000, []);
mkdirSync(dir + "/plain", { recursive: true });
sess("n1", dir + "/plain", T + 50000, T + 70000, []); // no git worktree: no info, and not rebuilt every pass

// GitInfo → text (every field the views and --json read)
function show(m: Map<string, GitInfo>): string {
  const o: string[] = [];
  const ks = [...m.keys()].sort();
  for (const k of ks) {
    const g = m.get(k); if (!g) continue;
    const cs: string[] = []; for (const c of g.commits) cs.push(c.sha.slice(0, 3) + ":" + c.how + (c.counted ? "+" : "") + ":" + c.status + ":" + c.br + ":" + String(c.at) + ":" + c.call + ":" + c.path.slice(-8));
    const ls: string[] = []; for (const l of g.prs.concat(g.issues).concat(g.links)) ls.push(l.url + ":" + l.how);
    o.push(k.slice(-8) + " " + cs.join(",") + " | " + ls.join(",") + " =" + String(g.produced) + (g.noReflog ? " noreflog" : ""));
  }
  return o.join("\n");
}
let now = T + 200000;
GIT_CLOCK.now = (): number => now;

// (a) the incremental result equals a full rebuild
const full0 = show(fullRebuildForCheck());
eq("first pass == full rebuild", show(allInfo()), full0);
eq("sanity: shared + observed attributed", full0.indexOf("222:shared") >= 0 && full0.indexOf("111:observed+") >= 0 ? "yes" : "no", "yes");
eq("first pass attributes both repos", String(ATTR_STATS.projects), "2");

// (d) nothing changed: within 5 s no stamp is read and no repo re-attributed; after 5 s stamps only
let p0 = ATTR_STATS.projects; let s0 = ATTR_STATS.stamps; const g0 = gitGen();
now += 1500; allInfo();
eq("unchanged, 1.5 s: no repo", String(ATTR_STATS.projects - p0), "0");
eq("unchanged, 1.5 s: no stamp read", String(ATTR_STATS.stamps - s0), "0");
eq("unchanged: generation kept", String(gitGen() - g0), "0");
now += 5000; allInfo();
eq("unchanged, 6.5 s: no repo", String(ATTR_STATS.projects - p0), "0");
eq("unchanged, 6.5 s: stamps re-read", String(ATTR_STATS.stamps - s0), "2");

// (b) a new commit in repo a: seen once its stamp is due (≤ 5 s), equal to a full rebuild
appendFileSync(ra + "/.git/logs/HEAD", ln(sha("2"), sha("4"), T + 135000, "commit: four"));
p0 = ATTR_STATS.projects;
now += 1500; allInfo();
eq("new commit, stamp not due: nothing yet", String(ATTR_STATS.projects - p0), "0");
now += 4000; const m1 = show(allInfo());
eq("new commit after ≤ 5 s: repo a only", String(ATTR_STATS.projects - p0), "1");
eq("new commit attributed", m1.indexOf("444:shared") >= 0 ? "yes" : "no", "yes");
eq("== full rebuild after a reflog change", m1, show(fullRebuildForCheck()));

// (c) one session's log grew (its mtime moves with it) and the ledger moved its last activity: only its repo
// re-attributes, on the next pass a second later
const s1 = sessions.get(dir + "/a1.jsonl");
function wrote(): void { if (s1) s1.mtime = now; }
p0 = ATTR_STATS.projects; const g1 = gitGen();
now += 1500; wrote(); a1.al = T + 125000;
now += 1100; const m2 = show(allInfo());
eq("one session changed: one repo", String(ATTR_STATS.projects - p0), "1");
eq("generation bumped", gitGen() > g1 ? "yes" : "no", "yes");
eq("== full rebuild after a session change", m2, show(fullRebuildForCheck()));
// a banner appended to a session's refs (same array, longer)
p0 = ATTR_STATS.projects;
wrote(); a1.vcs.push(vr("commit", "2222222", T + 120000));
now += 1100; const m3 = show(allInfo());
eq("banner added: one repo", String(ATTR_STATS.projects - p0), "1");
eq("== full rebuild after a banner", m3, show(fullRebuildForCheck()));
// a log not written within the minute and not live is looked at by the full pass only (every 5 s): the ledger books
// bytes only of logs that grew, so this is a re-index or a removal
const b1 = dir + "/b1.jsonl"; ledger.delete(b1);
now += 5000; const m4 = allInfo();
eq("session gone: dropped within 5 s", m4.has(b1) ? "kept" : "dropped", "dropped");
eq("== full rebuild after removal", show(m4), show(fullRebuildForCheck()));
// within the 1 s pass interval nothing is looked at, also when the ledger moved (live sessions write all the time): the
// next pass a second later rebuilds what changed; gitStale forces a pass with stamp reads at once
const i0 = ATTR_STATS.sessIns; now += 100; allInfo();
a1.al = T + 126000; L.ver++; now += 100; allInfo();
eq("ledger moved: no pass within the second", String(ATTR_STATS.sessIns - i0), "0");
now += 1000; allInfo();
eq("…then one SessIn rebuilt", String(ATTR_STATS.sessIns - i0), "1");
eq("no worktree: no info", allInfo().has(dir + "/n1.jsonl") ? "has" : "none", "none");
s0 = ATTR_STATS.stamps; now += 100;
gitStale(); allInfo(); eq("gitStale: stamps read at once", String(ATTR_STATS.stamps - s0), "1");

rmSync(dir, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("attrib-inc: all checks passed");
