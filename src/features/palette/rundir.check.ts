// agentglass — security self-check for the single-instance run directory and the server lock (temp dirs only)
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { OS } from "../../platform/index.ts";
import { type FInfo, type InfoFn, myUid, secureDir, takeLock, releaseLock, lockHolder, holdsLock } from "./rundir.ts";

const info: InfoFn = (p: string): FInfo | null => OS.fileInfo(p);
const yes = (pid: number): boolean => true; const no = (pid: number): boolean => false;
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (e) { return false; } }

// --race <dir>: a child of the concurrency case; prints its takeLock result
const ri = process.argv.indexOf("--race");
if (ri >= 0) { const d = process.argv[ri + 1] ?? ""; console.log("race " + String(takeLock(d, process.pid, myUid(), info, alive, yes))); setTimeout(() => process.exit(0), 800); } // stays alive: the other one must see a live holder
else main();
function main(): void {

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const uid = myUid();
const root = "/tmp/agentglass-rundir-" + String(process.pid);
rmSync(root, { recursive: true, force: true }); mkdirSync(root, { recursive: true });

// fileInfo: lstat semantics through the stat CLI
const fi0 = OS.fileInfo(root);
ok("fileInfo dir", fi0 !== null && fi0.kind === "dir" && fi0.uid === uid, JSON.stringify(fi0));
ok("fileInfo missing → null", OS.fileInfo(root + "/nope") === null, "");
writeFileSync(root + "/f", "x"); execFileSync("ln", ["-s", root + "/f", root + "/l"]); execFileSync("mkfifo", [root + "/p"]);
ok("fileInfo file/link/fifo", OS.fileInfo(root + "/f")?.kind === "file" && OS.fileInfo(root + "/l")?.kind === "link" && OS.fileInfo(root + "/p")?.kind === "fifo", "");

// absent + create → 0700, ours
const run = root + "/run";
ok("create", secureDir(run, uid, info, true) === "", secureDir(run, uid, info, true));
const ri0 = OS.fileInfo(run);
ok("created 0700, ours", ri0 !== null && ri0.kind === "dir" && ri0.mode === 0o700 && ri0.uid === uid, JSON.stringify(ri0));
ok("absent without create → reason", secureDir(root + "/none", uid, info, false) !== "" && !existsSync(root + "/none"), "");
// group/other bits: refused, never chmodded, contents intact
const g = root + "/grp"; mkdirSync(g); chmodSync(g, 0o750); writeFileSync(g + "/keep", "k");
const rg = secureDir(g, uid, info, true);
ok("0750 refused", rg.indexOf("group/other") >= 0, rg);
ok("0750 left alone", OS.fileInfo(g)?.mode === 0o750 && existsSync(g + "/keep"), "");
// a symlink: refused, target and link untouched
const tgt = root + "/tgt"; mkdirSync(tgt, { mode: 0o700 }); chmodSync(tgt, 0o700); writeFileSync(tgt + "/t", "t");
execFileSync("ln", ["-s", tgt, root + "/lnk"]);
const rl = secureDir(root + "/lnk", uid, info, true);
ok("symlink refused", rl.indexOf("symlink") >= 0, rl);
ok("symlink left alone", OS.fileInfo(root + "/lnk")?.kind === "link" && existsSync(tgt + "/t"), "");
// a foreign owner (stubbed): refused, nothing created or removed
const foreign: InfoFn = (p: string): FInfo | null => { const r = OS.fileInfo(p); return r ? { uid: uid + 1, mode: r.mode, kind: r.kind } : null; };
const rf = secureDir(run, uid, foreign, true);
ok("foreign owner refused", rf.indexOf("owned by uid") >= 0 && existsSync(run), rf);
// a regular file where the dir should be
ok("not a directory", secureDir(root + "/f", uid, info, true).indexOf("not a directory") >= 0, "");

// lock
ok("first takeLock → 1", takeLock(run, process.pid, uid, info, alive, yes) === 1, "");
const li = OS.fileInfo(run + "/tui.lock");
ok("lock 0600, our pid", li !== null && li.mode === 0o600 && readFileSync(run + "/tui.lock", "utf8").trim() === String(process.pid), JSON.stringify(li));
ok("live agentglass holder → 0", takeLock(run, 99999999, uid, info, alive, yes) === 0, "");
ok("lockHolder = us", lockHolder(run, uid, info, alive, yes) === process.pid, String(lockHolder(run, uid, info, alive, yes)));
// a dead holder (an exited child's pid) → stale takeover
const dead = Number(execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim()); // has exited
writeFileSync(run + "/tui.lock", String(dead) + "\n"); chmodSync(run + "/tui.lock", 0o600);
ok("dead holder → no holder", lockHolder(run, uid, info, alive, yes) === 0, "");
ok("stale takeover → 1", takeLock(run, process.pid, uid, info, alive, yes) === 1 && readFileSync(run + "/tui.lock", "utf8").trim() === String(process.pid), "");
// alive but not agentglass → takeover
ok("alive, not ours → takeover", takeLock(run, 4242, uid, info, alive, no) === 1 && readFileSync(run + "/tui.lock", "utf8").trim() === "4242", "");
ok("holdsLock: replaced by 4242 → we do not", !holdsLock(run, process.pid, uid, info) && holdsLock(run, 4242, uid, info), "");
// releaseLock only with our pid in the file
releaseLock(run, process.pid); ok("release with another pid in the file → stays", existsSync(run + "/tui.lock"), "");
releaseLock(run, 4242); ok("release with ours → gone", !existsSync(run + "/tui.lock"), "");
// a symlinked lock → -1, the link and its target untouched
execFileSync("ln", ["-s", "/etc/passwd", run + "/tui.lock"]);
const before = readFileSync("/etc/passwd", "utf8");
ok("symlink lock → -1", takeLock(run, process.pid, uid, info, alive, yes) === -1, "");
ok("symlink lock untouched", OS.fileInfo(run + "/tui.lock")?.kind === "link" && readFileSync("/etc/passwd", "utf8") === before, "");
ok("lockHolder of a symlinked lock → 0", lockHolder(run, uid, info, alive, yes) === 0, "");
rmSync(run + "/tui.lock");
// a foreign-owned lock (stubbed) → -1, not unlinked
writeFileSync(run + "/tui.lock", "1\n"); chmodSync(run + "/tui.lock", 0o600);
ok("foreign lock → -1", takeLock(run, process.pid, uid, foreign, alive, yes) === -1 && existsSync(run + "/tui.lock"), "");
rmSync(run + "/tui.lock");

// two servers started at once: exactly one takes the lock
const rc = root + "/race"; secureDir(rc, uid, info, true);
const outs: string[] = []; let done = 0; let round = 0;
race();
function race(): void { for (let i = 0; i < 2; i++) {
  const ch = spawn(process.execPath, ["--race", rc], { stdio: ["ignore", "pipe", "ignore"] });
  let o = ""; const so = ch.stdout; if (so) so.on("data", (d: Uint8Array) => { o += new TextDecoder().decode(d); });
  ch.on("exit", () => { outs.push(o.trim()); done++; if (done === 2) finish(); });
} }
function finish(): void {
  const ones = outs.filter((x: string) => x === "race 1").length;
  ok("concurrent: exactly one serves", ones === 1 && outs.length === 2, JSON.stringify(outs));
  if (round === 0) { // again over a stale lock (a dead pid): both see it stale, still exactly one takes over
    round = 1; outs.length = 0; done = 0;
    const dead2 = Number(execFileSync("sh", ["-c", "echo $$"], { encoding: "utf8" }).trim());
    rmSync(rc + "/tui.lock", { force: true }); writeFileSync(rc + "/tui.lock", String(dead2) + "\n"); chmodSync(rc + "/tui.lock", 0o600);
    setTimeout(race, 900); // the first round's children hold the lock for 800 ms
    return;
  }
  rmSync(root, { recursive: true, force: true });
  console.log(bad ? bad + " failed" : "rundir: all checks passed");
  process.exit(bad ? 1 : 0);
}
}
