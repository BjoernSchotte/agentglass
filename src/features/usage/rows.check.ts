// agentglass — self-check for columnar call rows: scriptc build src/features/usage/rows.check.ts -o rw && ./rw
// SPDX-License-Identifier: Apache-2.0
import { newRows, push, addId, rowIds, hasIds, compact, KIND_PROG, KIND_CMD, KIND_FILE } from "./rows.ts";
import { selfRssMb } from "../../util/selfmem.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const r = newRows();
eq("first index", String(push(r, 1000, 1, 2, 0)), "0");
addId(r, 0, KIND_PROG, 5); addId(r, 0, KIND_CMD, 7); addId(r, 0, KIND_CMD, 7); addId(r, 0, KIND_CMD, 8);
push(r, 2000, 3, -1, 1);
addId(r, 0, KIND_CMD, 9); // an older row: ignored
addId(r, 1, KIND_FILE, 4); addId(r, 1, KIND_PROG, -1);
push(r, 3000, 1, 2, 2); addId(r, 2, KIND_CMD, 11); addId(r, 2, KIND_PROG, 5);
r.ms[1] = 250; r.err[1] = 1; r.out[1] = 99; r.cid[2] = "toolu_x";
eq("ids per kind", rowIds(r, 0, KIND_PROG).join("+") + "|" + rowIds(r, 0, KIND_CMD).join("+") + "|" + rowIds(r, 0, KIND_FILE).join("+"), "5|7+8|");
eq("ids of the middle row", rowIds(r, 1, KIND_FILE).join("+") + "|" + rowIds(r, 1, KIND_PROG).join("+"), "4|");
eq("ids of the newest row", rowIds(r, 2, KIND_CMD).join("+") + "|" + rowIds(r, 2, KIND_PROG).join("+"), "11|5");
eq("hasIds", String(hasIds(r, 1, KIND_FILE)) + String(hasIds(r, 1, KIND_CMD)), "truefalse");
eq("defaults", String(r.ms[0]) + " " + String(r.err[0]) + " " + String(r.out[0]) + " " + JSON.stringify(r.cid[0]), "-1 -1 0 \"\"");
eq("out of range", rowIds(r, 7, KIND_CMD).length + "" + rowIds(r, -1, KIND_CMD).length, "00");
const m = compact(r, (i: number) => i !== 0);
eq("compact map", m.join(","), "-1,0,1");
eq("compact columns", String(r.n) + " " + String(r.t[0]) + " " + String(r.ms[0]) + " " + String(r.err[0]) + " " + String(r.out[0]) + " " + r.cid[1], "2 2000 250 1 99 toolu_x");
eq("compact keeps ids aligned", rowIds(r, 0, KIND_FILE).join("+") + "|" + rowIds(r, 1, KIND_CMD).join("+") + "|" + rowIds(r, 1, KIND_PROG).join("+") + " nl " + String(r.nl), "4|11|5 nl 3");
push(r, 4000, 1, 1, 0); addId(r, 2, KIND_FILE, 6);
eq("push after compact", String(r.n) + " " + rowIds(r, 2, KIND_FILE).join("+") + " " + rowIds(r, 1, KIND_CMD).join("+"), "3 6 11");
eq("compact all", compact(r, (i: number) => false).join(",") + " n " + String(r.n) + " nl " + String(r.nl), "-1,-1,-1 n 0 nl 0");
// 300k rows with an id each: ≤ 45 MB
const r0 = selfRssMb(); const big = newRows();
for (let i = 0; i < 300000; i++) { push(big, 1700000000000 + i, i % 40, i % 5, 0); addId(big, i, KIND_CMD, i % 1000); }
const g = selfRssMb() - r0;
if (r0 >= 0) eq("300k rows ≤ 45 MB (got " + String(g) + " MB)", String(g <= 45), "true");
eq("300k rows readable", String(big.n) + " " + rowIds(big, 299999, KIND_CMD).join(","), "300000 999");
console.log(bad ? bad + " failed" : "rows: all checks passed");
if (bad) process.exit(1);
