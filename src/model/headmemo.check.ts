// agentglass — self-check for the head memo (a replayed head read equals a real one): scriptc build src/model/headmemo.check.ts -o hmc && ./hmc
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Sess, newSess } from "./types.ts";
import { H } from "../hooks.ts";
import { loadHead, loadTail, titleOf, activity, HEADS, TAILS, type HeadMemo, type TailMemo } from "./sessions.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-headmemo-check-" + String(process.pid); // per process: concurrent suite runs
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });

// an in-memory memo store, counting reads and writes
const memos = new Map<string, HeadMemo>(); let puts = 0;
HEADS.get = (s: Sess): HeadMemo | null => memos.get(s.path) ?? null;
HEADS.put = (s: Sess, m: HeadMemo): void => { memos.set(s.path, m); puts++; };
const tails = new Map<string, TailMemo>(); let tputs = 0;
TAILS.get = (s: Sess): TailMemo | null => tails.get(s.path) ?? null;
TAILS.put = (s: Sess, m: TailMemo): void => { tails.set(s.path, m); tputs++; };

const T = (s: string): string => "\"timestamp\":\"2026-10-01T09:" + s + ":00.000Z\"";
const user = (t: string, at: string): string => "{\"type\":\"user\"," + T(at) + ",\"cwd\":\"/w/app\",\"gitBranch\":\"main\",\"message\":{\"role\":\"user\",\"content\":" + JSON.stringify(t) + "}}";
const asst = (at: string, model: string): string => "{\"type\":\"assistant\"," + T(at) + ",\"cwd\":\"/w/app\",\"gitBranch\":\"feat\",\"message\":{\"id\":\"m" + at + "\",\"model\":\"" + model + "\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}";
const custom = (t: string, at: string): string => "{\"type\":\"custom-title\",\"customTitle\":" + JSON.stringify(t) + ",\"sessionId\":\"x\"," + T(at) + "}";
const ai = (t: string): string => "{\"type\":\"ai-title\",\"aiTitle\":" + JSON.stringify(t) + ",\"sessionId\":\"x\"}";
const pad = (n: number): string => { let o = ""; const big = "{\"type\":\"progress\",\"data\":\"" + "x".repeat(4000) + "\"}\n"; while (o.length < n) o += big; return o; };

// a Claude log past its 128 KB head window: the first prompt, cwd/branch/model and a /rename live in the head only
const p = dir + "/a.jsonl";
writeFileSync(p, user("build the todo app", "00") + "\n" + asst("01", "claude-sonnet-4-5") + "\n" + custom("My todo app", "02") + "\n" + pad(140000) + ai("auto title") + "\n" + user("next step", "30") + "\n");
function fresh(): Sess { const s = newSess("claude", "a", p, false); s.size = statSync(p).size; return s; }
function shape(s: Sess): string { return [s.prompt, s.title, s.cwd, s.branch, s.model, titleOf(s)].join("|"); }

const real = fresh(); loadHead(real); loadTail(real);
eq("real read stores a memo", String(puts), "1");
const memo = memos.get(p);
eq("memo covers the head window", String(memo ? memo.w : 0), "131072");
// the same log under another path (Claude's rename state is per path): only the memo can bring the rename back
const p2 = dir + "/a2.jsonl"; copyFileSync(p, p2); if (memo) memos.set(p2, memo);
const replay = newSess("claude", "a2", p2, false); replay.size = statSync(p2).size; loadHead(replay); loadTail(replay);
eq("replayed head, no new memo", String(puts), "1");
eq("replay equals the real read", shape(replay), shape(real));
eq("the rename survives the tail's ai-title", replay.title, "My todo app");
eq("the head's first prompt", replay.prompt, "build the todo app");

// the tail memo: a lite read (one-shot lists) of an unchanged, not live log replays the tail's fields and its last event
const p3 = dir + "/a3.jsonl"; copyFileSync(p, p3); const tm = tails.get(p); if (tm) tails.set(p3, tm); if (memo) memos.set(p3, memo);
const n1 = tputs;
const lite = newSess("claude", "a3", p3, false); lite.size = statSync(p3).size; loadHead(lite); loadTail(lite, true);
eq("lite tail replayed", String(tputs - n1) + "|" + String(lite.evs.length), "0|1");
eq("lite tail equals the real read", shape(lite) + "|" + activity(lite), shape(real) + "|" + activity(real));
const live = newSess("claude", "a3", p3, false); live.size = statSync(p3).size; live.pid = 4242; loadHead(live); loadTail(live, true);
eq("a live session reads its tail", String(tputs - n1), "1");
const full = newSess("claude", "a3", p3, false); full.size = statSync(p3).size; loadHead(full); loadTail(full);
eq("a full tail read (TUI) never replays", String(tputs - n1), "2");

// the log keeps growing: the memo stays valid (the head is final)
appendFileSync(p, user("more", "40") + "\n");
const grown = fresh(); loadHead(grown);
eq("grown log: still replayed", String(puts), "1");
eq("grown log: same head", grown.prompt + "|" + grown.cwd, "build the todo app|/w/app");

// a log rewritten in place (another first prompt): its first 4 KB hash no longer matches, the head is read again
writeFileSync(p, user("a different start", "00") + "\n" + pad(140000));
const rw = fresh(); loadHead(rw);
eq("rewritten log read again", rw.prompt + "|" + String(puts), "a different start|2");

