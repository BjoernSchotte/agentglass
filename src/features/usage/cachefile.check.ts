// agentglass — self-check for the streamed ledger cache file: scriptc build src/features/usage/cachefile.check.ts -o cf && ./cf
// SPDX-License-Identifier: Apache-2.0
import { readCache, writeCache, isTmpOf, FILE_FORMAT } from "./cachefile.ts";
import { type Obj, str } from "../../util/json.ts";
import { mkdirSync, writeFileSync, existsSync, rmSync, chmodSync, readdirSync } from "node:fs";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-cf-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
const f = dir + "/ledger.jsonl";
const big = "x".repeat(5 * 1048576); // a line over the 4 MB window
ok("write", writeCache(f, { v: 15, prices: "P", kiro: 0, rl: null, sk: 0 }, (put) => { put("/a", { off: 1 }); put("/b", { off: 2, s: big }); put("/c", { off: 3 }); put("/e", {}); }), "false");
function tmps(): string { return readdirSync(dir).filter((n: string) => isTmpOf(f, n)).join(","); }
ok("no tmp left", tmps() === "", tmps());
const got: string[] = [];
const r = readCache(f, (h) => h.v === 15 && h.prices === "P", (p: string, o: Obj) => { got.push(p + ":" + String(o["off"]) + (o["s"] ? ":" + String(str(o["s"]).length) : "")); });
ok("all sessions, long line included", got.join(",") === "/a:1,/b:2:5242880,/c:3,/e:undefined" && r.bad === 0 && r.lines === 4, got.join(",") + " bad=" + String(r.bad));
writeFileSync(f, '{"v":15,"f":' + String(FILE_FORMAT) + ',"prices":"P"}\n{"path":"/a","off":1}\n{"path":"/b","off":\n{"off":9}\n{"path":"/c","off":3}\n');
const g2: string[] = []; const r2 = readCache(f, (h) => true, (p: string, o: Obj) => { g2.push(p); });
ok("corrupt and pathless lines skipped", g2.join(",") === "/a,/c" && r2.bad === 2, g2.join(",") + " bad=" + String(r2.bad));
const g3: string[] = []; readCache(f, (h) => false, (p: string, o: Obj) => { g3.push(p); });
ok("stale header stops", g3.length === 0, g3.join(","));
// a torn last line (crash of a writer that did not use the temp file, a truncated copy): only that session is lost
writeFileSync(f, '{"v":15,"f":2,"prices":"P"}\n{"path":"/a","off":1}\n{"path":"/c","of');
const g4: string[] = []; const r4 = readCache(f, (h) => true, (p: string, o: Obj) => { g4.push(p); });
ok("torn last line", g4.join(",") === "/a" && r4.bad === 1, g4.join(",") + " bad=" + String(r4.bad));
// the old single-object file or another format is not read as lines
writeFileSync(f, '{"v":15,"prices":"P","sessions":{}}\n');
const g5: string[] = []; readCache(f, (h) => true, (p: string, o: Obj) => { g5.push(p); });
ok("no format, no lines", g5.length === 0, g5.join(","));
// a line over the largest window (64 MB) is skipped, the next one still read
writeFileSync(f, '{"v":15,"f":2,"prices":"P"}\n{"path":"/h","s":"' + "y".repeat(65 * 1048576) + '"}\n{"path":"/n","off":7}\n');
const g6: string[] = []; const r6 = readCache(f, (h) => true, (p: string, o: Obj) => { g6.push(p); });
ok("over-long line skipped", g6.join(",") === "/n" && r6.bad === 1, g6.join(",") + " bad=" + String(r6.bad));
ok("missing file", readCache(dir + "/none.jsonl", (h) => true, (p: string, o: Obj) => { bad++; }).lines === 0, "lines");
// two writers at once (a TUI and a CLI run saving the same cache): each renames a whole file of its own, the last one
// wins; a shared temp name let the second truncate the first's file mid-write and spliced lines of both into the cache
const pad = "z".repeat(2 * 1048576); // past the 1 MB write buffer: the outer writer flushes after the inner one renamed
const outer = writeCache(f, { v: 15, prices: "P", kiro: 0, rl: null, sk: 0 }, (put) => {
  put("/o1", { off: 1 });
  ok("inner writer", writeCache(f, { v: 15, prices: "P", kiro: 0, rl: null, sk: 0 }, (p2) => { p2("/i1", { off: 5 }); p2("/i2", { off: 6 }); }), "false");
  put("/o2", { off: 2, s: pad });
});
const g7: string[] = []; const r7 = readCache(f, (h) => true, (p: string, o: Obj) => { g7.push(p + ":" + String(o["off"])); });
ok("concurrent writers: one whole file", outer && g7.join(",") === "/o1:1,/o2:2" && r7.bad === 0, String(outer) + " " + g7.join(",") + " bad=" + String(r7.bad));
ok("concurrent writers: no tmp left", tmps() === "", tmps());
// an unwritable dir: false, nothing left behind
const ro = dir + "/ro"; mkdirSync(ro); chmodSync(ro, 0o500);
const w = writeCache(ro + "/ledger.jsonl", { v: 15, prices: "P", kiro: 0, rl: null, sk: 0 }, (put) => { put("/a", { off: 1 }); });
ok("unwritable: false", !w || process.getuid?.() === 0, String(w));
chmodSync(ro, 0o700);
rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "cachefile: all checks passed");
if (bad) process.exit(1);
