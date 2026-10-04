// agentglass — self-check for the Gemini CLI adapter (normalizing source, scan, parse, usage): scriptc build src/harness/gemini.check.ts -o gc && ./gc
// SPDX-License-Identifier: Apache-2.0
import { openSync, writeSync, closeSync, mkdirSync, rmSync, appendFileSync, copyFileSync, renameSync } from "node:fs";
import { type Obj, obj, str, arr, parse as parseJson } from "../util/json.ts";
import { type Ev, type Sess, newSess } from "../model/types.ts";
import { gemini } from "./gemini.ts";
import { type Acc, type Day, newAcc, skillUses } from "../features/usage/record.ts";
import { applyUserPrices } from "../features/usage/pricing.ts";
import { setCallTap } from "../features/usage/calls.ts";
import { DICT, nameOf } from "../features/usage/facts.ts";
import type { SessionSource } from "./types.ts";
import { FILE_SOURCE } from "./source.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const DIR = "/tmp/agentglass-gemini-check-" + String(process.pid);
rmSync(DIR, { recursive: true, force: true }); mkdirSync(DIR, { recursive: true });
function write(p: string, t: string): void { const fd = openSync(p, "w"); writeSync(fd, t); closeSync(fd); }
function bytes(t: string): number { return new TextEncoder().encode(t).length; }
ok("gemini has its own source", !!gemini.source, "none");
const at = gemini.approvalTitle; const asks = (t: string): boolean => at ? at(t) : false;
ok("title: approval dialog", asks("✋  Action Required (agtest-x)"), "no");
ok("title: ready / working are not", !asks("◇  Ready (agtest-x)") && !asks("✦  Working… (agtest-x)") && !asks(""), "yes");
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
const WANT = "call:c1 call:c2 call:c3 hdr meta:history rewritten: 3 messages dropped meta:rewound: 1 message dropped msg:e1 msg:m0 msg:m1 msg:m2 msg:m2_response msg:m3 msg:m4 msg:s1 title:Todo app ✓ tok:m2 tok:m4";
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
// a file replaced by another (atomic rename, not smaller): the index starts over
{
  const p = DIR + "/repl.jsonl"; const q = DIR + "/repl.new";
  write(p, L[0] + "\n" + L[2] + "\n"); const s = sess(p);
  read(s, 0, bytes(L[0] + "\n" + L[2] + "\n"));
  const nb = L[0] + "\n" + L[2].split("m1").join("n1") + "\n" + L[9] + "\n"; write(q, nb); renameSync(q, p);
  const r = read(s, 0, bytes(nb));
  ok("replaced file re-indexed", sorted(r.k) === "hdr msg:m3 msg:n1", sorted(r.k));
}
// drop counts cover messages that become events: an empty info note or a bare gemini message do not, until calls arrive
{
  const p = DIR + "/drop.jsonl";
  const u = (id: string): string => "{\"id\":\"" + id + "\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"go\"}]}";
  const bare = (id: string, calls: string): string => "{\"id\":\"" + id + "\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"gemini\",\"content\":\"\",\"thoughts\":[]" + calls + "}";
  const info = "{\"id\":\"i1\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"info\",\"content\":[{\"inlineData\":{\"data\":\"AA\"}}]}";
  const t = [L[0], u("v1"), bare("b1", ""), info, "{\"$rewindTo\":\"v1\"}", u("v2"), bare("b2", ""), bare("b2", ",\"toolCalls\":[" + call("k1", "read_file", "{}") + "]"), "{\"$rewindTo\":\"v2\"}"].join("\n") + "\n";
  write(p, t);
  const ms = read(sess(p), 0, bytes(t)).k.filter((k: string) => k.startsWith("meta:")).join(" | ");
  ok("drop counts: hidden messages not counted, a message with calls is", ms === "meta:rewound: 1 message dropped | meta:rewound: 2 messages dropped", ms);
}
{ const st = src.stat(sess(P)); ok("stat size", !!st && st.size === bytes(FULL + PART + PART2), JSON.stringify(st)); }

