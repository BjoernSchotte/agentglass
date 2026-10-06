// agentglass — self-check for the fleet CLI's pure parts: scriptc build src/features/fleet/cli.check.ts -o fc && ./fc
// SPDX-License-Identifier: Apache-2.0
import { obj } from "../../util/json.ts";
import { newSum } from "../usage/costs.ts";
import { withHost, strictCode, FLEET_FIELDS, totalJson } from "./cli.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const o = withHost({ id: "a", harness: "claude", title: "t", updated: "x", live: true, pid: 0 }, "ws", false);
ok("host after harness, stale after live", Object.keys(o).join(",") === "id,harness,host,title,updated,live,stale,pid", Object.keys(o).join(","));
ok("values", o["host"] === "ws" && o["stale"] === false, JSON.stringify(o));
ok("fields", FLEET_FIELDS.indexOf("host") === FLEET_FIELDS.indexOf("harness") + 1 && FLEET_FIELDS.indexOf("stale") === FLEET_FIELDS.indexOf("live") + 1, FLEET_FIELDS.join(","));
ok("strict", strictCode(1, 0) === 5 && strictCode(0, 1) === 5 && strictCode(0, 0) === 0, "codes");
const t = newSum(); t.by[0] = 3; t.by[1] = 2;
const tj = totalJson({ today: t, week: t, month: t, projByMode: [10, 1, 0, 0, 0], approx: false, marked: false, perHost: [] }, { state: "", used: 0, projected: -1, approx: false });
const today = obj(tj["today"]); const bm = today ? obj(today["byMode"]) : null; const mo = obj(tj["month"]); const pr = mo ? obj(mo["projected"]) : null;
ok("total shape", !!bm && bm["api"] === 3 && bm["plan"] === 2 && !!pr && pr["total"] === 11 && tj["budget"] === null, JSON.stringify(tj));
console.log(bad ? String(bad) + " failed" : "fleet cli: all checks passed");
if (bad) process.exit(1);
