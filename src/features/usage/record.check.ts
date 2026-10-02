// agentglass — self-check for the usage record primitives: scriptc build src/features/usage/record.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
import { newAcc, bucket, tool, pend, retool, skill, skillUses } from "./record.ts";
import { accOut, accIn } from "./cache.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

// retool moves the one count of a pending call to another tool row: tool total, hour histogram, row removed at 0
const a = newAcc();
const iso = "2026-10-01T10:00:00.000Z";
const d = bucket(a, 0, iso); const hr = new Date(iso).getHours();
pend(a, d, tool(a, d, "mcp"), "mcp", "c1", 0, iso, "", []);
const p1 = a.pend.get("c1");
ok("pending", !!p1, "");
if (p1) retool(a, p1, "mcp__s__t");
const row = d.tt.get("mcp__s__t");
ok("old row gone", !d.tt.has("mcp"), String(d.tt.size));
ok("new row n", !!row && row.n === 1, row ? String(row.n) : "none");
ok("new row hour", !!row && (row.h[hr] ?? 0) === 1, row ? row.h.join(",") : "none");
ok("totals unchanged", a.tools === 1 && d.tools === 1 && (d.hours[hr] ?? 0) === 1, [a.tools, d.tools, d.hours[hr] ?? 0].join(","));
ok("pend points at new row", !!p1 && !!row && p1.st === row, "");
// a second call of the old tool stays where it is when another one moves
pend(a, d, tool(a, d, "mcp"), "mcp", "c2", 0, iso, "", []);
pend(a, d, tool(a, d, "mcp"), "mcp", "c3", 0, iso, "", []);
const p3 = a.pend.get("c3");
if (p3) retool(a, p3, "mcp__s__t");
const old = d.tt.get("mcp"); const nw = d.tt.get("mcp__s__t");
ok("kept row", !!old && old.n === 1 && (old.h[hr] ?? 0) === 1, old ? String(old.n) : "none");
ok("moved row", !!nw && nw.n === 2 && (nw.h[hr] ?? 0) === 2, nw ? String(nw.n) : "none");
ok("totals after two moves", a.tools === 3 && d.tools === 3, [a.tools, d.tools].join(","));
// same name: no-op
if (p3) retool(a, p3, "mcp__s__t");
const nw2 = d.tt.get("mcp__s__t");
ok("same name no-op", !!nw2 && nw2.n === 2, nw2 ? String(nw2.n) : "none");
// skills per day: "<source>\t<name>", summed and sorted by uses
{
  const k = newAcc(); const kd = bucket(k, 0, "2026-10-01T10:00:00.000Z"); const ke = bucket(k, 0, "2026-10-02T10:00:00.000Z");
  skill(kd, "command", "a:b"); skill(ke, "command", "a:b"); skill(kd, "model", "a:b"); skill(kd, "model", "");
  const u = skillUses(k, null).map((x) => x.name + "/" + x.source + "/" + String(x.n)).join(",");
  ok("skillUses", u === "a:b/command/2,a:b/model/1", u);
  const u1 = skillUses(k, ["2026-10-02"]).map((x) => x.name + "/" + x.source + "/" + String(x.n)).join(",");
  ok("skillUses by day", u1 === "a:b/command/1", u1);
  k.pk = "p1\tx:y";
  const r = accIn(JSON.parse(JSON.stringify(accOut(k))));
  const ru = skillUses(r, null).map((x) => x.name + "/" + x.source + "/" + String(x.n)).join(",");
  const rd = r.days.get("2026-10-01");
  ok("cache round trip: skills, pk", ru === u && r.pk === "p1\tx:y" && !!rd, ru + " " + r.pk);
  const old = accIn({ off: 1, days: { "2026-10-01": { t: 1 } } }); const od = old.days.get("2026-10-01");
  ok("cache: old day without k", !!od && od.skills.size === 0 && old.pk === "", od ? String(od.skills.size) : "-");
}
console.log(bad ? bad + " failed" : "usage record: all checks passed");
if (bad) process.exit(1);
