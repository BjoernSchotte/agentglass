// agentglass — self-check for the per-session call-row files: scriptc build src/features/usage/callcache.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { newAcc, bucket, tool, pend } from "./record.ts";
import { type Call, MQ_MSG, DICT, nameOf } from "./facts.ts";
import { pathKey, encodeCalls, decodeCalls, prune, saveCallsTo, loadCallsFrom, sweepCalls } from "./callcache.ts";
import { intOf } from "../../util/config.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

// key: 16 hex, stable, differs for near paths (value pinned against the same arithmetic in node)
ok("key shape", /^[0-9a-f]{16}$/.test(pathKey("/a/b.jsonl")), pathKey("/a/b.jsonl"));
ok("key value", pathKey("/a/b.jsonl") === "85e38b64706b28ae", pathKey("/a/b.jsonl"));
ok("key stable/distinct", pathKey("/a/b.jsonl") === pathKey("/a/b.jsonl") && pathKey("/a/b.jsonl") !== pathKey("/a/c.jsonl"), "");
// round trip: local dictionaries remapped to the global ones
const a = newAcc(); a.off = 900; const iso = "2026-10-01T10:00:00.000Z"; const d = bucket(a, 0, iso);
pend(a, d, tool(a, d, "Bash", "claude-opus-4-5", MQ_MSG), "Bash", "t1", 0, iso, "", ["npm test"]);
tool(a, d, "Read", "", MQ_MSG);
const body = encodeCalls("/s/x.jsonl", a);
const back = decodeCalls(body, "/s/x.jsonl", 900);
function rowStr(c: Call): string { const ps: string[] = []; for (const x of c.progs) ps.push(nameOf(DICT.prog, x)); const cs: string[] = []; for (const x of c.cmds) cs.push(nameOf(DICT.cmd, x)); return [nameOf(DICT.tool, c.tool), nameOf(DICT.model, c.model) || "?", ps.join("+"), cs.join("+"), c.cid, String(c.t), String(c.err), String(c.ms)].join("|"); }
const rs: string[] = []; if (back) for (const c of back) rs.push(rowStr(c));
const T1 = String(Date.parse(iso));
ok("round trip", rs.join(" ; ") === "Bash|claude-opus-4-5|npm|npm test|t1|" + T1 + "|-1|-1 ; Read|?||||" + T1 + "|-1|-1", rs.join(" ; "));
ok("off mismatch → null", decodeCalls(body, "/s/x.jsonl", 901) === null, "");
ok("foreign path → null", decodeCalls(body, "/s/y.jsonl", 900) === null, "");
ok("corrupt → null", decodeCalls(body.slice(0, 40), "/s/x.jsonl", 900) === null && decodeCalls("", "/s/x.jsonl", 900) === null, "");
ok("ragged columns → null", decodeCalls(body.split("\"ms\":[-1,-1]").join("\"ms\":[-1]"), "/s/x.jsonl", 900) === null, body.slice(-120));
ok("other format → null", decodeCalls(body.split("{\"v\":1,").join("{\"v\":2,"), "/s/x.jsonl", 900) === null, "");
// retention
const old = newAcc(); const od = bucket(old, Date.parse("2026-01-01T10:00:00Z"), ""); tool(old, od, "Bash", "", MQ_MSG);
const nd = bucket(old, Date.parse("2026-10-01T10:00:00Z"), ""); tool(old, nd, "Read", "", MQ_MSG);
ok("prune drops old rows", prune(old, Date.parse("2026-07-01T00:00:00Z")) && old.calls.length === 1 && old.lastCall === 0, String(old.calls.length));
ok("prune no-op", !prune(old, Date.parse("2026-07-01T00:00:00Z")), "");
ok("prune newest gone", prune(old, Date.parse("2026-12-01T00:00:00Z")) && old.calls.length === 0 && old.lastCall === -1, String(old.lastCall));
// files: write, read back, other off, sweep of sessions that no longer exist
const dir = "/tmp/agentglass-callcache-check"; rmSync(dir, { recursive: true, force: true });
ok("save", saveCallsTo(dir, "/s/x.jsonl", a), "");
const rl = loadCallsFrom(dir, "/s/x.jsonl", 900);
ok("load", !!rl && rl.length === 2, rl ? String(rl.length) : "null");
ok("load other off", loadCallsFrom(dir, "/s/x.jsonl", 1) === null, "");
ok("load missing", loadCallsFrom(dir, "/s/none.jsonl", 900) === null, "");
writeFileSync(dir + "/" + pathKey("/s/z.jsonl") + ".json", "{}"); writeFileSync(dir + "/junk.json.tmp", "x");
sweepCalls(dir, new Set<string>([pathKey("/s/x.jsonl")]));
ok("sweep keeps live", existsSync(dir + "/" + pathKey("/s/x.jsonl") + ".json"), "");
ok("sweep drops dead + tmp", !existsSync(dir + "/" + pathKey("/s/z.jsonl") + ".json") && !existsSync(dir + "/junk.json.tmp"), "");
rmSync(dir, { recursive: true, force: true });
// integer settings
ok("intOf ok", intOf(90, 1, 0, 90) === 90 && intOf(7, 1, 0, 90) === 7, "");
ok("intOf invalid", intOf(0, 1, 0, 90) === 90 && intOf(-1, 1, 0, 90) === 90 && intOf(1.5, 1, 0, 90) === 90 && intOf("30", 1, 0, 90) === 90 && intOf(null, 1, 0, 90) === 90, "");
ok("intOf hi", intOf(60, 1, 60, 5) === 60 && intOf(61, 1, 60, 5) === 5, "");
console.log(bad ? bad + " failed" : "calls cache: all checks passed");
if (bad) process.exit(1);
