// agentglass — self-check for the fleet report line format: scriptc build src/features/fleet/report.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
import { FORMAT, type HostReport, noOwned } from "./model.ts";
import { newParse, feedLines, toReport, reportLines, parseReport, sessRowOf } from "./report.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const hello = { format: FORMAT, version: "2026.10.6", hostId: "0123456789abcdef", hostName: "ws", os: "linux", tzOffsetMin: 120, redact: false, days: 7, now: 1791000000000, priceSig: "" };
const r: HostReport = { hello, sessions: [sessRowOf({ id: "a", harness: "claude" }), sessRowOf({ id: "b", harness: "codex" })], cost: { today: { byMode: { api: 1 } } }, allowance: { claude: null, codex: null }, live: null, exact: false, owned: noOwned() };
const ls = reportLines(r);
ok("line order", ls.length === 6 && ls[0]?.startsWith("{\"hello\"") === true && ls[1]?.startsWith("{\"cost\"") === true && ls[2]?.startsWith("{\"allowance\"") === true && ls[5]?.startsWith("{\"end\"") === true, ls.join("\n"));
const p = newParse(); feedLines(p, ls.slice(0, 1));
ok("unfinished", toReport(p) === null && !p.done && p.err === "", String(p.done) + " " + p.err);
feedLines(p, ls.slice(1));
const back = toReport(p);
// the report as its lines (own rows are columns: compared on the wire, as they travel)
ok("round trip", back !== null && reportLines(back).join("\n") === ls.join("\n") && back.owned.length === 0 && back.sessions.every((x) => x.own === null && x.days === null), back ? reportLines(back).join("\n") : "null");
ok("keys", back !== null && (back.sessions[0]?.key ?? "") === "claude:a" && (back.sessions[1]?.key ?? "") === "codex:b", "keys");
const cut = newParse(); feedLines(cut, ls.slice(0, 5));
ok("no end: null", toReport(cut) === null && !cut.done, String(cut.done) + " " + cut.err);
ok("no end: parseReport says incomplete", parseReport(ls.slice(0, 5).join("\n")).err === "incomplete report", parseReport(ls.slice(0, 5).join("\n")).err);
const wrong = newParse(); feedLines(wrong, ls.slice(0, 5).concat(["{\"end\":{\"sessions\":3}}"]));
ok("end count", wrong.err === "incomplete report" && toReport(wrong) === null, wrong.err);
const nh = newParse(); feedLines(nh, ls.slice(1));
ok("not hello first", nh.err === "not a fleet report", nh.err);
const nf = newParse(); feedLines(nf, ["{\"hello\":{\"format\":\"agentglass-fleet/v2\"}}"].concat(ls.slice(1)));
ok("newer format", nf.err === "newer format agentglass-fleet/v2", nf.err);
const ex = newParse(); feedLines(ex, ls.slice(0, 4).concat(["{\"x\":1}", "", "garbage"]).concat(ls.slice(4)));
ok("unknown lines ignored", toReport(ex) !== null && ex.sessions.length === 2, ex.err);
ok("shell rc text before hello", parseReport("Welcome to Ubuntu\n" + ls.join("\n")).r !== null, "rejected");
ok("only text", parseReport("bash: agentglass: command not found").err === "not a fleet report", parseReport("x").err);
console.log(bad ? String(bad) + " failed" : "fleet report: all checks passed");
if (bad) process.exit(1);
