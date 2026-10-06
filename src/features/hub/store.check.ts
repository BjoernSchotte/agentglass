// agentglass — self-check for receive storage: retention, disk budget, closed-day compression, appends: scriptc build src/features/hub/store.check.ts -o st && ./st
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME, readBytes } from "../../util/fs.ts";
import { gunzipCapped } from "../../util/inflate.ts";
import { enforce, compressClosed, appendReq, hostDir, utcDay, hubFiles } from "./store.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const mode = (p: string): string => execFileSync("stat", process.platform === "darwin" ? ["-f", "%Lp", p] : ["-c", "%a", p], { encoding: "utf8" }).trim();
const D = 86400000; const now = Date.UTC(2026, 9, 6, 12, 0, 0);
ok("utc day", utcDay(now) === "20261006" && utcDay(Date.UTC(2026, 0, 2, 23, 59)) === "20260102", utcDay(now));
const root = join(HOME, "hub"); mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
for (const h of ["a", "b"]) mkdirSync(join(root, h), { recursive: true, mode: 0o700 });
const kb = (n: number): string => "x".repeat(n * 1024);
// two hosts, 45 days of 20 KB each (traces), today 100 KB on a
for (let i = 1; i <= 45; i++) for (const h of ["a", "b"]) writeFileSync(join(root, h, "traces-" + utcDay(now - i * D) + ".jsonl"), kb(20));
writeFileSync(join(root, "a", "traces-" + utcDay(now) + ".jsonl"), kb(100));
writeFileSync(join(root, "a", "notes.txt"), "not ours");
const e = enforce(root, 1048576, 30, now);
ok("retention: > 30 days gone", !existsSync(join(root, "a", "traces-" + utcDay(now - 31 * D) + ".jsonl")) && !existsSync(join(root, "b", "traces-" + utcDay(now - 45 * D) + ".jsonl")), String(e.deleted.length));
ok("budget: under 90 %", e.used < 1048576 * 0.9 && e.used > 1048576 * 0.8, String(e.used));
ok("budget: oldest closed first", !existsSync(join(root, "b", "traces-" + utcDay(now - 30 * D) + ".jsonl")) && existsSync(join(root, "b", "traces-" + utcDay(now - 1 * D) + ".jsonl")), "order");
ok("today untouched", existsSync(join(root, "a", "traces-" + utcDay(now) + ".jsonl")) && !e.full && e.today === 102400, String(e.today));
ok("foreign files untouched", existsSync(join(root, "a", "notes.txt")), "deleted");
writeFileSync(join(root, "b", "logs-" + utcDay(now) + ".jsonl"), kb(1100));
const f = enforce(root, 1048576, 30, now);
ok("today alone over budget → full", f.full && existsSync(join(root, "b", "logs-" + utcDay(now) + ".jsonl")), JSON.stringify([f.full, f.today]));
ok("full: every closed file pruned", hubFiles(root).every((x) => x.day === utcDay(now)), String(hubFiles(root).length));
// compression of closed days: not before 01:00 UTC; the .gz reads back to the same bytes, 0600
const y = join(root, "a", "traces-" + utcDay(now - D) + ".jsonl");
const line = "{\"resourceSpans\":[]}\n".repeat(500);
writeFileSync(y, line);
ok("not in the first hour", compressClosed(root, Date.UTC(2026, 9, 6, 0, 30)) === 0 && existsSync(y), "compressed early");
ok("one per call", compressClosed(root, now) === 1, "none");
ok("closed day compressed", !existsSync(y) && existsSync(y + ".gz"), "missing");
const z = readBytes(y + ".gz", 0, 1 << 20); const back = gunzipCapped(z, 1 << 20);
ok("gz round trip", back.err === "" && new TextDecoder("utf-8").decode(back.out) === line, back.err);
ok("gz mode 0600", mode(y + ".gz") === "600", mode(y + ".gz"));
ok("today never compressed", compressClosed(root, now) === 0 && existsSync(join(root, "a", "traces-" + utcDay(now) + ".jsonl")), "today compressed");
// appends: host dir 0700 with .host, files 0600, a torn last line is ended first
ok("hostDir", hostDir(root, "c", "0011223344556677", now) === "" && mode(join(root, "c")) === "700" && readFileSync(join(root, "c", ".host"), "utf8").indexOf("\"hostId\":\"0011223344556677\"") >= 0, mode(join(root, "c")));
ok("hostDir refuses a bad root", hostDir(join(root, "a", "notes.txt"), "c", "", now) !== "", "accepted");
const cf = join(root, "c", "traces-" + utcDay(now) + ".jsonl");
writeFileSync(cf, "{\"torn"); chmodSync(cf, 0o600);
ok("append", appendReq(root, "c", "traces", "{\"a\":1}", now) === "" && readFileSync(cf, "utf8") === "{\"torn\n{\"a\":1}\n", JSON.stringify(readFileSync(cf, "utf8")));
ok("append mode", mode(cf) === "600", mode(cf));
ok("append to a new file", appendReq(root, "c", "logs", "{}", now) === "" && mode(join(root, "c", "logs-" + utcDay(now) + ".jsonl")) === "600", "mode");
ok("append failure reported", appendReq(root, "nohost", "logs", "{}", now) !== "", "no error");
if (bad) console.log(String(bad) + " failed"); else console.log("hub store: all checks passed");
if (bad) process.exit(1);
