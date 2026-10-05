// agentglass — self-check for the per-session call-row files: scriptc build src/features/usage/callcache.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { newAcc, bucket, tool, pend, file } from "./record.ts";
import { type Call, MQ_MSG, DICT, nameOf, intern } from "./facts.ts";
import { pathKey, encodeCalls, decodeCalls, prune, saveCallsTo, loadCallsFrom, sweepCalls } from "./callcache.ts";
import { accOut, accIn } from "./codec.ts";
import { callList, callAt, addId, KIND_CMD } from "./rows.ts";
import { done } from "./calls.ts";
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
const backR = decodeCalls(body, "/s/x.jsonl", a); const back = backR ? callList(backR) : null;
function rowStr(c: Call): string { const ps: string[] = []; for (const x of c.progs) ps.push(nameOf(DICT.prog, x)); const cs: string[] = []; for (const x of c.cmds) cs.push(nameOf(DICT.cmd, x)); return [nameOf(DICT.tool, c.tool), nameOf(DICT.model, c.model) || "?", ps.join("+"), cs.join("+"), c.cid, String(c.t), String(c.err), String(c.ms)].join("|"); }
const rs: string[] = []; if (back) for (const c of back) rs.push(rowStr(c));
const T1 = String(Date.parse(iso));
ok("round trip", rs.join(" ; ") === "Bash|claude-opus-4-5|npm|npm test|t1|" + T1 + "|-1|-1 ; Read|?||||" + T1 + "|-1|-1", rs.join(" ; "));
a.off = 901; ok("off mismatch → null", decodeCalls(body, "/s/x.jsonl", a) === null, ""); a.off = 900;
ok("foreign path → null", decodeCalls(body, "/s/y.jsonl", a) === null, "");
ok("corrupt → null", decodeCalls(body.slice(0, 40), "/s/x.jsonl", a) === null && decodeCalls("", "/s/x.jsonl", a) === null, "");
ok("ragged columns → null", decodeCalls(body.split("\"ms\":[-1,-1]").join("\"ms\":[-1]"), "/s/x.jsonl", a) === null, body.slice(-120));
ok("other format → null", decodeCalls(body.split("{\"v\":2,").join("{\"v\":1,"), "/s/x.jsonl", a) === null, "");
// compact: command and file text is a reference into the ledger's own day counters (same off), not a second copy
ok("command text not stored twice", body.indexOf("npm test") < 0, body);
const noDays = newAcc(); noDays.off = 900;
ok("command reference missing from the ledger → null", decodeCalls(body, "/s/x.jsonl", noDays) === null, "");
// a command the day counters lack (cannot happen through pend) is kept literally; deltas, call id prefixes and files round-trip
const b = newAcc(); b.off = 5; const iso1 = "2026-10-01T10:00:00.000Z"; const iso2 = "2026-10-01T10:00:07.250Z";
const b1 = bucket(b, 0, iso1); pend(b, b1, tool(b, b1, "Bash", "", MQ_MSG), "Bash", "toolu_01abc", 0, iso1, "", ["git status"]);
addId(b.rows, 0, KIND_CMD, intern(DICT.cmd, "only in the row")); addId(b.rows, 0, KIND_CMD, intern(DICT.cmd, "only in the rows too")); addId(b.rows, 0, KIND_CMD, intern(DICT.cmd, "a literal sorted first"));
const b2 = bucket(b, 0, iso2); pend(b, b2, tool(b, b2, "Edit", "", MQ_MSG), "Edit", "toolu_01abd", 0, iso2, "", []); file(b, b2, "Edit", "/w/src/a.ts", 1, 0);
pend(b, b2, tool(b, b2, "Read", "", MQ_MSG), "Read", "", 0, iso2, "", []);
pend(b, b2, tool(b, b2, "Grep", "", MQ_MSG), "Grep", "toolu_01ab", 0, iso2, "", []);
const bb = encodeCalls("/s/b.jsonl", b); const bkR = decodeCalls(bb, "/s/b.jsonl", b); const bk = bkR ? callList(bkR) : null;
const brs: string[] = []; if (bk) for (const c of bk) { const fs: string[] = []; for (const x of c.files) fs.push(nameOf(DICT.file, x)); brs.push(rowStr(c) + "|" + fs.join("+")); }
const B1 = String(Date.parse(iso1)); const B2 = String(Date.parse(iso2));
ok("literal, delta t, cid prefix, files", brs.join(" ; ") === "Bash|?|git|git status+only in the row+only in the rows too+a literal sorted first|toolu_01abc|" + B1 + "|-1|-1| ; Edit|?|||toolu_01abd|" + B2 + "|-1|-1|/w/src/a.ts ; Read|?||||" + B2 + "|-1|-1| ; Grep|?|||toolu_01ab|" + B2 + "|-1|-1|", brs.join(" ; "));
ok("literals front-coded, references for the rest", bb.indexOf("only in the row") >= 0 && bb.indexOf("\"s too\"") >= 0 && bb.indexOf("git status") < 0 && bb.indexOf("/w/src/a.ts") < 0, bb);
// retention
const old = newAcc(); const od = bucket(old, Date.parse("2026-01-01T10:00:00Z"), ""); tool(old, od, "Bash", "", MQ_MSG);
const nd = bucket(old, Date.parse("2026-10-01T10:00:00Z"), ""); tool(old, nd, "Read", "", MQ_MSG);
ok("prune drops old rows", prune(old, Date.parse("2026-07-01T00:00:00Z")) && old.rows.n === 1 && old.lastCall === 0, String(old.rows.n));
ok("prune no-op", !prune(old, Date.parse("2026-07-01T00:00:00Z")), "");
ok("prune newest gone", prune(old, Date.parse("2026-12-01T00:00:00Z")) && old.rows.n === 0 && old.lastCall === -1, String(old.lastCall));
// prune compacts the columns: the newest row and the pending calls' rows follow (Review focus: rows held by index)
{
  const p = newAcc(); const p0 = bucket(p, Date.parse("2026-01-01T10:00:00Z"), ""); pend(p, p0, tool(p, p0, "Read", "", MQ_MSG), "Read", "k0", 0, "", "", []);
  const p1 = bucket(p, Date.parse("2026-10-01T10:00:00Z"), ""); pend(p, p1, tool(p, p1, "Bash", "", MQ_MSG), "Bash", "k1", 0, "", "", ["ls -la"]);
  pend(p, p1, tool(p, p1, "Edit", "", MQ_MSG), "Edit", "k2", 0, "", "", []);
  ok("prune with pending calls", prune(p, Date.parse("2026-07-01T00:00:00Z")) && p.rows.n === 2 && p.lastCall === 1, String(p.rows.n) + " last " + String(p.lastCall));
  const k0 = p.pend.get("k0"); const k1 = p.pend.get("k1"); const k2 = p.pend.get("k2");
  ok("pending rows remapped", !!k0 && k0.ri === -1 && !!k1 && k1.ri === 0 && !!k2 && k2.ri === 1, [k0 ? k0.ri : 9, k1 ? k1.ri : 9, k2 ? k2.ri : 9].join(","));
  if (k1) done(k1, 500, true, 7, "k1", []); if (k0) done(k0, 9, false, 1, "k0", []);
  ok("result lands on the moved row", p.rows.err[0] === 1 && p.rows.ms[0] === 500 && p.rows.out[0] === 7 && p.rows.err[1] === -1, [p.rows.err[0], p.rows.ms[0], p.rows.err[1]].join(","));
  file(p, p1, "Edit", "/w/e.ts", 1, 0);
  ok("newest row still takes files", callAt(p.rows, 1).files.length === 1 && callAt(p.rows, 0).cmds.length === 1, "");
}
// files: write, read back, other off, sweep of sessions that no longer exist
const dir = "/tmp/agentglass-callcache-check"; rmSync(dir, { recursive: true, force: true });
ok("save", saveCallsTo(dir, "/s/x.jsonl", a), "");
const rl = loadCallsFrom(dir, "/s/x.jsonl", a);
ok("load", !!rl && rl.n === 2, rl ? String(rl.n) : "null");
a.off = 1; ok("load other off", loadCallsFrom(dir, "/s/x.jsonl", a) === null, ""); a.off = 900;
// reading rows decodes the day maps' text keys without keeping them decoded (a ledger loaded from the cache keeps them text)
const two = newAcc(); two.off = 50; const t1 = bucket(two, 0, "2026-10-01T10:00:00.000Z"); pend(two, t1, tool(two, t1, "Bash", "", MQ_MSG), "Bash", "c1", 0, "2026-10-01T10:00:00.000Z", "", ["make"]);
const t2 = bucket(two, 0, "2026-10-02T10:00:00.000Z"); pend(two, t2, tool(two, t2, "Bash", "", MQ_MSG), "Bash", "c2", 0, "2026-10-02T10:00:00.000Z", "", ["make test"]); file(two, t2, "Edit", "/w/b.ts", 1, 0);
ok("save two days", saveCallsTo(dir, "/s/two.jsonl", two), "");
const cold = accIn(accOut(two)); let pinned = 0; for (const x of cold.days.values()) if (x.hx) pinned++;
ok("cache-loaded days are text", pinned === 0 && cold.days.size === 2, String(pinned));
const cr = loadCallsFrom(dir, "/s/two.jsonl", cold); pinned = 0; for (const x of cold.days.values()) if (x.hx) pinned++;
const crs: string[] = []; if (cr) for (const c of callList(cr)) { const cs: string[] = []; for (const x of c.cmds) cs.push(nameOf(DICT.cmd, x)); crs.push(cs.join("+")); }
ok("rows from text days, days not pinned", crs.join(",") === "make,make test" && pinned === 0, crs.join(",") + " pinned " + String(pinned));
ok("load missing", loadCallsFrom(dir, "/s/none.jsonl", a) === null, "");
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
