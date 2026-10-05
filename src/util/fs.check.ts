// agentglass — self-check for the session scans' cached directory listing: scriptc build src/util/fs.check.ts -o fsc && ./fsc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { listDirCached, FS_CLOCK, FS_STATS, WAKE_ALL } from "./fs.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-fs-check-" + String(process.pid);
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/a.jsonl", "x\n");
const T = 1700000000000;
// the directory's mtime, whole seconds (no utimes in scriptc: touch, ISO form for GNU and BSD alike)
function setDirTime(ms: number): void { execFileSync("touch", ["-m", "-d", new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19) + "Z", dir]); }
function names(): string { return listDirCached(dir).slice().sort().join(","); }
let now = T; FS_CLOCK.now = (): number => now;
setDirTime(T - 10000);

let n0 = FS_STATS.lists;
eq("first listing", names(), "a.jsonl"); eq("listed", String(FS_STATS.lists - n0), "1");
now += 3000; n0 = FS_STATS.lists;
eq("unchanged dir, 3 s later", names(), "a.jsonl"); eq("cached", String(FS_STATS.lists - n0), "0");
// a new entry moves the directory's mtime: listed again
writeFileSync(dir + "/b.jsonl", "y\n"); setDirTime(now - 5000); n0 = FS_STATS.lists;
eq("new file seen", names(), "a.jsonl,b.jsonl"); eq("listed after an mtime move", String(FS_STATS.lists - n0), "1");
// a directory changed within the last 2 s is listed every time (coarse mtimes: two changes in one tick)
setDirTime(now - 500); names(); n0 = FS_STATS.lists;
writeFileSync(dir + "/c.jsonl", "z\n"); setDirTime(now - 500); // same mtime as the listing before
eq("fresh dir: listed although mtime is the same", names(), "a.jsonl,b.jsonl,c.jsonl"); eq("fresh: listed", String(FS_STATS.lists - n0), "1");
n0 = FS_STATS.lists; names(); eq("fresh: listed each time", String(FS_STATS.lists - n0), "1");
// a filesystem whose directory mtime does not move: the new entry shows within a minute anyway
now += 3000; setDirTime(now - 5000); names(); // listed with this mtime
const mt = statSync(dir).mtimeMs; writeFileSync(dir + "/d.jsonl", "w\n"); setDirTime(mt); // the mtime "did not move"
n0 = FS_STATS.lists; now += 30000; eq("within a minute: cached", names(), "a.jsonl,b.jsonl,c.jsonl"); eq("not listed", String(FS_STATS.lists - n0), "0");
now += 31000; n0 = FS_STATS.lists; eq("after a minute: listed again", names(), "a.jsonl,b.jsonl,c.jsonl,d.jsonl"); eq("relisted", String(FS_STATS.lists - n0), "1");
// aged (no new entries expected): looked at once a minute only; a missing aged dir is remembered as missing as long
let st0 = FS_STATS.stats; now += 1000; names(); listDirCached(dir, 0); eq("aged right after a listing: no stat", String(FS_STATS.stats - st0 - 1), "0");
writeFileSync(dir + "/e.jsonl", "v\n"); setDirTime(now - 3000);
now += 30000; eq("aged within a minute: old listing", listDirCached(dir, 0).slice().sort().join(","), "a.jsonl,b.jsonl,c.jsonl,d.jsonl");
now += 31000; eq("aged after a minute: listed", listDirCached(dir, 0).slice().sort().join(","), "a.jsonl,b.jsonl,c.jsonl,d.jsonl,e.jsonl");
st0 = FS_STATS.stats; eq("aged missing", String(listDirCached(dir + "/nope", 0).length + listDirCached(dir + "/nope", 0).length), "0");
eq("aged missing: one stat", String(FS_STATS.stats - st0), "1");
// quiet for a day: a directory changed within the day is looked at every time
now += 61000; setDirTime(now - 5000); listDirCached(dir, 86400000); st0 = FS_STATS.stats; listDirCached(dir, 86400000);
eq("changed within the quiet span: stat", String(FS_STATS.stats - st0), "1");
// a new agent wakes every quiet directory for a minute
listDirCached(dir, 86400000); WAKE_ALL.at = now; st0 = FS_STATS.stats; listDirCached(dir, 0);
eq("woken: quiet dir looked at", String(FS_STATS.stats - st0), "1"); WAKE_ALL.at = 0;
// a missing directory lists as [] and is forgotten
rmSync(dir, { recursive: true, force: true });
eq("gone", names(), "");
mkdirSync(dir, { recursive: true }); setDirTime(now - 10000);
eq("back, empty", names(), "");

rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "fs: all checks passed");
if (bad) process.exit(1);
