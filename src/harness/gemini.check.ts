// agentglass — self-check for the Gemini CLI adapter (normalizing source, scan, parse, usage): scriptc build src/harness/gemini.check.ts -o gc && ./gc
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, mkdirSync, rmSync, appendFileSync, copyFileSync } from "node:fs";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { type Sess, newSess } from "../model/types.ts";
import { gemini } from "./gemini.ts";
import type { SessionSource } from "./types.ts";
import { FILE_SOURCE } from "./source.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const DIR = "/tmp/agentglass-gemini-check";
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
function write(p: string, t: string): void { const fd = openSync(p, "w"); writeSync(fd, t); closeSync(fd); }
function bytes(t: string): number { return new TextEncoder().encode(t).length; }
ok("gemini has its own source", !!gemini.source, "none");
const src: SessionSource = gemini.source ?? FILE_SOURCE;

// ── fixture: lines in the shapes gemini 0.62.0 writes (hand-written, anonymized) ──
const TS = "2026-10-01T16:34:0";
const TOK2 = "\"tokens\":{\"input\":1000,\"output\":100,\"cached\":400,\"thoughts\":50,\"tool\":10,\"total\":1160}";
const TOK4 = "\"tokens\":{\"input\":2000,\"output\":20,\"cached\":0,\"thoughts\":0,\"tool\":0,\"total\":2020}";
function call(id: string, name: string, args: string): string {
  return "{\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"args\":" + args + ",\"result\":[{\"functionResponse\":{\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"response\":{\"output\":\"ok ü\"}}}],\"status\":\"success\",\"timestamp\":\"" + TS + "9.000Z\",\"displayName\":\"X\",\"description\":\"d\"}";
}
const L: string[] = [
  "{\"sessionId\":\"0000aaaa-1111-2222-3333-444455556666\",\"projectHash\":\"ab12\",\"startTime\":\"" + TS + "0.000Z\",\"lastUpdated\":\"" + TS + "0.000Z\",\"kind\":\"main\"}",
  "{\"$set\":{\"messages\":[{\"id\":\"m0\",\"timestamp\":\"" + TS + "0.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"<session_context>\\nThis is the Gemini CLI.\"}]}],\"lastUpdated\":\"" + TS + "0.000Z\"}}",
  "{\"id\":\"m1\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"build a todo app — schön ✓\"}]}",
  "{\"$set\":{\"lastUpdated\":\"" + TS + "1.000Z\"}}",
  "{\"id\":\"m2\",\"timestamp\":\"" + TS + "2.000Z\",\"type\":\"gemini\",\"content\":\"I will write the files.\",\"thoughts\":[{\"subject\":\"Plan\",\"description\":\"two files\",\"timestamp\":\"" + TS + "2.000Z\"}]," + TOK2 + ",\"model\":\"gemini-2.5-pro\"}",
  "{\"id\":\"m2\",\"timestamp\":\"" + TS + "2.000Z\",\"type\":\"gemini\",\"content\":\"I will write the files.\",\"thoughts\":[{\"subject\":\"Plan\",\"description\":\"two files\",\"timestamp\":\"" + TS + "2.000Z\"}]," + TOK2 + ",\"model\":\"gemini-2.5-pro\",\"toolCalls\":[" + call("c1", "write_file", "{\"file_path\":\"a.js\",\"content\":\"x\\ny\\n\"}") + "," + call("c2", "run_shell_command", "{\"command\":\"node --check a.js\"}") + "]}",
  "{\"id\":\"e1\",\"timestamp\":\"" + TS + "3.000Z\",\"type\":\"user\",\"content\":[{\"functionResponse\":{\"id\":\"c1\",\"name\":\"write_file\",\"response\":{\"output\":\"ok\"}}}]}",
  "{\"$set\":{\"summary\":\"Todo app ✓\"}}",
  "{\"$set\":{\"lastUpdated\":\"" + TS + "4.000Z\"}}",
  "{\"id\":\"m3\",\"timestamp\":\"" + TS + "5.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"undo that\"}]}",
  "{\"$rewindTo\":\"m3\"}",
  // resume: the full history again (other content form), plus a synthetic echo id never seen before
  "{\"$set\":{\"sessionId\":\"0000aaaa-1111-2222-3333-444455556666\"}}",
  "{\"$set\":{\"messages\":[{\"id\":\"m0\",\"timestamp\":\"" + TS + "0.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"<session_context>\"}]},{\"id\":\"m1\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"build a todo app — schön ✓\"}]},{\"id\":\"m2\",\"timestamp\":\"" + TS + "2.000Z\",\"type\":\"gemini\",\"content\":[{\"text\":\"Plan\",\"thought\":true},{\"functionCall\":{\"name\":\"write_file\"}}]," + TOK2 + ",\"model\":\"gemini-2.5-pro\",\"toolCalls\":[" + call("c1", "write_file", "{}") + "]},{\"id\":\"e1\",\"timestamp\":\"" + TS + "3.000Z\",\"type\":\"user\",\"content\":[{\"functionResponse\":{\"id\":\"c1\",\"name\":\"write_file\",\"response\":{\"output\":\"ok\"}}}]},{\"id\":\"m2_response\",\"timestamp\":\"" + TS + "2.000Z\",\"type\":\"user\",\"content\":[{\"functionResponse\":{\"id\":\"c1\",\"name\":\"write_file\",\"response\":{\"output\":\"ok\"}}}]}],\"lastUpdated\":\"" + TS + "6.000Z\"}}",
  "{\"id\":\"m4\",\"timestamp\":\"" + TS + "7.000Z\",\"type\":\"gemini\",\"content\":\"Done.\",\"thoughts\":[]," + TOK4 + ",\"model\":\"gemini-2.5-flash\"}",
  "{\"id\":\"m4\",\"timestamp\":\"" + TS + "7.000Z\",\"type\":\"gemini\",\"content\":\"Done.\",\"thoughts\":[]," + TOK4 + ",\"model\":\"gemini-2.5-flash\",\"toolCalls\":[" + call("c3", "replace", "{\"file_path\":\"a.js\",\"old_string\":\"x\",\"new_string\":\"z\"}") + "]}",
  // compression: history rebuilt from a summary, m1…m4 dropped
  "{\"$set\":{\"messages\":[{\"id\":\"s1\",\"timestamp\":\"" + TS + "8.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"<state_snapshot>todo app</state_snapshot>\"}]}],\"lastUpdated\":\"" + TS + "8.000Z\"}}",
];
const PART = "{\"id\":\"m5\",\"timestamp\":\"" + TS + "9.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"still writ";
const PART2 = "ing\"}]}\n";
const FULL = L.join("\n") + "\n";
const P = DIR + "/s.jsonl";
write(P, FULL + PART);
const END = bytes(FULL + PART);
const starts: number[] = []; { let o = 0; for (const l of L) { starts.push(o); o += bytes(l) + 1; } }
const sess = (p: string): Sess => newSess("gemini", "0000aaaa-1111-2222-3333-444455556666", p, false);

