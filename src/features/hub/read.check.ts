// agentglass — self-check for the hub file reader: scriptc build src/features/hub/read.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, appendFileSync, renameSync, chmodSync, unlinkSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { gzip, writeBin } from "../../util/gzip.ts";
import { newSource, readStep, scanFiles, saveState, loadState, trustOf, type Source } from "./read.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const d = join(HOME, "src"); mkdirSync(join(d, "ci"), { recursive: true });
process.env["AGENTGLASS_FLEET_DIR"] = join(HOME, "fleet");
const L = (tag: string, n: number): string => { let s = ""; for (let i = 0; i < n; i++) s += "{\"resourceSpans\":[],\"x\":\"" + tag + String(i) + "\"}\n"; return s; };
const mk = (p: string, t: string): void => { writeFileSync(p, t); chmodSync(p, 0o600); };
mk(join(d, "a.jsonl"), L("a", 5)); mk(join(d, "b.jsonl"), L("b", 3));
let got: string[] = [];
const sink = (l: string, f: string): void => { got.push(l); };
const src: Source = newSource("t", d, "", 30);
let r = readStep(src, 1 << 20, 4, sink);
ok("budget 4 lines", r.lines === 4 && got.length === 4 && src.backlog, String(r.lines));
r = readStep(src, 1 << 20, 4, sink); ok("next 4", r.lines === 4 && got.length === 8 && !src.backlog, String(r.lines) + " backlog " + String(src.backlog));
r = readStep(src, 1 << 20, 4, sink); ok("then 0", r.lines === 0, String(r.lines));
ok("each line once", new Set(got).size === 8, JSON.stringify(got));
appendFileSync(join(d, "a.jsonl"), L("a2-", 2));
appendFileSync(join(d, "a.jsonl"), "{\"partial\":"); // a line still being written
r = readStep(src, 1 << 20, 100, sink); ok("appended 2, partial not read", r.lines === 2 && got.length === 10, String(r.lines));
appendFileSync(join(d, "a.jsonl"), "1}\n");
r = readStep(src, 1 << 20, 100, sink); ok("partial completed", r.lines === 1 && got[got.length - 1] === "{\"partial\":1}", got[got.length - 1] ?? "");
// rotation: renamed (same inode) → nothing again; a new file at the old name → read
renameSync(join(d, "a.jsonl"), join(d, "a-2026-10-06T09-20-58.479-size.jsonl"));
r = readStep(src, 1 << 20, 100, sink); ok("rename: nothing re-read", r.lines === 0, String(r.lines));
mk(join(d, "a.jsonl"), L("new", 2));
r = readStep(src, 1 << 20, 100, sink); ok("new file at the old name", r.lines === 2, String(r.lines));
// a rewritten head restarts at 0; a shrunk file too
mk(join(d, "b.jsonl"), L("B", 3));
r = readStep(src, 1 << 20, 100, sink); ok("rewritten head → from 0", r.lines === 3 && got[got.length - 1]?.indexOf("B2") !== -1, String(r.lines));
// gzip: read whole once; a compressed copy of a file already read continues at its offset (receive's closed days)
const gzText = L("g", 4);
writeBin(join(d, "c.jsonl.gz"), gzip(new TextEncoder().encode(gzText)));
r = readStep(src, 1 << 20, 100, sink); ok("gzip lines once", r.lines === 4, String(r.lines));
r = readStep(src, 1 << 20, 100, sink); ok("gzip not again", r.lines === 0, String(r.lines));
mk(join(d, "ci", "traces-20261005.jsonl"), L("day", 3));
r = readStep(src, 1 << 20, 100, sink); ok("subdirectory", r.lines === 3, String(r.lines));
const day = readFileSync(join(d, "ci", "traces-20261005.jsonl"), "utf8") + L("late", 2);
writeBin(join(d, "ci", "traces-20261005.jsonl.gz"), gzip(new TextEncoder().encode(day)));
unlinkSync(join(d, "ci", "traces-20261005.jsonl"));
r = readStep(src, 1 << 20, 100, sink); ok("compressed copy: only the unread rest", r.lines === 2 && (got[got.length - 1] ?? "").indexOf("late1") >= 0, String(r.lines));
// two gzip files: one per pass
writeBin(join(d, "d.jsonl.gz"), gzip(new TextEncoder().encode(L("d", 1)))); writeBin(join(d, "e.jsonl.gz"), gzip(new TextEncoder().encode(L("e", 1))));
r = readStep(src, 1 << 20, 100, sink); ok("one gzip per pass", r.lines === 1 && src.backlog, String(r.lines));
r = readStep(src, 1 << 20, 100, sink); ok("the second next pass", r.lines === 1, String(r.lines));
// unsafe files are skipped with a reason
mk(join(d, "w.jsonl"), L("w", 2)); chmodSync(join(d, "w.jsonl"), 0o664);
r = readStep(src, 1 << 20, 100, sink); ok("group-writable skipped", r.lines === 0 && (src.skipped.get(join(d, "w.jsonl")) ?? "").indexOf("chmod go-w") >= 0, JSON.stringify([...src.skipped.values()]));
ok("scan lists no unsafe file", scanFiles(src).indexOf(join(d, "w.jsonl")) < 0, "listed");
unlinkSync(join(d, "w.jsonl"));
// a byte budget spreads a backlog over passes
const big = newSource("big", join(HOME, "big"), "", 30); mkdirSync(big.dir, { recursive: true }); mk(join(big.dir, "x.jsonl"), L("x", 10000));
let passes = 0; let total = 0; got = [];
for (; passes < 50; passes++) { const q = readStep(big, 2 * 1048576, 2000, sink); total += q.lines; if (!big.backlog) break; }
ok("10,000 lines over ≥ 5 passes", total === 10000 && passes >= 4, String(total) + " in " + String(passes + 1));
// older than maxAgeDays on first sight: not read; a line over 16 MB: skipped, the next one read
const old = newSource("old", join(HOME, "old"), "", 30); mkdirSync(old.dir, { recursive: true }); mk(join(old.dir, "o.jsonl"), L("o", 3));
execFileSync("touch", ["-t", "202001011200", join(old.dir, "o.jsonl")]); // scriptc has no utimesSync
got = []; r = readStep(old, 1 << 20, 100, sink); ok("old file not read", r.lines === 0, String(r.lines));
appendFileSync(join(old.dir, "o.jsonl"), L("fresh", 1));
r = readStep(old, 1 << 20, 100, sink); ok("but what is appended later", r.lines === 1, String(r.lines));
mk(join(old.dir, "huge.jsonl"), "{\"x\":\"" + "y".repeat(17 * 1048576) + "\"}\n" + L("after-huge", 1));
got = []; for (let i = 0; i < 20 && got.length === 0; i++) readStep(old, 2 * 1048576, 2000, sink);
ok("16 MB line skipped, next read (long legal lines below)", got.length === 1 && (got[0] ?? "").indexOf("after-huge0") >= 0, String(got.length));
mk(join(old.dir, "long.jsonl"), "{\"x\":\"" + "z".repeat(3 * 1048576) + "\"}\n");
got = []; for (let i = 0; i < 5 && got.length === 0; i++) readStep(old, 2 * 1048576, 2000, sink);
ok("a 3 MB line is read whole", got.length === 1 && (got[0] ?? "").length === 3 * 1048576 + 8, String((got[0] ?? "").length));
// state round trip: a restart resumes exactly
appendFileSync(join(d, "a.jsonl"), L("after", 1));
ok("save", saveState(src, ["{\"agg\":1}"]) === "", "error");
const back = newSource("t", d, "", 30);
const body = loadState(back);
ok("load", body !== null && body.length === 1 && body[0] === "{\"agg\":1}", JSON.stringify(body));
got = []; r = readStep(back, 1 << 20, 100, sink);
ok("resume: only the new line", r.lines === 1 && (got[0] ?? "").indexOf("after0") >= 0, JSON.stringify(got));
ok("other dir: no resume", loadState(newSource("t", join(HOME, "other"), "", 30)) === null, "loaded");
// trust by directory; the Collector sample parses
writeFileSync(join(d, "tokens"), ""); ok("trust label in a receive dir", trustOf(d, "") === "label" && trustOf(big.dir, "") === "payload" && trustOf(d, "payload") === "payload", trustOf(d, ""));
if (bad) console.log(String(bad) + " failed"); else console.log("hub read: all checks passed");
if (bad) process.exit(1);
