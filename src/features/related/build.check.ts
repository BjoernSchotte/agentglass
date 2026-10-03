// agentglass — self-check for the related-events builder: scriptc build src/features/related/build.check.ts -o rb && ./rb
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, appendFileSync, statSync, readFileSync } from "node:fs";
import { type Ev, type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { harnessOf, parseEvents } from "../../harness/index.ts";
import { P } from "../../model/project.ts";
import { ledger, accOf } from "../usage/ledger.ts";
import { LOG } from "../rules/engine.ts";
import { type Build, anchorTime, candidates, startBuild, stepBuild, repoll, CAP_BYTES } from "./build.ts";
import type { RelEv } from "./model.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
P.sync = true;
const D = "/tmp/agentglass-related-keepme-" + String(process.pid); // keepme: content stays real under the checks' redaction
rmSync(D, { recursive: true, force: true });
function repo(p: string): void { mkdirSync(p + "/.git/logs", { recursive: true }); writeFileSync(p + "/.git/config", "[core]\n"); writeFileSync(p + "/.git/HEAD", "ref: refs/heads/main\n"); }
repo(D + "/proj"); repo(D + "/other"); mkdirSync(D + "/logs", { recursive: true });
const NOW = Date.now(); const T = NOW - 120000; // the anchor: 2 min ago, so ±10 min reaches into the future (live)
function iso(dt: number): string { return new Date(T + dt).toISOString(); }
function user(dt: number, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(dt), cwd: "", message: { role: "user", content: text } }); }
function call(dt: number, id: string, name: string, input: string): string { return "{\"type\":\"assistant\",\"timestamp\":\"" + iso(dt) + "\",\"message\":{\"id\":\"m" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":" + input + "}]}}"; }
function res(dt: number, id: string, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(dt), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } }); }
// a session file + its ledger account (fed through the adapter like the ledger does, so Day.act is real); indexed = false: no account
function sess(id: string, cwd: string, lines: string[], indexed: boolean): Sess {
  const p = D + "/logs/" + id + ".jsonl";
  const body = lines.join("\n") + "\n"; writeFileSync(p, body);
  const s = newSess("claude", id, p, false); s.cwd = cwd; s.headDone = true;
  const st = statSync(p); s.size = st.size; s.mtime = st.mtimeMs;
  sessions.set(p, s);
  if (indexed) { const a = accOf(s); const ad = harnessOf("claude"); for (const l of lines) ad.usage(a, l); a.off = s.size; }
  return s;
}
// the events a transcript of s holds (the whole file, parsed)
function evsOf(s: Sess): Ev[] { const out: Ev[] = []; for (const l of readFileSync(s.path, "utf8").split("\n")) parseEvents(s.h, l, out, s); return out; }
function reset(): void { sessions.clear(); ledger.clear(); }
function run(b: Build): void { for (let g = 0; g < 10000 && stepBuild(b, 1e9, () => Date.now()); g++) { /* to the end */ } }
function kinds(b: Build, sess: string): string { return b.rows.filter((r: RelEv) => r.sess === sess).map((r: RelEv) => r.kind + ":" + r.text).join(" | "); }

// ── anchorTime ──
const ev = (ts: string): Ev => ({ kind: "user", text: "x", ts, id: "", full: "" });
eq("anchorTime: nearest earlier", String(anchorTime([ev(""), ev(""), ev(iso(5000)), ev(""), ev(iso(9000))], 3) - T), "5000");
eq("anchorTime: next later when nothing earlier", String(anchorTime([ev(""), ev(iso(7000))], 0) - T), "7000");
eq("anchorTime: none", String(anchorTime([ev(""), ev("")], 1)), "0");
const nt = sess("nt", D + "/proj", [user(0, "hi")], true);
eq("startBuild: no time → null", String(startBuild(nt, [ev(""), ev("")], 1, 10, 10) === null), "true");

// ── candidates: 45 of the project active in the window, 3 of another project, 1 inactive ──
reset();
const anc = sess("a00", D + "/proj", [user(0, "anchor"), user(60000, "more")], true);
for (let i = 1; i < 45; i++) sess("p" + String(i).padStart(2, "0"), D + "/proj", [user(-300000, "x"), user(-300000 + i * 5000, "y")], true);
for (let i = 0; i < 3; i++) sess("o" + String(i), D + "/other", [user(0, "x")], true);
const old = sess("old", D + "/proj", [user(-3 * 3600000, "x")], true); old.mtime = T - 3 * 3600000;
const c1 = candidates(anc, T - 600000, T + 600000, 40);
eq("cap 40", String(c1.paths.length) + " more " + String(c1.more), "40 more 5");
eq("anchor first", c1.paths[0] ?? "", anc.path);
eq("other project absent", String(c1.paths.some((p: string) => p.indexOf("/o") >= 0 && p.indexOf("/old") < 0)), "false");
eq("inactive absent", String(c1.paths.indexOf(old.path) >= 0), "false");
eq("scope project", c1.scope, "project");
eq("ranked by active minutes: the longest kept", String(c1.paths.indexOf(D + "/logs/p44.jsonl") > 0 && c1.paths.indexOf(D + "/logs/p43.jsonl") > 0), "true");
// ── no project (no cwd) → only same-cwd sessions ──
reset();
const n0 = sess("n0", "", [JSON.stringify({ type: "user", timestamp: iso(0), message: { role: "user", content: "a" } })], true);
const n1 = sess("n1", "", [JSON.stringify({ type: "user", timestamp: iso(1000), message: { role: "user", content: "b" } })], true);
sess("n2", D + "/proj", [user(1000, "c")], true);
const c2 = candidates(n0, T - 600000, T + 600000, 40);
eq("kind none: same cwd only", c2.scope + " " + String(c2.paths.length) + " " + String(c2.paths.indexOf(n1.path)), "cwd 2 1");
// ── unindexed (no account): mtime in the window, head ts before t1 → candidate ──
reset();
const ua = sess("ua", D + "/proj", [user(0, "a")], true);
const ub = sess("ub", D + "/proj", [user(-60000, "b")], false);
const uc = sess("uc", D + "/proj", [user(900000, "late")], false); // first ts after t1
const c3 = candidates(ua, T - 600000, T + 600000, 40);
eq("unindexed in window", String(c3.paths.indexOf(ub.path) > 0), "true");
eq("unindexed starting after t1", String(c3.paths.indexOf(uc.path) >= 0), "false");

