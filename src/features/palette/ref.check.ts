// agentglass — self-check for deep links: the strict ref grammar and the resolver (ids, prefixes, call/ts anchors)
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, statSync, rmSync } from "node:fs";
import { type Ref, parseRef, resolve, canonicalUrl } from "./ref.ts";
import { rootKey, traceId, rootSpanId, toolSpanId } from "../otlp/ids.ts";
import { tmpDir, addSess, convo, userLine, toolLine, resultLine, textLine } from "./fixture.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function f(r: Ref): string { return r.ok ? [r.harness, r.sess, r.akey, r.aval, r.warn ? "warn" : ""].join("|") : "ERR"; }
const T: string[][] = [
  ["abc123", "|abc123|||"],
  ["claude:abc123def", "claude|abc123def|||"],
  ["abc123#call=toolu_01", "|abc123|call|toolu_01|"],
  ["abc123#ts=2026-09-30T10:00:00Z", "|abc123|ts|2026-09-30T10:00:00Z|"],
  ["abc123#ts=2026-09-30T10:00:00.000+02:00", "|abc123|ts|2026-09-30T10:00:00.000+02:00|"],
  ["agentglass://open/codex/019a%2D11#call=c1", "codex|019a-11|call|c1|"],
  ["agentglass://open/abc123", "|abc123|||"],
  ["agentglass://open/claude/abc123#call%3Dtoolu_9", "claude|abc123|call|toolu_9|"],
  ["abc123#foo=1", "|abc123|||warn"],
  ["abc12", "ERR"], ["bogus:abc123", "ERR"], ["../etc/passwd", "ERR"], ["/home/u/x.jsonl", "ERR"], ["~/x", "ERR"],
  ["abc 123", "ERR"], ["abc\x07def", "ERR"], ["a".repeat(513), "ERR"], ["a".repeat(201), "ERR"], ["%zz", "ERR"],
  ["agentglass://open/%zz", "ERR"], ["agentglass://open/%252e%252e", "ERR"], ["agentglass://open/a/b/c", "ERR"],
  ["agentglass://open/bogus/abc123", "ERR"], ["agentglass://evil/abc123", "ERR"], ["abc123..x", "ERR"],
  ["agentglass://open/claude/..%2F..%2Fetc", "ERR"], ["abc123#call=a/b", "ERR"], ["abc123#ts=yesterday", "ERR"], ["", "ERR"],
  // review: scheme and host are case-insensitive (RFC 3986), one trailing slash (some apps add it) is fine, an empty
  // harness segment is not; traversal and smuggling stay refused after the one decoding pass
  ["AGENTGLASS://Open/claude/abc123", "claude|abc123|||"], ["agentglass://open/claude/abc123/", "claude|abc123|||"],
  ["agentglass://open/abc123/#call=c1", "|abc123|call|c1|"], ["agentglass://open//abc123", "ERR"], ["agentglass://open/claude/abc123//", "ERR"],
  ["agentglass://open/%2e%2e%2fetc%2fpasswd", "ERR"], ["agentglass://open/claude/abc123?x=1", "ERR"], ["agentglass://open/claude/abc%00123", "ERR"],
  ["agentglass://open/claude/abc123#call=%0a", "ERR"], ["agentglass://open/abc%23call=x", "ERR"], ["agentglass://open/claude%2Fabc123", "ERR"],
  ["agentglass:abc123", "ERR"], ["agentglass:/open/abc123", "ERR"], ["file:///etc/passwd", "ERR"], ["claude:abc123;rm", "ERR"], ["$(id)abc", "ERR"],
];
for (const c of T) { const got = f(parseRef(c[0] ?? "")); ok("parse " + JSON.stringify((c[0] ?? "").slice(0, 60)), got === c[1], got); }
ok("error says why", parseRef("../x").err.indexOf("paths") >= 0, parseRef("../x").err);

