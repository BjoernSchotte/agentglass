// agentglass — security self-check for the spool hand-off (~/.agentglass/run/inbox): owner-only files, bounded reads,
// replies, stale cleanup, tampered entries never followed or unlinked (temp dirs only)
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { OS } from "../../platform/index.ts";
import { type FInfo, type InfoFn, myUid, secureDir, takeLock } from "./rundir.ts";
import { type Rate } from "./handoff.ts";
import { spoolSend, spoolAwait, spoolPoll, spoolWarn } from "./spool.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const info: InfoFn = (p: string): FInfo | null => OS.fileInfo(p);
const uid = myUid();
const live = (pid: number): boolean => true; const ours = (pid: number): boolean => true;
const deadAlive = (pid: number): boolean => false;
const root = "/tmp/agentglass-spool-" + String(process.pid);
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });
const run = root + "/run"; const inbox = run + "/inbox";
secureDir(run, uid, info, true); secureDir(inbox, uid, info, true);
const applied: string[] = [];
const apply = (ref: string): string => { applied.push(ref); return ref.startsWith("zzzzzz") ? "err not-found" : "ok"; };
function ls(): string { return readdirSync(inbox).sort().join(","); }
function clear(): void { for (const f of readdirSync(inbox)) rmSync(inbox + "/" + f, { force: true }); applied.length = 0; }
const now = Date.now();

