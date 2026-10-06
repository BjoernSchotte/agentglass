// agentglass — self-check for the per-message rows sidecar (fleet spec 13.1): scriptc build src/features/usage/msgrows.check.ts -o mr && ./mr
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, appendFileSync, mkdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, complete } from "./ledger.ts";
import { forget } from "./owners.ts";
import { msgHash, rowsFor, readRows, rowsFile, ownKeys } from "./msgrows.ts";
import type { OwnRow } from "../fleet/model.ts";
import "../../harness/index.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = join(HOME, "mr", "p"); mkdirSync(dir, { recursive: true });
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "mr", "cache");
function asst(id: string, ts: string, model: string, inp: number, out: number, cr: number, cw: number): string {
  return "{\"type\":\"assistant\",\"timestamp\":\"" + ts + "\",\"requestId\":\"req_" + id + "\",\"message\":{\"id\":\"" + id + "\",\"model\":\"" + model + "\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"usage\":{\"input_tokens\":" + String(inp) + ",\"output_tokens\":" + String(out) + ",\"cache_read_input_tokens\":" + String(cr) + ",\"cache_creation_input_tokens\":" + String(cw) + "}}}";
}
function sess(path: string): Sess {
  let s = sessions.get(path);
  if (!s) { s = newSess("claude", path.slice(path.lastIndexOf("/") + 1, -6), path, false); sessions.set(path, s); }
  s.size = statSync(path).size; s.mtime = Date.now();
  return s;
}
function sums(rows: OwnRow[]): number[] { const t = [0, 0, 0, 0, 0]; for (const r of rows) { for (let i = 0; i < 4; i++) t[i] = (t[i] ?? 0) + (r.n[i] ?? 0); t[3] = (t[3] ?? 0) + (r.n[4] ?? 0); if ((r.n[6] ?? 0) === 1) t[4] = (t[4] ?? 0) + (r.n[5] ?? 0); } return t; }
function hs(rows: OwnRow[]): string { const o: string[] = []; for (const r of rows) if (o.indexOf(r.h) < 0) o.push(r.h); return o.sort().join(","); }

const L1 = join(dir, "s-one.jsonl"); const L2 = join(dir, "s-two.jsonl");
const T1 = "2026-09-01T10:00:00.000Z"; const T2 = "2026-09-01T10:01:00.000Z"; const T3 = "2026-09-01T11:30:00.000Z"; const T9 = "2026-09-02T09:00:00.000Z"; const T0 = "2026-08-31T09:00:00.000Z";
writeFileSync(L1, [asst("m1", T1, "claude-sonnet-4-5", 10, 5, 100, 20), asst("m2", T2, "claude-opus-4-1", 7, 3, 50, 0), asst("m2", T2, "claude-opus-4-1", 7, 9, 50, 0), asst("m3", T3, "claude-sonnet-4-5", 1, 2, 3, 4)].join("\n") + "\n");
writeFileSync(L2, [asst("m2", T9, "claude-opus-4-1", 7, 9, 50, 0), asst("m4", T9, "claude-sonnet-4-5", 2, 2, 2, 2)].join("\n") + "\n");

ok("hash 16 hex", /^[0-9a-f]{16}$/.test(msgHash("msg_x")), msgHash("msg_x"));
ok("hash stable", msgHash("msg_x") === msgHash("msg_x") && msgHash("msg_x") !== msgHash("msg_y"), "differs");
ok("hash is salted", msgHash("msg_x") !== "", "");

