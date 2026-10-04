// agentglass — self-check for the head memo (a replayed head read equals a real one): scriptc build src/model/headmemo.check.ts -o hmc && ./hmc
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Sess, newSess } from "./types.ts";
import { loadHead, loadTail, titleOf, HEADS, type HeadMemo } from "./sessions.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-headmemo-check-" + String(process.pid); // per process: concurrent suite runs
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });

// an in-memory memo store, counting reads and writes
const memos = new Map<string, HeadMemo>(); let puts = 0;
HEADS.get = (s: Sess): HeadMemo | null => memos.get(s.path) ?? null;
HEADS.put = (s: Sess, m: HeadMemo): void => { memos.set(s.path, m); puts++; };

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

// the log keeps growing: the memo stays valid (the head is final)
appendFileSync(p, user("more", "40") + "\n");
const grown = fresh(); loadHead(grown);
eq("grown log: still replayed", String(puts), "1");
eq("grown log: same head", grown.prompt + "|" + grown.cwd, "build the todo app|/w/app");

// a log rewritten in place (another first prompt): its first 4 KB hash no longer matches, the head is read again
writeFileSync(p, user("a different start", "00") + "\n" + pad(140000));
const rw = fresh(); loadHead(rw);
eq("rewritten log read again", rw.prompt + "|" + String(puts), "a different start|2");

// a log still inside its head window: never memoized (its head is not final yet)
const q = dir + "/b.jsonl"; writeFileSync(q, user("small", "00") + "\n");
const sm = newSess("claude", "b", q, false); sm.size = statSync(q).size; loadHead(sm);
eq("small log: no memo", String(memos.has(q)) + "|" + sm.prompt, "false|small");

rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "headmemo: all checks passed");
if (bad) process.exit(1);
