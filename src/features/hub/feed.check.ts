// agentglass — self-check for hub sources as fleet hosts: scriptc build src/features/hub/feed.check.ts -o fc && ./fc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, chmodSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { type HubHost, hubSource, sanitizeName } from "./feed.ts";
import { lenOf } from "../fleet/ownc.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const SAMPLE = readFileSync("testdata/hub/collector-sample.jsonl", "utf8").trim();
const mk = (p: string, t: string): void => { writeFileSync(p, t); chmodSync(p, 0o600); };
const big = { bytes: 1 << 30, lines: 1 << 30 };
ok("sanitize", sanitizeName("Bjoerns-MacBook.local") === "bjoerns-macbook" && sanitizeName("-x_y-") === "x-y" && sanitizeName("___") === "" && sanitizeName("a".repeat(30)).length === 16, sanitizeName("Bjoerns-MacBook.local"));
// a receive directory: one directory per host, the label names it
const rd = join(HOME, "hub"); mkdirSync(join(rd, "ci"), { recursive: true }); mkdirSync(join(rd, "lap"), { recursive: true });
mk(join(rd, "tokens"), "");
mk(join(rd, "ci", ".host"), "{\"name\":\"ci\",\"hostId\":\"00112233445566ff\",\"since\":1}\n");
mk(join(rd, "ci", "traces-20260901.jsonl"), SAMPLE + "\n");
mk(join(rd, "lap", "traces-20260901.jsonl"), SAMPLE.split("00112233445566ff").join("aaaaaaaaaaaaaaaa") + "\n");
mk(join(rd, "stray.jsonl"), SAMPLE + "\n"); mk(join(rd, "status.json"), "{\"pid\":1}\n");
const s1 = hubSource("hub", { dir: rd, names: new Map<string, string>(), trust: "", maxAgeDays: 3650, includeNative: false });
const got = s1.poll(Date.now(), { bytes: 1 << 30, lines: 1 << 30 });
const names = got.map((h) => h.name).sort().join(",");
ok("two hosts, named by their directories", names === "ci,lap", names);
const ci = got.find((h) => h.name === "ci");
ok("host id from .host", ci !== undefined && ci.hostId === "00112233445566ff" && ci.state.report !== null && ci.state.report.sessions.length === 1, JSON.stringify(ci?.hostId));
ok("files in the root of a receive directory are not read (status.json, strays)", s1.status().join("\n").indexOf("outside a host directory") < 0, s1.status().join("|"));
ok("nothing new: no hosts returned", s1.poll(Date.now(), big).length === 0, "returned");
// a Collector directory: host = host.id; names from the hosts map, host.name, else <source>-<6 hex>
const cd = join(HOME, "otel"); mkdirSync(cd, { recursive: true });
const withName = SAMPLE.split("{\"key\":\"host.id\"").join("{\"key\":\"host.name\",\"value\":{\"stringValue\":\"Build-Box.example\"}},{\"key\":\"host.id\"").split("00112233445566ff").join("bbbbbbbbbbbbbbbb");
mk(join(cd, "spans.jsonl"), SAMPLE + "\n" + withName + "\n" + SAMPLE.split("00112233445566ff").join("cccccccccccccccc") + "\n");
const s2 = hubSource("team", { dir: cd, names: new Map<string, string>([["cccccccccccccccc", "ci2"]]), trust: "", maxAgeDays: 3650, includeNative: false });
const g2 = s2.poll(Date.now(), big).map((h) => h.name).sort().join(",");
ok("derived names", g2 === "build-box,ci2,team-001122", g2);
// a backlog is read over several polls, busy meanwhile
const bd = join(HOME, "bl"); mkdirSync(bd, { recursive: true });
let lines = ""; for (let i = 0; i < 10000; i++) lines += SAMPLE.split("4e517d07a6c04666").join(String(1000000000000000 + i)) + "\n";
mk(join(bd, "spans.jsonl"), lines);
const s3 = hubSource("bl", { dir: bd, names: new Map<string, string>(), trust: "", maxAgeDays: 3650, includeNative: false });
let polls = 0; let busySeen = false;
for (; polls < 200; polls++) { s3.poll(Date.now(), { bytes: 2 * 1048576, lines: 2000 }); if (s3.busy()) busySeen = true; else break; }
ok("10,000 lines over ≥ 5 polls, busy meanwhile", polls >= 4 && busySeen, String(polls + 1) + " busy " + String(busySeen));
// persistence: a restart resumes from the state file (reports, span ids) without re-reading
process.env["AGENTGLASS_FLEET_DIR"] = join(HOME, "fleetstate");
function costOf(h: HubHost | undefined): string { if (!h || !h.state.report) return "none"; const ss = h.state.report.sessions; if (!ss.length) return "empty"; const x = ss[0]; return x ? JSON.stringify(x.s["costUsd"]) : "empty"; }
function ownedOf(h: HubHost | undefined): number { if (!h || !h.state.report) return -1; const o = h.state.report.owned; const x = o.length ? o[0] : undefined; return x ? lenOf(x.rows) : 0; }
const pd = join(HOME, "persist"); mkdirSync(pd, { recursive: true }); mk(join(pd, "spans.jsonl"), SAMPLE + "\n");
const p1 = hubSource("pst", { dir: pd, names: new Map<string, string>(), trust: "", maxAgeDays: 3650, includeNative: false });
const r1 = p1.poll(Date.now(), big)[0];
ok("persist: first read", costOf(r1) !== "none", "no host");
ok("persist: saved", p1.save(Date.now()) === "", "save failed");
const p2 = hubSource("pst", { dir: pd, names: new Map<string, string>(), trust: "", maxAgeDays: 3650, includeNative: false });
const r2 = p2.poll(Date.now(), big);
ok("persist: restored without re-reading, same name and totals", r2.length === 1 && r2[0]?.name === r1?.name && costOf(r2[0]) === costOf(r1) && ownedOf(r2[0]) === 6, costOf(r2[0]) + " owned " + String(ownedOf(r2[0])));
appendFileSync(join(pd, "spans.jsonl"), SAMPLE + "\n"); // a resend after the restart
const r3 = p2.poll(Date.now(), big);
ok("persist: a resend after the restart counts once", r3.length === 0 || costOf(r3[0]) === costOf(r1), costOf(r3[0]));
if (bad) console.log(String(bad) + " failed"); else console.log("hub feed: all checks passed");
if (bad) process.exit(1);
