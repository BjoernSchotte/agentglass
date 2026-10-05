// agentglass — self-check for the tick's billing labels (recomputed only when an input moved):
// scriptc build src/features/usage/bill-live.check.ts -o blc && ./blc
// SPDX-License-Identifier: Apache-2.0
import { newSess } from "../../model/types.ts";
import { sessions, SG } from "../../model/sessions.ts";
import { ledger } from "./ledger.ts";
import { newAcc, stamp } from "./record.ts";
import { labelAll, BL } from "./bill-live.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const a = newSess("claude", "b1", "/b/1.jsonl", false); a.cwd = "/tmp/proj"; sessions.set(a.path, a);
const b = newSess("codex", "b2", "/b/2.jsonl", false); sessions.set(b.path, b);
const acc = newAcc(); ledger.set(a.path, acc);
const T = 1700000000000; // a minute boundary: T / 60000 is whole
function runs(now: number): string { const n0 = BL.labels; labelAll(now); return String(BL.labels - n0); }

eq("first tick labels all", runs(T), "2");
const base = a.bill + "/" + a.billSrc; // the config's (assumed) label in this empty home
eq("nothing changed: none", runs(T + 500), "0");
a.pid = 77; eq("pid: that session", runs(T + 1000), "1");
stamp(acc, "api", "", "transcript"); eq("stamp: that session", runs(T + 1500), "1");
eq("label follows the stamp", a.bill + "/" + a.billSrc, "api/transcript");
ledger.set(a.path, newAcc()); eq("re-indexed entry: that session", runs(T + 2000), "1");
eq("label back to the config's", a.bill + "/" + a.billSrc, base);
a.cwd = "/tmp/other"; eq("cwd (project settings): that session", runs(T + 2500), "1");
// an old session (not live, not written within the minute) waits for the next minute's pass
const old = newSess("claude", "b3", "/b/3.jsonl", false); old.mtime = T - 3600000; sessions.set(old.path, old);
SG.gen++; eq("new session: looked at, labelled", runs(T + 2600), "1");
ledger.set(old.path, newAcc()); const oa = ledger.get(old.path); if (oa) stamp(oa, "api", "", "transcript");
eq("old session's stamp: not before the minute", runs(T + 3000), "0");
a.pid = 0; eq("a pid that went: relabelled", runs(T + 3500), "1");
eq("next minute: config re-checked for all", runs(T + 60000), "3");
eq("old session's stamp: at the minute", old.bill + "/" + old.billSrc, "api/transcript");
const a2 = newSess("claude", "b1", "/b/1.jsonl", false); sessions.set(a2.path, a2); SG.gen++; // the same path, a new session object (scan bumps the generation)
eq("new session object: labelled", runs(T + 60500), "1");
eq("its label", a2.bill + "/" + a2.billSrc, base);

console.log(bad ? bad + " failed" : "bill-live: all checks passed");
if (bad) process.exit(1);
