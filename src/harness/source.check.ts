// agentglass — self-check for the file session source: scriptc build src/harness/source.check.ts -o sc && ./sc
import { openSync, writeSync, closeSync, mkdirSync, rmSync } from "node:fs";
import { newSess } from "../model/types.ts";
import { FILE_SOURCE, seekTime } from "./source.ts";
import type { SessionSource } from "./types.ts";
import { accOf } from "../features/usage/ledger.ts";
import { restat } from "../model/sessions.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-source-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
const p = dir + "/s.jsonl";
const fd = openSync(p, "w"); writeSync(fd, "{\"a\":1}\n{\"b\":2}\n{\"c\":3"); closeSync(fd); // last line still being written
const s = newSess("claude", "x", p, false);
const st = FILE_SOURCE.stat(s);
ok("stat size", !!st && st.size === 22, JSON.stringify(st));
const r = FILE_SOURCE.lines(s, 0, 22);
ok("whole lines only", r.lines.join("|") === "{\"a\":1}|{\"b\":2}" && r.next === 16, JSON.stringify(r));
ok("align mid-line", FILE_SOURCE.align(s, 3) === 8, String(FILE_SOURCE.align(s, 3)));
ok("align at start", FILE_SOURCE.align(s, 0) === 0, String(FILE_SOURCE.align(s, 0)));
ok("align at boundary", FILE_SOURCE.align(s, 8) === 8, String(FILE_SOURCE.align(s, 8)));
ok("align in unterminated tail", FILE_SOURCE.align(s, 18) === 22, String(FILE_SOURCE.align(s, 18)));
ok("nothing after EOF align", FILE_SOURCE.lines(s, 22, 22).lines.length === 0, "");
const p2 = dir + "/t.jsonl";
const fd2 = openSync(p2, "w"); writeSync(fd2, "{\"a\":1}\n{\"b\":2}\n"); closeSync(fd2);
const s2 = newSess("claude", "z", p2, false);
const r2 = FILE_SOURCE.lines(s2, 0, 16);
ok("terminated file: no trailing empty", r2.lines.length === 2 && r2.next === 16, JSON.stringify(r2));
ok("align at EOF of terminated file", FILE_SOURCE.align(s2, 16) === 16, String(FILE_SOURCE.align(s2, 16)));
const p3 = dir + "/n.jsonl";
const fd3 = openSync(p3, "w"); writeSync(fd3, "{\"a\":1}\n" + "x".repeat(70000)); closeSync(fd3); // long unterminated line
const s3 = newSess("claude", "w", p3, false);
ok("align across chunks to EOF", FILE_SOURCE.align(s3, 100) === 70008, String(FILE_SOURCE.align(s3, 100)));
ok("nothing new", FILE_SOURCE.lines(s, 16, 22).lines.length === 0 && FILE_SOURCE.lines(s, 16, 22).next === 16, "");
ok("missing file", FILE_SOURCE.stat(newSess("claude", "y", dir + "/nope.jsonl", false)) === null, "");
// cursor epoch (SessionSource.epoch): same size, other cursor meaning → the ledger and the loaded tail start over
const se = newSess("opencode", "e", dir + "/e#1", false);
restat(se, 10, 1, "a"); se.headDone = true; se.tailSize = 10; se.evs.push({ kind: "user", text: "x", ts: "", id: "", full: "" });
const a1 = accOf(se); a1.off = 10; a1.tools = 3;
ok("unchanged epoch keeps the account", accOf(se) === a1, "");
restat(se, 10, 2, "a");
ok("unchanged epoch keeps the tail", se.tailSize === 10 && se.headDone && se.evs.length === 1, String(se.tailSize));
restat(se, 10, 3, "b");
const a2 = accOf(se);
ok("epoch change: fresh account", a2 !== a1 && a2.off === 0 && a2.tools === 0 && a2.ep === "b", a2.ep);
ok("epoch change: tail and head reload", se.tailSize === -1 && !se.headDone && se.evs.length === 0, String(se.tailSize));