// no lock holder → nothing written, open it yourself
ok("no holder → \"\"", spoolSend(run, "open abc123\n", 7, now, uid, info, live, ours) === "" && ls() === "", ls());
ok("take the lock", takeLock(run, process.pid, uid, info, live, ours) === 1, "");
ok("dead holder → \"\"", spoolSend(run, "open abc123\n", 7, now, uid, info, deadAlive, ours) === "" && ls() === "", ls());
// round trip
const p = spoolSend(run, "open abc123\n", 7, now, uid, info, live, ours);
ok("link written", p === inbox + "/" + String(now) + "-7.link" && existsSync(p), p);
ok("link 0600", OS.fileInfo(p)?.mode === 0o600, JSON.stringify(OS.fileInfo(p)));
const rate: Rate = { at: [] };
ok("poll applies 1", spoolPoll(run, now + 10, uid, info, rate, apply) === 1 && applied.join() === "abc123", applied.join());
ok("link removed, .res 0600 = ok", !existsSync(p) && readFileSync(inbox + "/" + String(now) + "-7.res", "utf8") === "ok\n" && OS.fileInfo(inbox + "/" + String(now) + "-7.res")?.mode === 0o600, ls());
let got = "-"; spoolAwait(p, 2000, uid, info, (r: string) => { got = r; });
setTimeout(step2, 200);
function step2(): void {
  ok("await reads ok and removes the .res", got === "ok" && ls() === "", got + " " + ls());
  clear();
  // not found; oversized; foreign verbs; refused grammar
  spoolSend(run, "open zzzzzz-1\n", 8, now, uid, info, live, ours);
  spoolPoll(run, now + 10, uid, info, rate, apply);
  ok("not found → err not-found", readFileSync(inbox + "/" + String(now) + "-8.res", "utf8") === "err not-found\n", ls());
  clear();
  writeFileSync(inbox + "/" + String(now) + "-9.link", "open " + "a".repeat(1019) + "\n"); chmodSync(inbox + "/" + String(now) + "-9.link", 0o600);
  writeFileSync(inbox + "/" + String(now) + "-10.link", "open abc123\n" + "x".repeat(5000)); chmodSync(inbox + "/" + String(now) + "-10.link", 0o600);
  writeFileSync(inbox + "/" + String(now) + "-11.link", "send abc123\n"); chmodSync(inbox + "/" + String(now) + "-11.link", 0o600);
  writeFileSync(inbox + "/" + String(now) + "-12.link", "open ../x\n"); chmodSync(inbox + "/" + String(now) + "-12.link", 0o600);
  spoolPoll(run, now + 10, uid, info, { at: [] }, apply);
  let allBad = true; for (const n of ["9", "10", "11", "12"]) if (readFileSync(inbox + "/" + String(now) + "-" + n + ".res", "utf8") !== "err bad-request\n") allBad = false;
  ok("1025 bytes / 5000-byte file / send / bad ref → bad-request, never applied", allBad && applied.length === 0, ls() + " " + applied.join());
  clear();
  // stale, future and foreign names
  writeFileSync(inbox + "/" + String(now - 61000) + "-13.link", "open abc123\n"); chmodSync(inbox + "/" + String(now - 61000) + "-13.link", 0o600);
  writeFileSync(inbox + "/" + String(now + 10000) + "-14.link", "open abc123\n"); chmodSync(inbox + "/" + String(now + 10000) + "-14.link", 0o600);
  writeFileSync(inbox + "/notalink.txt", "open abc123\n");
  writeFileSync(inbox + "/.tmp-" + String(now - 70000) + "-15", "x");
  spoolPoll(run, now, uid, info, { at: [] }, apply);
  ok("stale/future unlinked unread, other names ignored, old tmp cleaned", ls() === "notalink.txt" && applied.length === 0, ls());
  clear();
  // rate: the 11th link in a minute is busy
  for (let i = 0; i < 11; i++) { writeFileSync(inbox + "/" + String(now + i) + "-2" + String(i) + ".link", "open abc123\n"); chmodSync(inbox + "/" + String(now + i) + "-2" + String(i) + ".link", 0o600); }
  const r2: Rate = { at: [] }; let n = 0; for (let k = 0; k < 3; k++) n += Math.max(0, spoolPoll(run, now + 20 + k, uid, info, r2, apply));
  let busy = 0; for (const f of readdirSync(inbox)) if (f.endsWith(".res") && readFileSync(inbox + "/" + f, "utf8") === "err busy\n") busy++;
  ok("10 applied, the 11th busy", applied.length === 10 && busy === 1, String(applied.length) + " " + String(busy));
  clear();
  // order: by name
  for (const i of [3, 1, 2]) { writeFileSync(inbox + "/" + String(now + i) + "-1.link", "open abc12" + String(i) + "\n"); chmodSync(inbox + "/" + String(now + i) + "-1.link", 0o600); }
  spoolPoll(run, now + 10, uid, info, { at: [] }, apply);
  ok("applied in name order", applied.join() === "abc121,abc122,abc123", applied.join());
  clear();
  // a symlink entry → not read, not unlinked, disabled with a warning; same for a FIFO (and no block)
  execFileSync("ln", ["-s", "/etc/passwd", inbox + "/" + String(now) + "-31.link"]);
  ok("symlink → disabled", spoolPoll(run, now, uid, info, { at: [] }, apply) === -1 && spoolWarn().indexOf("symlink") >= 0, spoolWarn());
  ok("symlink untouched, nothing applied", OS.fileInfo(inbox + "/" + String(now) + "-31.link")?.kind === "link" && applied.length === 0 && readdirSync(inbox).length === 1, ls());
  clear();
  execFileSync("mkfifo", [inbox + "/" + String(now) + "-32.link"]);
  ok("fifo → disabled, no block", spoolPoll(run, now, uid, info, { at: [] }, apply) === -1 && OS.fileInfo(inbox + "/" + String(now) + "-32.link")?.kind === "fifo", spoolWarn());
  clear();
  // a foreign owner (stubbed) on a .link → not read, not unlinked, disabled
  writeFileSync(inbox + "/" + String(now) + "-33.link", "open abc123\n"); chmodSync(inbox + "/" + String(now) + "-33.link", 0o600);
  const foreign: InfoFn = (q: string): FInfo | null => { const r = OS.fileInfo(q); return r && q.endsWith(".link") ? { uid: uid + 1, mode: r.mode, kind: r.kind } : r; };
  ok("foreign .link → disabled", spoolPoll(run, now, uid, foreign, { at: [] }, apply) === -1 && existsSync(inbox + "/" + String(now) + "-33.link") && applied.length === 0, spoolWarn());
  clear();
  // the inbox replaced by a symlink to another dir → disabled, the other dir untouched
  const other = root + "/other"; mkdirSync(other, { mode: 0o700 }); writeFileSync(other + "/" + String(now) + "-34.link", "open abc123\n");
  rmSync(inbox, { recursive: true }); execFileSync("ln", ["-s", other, inbox]);
  ok("symlinked inbox → disabled", spoolPoll(run, now, uid, info, { at: [] }, apply) === -1 && existsSync(other + "/" + String(now) + "-34.link") && applied.length === 0, spoolWarn());
  ok("client refuses a symlinked inbox", spoolSend(run, "open abc123\n", 7, now + 50, uid, info, live, ours) === "", "");
  rmSync(inbox); secureDir(inbox, uid, info, true);
  // review: a rename (.tmp → .link) that leaves the inbox's mtime and entry count as they were is still seen
  clear();
  const pin = (): void => { execFileSync("touch", ["-m", "-d", "@1700000000", inbox]); };
  writeFileSync(inbox + "/.tmp-" + String(now) + "-41", "open abc123\n"); chmodSync(inbox + "/.tmp-" + String(now) + "-41", 0o600); pin();
  ok("tmp only → nothing applied", spoolPoll(run, now + 5, uid, info, { at: [] }, apply) === 0, ls());
  execFileSync("mv", [inbox + "/.tmp-" + String(now) + "-41", inbox + "/" + String(now) + "-41.link"]); pin();
  ok("renamed at the same mtime and count → applied", spoolPoll(run, now + 6, uid, info, { at: [] }, apply) === 1 && applied.join() === "abc123", ls());
  clear();
  // two clients in the same millisecond: both applied, each gets its own reply
  const pa = spoolSend(run, "open abc121\n", 51, now, uid, info, live, ours); const pb = spoolSend(run, "open abc122\n", 52, now, uid, info, live, ours);
  ok("two senders, two links", pa !== "" && pb !== "" && pa !== pb, pa + " " + pb);
  spoolPoll(run, now + 10, uid, info, { at: [] }, apply);
  ok("both applied, both answered", applied.join() === "abc121,abc122" && existsSync(inbox + "/" + String(now) + "-51.res") && existsSync(inbox + "/" + String(now) + "-52.res"), applied.join() + " " + ls());
  clear();
  // a reply that is not a regular file of ours: not read, not unlinked, the client falls back
  const pr = spoolSend(run, "open abc123\n", 53, now, uid, info, live, ours);
  execFileSync("ln", ["-s", "/etc/hostname", inbox + "/" + String(now) + "-53.res"]);
  let gr = "-"; spoolAwait(pr, 2000, uid, info, (r: string) => { gr = r; });
  ok("symlinked .res → \"\" and left alone", gr === "" && OS.fileInfo(inbox + "/" + String(now) + "-53.res")?.kind === "link", gr + " " + ls());
  clear();
  // a hung server: our .link removed after the timeout, done("") → the client falls back
  const hp = spoolSend(run, "open abc123\n", 40, now + 100, uid, info, live, ours);
  const t0 = Date.now();
  spoolAwait(hp, 2000, uid, info, (r: string) => {
    ok("timeout after ~2 s → \"\"", r === "" && Date.now() - t0 >= 1900 && Date.now() - t0 < 3500, String(Date.now() - t0));
    ok("our .link gone", !existsSync(hp), ls());
    rmSync(root, { recursive: true, force: true });
    console.log(bad ? bad + " failed" : "spool: all checks passed");
    process.exit(bad ? 1 : 0);
  });
}