// a log still inside its head window: replayed only while its size stays the same
const q = dir + "/b.jsonl"; writeFileSync(q, user("small", "00") + "\n");
const small = (): Sess => { const x = newSess("claude", "b", q, false); x.size = statSync(q).size; loadHead(x); return x; };
const n0 = puts; small();
eq("small log: memo", String(memos.has(q)) + "|" + String(puts - n0), "true|1");
eq("small log unchanged: replayed", small().prompt + "|" + String(puts - n0), "small|1");
appendFileSync(q, asst("05", "claude-opus-5-5") + "\n");
eq("small log grew: read again", small().model + "|" + String(puts - n0), "claude-opus-5-5|2");

// rewritten in place with the same first 4 KB: a /rename near the end of the head window changed, the log grew
const fill = (n: number): string => "{\"type\":\"progress\",\"data\":\"" + "y".repeat(n - 32) + "\"}\n"; // exactly n bytes
const r = dir + "/r.jsonl"; const W = 131072;
const body = (t: string, more: number): string => { const a = user("build the todo app", "00") + "\n" + pad(100000); return a + fill(W - 2000 - a.length) + custom(t, "50") + "\n" + pad(more); };
writeFileSync(r, body("Old name", 20000));
const rs = (mt: number): Sess => { const x = newSess("claude", "r", r, false); x.size = statSync(r).size; x.mtime = mt; loadHead(x); return x; };
let n2 = puts; rs(1);
eq("window-end rename: stored", String(puts - n2), "1");
writeFileSync(r, body("New name", 30000)); n2 = puts;
eq("same first 4 KB, the window's end changed: read again", rs(2).title + "|" + String(puts - n2), "New name|1");
// …or shrank below the size it had when the memo was kept (a rewrite the two hashed ends cannot see)
const big = statSync(r).size; writeFileSync(r, body("New name", 30000).slice(0, big - 8000) + "\n"); n2 = puts; rs(4);
eq("shrunk log: read again", String(puts - n2), "1");
// a log shorter than its window: rewritten at the same size and the same ends (a mid-file edit): mtime tells
const u = dir + "/u.jsonl"; const short = (t: string): string => user("small", "00") + "\n" + pad(9000) + custom(t, "10") + "\n" + pad(9000);
writeFileSync(u, short("aaaa"));
const us = (mt: number): Sess => { const x = newSess("claude", "u", u, false); x.size = statSync(u).size; x.mtime = mt; loadHead(x); return x; };
us(10); n2 = puts;
eq("short log, same mtime: replayed", us(10).title + "|" + String(puts - n2), "aaaa|0");
writeFileSync(u, short("bbbb"));
eq("short log rewritten (same size, new mtime): read again", us(11).title + "|" + String(puts - n2), "bbbb|1");
// the tail memo: same size but another mtime (rewritten) is read again
const v = dir + "/v.jsonl"; writeFileSync(v, user("tail one", "00") + "\n" + asst("01", "claude-sonnet-4-5") + "\n");
const vt = (mt: number): Sess => { const x = newSess("claude", "v", v, false); x.size = statSync(v).size; x.mtime = mt; loadHead(x); loadTail(x, true); return x; };
vt(20); let n3 = tputs; vt(20);
eq("tail memo, same size and mtime: replayed", String(tputs - n3), "0");
writeFileSync(v, user("tail one", "00") + "\n" + asst("01", "claude-sonnet-4-6") + "\n"); n3 = tputs;
eq("tail memo, same size, new mtime: read again", vt(21).model + "|" + String(tputs - n3), "claude-sonnet-4-6|1");

// a head read in a run that knew the cwd already (the project cache, an earlier read) still keeps it: a later run that
// replays the memo knows it only from there (agent mode scopes by it)
{
  const q = dir + "/q.jsonl"; writeFileSync(q, user("known cwd", "00") + "\n" + asst("01", "claude-sonnet-4-5") + "\n");
  const k1 = newSess("claude", "q", q, false); k1.size = statSync(q).size; k1.mtime = 30; k1.cwd = "/w/app"; k1.branch = "feat"; k1.model = "claude-sonnet-4-5"; loadHead(k1);
  const k2 = newSess("claude", "q", q, false); k2.size = statSync(q).size; k2.mtime = 30; const nq = puts; loadHead(k2);
  eq("replay keeps the cwd, branch and model a run knew before its read", k2.cwd + "|" + k2.branch + "|" + k2.model + "|" + String(puts - nq), k1.cwd + "|" + k1.branch + "|" + k1.model + "|0");
  eq("(the read kept them)", k1.cwd, "/w/app");
}
// memos hold what the event hooks made of the log (a title, the last event) under the hiding rules of their run: other
// rules (skills.hide changed) read the log again, so a memo never shows what the new rules hide
let key = ""; H.memoKey.push((): string => key);
vt(21); n3 = tputs; let nh = puts; vt(21); eq("memo replayed before the change", String(puts - nh) + "|" + String(tputs - n3), "0|0"); key = "acme-*=name";
const vk = vt(21); eq("other hiding rules: head and tail read again", String(puts - nh) + "|" + String(tputs - n3), "1|1");
nh = puts; n3 = tputs; vt(21); eq("same rules again: replayed", String(puts - nh) + "|" + String(tputs - n3), "0|0");
key = ""; eq("memo key kept", vk.model, "claude-sonnet-4-6");
rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "headmemo: all checks passed");
if (bad) process.exit(1);
