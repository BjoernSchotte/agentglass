// agentglass — self-check for dir hosts (fleet spec 15): the writer's base + delta files, the reader's chain, gaps and
// out-of-order syncs, unsafe files, pruning. scriptc build src/features/fleet/drop.check.ts -o dc && ./dc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, appendFileSync, readdirSync, renameSync, chmodSync, copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { OS } from "../../platform/index.ts";
import type { FileInfo } from "../../platform/types.ts";
import type { HostCfg, FleetCfg } from "./config.ts";
import type { FeedState, HostReport, SessRow } from "./model.ts";
import { type DropFile, dropOnce, dropFiles, prune, DAY } from "./drop.ts";
import { dirFeed, DIRTEST, GAP_MS, unsafe } from "./dirfeed.ts";
import { buildSnap } from "./snapshot.ts";
import { applySnap } from "./snap.ts";
import { hostId } from "../../util/hostid.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "cache");
process.env["AGENTGLASS_FLEET_DIR"] = join(HOME, "fl", "fleet");
const p = join(HOME, ".claude", "projects", "-w-app"); mkdirSync(p, { recursive: true });
const now0 = Date.now(); const iso = (m: number): string => new Date(now0 - m * 60000).toISOString();
function user(id: string, ts: string): string { return '{"type":"user","sessionId":"' + id + '","cwd":"/w/app","timestamp":"' + ts + '","message":{"role":"user","content":"fix the keepme bug"}}\n'; }
function asst(id: string, mid: string, ts: string, inp: number): string {
  return '{"type":"assistant","sessionId":"' + id + '","timestamp":"' + ts + '","message":{"id":"' + mid + '","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":' + String(inp) + ',"output_tokens":10}}}\n';
}
writeFileSync(join(p, "s1.jsonl"), user("s1", iso(50)) + asst("s1", "m1", iso(50), 100));
const drop = join(HOME, "Sync", "nas"); // the synced folder on the host
const view = join(HOME, "view", "nas"); mkdirSync(view, { recursive: true, mode: 0o700 }); // its copy on the viewer
function two(n: number): string { return (n < 10 ? "0" : "") + String(n); }
function touchAt(path: string, ms: number): void { const d = new Date(ms); execFileSync("touch", ["-t", String(d.getFullYear()) + two(d.getMonth() + 1) + two(d.getDate()) + two(d.getHours()) + two(d.getMinutes()) + "." + two(d.getSeconds()), path]); }
function names(d: string): string[] { return readdirSync(d).filter((n: string) => n.endsWith(".snap.gz")).sort(); }
function sync(only: string[] | null): void { for (const n of names(drop)) if (!only || only.indexOf(n) >= 0) { copyFileSync(join(drop, n), join(view, n)); chmodSync(join(view, n), 0o600); } }

// the writer: base, then two deltas as the history changes
const r1 = dropOnce(drop, 7, Date.now());
appendFileSync(join(p, "s1.jsonl"), asst("s1", "m2", iso(10), 200));
const r2 = dropOnce(drop, 7, Date.now());
writeFileSync(join(p, "s2.jsonl"), user("s2", iso(5)) + asst("s2", "m3", iso(5), 300));
const r3 = dropOnce(drop, 7, Date.now());
const id = hostId();
ok("1 base + 2 deltas", !r1.err && !r2.err && !r3.err && r1.name.startsWith(id + ".base-") && r2.name.startsWith(id + ".delta-1-") && r3.name.startsWith(id + ".delta-2-"), [r1.name, r2.name, r3.name, r1.err].join(" "));
const mi = OS.fileInfo(join(drop, r2.name));
ok("files 0600", mi !== null && (mi.mode & 0o077) === 0, mi ? String(mi.mode) : "missing");
ok("no temp files left", readdirSync(drop).every((n: string) => !n.endsWith(".tmp")), readdirSync(drop).join(","));

