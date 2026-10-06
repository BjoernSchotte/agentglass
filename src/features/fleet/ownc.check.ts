// agentglass — self-check for own rows in columns: scriptc build src/features/fleet/ownc.check.ts -o oc && ./oc
// SPDX-License-Identifier: Apache-2.0
import { sha256Hex } from "../../util/sha256.ts";
import type { OwnRow } from "./model.ts";
import { hashId, hashFind, hashHex, hashCount, chunkOf, rowAt, fillRow, rowsOfChunk, rowsOfChunks, lenOf, joinChunks, NO_ROWS } from "./ownc.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const hx = (i: number): string => sha256Hex("m" + String(i)).slice(0, 16);
ok("not a hash: -1", hashId("") === -1 && hashId("msg_raw_id") === -1 && hashFind("ABCDEF0123456789") === -1, String(hashId("")));
ok("unknown hash: find is -1, adds nothing", hashFind(hx(0)) === -1 && hashCount() === 0, String(hashCount()));
// the table grows past several doublings; every hash keeps its id and comes back as the same 16 digits
const N = 50000; const ids: number[] = [];
for (let i = 0; i < N; i++) ids.push(hashId(hx(i)));
let same = true; let back = true; let dense = true;
for (let i = 0; i < N; i++) { if (hashId(hx(i)) !== ids[i] || hashFind(hx(i)) !== ids[i]) same = false; if (hashHex(ids[i] ?? -1) !== hx(i)) back = false; if (ids[i] !== i) dense = false; }
ok("ids stable across growth", same, "");
ok("hex round trip", back, hashHex(ids[7] ?? -1) + " vs " + hx(7));
ok("dense ids", dense && hashCount() === N, String(hashCount()));
// the high bit of either half (int32 sign) and leading zeros
for (const h of ["ffffffffffffffff", "0000000000000000", "80000000000000ff", "00000001ffffffff"]) ok("edge " + h, hashHex(hashId(h)) === h && hashFind(h) === hashId(h), hashHex(hashId(h)));
// a chunk holds rows with usage and ownership-only rows; rows come back exactly
const rows: OwnRow[] = [
  { h: hx(1), key: 1759000000123, d: "2026-09-30", hr: 23, m: "claude-sonnet-4-5", prov: "anthropic", n: [3, 120, 45000, 300, 7, 0.0123, 1] },
  { h: hx(2), key: 1759000001000, d: "", hr: 0, m: "", prov: "", n: [] },
  { h: hx(1), key: 1759000002000, d: "2026-10-01", hr: 0, m: "claude-opus-4-1", prov: "bedrock", n: [1, 2, 0, 0, 0, -1, 0] },
];
const c = chunkOf(rows);
ok("rowAt", JSON.stringify(rowAt(c, 0)) === JSON.stringify(rows.slice(0, 1)[0] ?? null), JSON.stringify(rowAt(c, 0)));
ok("chunk size", c.n === 3 && lenOf([c, c]) === 6, String(c.n));
ok("rows round trip", JSON.stringify(rowsOfChunk(c)) === JSON.stringify(rows), JSON.stringify(rowsOfChunk(c)));
ok("chunks in order", JSON.stringify(rowsOfChunks([c, chunkOf(rows.slice(1))])) === JSON.stringify(rows.concat(rows.slice(1))), "");
ok("a copy shares the hash id", (c.h[0] ?? -1) === (c.h[2] ?? -2) && (c.h[0] ?? -1) === hashFind(hx(1)), "");
const scratch: OwnRow = { h: "", key: 0, d: "", hr: 0, m: "", prov: "", n: [] };
fillRow(c, 0, scratch); const n0 = scratch.n; fillRow(c, 2, scratch);
ok("scratch row reused", scratch.n === n0 && scratch.prov === "bedrock" && (scratch.n[5] ?? 0) === -1, JSON.stringify(scratch));
fillRow(c, 1, scratch); ok("scratch: ownership-only", scratch.n.length === 0 && scratch.d === "" && scratch.key === 1759000001000, JSON.stringify(scratch));
ok("no rows", chunkOf([]) === NO_ROWS && NO_ROWS.n === 0, "");
ok("usage columns only for rows with usage", c.d.length === 2 && c.v.length === 14 && (c.u[1] ?? 0) === -1, String(c.d.length));
const j2 = joinChunks([c, NO_ROWS, chunkOf(rows.slice(1))]);
ok("joined chunks: one, rows in order", j2.n === 5 && j2.d.length === 3 && JSON.stringify(rowsOfChunk(j2)) === JSON.stringify(rows.concat(rows.slice(1))), JSON.stringify(rowsOfChunk(j2)));
ok("one chunk joins as itself", joinChunks([c]) === c && joinChunks([]) === NO_ROWS, "");
console.log(bad ? String(bad) + " failed" : "own columns: all checks passed");
if (bad) process.exit(1);