// resolver on fixture sessions
const dir = tmpDir("ref");
const a = addSess(dir, "aaaaaa-0001-x", "first", convo(1), 100, "");
addSess(dir, "aaaaaa-0002-y", "second", convo(2), 200, "");
const c = addSess(dir, "cccccc-0003", "third", convo(3), 300, "");
function r(ref: string): string { const t = resolve(parseRef(ref)); return String(t.code) + "|" + (t.s ? t.s.id : "-") + "|" + t.cands.map((x) => x.id).join(","); }
ok("exact id", r("cccccc-0003") === "0|cccccc-0003|", r("cccccc-0003"));
ok("harness:id", r("claude:cccccc-0003") === "0|cccccc-0003|", r("claude:cccccc-0003"));
ok("prefix", r("cccccc") === "0|cccccc-0003|", r("cccccc"));
ok("harness:prefix", r("claude:cccccc") === "0|cccccc-0003|" && r("agentglass://open/claude/cccccc") === "0|cccccc-0003|", r("claude:cccccc"));
ok("harness:prefix ambiguous", r("claude:aaaaaa") === "4|-|aaaaaa-0002-y,aaaaaa-0001-x", r("claude:aaaaaa"));
ok("harness:prefix of another harness", r("codex:cccccc") === "3|-|", r("codex:cccccc"));
ok("ambiguous prefix → 4, both, newest first", r("aaaaaa") === "4|-|aaaaaa-0002-y,aaaaaa-0001-x", r("aaaaaa"));
ok("unknown → 3", r("zzzzzz") === "3|-|", r("zzzzzz"));
const tc = resolve(parseRef("cccccc-0003#call=toolu_03"));
ok("call= → that tool event", tc.kind === "tool" && tc.id === "toolu_03" && tc.ts === "2026-09-30T10:00:03.000Z" && tc.cursor === 0, JSON.stringify(tc.kind + " " + tc.id + " " + tc.ts));
const tt = resolve(parseRef("cccccc-0003#ts=2026-09-30T10:00:03.500Z"));
ok("ts= → first event at/after", tt.kind === "result" && tt.ts === "2026-09-30T10:00:04.000Z", tt.kind + " " + tt.ts);
const tm = resolve(parseRef("cccccc-0003#call=nope_1"));
ok("missing call → found session + warn", tm.code === 0 && tm.warn.indexOf("no call") >= 0 && tm.kind === "", tm.warn);
// an event older than the last 6 MB of a 7 MB log: found, cursor > 0
const big: string[] = [userLine("2026-09-30T09:00:00.000Z", "start")];
const pad = "x".repeat(3000);
for (let i = 0; i < 400; i++) big.push(textLine("2026-09-30T09:00:01.000Z", "p" + String(i), pad));
big.push(toolLine("2026-09-30T09:30:00.000Z", "mo", "toolu_old", "ls")); big.push(resultLine("2026-09-30T09:30:01.000Z", "toolu_old", "ok"));
const g = addSess(dir, "gggggg-0007", "big", big, 400, "");
const filler: string[] = []; for (let i = 0; i < 2400; i++) filler.push(textLine("2026-09-30T10:00:00.000Z", "q" + String(i), pad));
appendFileSync(g.path, filler.join("\n") + "\n");
g.size = statSync(g.path).size;
ok("fixture is > 7 MB", g.size > 7000000, String(g.size));
const to = resolve(parseRef("gggggg-0007#call=toolu_old"));
ok("old event: found, cursor > 0, before the 6 MB tail", to.kind === "tool" && to.cursor > 0 && to.cursor < g.size - 6291456, String(to.cursor) + " " + to.kind);
// canonical urls: always the stable form, components encoded once
ok("canonical", canonicalUrl(a, "", "") === "agentglass://open/claude/aaaaaa-0001-x", canonicalUrl(a, "", ""));
ok("canonical call", canonicalUrl(c, "call", "toolu_03") === "agentglass://open/claude/cccccc-0003#call=toolu_03", canonicalUrl(c, "call", "toolu_03"));
const odd = addSess(dir, "odd#id%x", "odd", convo(5), 500, "");
const u = canonicalUrl(odd, "ts", "2026-09-30T10:00:00.000Z");
ok("canonical encodes # and %", u === "agentglass://open/claude/odd%23id%25x#ts=2026-09-30T10:00:00.000Z", u);
ok("round trip", f(parseRef(canonicalUrl(c, "call", "toolu_03"))) === "claude|cccccc-0003|call|toolu_03|", f(parseRef(canonicalUrl(c, "call", "toolu_03"))));
// turn=, span= and trace ids (otlp-export ids)
function g3(r: Ref): string { return r.ok ? [r.sess, r.trace, r.span, r.akey, r.aval, String(r.ak)].join("|") : "ERR"; }
const TT: string[][] = [
  ["abc123#turn=2026-09-30T10:00:00.000Z", "abc123|||turn|2026-09-30T10:00:00.000Z|0"], ["abc123#turn=2026-09-30T10:00:00.000Z~1", "abc123|||turn|2026-09-30T10:00:00.000Z|1"],
  ["abc123#turn=3", "abc123|||turn|3|0"], ["abc123#turn=0", "ERR"], ["abc123#turn=yesterday", "ERR"], ["abc123#turn=2026-09-30T10:00:00Z~x", "ERR"],
  ["agentglass://open/claude/abc123#turn=2026-09-30T10:00:00.000%2B02:00~2", "abc123|||turn|2026-09-30T10:00:00.000+02:00|2"],
  ["abc123#span=0123456789abcdef", "abc123|||span|0123456789abcdef|0"], ["abc123#span=0123456789ABCDEF", "ERR"], ["abc123#span=0123", "ERR"],
  ["0123456789abcdef0123456789abcdef", "|0123456789abcdef0123456789abcdef||||0"], ["0123456789abcdef0123456789abcdef/fedcba9876543210", "|0123456789abcdef0123456789abcdef|fedcba9876543210|||0"],
  ["0123456789abcdef0123456789abcdef/fedcba98", "ERR"], ["0123456789abcdef0123456789abcdef/../x", "ERR"],
];
for (const c of TT) { const got = g3(parseRef(c[0] ?? "")); ok("parse " + JSON.stringify(c[0] ?? ""), got === c[1], got); }
// turn anchors on a log that lost a turn (a rewind / rewritten history): the stable key keeps its turn, the index moves,
// a vanished key falls back to the next turn with a warning; two turns sharing a start time are ~0 and ~1
const TS = (n: number): string => "2026-09-30T11:00:0" + String(n) + ".000Z";
const turnsLog = (skip2: boolean): string[] => {
  const o: string[] = [];
  for (const n of [1, 2, 3, 3]) { if (skip2 && n === 2) continue; o.push(userLine(TS(n), "prompt " + String(n) + "-" + String(o.length))); o.push(textLine(TS(n), "m" + String(o.length), "ok")); }
  return o;
};
const tw = addSess(dir, "tttttt-0009", "turns", turnsLog(false), 900, "");
function tr(ref: string): string { const t = resolve(parseRef(ref)); return String(t.turn) + "|" + t.ts + "|" + (t.warn ? "warn" : "") + "|" + t.ukey + "=" + t.uval; }
ok("turn=<ts> → that turn", tr("tttttt-0009#turn=" + TS(3)) === "3|" + TS(3) + "||turn=" + TS(3), tr("tttttt-0009#turn=" + TS(3)));
ok("turn=<ts>~1 → the 2nd turn sharing it", tr("tttttt-0009#turn=" + TS(3) + "~1") === "4|" + TS(3) + "||turn=" + TS(3) + "~1", tr("tttttt-0009#turn=" + TS(3) + "~1"));
ok("turn=<n> → the canonical key", tr("tttttt-0009#turn=2") === "2|" + TS(2) + "||turn=" + TS(2), tr("tttttt-0009#turn=2"));
addSess(dir, "tttttt-0009", "turns", turnsLog(true), 901, ""); // turn 2 gone
ok("after: turn=<ts> keeps its turn", tr("tttttt-0009#turn=" + TS(3)) === "2|" + TS(3) + "||turn=" + TS(3), tr("tttttt-0009#turn=" + TS(3)));
ok("after: turn=3 is the next one", tr("tttttt-0009#turn=3") === "3|" + TS(3) + "||turn=" + TS(3) + "~1", tr("tttttt-0009#turn=3"));
ok("after: a vanished key → the next turn + warn", tr("tttttt-0009#turn=" + TS(2)) === "2|" + TS(3) + "|warn|turn=" + TS(3), tr("tttttt-0009#turn=" + TS(2)));
ok("turn=9 → warn, the end", tr("tttttt-0009#turn=9").startsWith("-1||warn"), tr("tttttt-0009#turn=9"));
// trace and span ids exactly as the exporter derives them (the goldens of all harnesses: scripts/open-trace.test.sh)
const R = rootKey("claude", "tttttt-0009");
const tid = traceId(R, TS(3) + "#1");
const t4 = resolve(parseRef(tid));
ok("trace → session and turn", t4.s?.id === tw.id && t4.turn === 3 && t4.ukey === "turn" && t4.uval === TS(3) + "~1", String(t4.turn) + " " + t4.uval);
const ts1 = resolve(parseRef(tid + "/" + rootSpanId(R, TS(1) + "#0")));
ok("trace/root span → that span's turn", ts1.turn === 1 && !ts1.warn, String(ts1.turn) + " " + ts1.warn);
const tsp = resolve(parseRef("cccccc-0003#span=" + toolSpanId(rootKey("claude", "cccccc-0003"), "cccccc-0003", "toolu_03")));
ok("span= a tool span → that call", tsp.kind === "tool" && tsp.id === "toolu_03" && tsp.ukey === "call" && !tsp.warn, tsp.kind + " " + tsp.id + " " + tsp.warn);
const tx = resolve(parseRef("ffffffffffffffff0000000000000000"));
ok("unknown trace → not found", tx.code === 3, String(tx.code));
const tn = resolve(parseRef(traceId(R, "nope#0")));
ok("trace of a session but no turn → the session + warn", tn.s?.id === tw.id && tn.warn !== "", tn.warn);
console.log(bad ? bad + " failed" : "ref: all checks passed (" + String(T.length) + " grammar cases)");
rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