// ── scan / meta / spawnOf / files on a temp ~/.gemini (GEMINI_CLI_HOME, as gemini itself honors it) ──
{
  const HOMED = DIR + "/home"; process.env["GEMINI_CLI_HOME"] = HOMED;
  const T = HOMED + "/.gemini/tmp";
  const A = "aaaaaaaa-0000-4000-8000-000000000001"; const B = "bbbbbbbb-0000-4000-8000-000000000002"; const SUB = "cccccccc-0000-4000-8000-000000000003";
  const hdr = (id: string, kind: string): string => "{\"sessionId\":\"" + id + "\",\"projectHash\":\"ab\",\"startTime\":\"" + TS + "0.000Z\",\"lastUpdated\":\"" + TS + "0.000Z\",\"kind\":\"" + kind + "\"}\n";
  const user = "{\"id\":\"u1\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"user\",\"content\":[{\"text\":\"hi\"}]}\n";
  for (const d of ["app/chats/" + A, "app/tool-outputs/session-" + A, "app/" + A + "/plans", "app/logs", "app-1/chats", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/chats", "bin"]) mkdirSync(T + "/" + d, { recursive: true });
  write(T + "/app/.project_root", "/w/app\n"); write(T + "/app-1/.project_root", "/v/app");
  write(T + "/app/logs.json", "[]"); write(T + "/app/logs/session-" + A + ".jsonl", "{}\n");
  const spawnCall = "{\"id\":\"g1\",\"timestamp\":\"" + TS + "2.000Z\",\"type\":\"gemini\",\"content\":\"\",\"toolCalls\":[{\"id\":\"invoke_agent__call_1\",\"name\":\"invoke_agent\",\"args\":{\"agent_name\":\"codebase_investigator\",\"prompt\":\"summarize\"},\"status\":\"success\",\"timestamp\":\"" + TS + "8.000Z\",\"agentId\":\"" + SUB + "\"}]}\n";
  write(T + "/app/chats/session-2026-10-01T10-00-aaaaaaaa.jsonl", hdr(A, "main") + user + spawnCall);
  write(T + "/app/chats/session-2026-10-01T10-00-aaaaaaaa.jsonl.unreadable-1790000000000", "x"); // gemini's backup of a file it could not read
  const D = "dddddddd-0000-4000-8000-000000000004"; // a migrated legacy session: summary in a header longer than 4 KB
  write(T + "/app/chats/session-2026-10-01T12-00-dddddddd.jsonl", "{\"sessionId\":\"" + D + "\",\"projectHash\":\"ab\",\"summary\":\"" + "s".repeat(9000) + "\",\"kind\":\"main\"}\n" + user);
  write(T + "/app/chats/" + A + "/" + SUB + ".jsonl", hdr(SUB, "subagent") + user);
  write(T + "/app-1/chats/session-2026-10-01T10-00-bbbbbbbb.jsonl", hdr(B, "main") + user + user);
  write(T + "/app-1/chats/session-2026-10-01T11-00-bbbbbbbb.jsonl", hdr(B, "main")); // startup-only copy a resume leaves behind
  write(T + "/app-1/chats/session-2026-10-01T09-00-bbbbbbbb.json", "{}"); // legacy whole-file JSON: out of scope
  write(T + "/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/chats/session-2026-10-01T10-00-aaaaaaaa.jsonl", hdr(A, "main") + user); // pre-0.29 copy
  const found: string[] = []; const byPath = new Map<string, Sess>();
  gemini.scan((path: string, id: string, parent: string, archived: boolean) => {
    found.push(path.slice(T.length + 1) + " " + id.slice(0, 8) + " " + parent.slice(0, 8) + (archived ? " archived" : ""));
    const se = newSess("gemini", id, path, archived); se.parent = parent; byPath.set(path, se);
  });
  ok("roots", gemini.roots().join(" ") === T, gemini.roots().join(" "));
  ok("scan: one entry per session, cwd dirs only, legacy and copies skipped", found.slice().sort().join(" | ") ===
    "app-1/chats/session-2026-10-01T10-00-bbbbbbbb.jsonl bbbbbbbb  | app/chats/aaaaaaaa-0000-4000-8000-000000000001/cccccccc-0000-4000-8000-000000000003.jsonl cccccccc aaaaaaaa | app/chats/session-2026-10-01T10-00-aaaaaaaa.jsonl aaaaaaaa  | app/chats/session-2026-10-01T12-00-dddddddd.jsonl dddddddd ", found.slice().sort().join(" | "));
  const mA = byPath.get(T + "/app/chats/session-2026-10-01T10-00-aaaaaaaa.jsonl"); const mB = byPath.get(T + "/app-1/chats/session-2026-10-01T10-00-bbbbbbbb.jsonl");
  const sub = byPath.get(T + "/app/chats/" + A + "/" + SUB + ".jsonl");
  const mt = gemini.meta;
  if (mA && mB && sub && mt) {
    mt(mA); mt(mB); mt(sub);
    ok("meta: cwd from .project_root", mA.cwd === "/w/app" && mB.cwd === "/v/app" && sub.cwd === "/w/app", mA.cwd + " " + mB.cwd + " " + sub.cwd);
    ok("meta: subagent kind = the tool that ran it", sub.kind === "codebase_investigator" && mA.kind === "", sub.kind + "/" + mA.kind);
    const sp = gemini.spawnOf;
    ok("spawnOf: the call carrying the agent id", !!sp && sp(sub) === "invoke_agent__call_1" && sp(mA) === "", sp ? sp(sub) : "none");
    const fl = gemini.files;
    const fs = fl ? fl(mA).map((f: string) => f.slice(T.length + 1)).sort().join(" ") : "";
    ok("files: session + subagents + artifacts, never logs.json", fs === "app/" + A + " app/chats/" + A + " app/chats/session-2026-10-01T10-00-aaaaaaaa.jsonl app/chats/session-2026-10-01T10-00-aaaaaaaa.jsonl.unreadable-1790000000000 app/logs/session-" + A + ".jsonl app/tool-outputs/session-" + A, fs);
    const fb = fl ? fl(mB).map((f: string) => f.slice(T.length + 1)).sort().join(" ") : "";
    ok("files: the startup-only copy goes too", fb === "app-1/chats/session-2026-10-01T10-00-bbbbbbbb.jsonl app-1/chats/session-2026-10-01T11-00-bbbbbbbb.jsonl", fb);
    ok("files: a subagent is its file", fl ? fl(sub).join(" ") === sub.path : false, fl ? fl(sub).join(" ") : "");
  } else ok("scan found the sessions", false, found.join(" | "));
  delete process.env["GEMINI_CLI_HOME"];
}
// ── parse + busy on the normalized stream ──
function evs(ls: string[], s: Sess | null): Ev[] { const out: Ev[] = []; for (const l of ls) { const o = parseJson(l); if (o) gemini.parse(o, out, s); } return out; }
{
  const s = sess(P);
  const e = evs(src.lines(s, 0, bytes(FULL)).lines, s);
  const kinds = e.map((v: Ev) => v.kind + (v.kind === "meta" ? "(" + v.text + ")" : "")).join(" ");
  ok("parse: event kinds", kinds === "user thinking assistant tool result tool result user meta(rewound: 1 message dropped) assistant tool result meta(history rewritten: 3 messages dropped)", kinds);
  ok("parse: title and model", s.title === "Todo app ✓" && s.model === "gemini-2.5-flash", s.title + "/" + s.model);
  const u = e[0]; ok("parse: user text", u.text === "build a todo app — schön ✓", u.text);
  ok("parse: thinking = subject: description", e[1].text === "Plan: two files", e[1].text);
  const t = e[3]; const r = e[4];
  ok("parse: tool name\\0arg, paired with its result", t.text === "write_file\u0000a.js" && t.id === "c1" && r.id === "c1" && r.text === "ok ü", t.text + "/" + t.id + " " + r.text + "/" + r.id);
  ok("parse: shell arg", e[5].text === "run_shell_command\u0000node --check a.js", e[5].text);
}
{
  const g = (extra: string): string => "{\"id\":\"x\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"gemini\"" + extra + "}";
  const lines = [
    g(",\"content\":[{\"text\":\"hmm\",\"thought\":true},{\"text\":\"Answer\"},{\"functionCall\":{\"name\":\"ls\"}}]"), // checkpoint form
    "{\"id\":\"y\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"user\",\"content\":\"/rewind\"}",
    "{\"id\":\"y2\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"user\",\"content\":{\"text\":\"single part\"}}",
    "{\"id\":\"y3\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"user\",\"content\":[{\"inlineData\":{\"mimeType\":\"image/png\",\"data\":\"AAAA\"}}]}",
    "{\"id\":\"z\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"error\",\"content\":\"quota exceeded\"}",
    "{\"id\":\"z2\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"info\",\"content\":\"Request cancelled.\"}",
    g(",\"toolCalls\":[{\"id\":\"k\",\"name\":\"read_file\",\"args\":{\"file_path\":\"a\"},\"status\":\"error\",\"result\":[{\"functionResponse\":{\"id\":\"k\",\"name\":\"read_file\",\"response\":{\"error\":\"ENOENT\"}}}]},{\"id\":\"k2\",\"name\":\"list_directory\",\"args\":{\"dir_path\":\"src\"},\"status\":\"cancelled\",\"resultDisplay\":\"stopped\"}]"),
  ];
  const e = evs(lines, null);
  ok("parse: checkpoint content parts, noise, single part, image, error/info, tool status", e.map((v: Ev) => v.kind + ":" + v.text.split("\u0000").join("|")).join(" / ") ===
    "thinking:hmm / assistant:Answer / user:single part / user:[image] / meta:[error] quota exceeded / meta:Request cancelled. / tool:read_file|a / result:[error] ENOENT / tool:list_directory|src / result:[cancelled] stopped", e.map((v: Ev) => v.kind + ":" + v.text.split("\u0000").join("|")).join(" / "));
  const ts = sess(P); evs(["{\"$title\":\"{\\n  \\\"ExplorationTrace\\\": []}\"}"], ts);
  ok("parse: a subagent's JSON report is no title", ts.title === "", ts.title);
  const bz = (ks: string[]): boolean => { const s = sess(P); s.evs = ks.map((k: string) => ({ kind: k, text: "", ts: "", id: "", full: "" })); const f = gemini.busy; return !!f && f(s); };
  ok("busy: prompt", bz(["assistant", "user"]), "idle");
  ok("busy: tool result (the model answers next)", bz(["user", "tool", "result"]), "idle");
  ok("busy: thinking only (its tool calls are written on completion)", bz(["user", "thinking"]), "idle");
  ok("busy: answer", !bz(["user", "tool", "result", "assistant"]), "busy");
  ok("busy: error/cancel", !bz(["user", "meta"]), "busy");
  ok("busy: nothing", !bz([]), "busy");
  const sb = (name: string): boolean => { const s = sess(P); s.evs = [{ kind: "tool", text: name + "\u0000x", ts: "", id: "c9", full: "" }, { kind: "result", text: "done", ts: "", id: "c9", full: "" }]; const f = gemini.busy; return !!f && f(s); };
  ok("busy: a subagent's complete_task ends it", !sb("complete_task") && sb("read_file"), "");
  const ua = evs([g(",\"toolCalls\":[{\"id\":\"t1\",\"name\":\"update_topic\",\"args\":{\"title\":\"Todo\",\"summary\":\"long\"},\"status\":\"success\"},{\"id\":\"t2\",\"name\":\"activate_skill\",\"args\":{\"name\":\"ponytail\"},\"status\":\"success\"}]")], null);
  ok("tool args: update_topic title, activate_skill name", ua.length === 4 && ua[0].text === "update_topic\u0000Todo" && ua[2].text === "activate_skill\u0000ponytail", ua.map((v: Ev) => v.text.split("\u0000").join("|")).join(" / "));
}

// ── usage (normalized lines) and built-in Gemini prices ──
function acc(ls: string[]): Acc { const a = newAcc(); for (const l of ls) gemini.usage(a, l); return a; }
function day0(a: Acc): Day | null { let d: Day | null = null; for (const v of a.days.values()) d = v; return d; }
function near(x: number, y: number): boolean { return Math.abs(x - y) < 1e-12; }
const gm = (ts: string, model: string, tok: string, calls: string): string => "{\"id\":\"q\",\"timestamp\":\"" + ts + "\",\"type\":\"gemini\",\"model\":\"" + model + "\"" + (tok ? ",\"tokens\":" + tok : "") + (calls ? ",\"toolCalls\":[" + calls + "]" : "") + "}";
{
  const a = acc([gm("2026-10-01T10:00:00.000Z", "gemini-2.5-pro", "{\"input\":1000,\"output\":100,\"cached\":400,\"thoughts\":50,\"tool\":10,\"total\":1160}", "")]);
  ok("tokens: in = input − cached + tool, out = output + thoughts, cache read = cached", a.inTok === 610 && a.outTok === 150 && a.cr === 400 && a.cw === 0, a.inTok + "/" + a.outTok + "/" + a.cr);
  ok("cost: gemini-2.5-pro ≤ 200k", near(a.cost, (610 * 1.25 + 150 * 10 + 400 * 0.125) / 1e6) && a.unk === 0, String(a.cost));
  const b = acc([gm("2026-10-01T10:00:00.000Z", "gemini-2.5-pro", "{\"input\":250000,\"output\":100,\"cached\":0,\"thoughts\":0,\"tool\":0}", "")]);
  ok("cost: gemini-2.5-pro > 200k", near(b.cost, (250000 * 2.5 + 100 * 15) / 1e6), String(b.cost));
  const c = acc([gm("2026-10-01T10:00:00.000Z", "gemini-3.1-pro-preview", "{\"input\":300000,\"output\":10,\"cached\":100000,\"thoughts\":0,\"tool\":0}", "")]);
  ok("cost: gemini-3.1-pro > 200k incl. cache", near(c.cost, (200000 * 4 + 10 * 18 + 100000 * 0.4) / 1e6), String(c.cost));
  const f = acc([gm("2026-12-31T10:00:00.000Z", "gemini-3.8-flash", "{\"input\":1000,\"output\":10,\"cached\":0,\"thoughts\":0,\"tool\":0}", ""), gm("2027-01-02T10:00:00.000Z", "gemini-3.8-flash", "{\"input\":1000,\"output\":10,\"cached\":0,\"thoughts\":0,\"tool\":0}", "")]);
  ok("cost: gemini-3.8-flash before/after its 2027 price change", near(f.cost, (1000 * 0.75 + 10 * 3.75 + 1000 * 1.5 + 10 * 7.5) / 1e6), String(f.cost));
  const l = acc([gm("2026-10-01T10:00:00.000Z", "gemini-3.5-flash-lite", "{\"input\":1000,\"output\":10,\"cached\":0,\"thoughts\":0,\"tool\":0}", ""), gm("2026-10-01T10:00:00.000Z", "gemini-3-flash-preview", "{\"input\":1000,\"output\":10,\"cached\":0,\"thoughts\":0,\"tool\":0}", "")]);
  ok("cost: flash-lite is not priced as flash; -preview ids", near(l.cost, (1000 * 0.3 + 10 * 2.5 + 1000 * 0.5 + 10 * 3) / 1e6), String(l.cost));
  const u = acc([gm("2026-10-01T10:00:00.000Z", "gemini-9-flash", "{\"input\":1000,\"output\":10,\"cached\":0,\"thoughts\":0,\"tool\":0}", "")]);
  ok("cost: unknown model → unpriced tokens, not $0", u.cost === 0 && u.unk === 1010, u.cost + "/" + u.unk);
  applyUserPrices({ "gemini-2.5-pro": { input: 2, output: 20 } });
  const ov = acc([gm("2026-10-01T10:00:00.000Z", "gemini-2.5-pro", "{\"input\":250000,\"output\":100,\"cached\":0,\"thoughts\":0,\"tool\":0}", "")]);
  ok("prices.json override of a base model also covers its >200k tier", near(ov.cost, (250000 * 2 + 100 * 20) / 1e6), String(ov.cost));
  applyUserPrices({ "gemini-2.5-pro": { input: 2, output: 20 }, "gemini-2.5-pro>200k": { input: 3, output: 30 } });
  const ov2 = acc([gm("2026-10-01T10:00:00.000Z", "gemini-2.5-pro", "{\"input\":250000,\"output\":100,\"cached\":0,\"thoughts\":0,\"tool\":0}", "")]);
  ok("prices.json naming the tier keeps it", near(ov2.cost, (250000 * 3 + 100 * 30) / 1e6), String(ov2.cost));
  applyUserPrices(null);
  const tk = "{\"input\":1000,\"output\":10,\"cached\":0,\"thoughts\":0,\"tool\":0}";
  const v = acc([gm("2026-10-01T10:00:00.000Z", "gemini-3.8-flash-lite", tk, ""), gm("2026-10-01T10:00:00.000Z", "gemini-2.5-flash-image", tk, "")]);
  ok("cost: an unpriced variant is not priced as its base model", v.cost === 0 && v.unk === 2020, v.cost + "/" + v.unk);
  const w = acc([gm("2026-10-01T10:00:00.000Z", "gemini-3.1-flash-lite-preview-06-17", tk, ""), gm("2026-10-01T10:00:00.000Z", "models/gemini-2.5-pro-001", tk, "")]);
  ok("cost: -preview / version suffixes keep the base price", near(w.cost, (1000 * 0.25 + 10 * 1.5 + 1000 * 1.25 + 10 * 10) / 1e6) && w.unk === 0, w.cost + "/" + w.unk);
}
{
  const sh = "{\"id\":\"k1\",\"name\":\"run_shell_command\",\"args\":{\"command\":\"npm test\"},\"status\":\"error\",\"timestamp\":\"2026-10-01T10:00:02.500Z\",\"result\":[{\"functionResponse\":{\"id\":\"k1\",\"name\":\"run_shell_command\",\"response\":{\"output\":\"fail\"}}}]}";
  const rp = "{\"id\":\"k2\",\"name\":\"replace\",\"args\":{\"file_path\":\"a.js\",\"old_string\":\"x\",\"new_string\":\"y\"},\"status\":\"success\",\"timestamp\":\"2026-10-01T10:00:01.000Z\",\"resultDisplay\":{\"filePath\":\"/w/a.js\",\"diffStat\":{\"model_added_lines\":3,\"model_removed_lines\":1}}}";
  const wf = "{\"id\":\"k3\",\"name\":\"write_file\",\"args\":{\"file_path\":\"b.js\",\"content\":\"1\\n2\\n\"},\"status\":\"success\",\"timestamp\":\"2026-10-01T10:00:01.000Z\"}";
  const a = acc([gm("2026-10-01T10:00:00.000Z", "gemini-2.5-flash", "", sh + "," + rp + "," + wf)]);
  const d = day0(a);
  const row = (k: string): string => { const v = d ? d.tt.get(k) : undefined; return v ? [v.n, v.err, v.dn, v.ms].join(",") : "none"; };
  ok("tools: one row each, duration from the message, error from status", a.tools === 3 && row("run_shell_command") === "1,1,1,2500" && row("replace") === "1,0,1,1000", row("run_shell_command") + " " + row("replace"));
  const progs: string[] = []; if (d) for (const k of d.prog.keys()) progs.push(k);
  ok("shell program", progs.join("|") === "run_shell_command\tnpm", progs.join("|"));
  const fs: string[] = []; if (d) for (const [k, v] of d.files) fs.push(k + ":" + String(v.add) + "/" + String(v.del));
  ok("lines: diffStat preferred, write_file from its content", a.add === 5 && a.del === 1 && fs.sort().join(" ") === "replace\t/w/a.js:3/1 write_file\tb.js:2/0", a.add + "/" + a.del + " " + fs.join(" "));
  ok("no pending calls", a.pend.size === 0, String(a.pend.size));
}
// gemini writes status "success" for every shell command that ran: the failure is in the response (gemini 0.62 shapes)
{
  const sh = (id: string, out: string): string => "{\"id\":\"" + id + "\",\"name\":\"run_shell_command\",\"args\":{\"command\":\"cat missing.txt\"},\"status\":\"success\",\"timestamp\":\"2026-10-01T10:00:01.000Z\",\"result\":[{\"functionResponse\":{\"id\":\"" + id + "\",\"name\":\"run_shell_command\",\"response\":{\"output\":" + JSON.stringify(out) + "}}}]}";
  const rf = "{\"id\":\"f5\",\"name\":\"read_file\",\"args\":{\"file_path\":\"nope.txt\"},\"status\":\"success\",\"timestamp\":\"2026-10-01T10:00:01.000Z\",\"result\":[{\"functionResponse\":{\"id\":\"f5\",\"name\":\"read_file\",\"response\":{\"error\":\"File not found: nope.txt\"}}}]}";
  const calls = [
    sh("f1", "<untrusted_context>\nOutput: cat: missing.txt: No such file or directory\nExit Code: 1\nProcess Group PGID: 4242\n</untrusted_context>"), // failed
    sh("f2", "<untrusted_context>\nOutput: cat: missing.txt: No such file or directory\nProcess Group PGID: 4243\n</untrusted_context>"), // `|| true`: exit 0
    sh("f3", "Output: Exit Code: 7 is what the test prints\nProcess Group PGID: 4244"), // the command's own text, not the trailer
    sh("f4", "Command: sleep 9\nDirectory: (root)\nOutput: (empty)\nError: (none)\nExit Code: (none)\nSignal: 15\nBackground PIDs: (none)\nProcess Group PGID: 4245"), // older gemini: killed
    rf,
    sh("f6", "Command was automatically cancelled because it exceeded the timeout of 5.0 minutes without output. There was no output before it was cancelled."),
    sh("f7", "Command: ls\nDirectory: (root)\nOutput: a\nError: (none)\nExit Code: 0\nSignal: (none)\nBackground PIDs: (none)\nProcess Group PGID: 4246"), // older gemini: ok
    // exit 0, the output's own last lines look like trailer lines: gemini writes "Error:" only with status "error" and
    // "Exit Code:" only when non-zero, each once, in the order Error, Exit Code, Signal, Background PIDs, PGID
    sh("f8", "<untrusted_context>\nOutput: npm test\nError: 2 tests failed\nProcess Group PGID: 4247\n</untrusted_context>"),
    sh("f9", "<untrusted_context>\nOutput: done\nExit Code: 0\nProcess Group PGID: 4248\n</untrusted_context>"),
    sh("f10", "<untrusted_context>\nOutput: Signal: 9\nExit Code: 2\nProcess Group PGID: 4249\n</untrusted_context>"), // out of order: the trailer is Exit Code + PGID
    sh("f11", "<untrusted_context>\nOutput: x\nExit Code: 5\nExit Code: 3\nProcess Group PGID: 4250\n</untrusted_context>"), // one Exit Code line only
  ];
  const codes: string[] = [];
  setCallTap((id: string, ms: number, err: boolean, cs: number[], nm: string) => { codes.push(id + (err ? "!" : "") + (cs.length ? ":" + cs.join(",") : "")); });
  const a = acc([gm("2026-10-01T10:00:00.000Z", "gemini-2.5-flash", "", calls.join(","))]);
  setCallTap(null);
  const d = day0(a);
  const row = (k: string): string => { const v = d ? d.tt.get(k) : undefined; return v ? [v.n, v.err].join(",") : "none"; };
  ok("failed calls: non-zero exit code, signal, response error, timeout count as errors", row("run_shell_command") === "10,5" && row("read_file") === "1,1", row("run_shell_command") + " " + row("read_file"));
  ok("failed calls: the tap gets the error flag and the exit code", codes.join(" ") === "f1!:1 f2 f3 f4! f5! f6! f7 f8 f9 f10!:2 f11!:3", codes.join(" "));
  const pg = d ? d.prog.get("run_shell_command\tcat") : undefined;
  ok("failed calls: the shell program's error count", !!pg && pg.err === 5, pg ? String(pg.err) : "none");
  ok("failed calls: call rows carry the error", a.calls.map((c) => String(c.err)).join("") === "10011100011", a.calls.map((c) => String(c.err)).join(""));
  const e = evs(["{\"id\":\"q\",\"timestamp\":\"" + TS + "1.000Z\",\"type\":\"gemini\",\"toolCalls\":[" + calls.join(",") + "]}"], null);
  const tags = e.filter((v: Ev) => v.kind === "result").map((v: Ev) => { const m = /^\[[a-z]+\]/.exec(v.text); return m ? m[0] : "-"; }).join(" ");
  ok("failed calls: the transcript marks them", tags === "[error] - - [error] [error] [timeout] - - - [error] [error]", tags);
}
// the issuing message's model reaches each call row, also when the calls arrive in a later version of the message
{
  const s = sess(P);
  const ls = src.lines(s, 0, bytes(FULL)).lines.filter((l: string) => l.indexOf("\"toolCalls\"") >= 0);
  ok("normalized call lines carry the message's model", ls.length === 2 && ls.every((l: string) => { const o = parseJson(l); return !!o && str(o["model"]).startsWith("gemini-2.5-"); }), ls.map((l: string) => l.slice(0, 120)).join(" | "));
  const a = acc(src.lines(s, 0, bytes(FULL)).lines);
  const ms = a.calls.map((c) => nameOf(DICT.model, c.model)).join(" ");
  ok("call rows: the model of the message that issued them", ms === "gemini-2.5-pro gemini-2.5-pro gemini-2.5-flash", ms);
}
{
  const sk ="{\"id\":\"k9\",\"name\":\"activate_skill\",\"args\":{\"name\":\"ponytail\"},\"status\":\"success\",\"timestamp\":\"2026-10-01T10:00:01.000Z\"}";
  const a = acc([gm("2026-10-01T10:00:00.000Z", "gemini-2.5-flash", "", sk)]);
  const u = skillUses(a, null).map((x) => x.source + "\t" + x.name + "=" + String(x.n)).join(",");
  ok("activate_skill: a model skill use", u === "model\tponytail=1" && a.tools === 1, u);
}
// the ledger reads windows of the normalized stream: any split books the same totals, each message's tokens once
{
  const s = sess(P); const end = bytes(FULL);
  const whole = acc(src.lines(s, 0, end).lines);
  ok("stream: tokens of m2 and m4 once", whole.inTok === 610 + 2000 && whole.outTok === 150 + 20 && whole.cr === 400 && whole.tools === 3, whole.inTok + "/" + whole.outTok + "/" + whole.tools);
  for (let i = 1; i < starts.length; i++) {
    const a = newAcc(); for (const l of src.lines(s, 0, starts[i]).lines) gemini.usage(a, l); for (const l of src.lines(s, starts[i], end).lines) gemini.usage(a, l);
    let ta = 0; for (const d of a.days.values()) ta += d.turns; let tw = 0; for (const d of whole.days.values()) tw += d.turns;
    ok("stream split " + String(i) + ": same turns", ta === tw && tw > 0, String(ta) + "/" + String(tw));
    ok("stream split " + String(i) + ": same totals", a.inTok === whole.inTok && a.outTok === whole.outTok && near(a.cost, whole.cost) && a.tools === whole.tools && a.add === whole.add, a.inTok + "/" + a.tools);
  }
}

rmSync(DIR, { recursive: true, force: true });
// reasoning tokens (thoughts) for the OTLP export: a subset of out, never added twice
{ const a = newAcc(); gemini.usage(a, "{\"id\":\"r1\",\"timestamp\":\"2026-01-02T10:00:00.000Z\",\"type\":\"gemini\",\"model\":\"gemini-2.5-pro\",\"tokens\":{\"input\":10,\"output\":5,\"cached\":0,\"thoughts\":50,\"tool\":0,\"total\":65}}");
  ok("gemini thoughts → rs", a.rs === 50 && a.outTok === 55, a.rs + "/" + a.outTok); }
console.log(bad ? bad + " failed" : "gemini: all checks passed");
process.exit(bad ? 1 : 0);