// the reader, in TUI pace (one file per poll)
const h: HostCfg = { name: "nas", ssh: "", agentglass: "", redact: false, enabled: true, kind: "dir", path: view, snapshot: true, watch: false };
const f: FleetCfg = { hosts: [h], localName: "local", refreshS: 60, days: 7, timeoutS: 90, reprice: true, warns: [] };
function settle(fd: { poll(t: number): FeedState }, t: number): FeedState { let s = fd.poll(t); for (let i = 0; i < 10; i++) s = fd.poll(t + (i + 1) * 6000); return s; }
const keys = (r: HostReport | null): string => r ? r.sessions.map((s: SessRow) => s.key + ":" + String(s.s["costUsd"] ?? "")).sort().join(",") : "null";
// out of order: delta 2 synced before delta 1 → the reader stays at the base, then catches up
sync([r1.name, r3.name]);
const fd = dirFeed(h, f, 256); let t = Date.now();
let s = settle(fd, t);
ok("gap: the base only", !!s.report && s.report.sessions.length === 1 && s.code === "ok", keys(s.report));
sync(null); t += 60000;
s = settle(fd, t);
const truth = applySnap(null, buildSnap(7, null, Date.now()).snap);
ok("chain complete = the writer's state", keys(s.report) === keys(truth) && !!s.report && s.report.exact, keys(s.report) + " vs " + keys(truth));
// a delta missing for over an hour: the state before it, and the status says so
const fd2 = dirFeed(h, f, 256);
const view2 = join(HOME, "view", "nas2"); mkdirSync(view2, { recursive: true, mode: 0o700 });
for (const n of [r1.name, r3.name]) { copyFileSync(join(drop, n), join(view2, n)); chmodSync(join(view2, n), 0o600); }
const h2: HostCfg = { name: "nas2", ssh: "", agentglass: "", redact: false, enabled: true, kind: "dir", path: view2, snapshot: true, watch: false };
const fg = dirFeed(h2, f, 256); t = Date.now();
settle(fg, t); s = settle(fg, t + GAP_MS + 60000);
ok("an hour-long gap: says so", s.code === "gap" && s.err.indexOf("delta 1 missing") >= 0 && !!s.report && s.report.sessions.length === 1, s.code + " " + s.err);
void fd2;
// a group-writable file is refused; a file of another user too (stubbed: no root needed)
const gw = join(HOME, "gw.snap.gz"); writeFileSync(gw, "x"); chmodSync(gw, 0o664);
ok("group-writable refused", unsafe(gw) === "group- or world-writable", unsafe(gw));
const real = DIRTEST.info;
DIRTEST.info = (q: string): FileInfo | null => { const i = real(q); return i ? { uid: i.uid + 1, mode: i.mode, kind: i.kind } : null; };
ok("another owner refused", unsafe(join(view, r1.name)).indexOf("owned by another user") === 0, unsafe(join(view, r1.name)));
const view3 = join(HOME, "view", "nas3"); mkdirSync(view3, { recursive: true, mode: 0o700 }); copyFileSync(join(drop, r1.name), join(view3, r1.name)); chmodSync(join(view3, r1.name), 0o600);
const fo = dirFeed({ name: "nas3", ssh: "", agentglass: "", redact: false, enabled: true, kind: "dir", path: view3, snapshot: true, watch: false }, f, 256);
s = settle(fo, Date.now());
ok("a foreign-owned base: refused with a status", s.report === null && s.code === "refused" && s.err.indexOf("owned by another user") >= 0, s.code + " " + s.err);
DIRTEST.info = real;
// a bomb: the gzip trailer claims more than 256 MB → refused unread
const bomb = join(view3, id + ".base-00000000000000bb.snap.gz"); const zb = new Uint8Array(20); zb[0] = 0x1f; zb[1] = 0x8b; zb[16] = 0; zb[17] = 0; zb[18] = 0; zb[19] = 0x20; writeFileSync(bomb, zb); chmodSync(bomb, 0o600);
const fb = dirFeed({ name: "nas4", ssh: "", agentglass: "", redact: false, enabled: true, kind: "dir", path: view3, snapshot: true, watch: false }, f, 256);
touchAt(bomb, Date.now() + 60000);
s = settle(fb, Date.now());
ok("a zip bomb is refused (the older base stands)", s.err.indexOf("256 MB") >= 0 && !!s.report, s.code + " " + s.err);
// a bomb whose trailer lies: 300 gzip members of 1 MB of zeros each (the last trailer says 1 MB); the inflate stops at
// 256 MB instead of decoding all of it
const one = gzipSync(new Uint8Array(1048576)); const many = new Uint8Array(one.length * 300); for (let i = 0; i < 300; i++) many.set(one, i * one.length);
const liar = join(view3, id + ".base-00000000000000bc.snap.gz"); writeFileSync(liar, many); chmodSync(liar, 0o600);
const fl = dirFeed({ name: "nas5", ssh: "", agentglass: "", redact: false, enabled: true, kind: "dir", path: view3, snapshot: true, watch: false }, f, 256);
touchAt(liar, Date.now() + 120000);
s = settle(fl, Date.now());
ok("a bomb with a lying trailer is refused at the cap (the older base stands)", s.err.indexOf("256 MB") >= 0 && !!s.report, s.code + " " + s.err);
// pruning: after a day, deltas older than the newest base go; the newest base and its deltas stay
const files = dropFiles(drop, id);
const later = Date.now() + 25 * 3600000;
const base2 = dropOnce(drop, 7, later); // a new day: a new base
ok("a new day: a new base", base2.name.indexOf(".base-") > 0, base2.name);
const old = Date.now() - 2 * DAY; for (const x of files) touchAt(join(drop, x.name), old);
const gone = prune(drop, dropFiles(drop, id), Date.now());
ok("pruned: the old deltas (the previous base stays)", gone.length === 2 && gone.every((n: string) => n.indexOf(".delta-") > 0) && existsSync(join(drop, r1.name)), gone.join(","));

if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("fleet drop: all checks passed");
