// agentglass — self-check: skills per host for the fleet's skills panel (this machine's Accs, Part A skills[] entries,
// hiding on top): scriptc build src/features/skills/fleet.check.ts -o sf && ./sf
// SPDX-License-Identifier: Apache-2.0
import { newAcc, bucket, tokens, turn, skillLoad } from "../usage/record.ts";
import { type HostRow, hostRows } from "./fleet.ts";
import { setVis } from "./vis.ts";
import { type Obj, parse } from "../../util/json.ts";

let bad = 0;
function ok(what: string, c: boolean, info: string): void { if (!c) { bad++; console.log("FAIL " + what + (info ? ": " + info : "")); } }
setVis([], false);
const T = "LOREMSKILLTEXT" + "x".repeat(3586); const iso = "2026-10-01T09:00:00.000Z"; const M = "claude-sonnet-4-5";
const a = newAcc(); const d = bucket(a, 0, iso);
turn(a, 0, iso, 1); tokens(a, d, M, 0, 10, 0, 20000, 0);
skillLoad(a, "alpha", "user", 1, iso, T, true, "/h/.claude/skills/alpha", false);
tokens(a, d, M, 0, 10, 20000, 1500, 0); tokens(a, d, M, 0, 10, 21500, 100, 0);
const partA: Obj[] = []; const pa = parse('{"harness":"claude","id":"r1","skills":[{"name":"alpha","source":"command","n":2,"loads":2,"tokens":{"load":900,"carry":4000,"tail":100},"costUsd":0.5,"carryUsd":0.4,"tailUsd":0.1,"size":1000,"tier":"exact","hash":"00000000000000aa","scope":"user"},{"name":"secret","source":"model","n":1,"loads":1,"costUsd":0.2}]}'); if (pa) partA.push(pa);
const show = (rs: HostRow[]): string => rs.map((r: HostRow) => r.host + ":" + r.row.name + ":" + String(r.row.loadsUser + r.row.loadsModel) + ":" + r.row.usd.toFixed(2)).join(" ");
const rows = hostRows([{ host: "ws", accs: [a], ids: ["claude:s1"], sess: [], info: [] }, { host: "vm", accs: [], ids: [], sess: partA, info: [] }], null, "cost");
ok("a row per (skill, host)", show(rows).startsWith("ws:alpha:1:") && show(rows).indexOf("vm:alpha:2:0.50") > 0 && show(rows).indexOf("vm:secret:1:0.20") > 0, show(rows));
const vm = rows.filter((r: HostRow) => r.host === "vm" && r.row.name === "alpha")[0];
ok("Part A: tokens, size, hash from skills[]", !!vm && vm.row.carry === 4000 && vm.row.sizeP50 === 1000 && vm.row.hashes.join() === "00000000000000aa" && vm.row.tier === "≈", JSON.stringify(vm ? vm.row : null));
setVis([{ match: "secret", mode: "omit" }], false);
const hid = show(hostRows([{ host: "vm", accs: [], ids: [], sess: partA, info: [] }], null, "cost"));
ok("hidden here: omit folds into (hidden)", hid.indexOf("secret") < 0 && hid.indexOf("vm:(hidden):1:0.20") >= 0, hid);
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok skills fleet");
