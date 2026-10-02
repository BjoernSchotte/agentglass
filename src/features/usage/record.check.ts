// agentglass — self-check for the usage record primitives: scriptc build src/features/usage/record.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { newAcc, bucket, tool, pend, retool, tokens, usageExact, credits, modelUses } from "./record.ts";
import { newSess } from "../../model/types.ts";
import { fx } from "../../harness/fx.ts";

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

// unpriced tokens per model (gemini's "?" marker stripped), credits apart, cost per provider, per hour and per model
const b = newAcc(); const iso2 = "2026-10-01T09:30:00.000Z"; const h2 = new Date(iso2).getHours();
const d2 = bucket(b, 0, iso2);
tokens(b, d2, "claude-sonnet-4-5", 1000, 100, 0, 0, 0);                 // priced
tokens(b, d2, "gpt-x-unknown", 900, 0, 0, 0, 0);                         // unpriced
tokens(b, d2, "?gemini-2.5-flash-lite", 300, 0, 0, 0, 0);                // gemini's unpriced marker key
usageExact(b, d2, "whatever", 10, 0, 0, 0, 0, 0.5, "openrouter");        // harness-reported cost, provider key
credits(b, d2, 120);
ok("unk tokens only", b.unk === 1200 && d2.unk === 1200, String(d2.unk));
ok("um per model", d2.um.get("gpt-x-unknown") === 900 && d2.um.get("gemini-2.5-flash-lite") === 300 && !d2.um.has("?gemini-2.5-flash-lite"), [...d2.um.keys()].join(","));
ok("credits apart", b.uc === 120 && d2.uc === 120 && b.unk === 1200, String(b.uc));
ok("cp per provider", (d2.cp.get("openrouter") ?? 0) === 0.5 && (d2.cp.get("") ?? 0) > 0, [...d2.cp.keys()].join(","));
let cps = 0; for (const v of d2.cp.values()) cps += v;
ok("cp sums to cost", Math.abs(cps - d2.cost) < 1e-9, cps + " vs " + d2.cost);
ok("hc hour", Math.abs((d2.hc[h2] ?? 0) - d2.cost) < 1e-9 && d2.hc.length === 24, (d2.hc[h2] ?? 0) + "");
const ms = d2.mt.get("claude-sonnet-4-5") ?? [];
ok("mt tokens", ms[0] === 1000 && ms[1] === 100 && (d2.mt.get("gpt-x-unknown") ?? [])[0] === 900 && d2.mt.has("gemini-2.5-flash-lite") && !d2.mt.has("?gemini-2.5-flash-lite"), [...d2.mt.keys()].join(","));
let mtc = 0; for (const v of d2.mt.values()) mtc += v[4] ?? 0;
ok("mt cost sums to cost", Math.abs(mtc - d2.cost) < 1e-9, mtc + " vs " + d2.cost);
const mu = modelUses(b, null);
const gx = mu.filter((u) => u.model === "gpt-x-unknown");
ok("modelUses order + unk", mu.length === 4 && mu[0].cost >= mu[1].cost && gx.length === 1 && gx[0].unk === 900, mu.map((u) => u.model).join(","));
ok("modelUses day filter", modelUses(b, ["1999-01-01"]).length === 0, "");

// fx: a $0 snapshot (custom model connection) books its token delta as unpriced tokens, no "1" marker
const fdir = "/tmp/agentglass-record-check/s1"; mkdirSync(fdir, { recursive: true });
function snap(inp: number): void { const fd = openSync(fdir + "/usage-v2.json", "w"); writeSync(fd, "{\"snapshot\":{\"input_tokens\":" + String(inp) + ",\"output_tokens\":50,\"total_cost\":0}}"); closeSync(fd); }
const fs1 = newSess("fx", "s1", fdir + "/events.jsonl", false); const fa = newAcc();
const side = fx.usageSidecar;
snap(500); if (side) side(fs1, fa);
let fum = 0; for (const fd of fa.days.values()) fum += fd.um.get("fx:custom") ?? 0;
ok("fx $0 snapshot = unpriced tokens", fa.unk === 550 && fum === 550, fa.unk + " / " + fum);
snap(600); fa.xM = 0; if (side) side(fs1, fa);
ok("fx second snapshot adds the delta", fa.unk === 650, String(fa.unk));
rmSync("/tmp/agentglass-record-check", { recursive: true, force: true });
console.log(bad ? bad + " failed" : "usage record: all checks passed");
if (bad) process.exit(1);