// ── budget: 40 sessions of 2 MB each, all inside the window ──
reset();
const pad = "z".repeat(180);
function big(id: string): Sess { const ls: string[] = []; for (let i = 0; i < 10000; i++) ls.push(user(-540000 + i * 100, "m" + String(i) + " " + pad)); return sess(id, D + "/proj", ls, true); }
const b0 = big("b00"); for (let i = 1; i < 40; i++) big("b" + String(i).padStart(2, "0"));
const bb = startBuild(b0, [ev(iso(0))], 0, 10, 10);
if (!bb) { bad++; console.log("FAIL budget: no build"); } else {
  let clock = 0; const fake = (): number => { clock += 20; return clock; };
  let steps = 0; let maxWin = 0; let more = true;
  while (more && steps < 100000) {
    const before = bb.bytes; more = stepBuild(bb, 50, fake); steps++;
    const w = Math.round((bb.bytes - before) / 65536); if (w > maxWin) maxWin = w;
  }
  eq("budget: ≤ 16 MB read", String(bb.bytes <= CAP_BYTES), "true");
  eq("budget: capped", String(bb.capped), "true");
  eq("budget: ≤ 3 windows per 50 ms tick (seek reads included ≤ 16)", String(maxWin <= 19), "true");
  eq("budget: incremental (many ticks)", String(steps > 20), "true");
  eq("budget: rows from several sessions", String(new Set<string>(bb.rows.map((r: RelEv) => r.sess)).size >= 5), "true");
}

// ── alerts, commits, reflog, live repoll ──
reset();
const la = sess("la", D + "/proj", [user(0, "go"), call(30000, "g1", "Bash", "{\"command\":\"git commit -m fix\"}"), res(31000, "g1", "[main abc1234] fix login\n 1 file changed")], true);
const lb = sess("lb", D + "/proj", [user(5000, "other")], true);
const lo = sess("lo", D + "/other", [user(5000, "elsewhere")], true);
LOG.push({ at: T + 20000, path: lb.path, rule: "approval", from: 0, to: 1, state: "fire", v: 30, thr: 20 });
LOG.push({ at: T + 20000, path: lo.path, rule: "approval", from: 0, to: 1, state: "fire", v: 30, thr: 20 });
LOG.push({ at: T + 25000, path: lb.path, rule: "stuck", from: 1, to: 0, state: "resolve", v: 0, thr: 20 });
const ts = Math.floor((T + 40000) / 1000); const z40 = "0".repeat(40);
writeFileSync(D + "/proj/.git/logs/HEAD",
  z40 + " abc1234" + "f".repeat(33) + " N <a@b> " + String(ts - 9) + " +0000\tcommit: fix login\n" +
  "abc1234" + "f".repeat(33) + " def5678" + "e".repeat(33) + " N <a@b> " + String(ts) + " +0000\tcommit: hand-made\n" +
  "def5678" + "e".repeat(33) + " 1111111" + "e".repeat(33) + " N <a@b> " + String(ts + 1) + " +0000\tcheckout: moving from main to x\n");
la.pid = process.pid; // live
const bl = startBuild(la, evsOf(la), 0, 10, 10);
if (!bl) { bad++; console.log("FAIL live: no build"); } else {
  run(bl);
  eq("alert row of a candidate", kinds(bl, lb.path), "prompt:other | alert:approval degraded");
  eq("no alert of a non-candidate", String(bl.rows.some((r: RelEv) => r.sess === lo.path)), "false");
  eq("banner commit row", kinds(bl, la.path), "prompt:go | shell:git commit -m fix | commit:abc1234 fix login");
  eq("reflog commit no session observed (subject hidden under --redact)", kinds(bl, ""), "commit:commit (no session) def5678");
  eq("live", String(bl.live), "true");
  appendFileSync(la.path, user(90000, "later 1") + "\n" + user(95000, "later 2") + "\n");
  la.size = statSync(la.path).size;
  const n = bl.rows.length;
  eq("repoll: changed", String(repoll(bl)), "true");
  eq("repoll: 2 more rows", String(bl.rows.length - n), "2");
  eq("repoll again: nothing new", String(repoll(bl)), "false");
  eq("repoll: no duplicates", String(bl.rows.filter((r: RelEv) => r.text === "later 1").length), "1");
}
// the open transcript reaching back past t0 is reused: no read of the anchor's log
reset();
const ra = sess("ra", D + "/proj", [user(-700000, "early"), user(0, "mid")], true);
const tvEvs: Ev[] = [{ kind: "user", text: "early", ts: iso(-700000), id: "", full: "" }, { kind: "user", text: "mid", ts: iso(0), id: "", full: "" }];
const br = startBuild(ra, tvEvs, 1, 10, 10);
eq("reuse: anchor session done without reads", br ? String(br.next) + " " + String(br.bytes) + " " + kinds(br, ra.path) : "null", "1 0 prompt:mid");

rmSync(D, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "related build: all checks passed");
process.exit(bad ? 1 : 0);
