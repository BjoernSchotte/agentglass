// agentglass — self-check for the shared session marks: scriptc build src/model/marks.check.ts -o mk && ./mk
// SPDX-License-Identifier: Apache-2.0
import { newSess, type Sess } from "./types.ts";
import { type Mark, registerMarks, markKinds, marksOf, markEv, nextMark } from "./marks.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ok(what: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + what); } }

const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
function at(sec: number): number { return T0 + sec * 1000; }
function iso(sec: number): string { return new Date(at(sec)).toISOString(); }
function mk(kind: string, t0: number, t1: number, seq: number, turn: number, anchor: string, ref: string): Mark {
  return { kind, t0, t1, seq, turn, ev: -1, anchor, label: ref, sub: "", tok: 0, usd: 0, est: false, ref };
}

const s: Sess = newSess("claude", "m1", "/m/m1.jsonl", false);
for (let i = 0; i < 5; i++) s.evs.push({ kind: i === 3 ? "tool" : "assistant", text: "e" + String(i), ts: iso(i * 10), id: i === 3 ? "c1" : "", full: "" });
s.size = 100;

let aCalls = 0; let bCalls = 0; const G = { n: 0 };
registerMarks({ kind: "a", glyph: "a", color: () => "", gen: (x: Sess) => 0,
  of: (x: Sess) => { aCalls++; return [mk("a:x", at(30), at(30), 0, 0, "ts=" + iso(30), "a2"), mk("a:x", at(10), at(10), 0, 0, "ts=" + iso(10), "a1")]; } });
registerMarks({ kind: "b", glyph: "b", color: () => "", gen: (x: Sess) => G.n,
  of: (x: Sess) => { bCalls++; return [mk("b:y", at(20), at(40), 0, 0, "", "b1")]; } });

const all = marksOf(s, null);
eq("order", all.map((m: Mark) => m.kind + "@" + String((m.t0 - T0) / 1000)).join(","), "a:x@10,b:y@20,a:x@30");
eq("family filter", String(marksOf(s, ["b"]).length), "1");
eq("exact kind filter", String(marksOf(s, ["a:x"]).length), "2");
eq("unknown kind", String(marksOf(s, ["zz"]).length), "0");
eq("markEv by time", all.map((m: Mark) => String(markEv(s, m))).join(","), "1,2,3");
eq("markEv by anchor", String(markEv(s, mk("a:x", 0, 0, 0, 0, "call=c1", "z"))), "3");
eq("markEv none", String(markEv(s, mk("a:x", at(99), at(99), 0, 0, "", "z"))), "-1");
eq("next forward", String(nextMark(s, 1, 1, null)), "2");
eq("next back", String(nextMark(s, 2, -1, null)), "1");
eq("next at end", String(nextMark(s, 3, 1, null)), "-1");
eq("next first back", String(nextMark(s, 1, -1, null)), "-1");
eq("next filtered", String(nextMark(s, 0, 1, ["b"])), "2");
eq("families", markKinds().map((k) => k.kind).join(","), "a,b");

// memo: unchanged size and gen → providers not called again; a size change or a gen bump → again
const a0 = aCalls; const b0 = bCalls;
marksOf(s, null); marksOf(s, null);
ok("memo hit", aCalls === a0 && bCalls === b0);
s.size++; marksOf(s, null);
ok("size change recomputes", aCalls === a0 + 1 && bCalls === b0 + 1);
G.n++; marksOf(s, null);
ok("gen change recomputes", aCalls === a0 + 2 && bCalls === b0 + 2);

// a family registered twice replaces the first
registerMarks({ kind: "b", glyph: "B", color: () => "", gen: (x: Sess) => 7, of: (x: Sess) => [mk("b:z", at(5), -1, 0, 0, "", "bz")] });
eq("replaced family", markKinds().map((k) => k.kind + k.glyph).join(","), "aa,bB");
eq("replaced marks", marksOf(s, ["b"]).map((m: Mark) => m.kind).join(","), "b:z");

// Kiro-style marks without times: ordered by turn and seq, after the dated marks of their turn
const k: Sess = newSess("kiro", "k1", "/k/k1", false); k.size = 1;
registerMarks({ kind: "k", glyph: "k", color: () => "", gen: (x: Sess) => 0,
  of: (x: Sess) => x.h !== "kiro" ? [] : [mk("k:p", 0, 0, 2, 1, "", "k2"), mk("k:p", 0, 0, 1, 1, "", "k1"), mk("k:p", 0, 0, 0, 2, "", "k3"), mk("k:d", at(1), at(1), 0, 1, "", "kd")] });
eq("undated by seq", marksOf(k, ["k"]).map((m: Mark) => m.ref).join(","), "kd,k1,k2,k3");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok marks");