// what a normalized stream says, as countable keys: msg:<id> (message fields), call:<id>, tok:<id>, title:…, meta:…, hdr
function keys(ls: string[]): string[] {
  const out: string[] = [];
  for (const l of ls) {
    const o = parseJson(l); if (!o) { out.push("BAD:" + l.slice(0, 40)); continue; }
    if (str(o["sessionId"]) && str(o["projectHash"])) { out.push("hdr"); continue; }
    if (o["$title"] !== undefined) { out.push("title:" + str(o["$title"])); continue; }
    if (o["$meta"] !== undefined) { out.push("meta:" + str(o["$meta"])); continue; }
    const id = str(o["id"]);
    if (o["content"] !== undefined) out.push("msg:" + id);
    for (const c of arr(o["toolCalls"])) { const co = obj(c); if (co) out.push("call:" + str(co["id"])); }
    if (obj(o["tokens"])) out.push("tok:" + id);
    if (o["content"] === undefined && arr(o["toolCalls"]).length === 0 && !obj(o["tokens"])) out.push("EMPTY:" + id);
  }
  return out;
}
function sorted(k: string[]): string { return k.slice().sort().join(" "); }
function read(s: Sess, from: number, to: number): { k: string[]; next: number } { const r = src.lines(s, from, to); return { k: keys(r.lines), next: r.next }; }

