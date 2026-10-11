// agentglass — self-check: serve gives back the call rows it read for one answer (dropRows): back to unread when the
// calls file holds them as they are, read again on demand with the same rows; kept when a pending call points into them
// or the file is behind the ledger: scriptc build src/features/usage/droprows.check.ts -o dr && ./dr
// SPDX-License-Identifier: Apache-2.0
// Runs under check.sh's temp HOME: the cache (and its calls files) lives in $HOME/.agentglass/cache.
import { H } from "../../hooks.ts";
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { fxBase } from "../query/fixture.ts";
import { ledger, unread, callsOf, dropRows } from "./ledger.ts";
import { ROWS } from "./facts.ts";
import { L } from "./record.ts";
import { type Pend, newTS } from "./calls.ts";
import "./cache.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
if (!process.env.AGENTGLASS_HERMETIC) { console.log("droprows: skipped (needs check.sh's temp HOME)"); process.exit(0); }

for (const f of H.firstScan) f(); // the (empty) cache loaded: saves are on
fxBase();
ROWS.on = true; L.idx++;
for (const f of H.onQuit) f(); // saves the ledger and every session's calls file (written = its offset)
const withRows: Sess[] = []; for (const s of sessions.values()) { const a = ledger.get(s.path); if (a && a.rows.n > 0 && a.pend.size === 0) withRows.push(s); }
ok("fixture has sessions with call rows", withRows.length >= 2, String(withRows.length));
const s = withRows[0] as Sess; const a0 = ledger.get(s.path);
const sig = (x: Sess): string => { const r = callsOf(x); const o: string[] = []; for (let i = 0; i < r.n; i++) o.push(String(r.t[i] + 0) + "/" + String(r.tool[i] + 0) + "/" + String(r.err[i] + 0)); return o.join(","); };
const before = sig(s);
ok("dropped", dropRows(s), "kept");
ok("unread again, rows gone from memory", unread.has(s.path) && !!a0 && a0.rows.n === 0, String(unread.has(s.path)) + " " + String(a0 ? a0.rows.n : -1));
ok("read again on demand: the same rows", sig(s) === before && !unread.has(s.path), sig(s) + " vs " + before);
ok("entry kept (not re-indexed)", ledger.get(s.path) === a0, "replaced");
dropRows(s); ok("dropping unread rows: nothing to do", !dropRows(s), "dropped twice");
callsOf(s); // read back
// a pending call points into the rows: kept
const t = withRows[1] as Sess; const at = ledger.get(t.path);
const pd: Pend = { t: 0, ts: "", arg: "", st: newTS(), sh: [], rows: null, ri: -1, sp: [], name: "Bash", cmd: "", id: "x", end: 0, dn: [], day: "", shk: [] };
if (at) at.pend.set("x", pd);
ok("pending call: kept", !dropRows(t) && !unread.has(t.path), "dropped");
if (at) at.pend.delete("x");
// the ledger moved past the calls file (rows booked since the save): kept
if (at) at.off += 10;
ok("file behind the ledger: kept", !dropRows(t) && !unread.has(t.path), "dropped");
if (at) at.off -= 10;
ok("in step again: dropped", dropRows(t), "kept");
console.log(bad ? bad + " failed" : "droprows: all checks passed");
if (bad) process.exit(1);
