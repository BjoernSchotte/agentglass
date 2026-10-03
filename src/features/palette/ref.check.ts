// agentglass — self-check for deep links: the strict ref grammar and the resolver (ids, prefixes, call/ts anchors)
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, statSync, rmSync } from "node:fs";
import { type Ref, parseRef, resolve, canonicalUrl } from "./ref.ts";
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
console.log(bad ? bad + " failed" : "ref: all checks passed (" + String(T.length) + " grammar cases)");
rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