// ── full read ──
const full = read(sess(P), 0, END);
const WANT = "call:c1 call:c2 call:c3 hdr meta:history rewritten: 6 messages dropped meta:rewound: 1 message dropped msg:e1 msg:m0 msg:m1 msg:m2 msg:m2_response msg:m3 msg:m4 msg:s1 title:Todo app ✓ tok:m2 tok:m4";
ok("full read: every id once", sorted(full.k) === WANT, sorted(full.k));
ok("full read: stops before the partial last line", full.next === bytes(FULL), String(full.next) + " ≠ " + String(bytes(FULL)));
ok("full read: stream order", full.k.join(" ").startsWith("hdr msg:m0 msg:m1 msg:m2 tok:m2 call:c1 call:c2 msg:e1 title:Todo app ✓ msg:m3 meta:rewound"), full.k.join(" "));
// resume replays m0…m2: nothing but the never-seen echo id, no marker
ok("resume checkpoint: no marker", full.k.indexOf("meta:history rewritten: 0 messages dropped") < 0, "");

// ── every cut point, warm index (one reader keeps reading) and cold index (a tail reader that starts mid-file) ──
for (let k = 0; k <= bytes(FULL); k++) {
  const p = DIR + "/w.jsonl"; // the index is per path: a fresh copy per cut = a cold reader
  copyFileSync(P, p);
  const s = sess(p);
  const at = src.align(s, k);
  const b = read(s, at, END); // tail first, cold
  const a = read(s, 0, at);
  ok("cut " + String(k) + ": head ends where the tail starts", a.next === at, String(a.next) + " ≠ " + String(at));
  ok("cut " + String(k) + ": head ∪ tail = full read", sorted(a.k.concat(b.k)) === WANT, sorted(a.k.concat(b.k)));
  rmSync(p);
}
// a window ending mid-line stops at the last whole line before it
{
  const s = sess(P);
  for (let i = 1; i < starts.length; i++) {
    const r = src.lines(s, 0, starts[i] + 3);
    ok("mid-line end " + String(i), r.next === starts[i], String(r.next) + " ≠ " + String(starts[i]));
  }
}
// the partial last line arrives: the next read from `next` emits it
{
  appendFileSync(P, PART2);
  const s = sess(P);
  const r = read(s, full.next, bytes(FULL + PART + PART2));
  ok("completed line emitted once", sorted(r.k) === "msg:m5" && r.next === bytes(FULL + PART + PART2), sorted(r.k) + " @" + String(r.next));
  ok("nothing after EOF", src.lines(s, r.next, r.next).lines.length === 0, "");
}
// one line longer than the window still comes back whole (the ledger reads 1 MB windows: it must not stall)
{
  const p = DIR + "/long.jsonl";
  const big = "{\"id\":\"b1\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"" + "x".repeat(200000) + "\"}]}";
  write(p, L[0] + "\n" + big + "\n");
  const s = sess(p);
  const r = read(s, bytes(L[0]) + 1, bytes(L[0]) + 101);
  ok("long line returned whole", sorted(r.k) === "msg:b1" && r.next === bytes(L[0] + "\n" + big + "\n"), sorted(r.k) + " @" + String(r.next));
}
// the file shrank (rewritten): the index starts over
{
  const p = DIR + "/shrink.jsonl";
  write(p, FULL); const s = sess(p);
  read(s, 0, bytes(FULL));
  write(p, L[0] + "\n" + L[2] + "\n");
  const r = read(s, 0, bytes(L[0] + "\n" + L[2] + "\n"));
  ok("shrunk file re-indexed", sorted(r.k) === "hdr msg:m1", sorted(r.k));
}
// stat: bytes and mtime of the file
{ const st = src.stat(sess(P)); ok("stat size", !!st && st.size === bytes(FULL + PART + PART2), JSON.stringify(st)); }

rmSync(DIR, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "gemini: all checks passed");
process.exit(bad ? 1 : 0);