// ── seekTime: bisect by timestamp (50 MB log, lines without ts, an out-of-order tail; a record source stub) ──
const tsOf = (l: string): number => { const m = /"ts":"([^"]+)"/.exec(l); return m ? Date.parse(m[1] ?? "") : 0; };
const T0 = Date.parse("2026-01-01T00:00:00Z");
const pb = dir + "/big.jsonl";
const SIZE = 52428800; const TAIL = 2097152;
const fdb = openSync(pb, "w"); let nb = 0; let n = 0; let buf = ""; let ooo = 0; let oooFrom = -1;
while (nb < SIZE) {
  const inTail = nb >= SIZE - TAIL;
  if (inTail && oooFrom < 0) oooFrom = n;
  let l = "";
  if (n % 7 === 3) l = "{\"n\":" + String(n) + "}";
  else if (inTail && ooo < 300 && (n - oooFrom) % 140 === 70) { l = "{\"ts\":\"" + new Date(T0 + n * 1000 - 600000).toISOString() + "\",\"n\":" + String(n) + ",\"o\":1}"; ooo++; }
  else l = "{\"ts\":\"" + new Date(T0 + n * 1000).toISOString() + "\",\"n\":" + String(n) + "}";
  buf += l + "\n"; nb += l.length + 1; n++;
  if (buf.length > 1048576) { writeSync(fdb, buf); buf = ""; }
}
writeSync(fdb, buf); closeSync(fdb);
const sb = newSess("claude", "big", pb, false); sb.size = nb;
const WIN = 65536;
// all lines from `at` on: [offset, ts] of each timestamped line
function scanFrom(at: number): number[][] {
  const o: number[][] = []; let p0 = at;
  while (p0 < nb) { const r = FILE_SOURCE.lines(sb, p0, Math.min(nb, p0 + 4194304)); let q = p0; for (const l of r.lines) { const t = tsOf(l); if (t > 0) o.push([q, t]); q += l.length + 1; } if (r.next <= p0) break; p0 = r.next; }
  return o;
}
const all = scanFrom(0);
ok("ooo lines written", ooo === 300, String(ooo));
const t40 = (all[Math.floor(all.length * 0.4)] ?? [0, 0])[1] ?? 0;
const k40 = seekTime(sb, FILE_SOURCE, nb, t40, WIN, tsOf);
ok("seek 40%: found", k40.found, JSON.stringify(k40));
ok("seek 40%: ≤ 15 reads", k40.reads <= 15, String(k40.reads));
let firstOff = -1; for (const x of all) if ((x[1] ?? 0) >= t40) { firstOff = x[0] ?? 0; break; }
ok("seek 40%: window start not skipped", firstOff >= k40.at, String(firstOff) + " < " + String(k40.at));
ok("seek 40%: close to it (≤ 3 windows)", firstOff - k40.at <= 3 * WIN, String(firstOff - k40.at));
ok("seek 40%: aligned", FILE_SOURCE.align(sb, k40.at) === k40.at, String(k40.at));
// t0 inside the out-of-order tail: every line with ts ≥ t0 (also the late re-appended ones) lies at or after `at`
const tT = T0 + (n - 2000) * 1000;
const kT = seekTime(sb, FILE_SOURCE, nb, tT, WIN, tsOf);
let miss = 0; for (const x of all) if ((x[1] ?? 0) >= tT && (x[0] ?? 0) < kT.at) miss++;
ok("seek tail: found, ≤ 15 reads", kT.found && kT.reads <= 15, JSON.stringify(kT));
ok("seek tail: no line ≥ t0 before at", miss === 0, String(miss));
ok("seek before the first line → 0", seekTime(sb, FILE_SOURCE, nb, T0 - 3600000, WIN, tsOf).at === 0, "");
const kAfter = seekTime(sb, FILE_SOURCE, nb, T0 + n * 2000, WIN, tsOf);
ok("seek after the last line → near the end", kAfter.found && nb - kAfter.at <= 3 * WIN, String(nb - kAfter.at));
const pn = dir + "/nots.jsonl";
const fdn = openSync(pn, "w"); let bn = ""; for (let i = 0; i < 40000; i++) bn += "{\"x\":1}\n"; writeSync(fdn, bn); closeSync(fdn);
const sn = newSess("claude", "nots", pn, false);
const kn = seekTime(sn, FILE_SOURCE, 320000, T0, WIN, tsOf);
ok("no timestamps anywhere: not found", !kn.found, JSON.stringify(kn));
const small = seekTime(s2, FILE_SOURCE, 16, T0, WIN, tsOf);
ok("tiny file without ts: from 0, not found", small.at === 0 && !small.found, JSON.stringify(small));
// a record source: cursor = record index, align identity
const RECS: string[] = []; for (let i = 0; i < 100000; i++) RECS.push(i % 5 === 1 ? "{\"x\":" + String(i) + "}" : "{\"ts\":\"" + new Date(T0 + i * 1000).toISOString() + "\"}");
const REC: SessionSource = {
  stat: (x) => ({ size: RECS.length, mtime: 1 }),
  align: (x, at) => Math.max(0, Math.min(RECS.length, at)),
  lines: (x, from, to) => { const a = Math.max(0, from); const b = Math.min(RECS.length, to); return { lines: RECS.slice(a, b), next: Math.max(a, b) }; },
  unit: 1,
};
const tR = T0 + 61234 * 1000;
const kR = seekTime(newSess("opencode", "r", dir + "/r#1", false), REC, RECS.length, tR, 500, tsOf);
ok("record source: found, ≤ 20 reads", kR.found && kR.reads <= 20, JSON.stringify(kR));
ok("record source: window start not skipped, close", kR.at <= 61234 && 61234 - kR.at <= 1500, String(kR.at));
rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "source: all checks passed");
process.exit(bad ? 1 : 0);