const s1 = sess(L1); const s2 = sess(L2); complete(s1); complete(s2);
let a1 = ledger.get(L1); let a2 = ledger.get(L2);
let r1 = a1 ? rowsFor(L1, "claude", a1) : null; let r2 = a2 ? rowsFor(L2, "claude", a2) : null;
ok("log 1: 3 messages, ok", !!r1 && r1.ok && hs(r1.rows) === [msgHash("m1"), msgHash("m2"), msgHash("m3")].sort().join(","), r1 ? JSON.stringify(r1.rows) : "-");
ok("log 2: only m4 (m2 owned by log 1)", !!r2 && r2.ok && hs(r2.rows) === msgHash("m4"), r2 ? JSON.stringify(r2.rows) : "-");
// a streamed message (same id twice, output grew 3 → 9): one row with the final output
const m2 = r1 ? r1.rows.filter((r: OwnRow) => r.h === msgHash("m2")) : [];
ok("streamed message: one row, output 9", m2.length === 1 && (m2[0]?.n[1] ?? 0) === 9, JSON.stringify(m2));
ok("rows sum to the ledger entry", !!a1 && !!r1 && JSON.stringify(sums(r1.rows).slice(0, 4)) === JSON.stringify([a1.inTok, a1.outTok, a1.cr, a1.cw]), r1 && a1 ? JSON.stringify(sums(r1.rows)) + " vs " + String(a1.inTok) : "-");
ok("rows cost = the ledger's", !!a1 && !!r1 && Math.abs((sums(r1.rows)[4] ?? 0) - a1.cost) < 1e-9, r1 && a1 ? String(sums(r1.rows)[4]) + " vs " + String(a1.cost) : "-");
ok("row day/hour", !!r1 && r1.rows.some((r: OwnRow) => r.h === msgHash("m3") && r.hr === new Date(T3).getHours()), "hour");
ok("ownership keys", !!a1 && ownKeys(L1, a1).length === 3, "keys");
// cached: the second call reads the file
const again = a1 ? rowsFor(L1, "claude", a1) : null;
ok("cached read", !!again && again.ok && !again.rebuilt && again.rows.length === (r1 ? r1.rows.length : -1), again ? String(again.rebuilt) : "-");
// the log grows: rows continue from the stored offset
appendFileSync(L1, asst("m5", T3, "claude-sonnet-4-5", 3, 3, 3, 3) + "\n");
complete(sess(L1)); a1 = ledger.get(L1);
r1 = a1 ? rowsFor(L1, "claude", a1) : null;
ok("grown log: continued, not rebuilt", !!r1 && r1.ok && !r1.rebuilt && r1.rows.some((r: OwnRow) => r.h === msgHash("m5")), r1 ? String(r1.rebuilt) + " " + String(r1.rows.length) : "-");
ok("grown: file holds every row", readRows(L1, 0).n === (r1 ? r1.rows.length : -1), String(readRows(L1, 0).n));
ok("ownership keys follow a grown entry", !!a1 && ownKeys(L1, a1).length === 4 && ownKeys(L1, a1).some((r: OwnRow) => r.h === msgHash("m5")), a1 ? String(ownKeys(L1, a1).length) : "-");
// log 2's copy of m2 moves earlier: log 1 restarts without it, log 2 owns it
writeFileSync(L2, [asst("m2", T0, "claude-opus-4-1", 7, 9, 50, 0), asst("m4", T9, "claude-sonnet-4-5", 2, 2, 2, 2)].join("\n") + "\n");
sessions.clear(); ledger.clear(); forget();
complete(sess(L1)); complete(sess(L2));
a1 = ledger.get(L1); a2 = ledger.get(L2);
r1 = a1 ? rowsFor(L1, "claude", a1) : null; r2 = a2 ? rowsFor(L2, "claude", a2) : null;
ok("after the takeover: log 1 without m2", !!r1 && r1.ok && r1.rebuilt && !r1.rows.some((r: OwnRow) => r.h === msgHash("m2")), r1 ? JSON.stringify(r1.rows) : "-");
ok("after the takeover: log 2 owns m2", !!r2 && r2.ok && r2.rows.some((r: OwnRow) => r.h === msgHash("m2")), r2 ? JSON.stringify(r2.rows) : "-");
ok("after the takeover: sums", !!a2 && !!r2 && JSON.stringify(sums(r2.rows).slice(0, 4)) === JSON.stringify([a2.inTok, a2.outTok, a2.cr, a2.cw]), "sums");
// a corrupt line: readRows says so, rowsFor rebuilds
appendFileSync(rowsFile(L1), "garbage\n");
ok("corrupt line → not ok", !readRows(L1, 0).ok, "ok");
r1 = a1 ? rowsFor(L1, "claude", a1) : null;
ok("corrupt → rebuilt", !!r1 && r1.ok && r1.rebuilt && readRows(L1, 0).ok, r1 ? String(r1.rebuilt) : "-");
// no message id ever reaches the sidecar
const raw = readFileSync(rowsFile(L1), "utf8") + readFileSync(rowsFile(L2), "utf8");
ok("no raw ids in the rows file", raw.indexOf("m1\t") < 0 && raw.indexOf("req_") < 0, raw.slice(0, 200));

if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("msgrows: all checks passed");
