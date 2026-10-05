// agentglass — self-check for the usage record primitives: scriptc build src/features/usage/record.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { type Acc, reprice, tableTok, newAcc, bucket, tool, pend, retool, tokens, usageExact, credits, modelUses, skill, skillUses, turn, file, patchLines, type Booking, setBookTap, reasoning, heavy } from "./record.ts";
import { accOut, accIn } from "./cache.ts";
import { loadUser, setGateway, type Price } from "./pricing.ts";
import { type Dict, DICT, ROWS, nameOf, MQ_MSG, MQ_SESS, localOf, extOf } from "./facts.ts";
import { done, setCallTap } from "./calls.ts";
import { newSess } from "../../model/types.ts";
import { fx, fxTotals } from "../../harness/fx.ts";
import { codex } from "../../harness/codex.ts";
import { opencode } from "../../harness/opencode.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function names(dc: Dict, xs: number[]): string { const o: string[] = []; for (const x of xs) o.push(nameOf(dc, x)); return o.join(","); }

// retool moves the one count of a pending call to another tool row: tool total, hour histogram, row removed at 0
const a = newAcc();
const iso = "2026-10-01T10:00:00.000Z";
const d = bucket(a, 0, iso); const hr = new Date(iso).getHours();
pend(a, d, tool(a, d, "mcp", "", MQ_SESS), "mcp", "c1", 0, iso, "", []);
const p1 = a.pend.get("c1");
ok("pending", !!p1, "");
if (p1) retool(a, p1, "mcp__s__t");
const row = heavy(d).tt.get("mcp__s__t");
ok("old row gone", !heavy(d).tt.has("mcp"), String(heavy(d).tt.size));
ok("new row n", !!row && row.n === 1, row ? String(row.n) : "none");
ok("new row hour", !!row && (row.h[hr] ?? 0) === 1, row ? row.h.join(",") : "none");
ok("totals unchanged", a.tools === 1 && d.tools === 1 && (d.hours[hr] ?? 0) === 1, [a.tools, d.tools, d.hours[hr] ?? 0].join(","));
ok("pend points at new row", !!p1 && !!row && p1.st === row, "");
// a second call of the old tool stays where it is when another one moves
pend(a, d, tool(a, d, "mcp", "", MQ_SESS), "mcp", "c2", 0, iso, "", []);
pend(a, d, tool(a, d, "mcp", "", MQ_SESS), "mcp", "c3", 0, iso, "", []);
const p3 = a.pend.get("c3");
if (p3) retool(a, p3, "mcp__s__t");
const old = heavy(d).tt.get("mcp"); const nw = heavy(d).tt.get("mcp__s__t");
ok("kept row", !!old && old.n === 1 && (old.h[hr] ?? 0) === 1, old ? String(old.n) : "none");
ok("moved row", !!nw && nw.n === 2 && (nw.h[hr] ?? 0) === 2, nw ? String(nw.n) : "none");
ok("totals after two moves", a.tools === 3 && d.tools === 3, [a.tools, d.tools].join(","));
// same name: no-op
if (p3) retool(a, p3, "mcp__s__t");
const nw2 = heavy(d).tt.get("mcp__s__t");
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
// skills per day: "<source>\t<name>", summed and sorted by uses
{
  const k = newAcc(); const kd = bucket(k, 0, "2026-10-01T10:00:00.000Z"); const ke = bucket(k, 0, "2026-10-02T10:00:00.000Z");
  skill(kd, "command", "a:b"); skill(ke, "command", "a:b"); skill(kd, "model", "a:b"); skill(kd, "model", "");
  const u = skillUses(k, null).map((x) => x.name + "/" + x.source + "/" + String(x.n)).join(",");
  ok("skillUses", u === "a:b/command/2,a:b/model/1", u);
  const u1 = skillUses(k, ["2026-10-02"]).map((x) => x.name + "/" + x.source + "/" + String(x.n)).join(",");
  ok("skillUses by day", u1 === "a:b/command/1", u1);
  k.pk = "p1\tx:y"; turn(k, 0, "2026-10-01T11:00:00.000Z", 4);
  const sb = newAcc(); sb.sub = true; turn(sb, 0, "2026-10-01T11:00:00.000Z", 2); ok("subagent: no turn, no day", sb.days.size === 0, String(sb.days.size));
  const r = accIn(JSON.parse(JSON.stringify(accOut(k))));
  const ru = skillUses(r, null).map((x) => x.name + "/" + x.source + "/" + String(x.n)).join(",");
  const rd = r.days.get("2026-10-01");
  ok("cache round trip: skills, pk, turns", ru === u && r.pk === "p1\tx:y" && !!rd && rd.turns === 4, ru + " " + r.pk + " " + (rd ? String(rd.turns) : "-"));
  const old = accIn({ off: 1, days: { "2026-10-01": { t: 1 } } }); const od = old.days.get("2026-10-01");
  ok("cache: old day without k/tu", !!od && od.skills.size === 0 && od.turns === 0 && old.pk === "", od ? String(od.turns) : "-");
}
// per-call fact rows: tool, model, programs, call id, result, files, retool, time fallback, t0
{
  const b = newAcc(); const iso2 = "2026-10-01T10:00:05.000Z"; const d2 = bucket(b, 0, iso2);
  pend(b, d2, tool(b, d2, "Bash", "claude-opus-4-5", MQ_MSG), "Bash", "t1", Date.parse(iso2), iso2, "npm test", ["npm test", "git status", "npm run x"]);
  const r0 = b.calls[0];
  ok("row appended", b.calls.length === 1 && b.lastCall === 0, String(b.calls.length));
  ok("row tool/model/mq", !!r0 && nameOf(DICT.tool, r0.tool) === "Bash" && nameOf(DICT.model, r0.model) === "claude-opus-4-5" && r0.mq === MQ_MSG, "");
  ok("row progs", !!r0 && names(DICT.prog, r0.progs) === "npm,git", r0 ? r0.progs.join(",") : "");
  ok("row t from iso", !!r0 && r0.t === Date.parse(iso2), r0 ? String(r0.t) : "");
  ok("row open", !!r0 && r0.err === -1 && r0.ms === -1 && r0.cid === "t1", "");
  const pp = b.pend.get("t1"); if (pp) done(pp, 1200, true, 42, "t1", []);
  ok("row closed", !!r0 && r0.err === 1 && r0.ms === 1200 && r0.out === 42, r0 ? [r0.err, r0.ms, r0.out].join(",") : "");
  tool(b, d2, "Edit", "", MQ_SESS); file(b, d2, "Edit", "/w/src/a.TS", 3, 1);
  const r1 = b.calls[1];
  ok("unknown model", !!r1 && r1.model === -1, "");
  ok("file attached", !!r1 && names(DICT.file, r1.files) === "/w/src/a.TS", "");
  ok("ext", extOf("/w/src/a.TS") === "ts" && extOf("/w/.bashrc") === "" && extOf("/w/Makefile") === "", "");
  file(b, d2, "Write", "/w/other.md", 1, 0); // tool name differs from the newest row: day counter only
  ok("file not attached to other tool", !!r1 && r1.files.length === 1, "");
  tool(b, d2, "apply_patch", "gpt-5", MQ_SESS); patchLines(b, d2, "apply_patch", "*** Update File: x.go\n+a\n*** Add File: y.go\n+b\n");
  ok("patch files attached", b.calls[2].files.length === 2, String(b.calls[2].files.length));
  pend(b, d2, tool(b, d2, "mcp", "m1", MQ_MSG), "mcp", "c9", 0, iso2, "", []);
  const p9 = b.pend.get("c9"); if (p9) retool(b, p9, "mcp__s__t");
  ok("retool renames row", nameOf(DICT.tool, b.calls[3].tool) === "mcp__s__t", "");
  // kiro-style: no call time → the bucket's time
  const k = newAcc(); const kd = bucket(k, 1759312800000, ""); pend(k, kd, tool(k, kd, "shell", "", MQ_SESS), "shell", "u1", 0, "", "", []);
  ok("row t falls back to bucket ms", k.calls[0].t === 1759312800000, String(k.calls[0].t));
  ok("t0 first activity", k.t0 === 1759312800000 && b.t0 === Date.parse(iso2), [k.t0, b.t0].join(","));
  bucket(k, 1759312700000, ""); ok("t0 earliest, not first", k.t0 === 1759312700000, String(k.t0));
  const kn = newAcc(); bucket(kn, 0, ""); ok("now fallback is no activity", kn.t0 === 0, String(kn.t0));
  ok("localOf memo", localOf(Date.parse(iso2)).hour === new Date(iso2).getHours(), "");
  const rt = accIn(JSON.parse(JSON.stringify(accOut(k)))); ok("t0 persisted", rt.t0 === k.t0 && rt.calls.length === 0 && rt.lastCall === -1, String(rt.t0));
}
// rows off (one-shot CLI runs that never read them): counters as always, no rows, files attach nowhere
ROWS.on = false;
const ro = newAcc(); const rd = bucket(ro, 0, "2026-10-01T10:00:00.000Z");
pend(ro, rd, tool(ro, rd, "Bash", "m", MQ_MSG), "Bash", "r1", 0, "", "", ["ls"]); file(ro, rd, "Bash", "/w/x", 1, 0);
ok("rows off: counted, no row", ro.tools === 1 && ro.calls.length === 0 && ro.lastCall === -1 && (heavy(rd).tt.get("Bash")?.n ?? 0) === 1, String(ro.calls.length));
ROWS.on = true;

// otlp export taps: one Booking per tokens()/usageExact() call with the cost it added; reasoning is a subset of out
{
  const bs: Booking[] = [];
  setBookTap((b: Booking) => { bs.push(b); });
  const ta = newAcc(); const td = bucket(ta, 0, iso);
  tokens(ta, td, "claude-sonnet-4-5", 10, 5, 3, 2, 0);
  const c1 = ta.cost;
  usageExact(ta, td, "x-model", 1, 1, 0, 0, 0, 0.5, "openrouter");
  usageExact(ta, td, "claude-sonnet-4-5", 1, 1, 0, 0, 0, 0, "anthropic"); // no own cost: priced like tokens(), one booking
  tokens(ta, td, "no-such-model-zz", 10, 10, 0, 0, 0);
  const out0 = ta.outTok; reasoning(ta, td, 7);
  ok("reasoning", ta.rs === 7 && ta.outTok === out0, ta.rs + " " + ta.outTok);
  setBookTap(null);
  tokens(ta, td, "claude-sonnet-4-5", 1, 1, 0, 0, 0);
  const b0 = bs[0]; const b1 = bs[1]; const b2 = bs[2]; const b3 = bs[3];
  ok("bookings", bs.length === 4, String(bs.length));
  if (b0 && b1 && b2 && b3) {
    ok("tokens booking", b0.model === "claude-sonnet-4-5" && b0.nIn === 10 && b0.nOut === 5 && b0.cr === 3 && b0.cw === 2 && !b0.exact && b0.prov === "" && c1 > 0 && Math.abs(b0.cost - c1) < 1e-12 && b0.unk === 0, JSON.stringify(b0));
    ok("exact booking", b1.exact && b1.cost === 0.5 && b1.prov === "openrouter" && b1.nIn === 1, JSON.stringify(b1));
    ok("exact without cost = priced", !b2.exact && b2.cost > 0 && b2.prov === "anthropic", JSON.stringify(b2));
    ok("unpriced booking", b3.cost === 0 && b3.unk === 20, JSON.stringify(b3));
  }
  // call tap: id, duration, error, exit codes and the row's tool name (retool's new name)
  const seen: string[] = [];
  setCallTap((id: string, ms: number, err: boolean, codes: number[], name: string) => { seen.push(id + ":" + String(ms) + ":" + String(err) + ":" + codes.join("/") + ":" + name); });
  pend(ta, td, tool(ta, td, "Bash", "", MQ_SESS), "Bash", "k1", 1000, iso, "", ["ls"]);
  const pk = ta.pend.get("k1"); if (pk) done(pk, 1200, true, 10, "k1", [2]);
  pend(ta, td, tool(ta, td, "mcp", "", MQ_SESS), "mcp", "k2", 0, iso, "", []);
  const pm = ta.pend.get("k2"); if (pm) { retool(ta, pm, "mcp__s__t"); done(pm, -1, false, 0, "k2", []); }
  setCallTap(null);
  ok("call tap", seen.join(" ") === "k1:1200:true:2:Bash k2:-1:false::mcp__s__t", seen.join(" "));
}
// reasoning per harness: codex cumulative reasoning_output_tokens (delta), opencode tokens.reasoning
{
  const ca = newAcc();
  const tc = (r: number, o: number): string => "{\"timestamp\":\"2026-10-01T10:00:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":0,\"output_tokens\":" + String(o) + ",\"reasoning_output_tokens\":" + String(r) + "}}}}";
  codex.usage(ca, tc(20, 50)); codex.usage(ca, tc(30, 70));
  ok("codex reasoning delta", ca.rs === 30 && ca.outTok === 70, ca.rs + "/" + ca.outTok);
  const oa = newAcc();
  opencode.usage(oa, "{\"type\":\"assistant\",\"seq\":1,\"time\":{\"created\":1790000000000},\"model\":{\"id\":\"gpt-5.2\",\"providerID\":\"openai\"},\"content\":[],\"cost\":0.01,\"tokens\":{\"input\":5,\"output\":4,\"reasoning\":10,\"cache\":{\"read\":0,\"write\":0}}}");
  ok("opencode reasoning", oa.rs === 10 && oa.outTok === 14, oa.rs + "/" + oa.outTok);
}
// fx session totals from usage-v2.json (the exporter's per-session usage for fx)
{
  const fd0 = "/tmp/agentglass-fx-tot-" + String(process.pid); mkdirSync(fd0, { recursive: true });
  const f = openSync(fd0 + "/usage-v2.json", "w"); writeSync(f, "{\"snapshot\":{\"input_tokens\":30,\"output_tokens\":4,\"cache_read_tokens\":10,\"cache_write_tokens\":2,\"total_cost\":0.25}}"); closeSync(f);
  const t = fxTotals(newSess("fx", "x", fd0 + "/events.jsonl", false));
  ok("fx totals", !!t && t.nIn === 30 && t.nOut === 4 && t.cr === 10 && t.cw === 2 && t.usd === 0.25 && t.unk === 0, t ? JSON.stringify(t) : "null");
  ok("fx totals missing", fxTotals(newSess("fx", "y", fd0 + "/none/events.jsonl", false)) === null, "");
  rmSync(fd0, { recursive: true, force: true });
}

// ── priced-token rows (Day.tp) and in-place re-pricing: every aggregate equals a fresh booking under the new table ──
{
  const r6 = (x: number): string => "#" + String(x); // numbers compare within 1e-9 (same(): summed per booking vs. at once)
  const sorted = (m: Map<string, number>, tag: string, out: string[]): void => { for (const k of [...m.keys()].sort()) { const v = m.get(k) ?? 0; if (Math.abs(v) > 1e-9) { out.push(tag + " " + k); out.push(r6(v)); } } };
  const snap = (a: Acc): string => { // every aggregate a re-price touches, rounded; zero provider shares are no share
    const out: string[] = [r6(a.cost), r6(a.unk)];
    for (const k of [...a.days.keys()].sort()) {
      const d = a.days.get(k); if (!d) continue;
      out.push(k, r6(d.cost), r6(d.unk)); sorted(d.um, "um", out); sorted(d.cp, "cp", out);
      for (let h = 0; h < 24; h++) out.push(r6(d.hc[h] ?? 0));
      for (const m of [...d.mt.keys()].sort()) { const x = d.mt.get(m) ?? []; out.push("mt " + m); for (const v of x) out.push(r6(v)); }
    }
    return out.join("|");
  };
  const same = (x: string, y: string): string => { // "" = equal, else the first difference
    const a = x.split("|"); const b = y.split("|");
    if (a.length !== b.length) return "length " + a.length + " vs " + b.length + ": " + x + "\n  vs " + y;
    for (let i = 0; i < a.length; i++) {
      const p = a[i] ?? ""; const q = b[i] ?? "";
      if (p.startsWith("#") && q.startsWith("#") ? Math.abs(Number(p.slice(1)) - Number(q.slice(1))) > 1e-9 : p !== q) return "at " + i + ": " + p + " vs " + q + "\n" + x;
    }
    return "";
  };
  const book = (a: Acc): void => {
    const d1 = bucket(a, 0, "2026-10-01T09:30:00.000Z"); tokens(a, d1, "gpt-6.1-sol", 1000, 200, 5000, 0, 0); tokens(a, d1, "claude-sonnet-4-5", 100, 10, 0, 50, 20);
    const d2 = bucket(a, 0, "2026-10-01T14:10:00.000Z"); tokens(a, d2, "codex-auto-review", 300, 30, 0, 0, 0, "");
    usageExact(a, d2, "claude-sonnet-5-5", 10, 10, 0, 0, 0, 0.5, "cliproxy"); tokens(a, d2, "claude-sonnet-5-5", 10, 10, 0, 0, 0, "cliproxy");
    tokens(a, d2, "gpt-6-sol", 1000, 0, 0, 0, 0, "cliproxy"); // the gateway row of cliproxy prices it
    const d3 = bucket(a, 0, "2026-10-02T23:10:00.000Z"); tokens(a, d3, "gpt-6.1-sol", 7, 7, 0, 0, 0, "openai");
  };
  setGateway(new Map<string, Price[]>([["cliproxy", [{ p: "gpt-6-sol", i: 1, o: 8, cr: -1, cw: -1, cw1: -1 }]]]));
  const tables = ['{}', '{"gpt-6.1-sol":{"input":1.25,"output":10}}', '{"gpt-6.1-sol":{"input":2,"output":8,"cacheRead":0.5},"codex-auto-review":{"alias":"gpt-6.1-sol"},"claude-sonnet-4-5":{"input":0,"output":0}}', '{"codex-auto-review":{"alias":"gpt-6-sol"}}', '{}'];
  loadUser(JSON.parse(tables[0] ?? "{}")); const live = newAcc(); book(live);
  const d1 = live.days.get([...live.days.keys()][0] ?? "");
  const hr = new Date("2026-10-01T09:30:00.000Z").getHours();
  ok("tp row per hour/provider/model", !!d1 && (d1.tp.get(hr + "\t\tgpt-6.1-sol") ?? []).join(",") === "1000,200,5000,0,0,-1", d1 ? [...d1.tp.keys()].join(" | ") : "no day");
  ok("tp row of a priced model", !!d1 && ((d1.tp.get(hr + "\t\tclaude-sonnet-4-5") ?? [])[5] ?? -1) > 0, d1 ? [...d1.tp.keys()].join(" | ") : "no day");
  let i = 0;
  for (const t of tables) {
    loadUser(JSON.parse(t)); const dl = reprice(live);
    const fresh = newAcc(); book(fresh);
    const df = same(snap(live), snap(fresh)); ok("reprice == fresh under table " + i, df === "", df);
    ok("delta returned under table " + i, i === 0 ? Math.abs(dl) < 1e-9 : true, String(dl));
    i++;
  }
  // a second pass with nothing changed moves nothing
  ok("idempotent", Math.abs(reprice(live)) < 1e-12, "moved");
  // harness-reported 0.5 survives every table
  let ex = 0; for (const d of live.days.values()) ex += d.cp.get("cliproxy") ?? 0;
  ok("harness cost kept", Math.abs(ex - 0.5 - 1000 / 1e6 - (10 * 2 + 10 * 10) / 1e6) < 1e-9, String(ex));
  // a booking under a changed table that nobody re-priced yet: the row is re-priced before the tokens join it
  loadUser(JSON.parse('{"gpt-6.1-sol":{"input":1,"output":1}}'));
  const d9 = bucket(live, 0, "2026-10-01T09:40:00.000Z"); tokens(live, d9, "gpt-6.1-sol", 1, 1, 0, 0, 0);
  reprice(live); // the other rows follow (the trigger's pass); the row booked into must not be counted twice
  const fr = newAcc(); book(fr); tokens(fr, bucket(fr, 0, "2026-10-01T09:40:00.000Z"), "gpt-6.1-sol", 1, 1, 0, 0, 0);
  const ds = same(snap(live), snap(fr)); ok("stale row re-priced on booking", ds === "", ds);
  // fx: a $0 custom model's tokens go through the table (priceable)
  const fa = newAcc(); const fd = bucket(fa, 0, "2026-10-01T09:30:00.000Z"); tableTok(fa, fd, "fx:custom", "", 10, 5, 0, 0, 0);
  ok("fx custom unpriced", fa.unk === 15 && fa.cost === 0, fa.unk + "/" + fa.cost);
  loadUser(JSON.parse('{"fx:custom":{"input":1,"output":1}}')); reprice(fa);
  ok("fx custom priced after a user price", fa.unk === 0 && Math.abs(fa.cost - 15 / 1e6) < 1e-12, fa.unk + "/" + fa.cost);
  // the booking tap carries the price source and the estimate flag
  const bs: Booking[] = []; setBookTap((b: Booking): void => { bs.push(b); });
  loadUser(JSON.parse('{"codex-auto-review":{"alias":"claude-sonnet-4-5"}}'));
  const ta = newAcc(); const td = bucket(ta, 0, "2026-10-01T09:30:00.000Z");
  tokens(ta, td, "codex-auto-review", 1, 1, 0, 0, 0); tokens(ta, td, "claude-sonnet-4-5", 1, 1, 0, 0, 0); tokens(ta, td, "nope", 1, 1, 0, 0, 0); usageExact(ta, td, "x", 1, 1, 0, 0, 0, 0.1, "p");
  setBookTap(null);
  ok("booking src/est", bs.map((b: Booking): string => b.src + (b.est ? "~" : "")).join(",") === "alias~,built-in,unpriced,harness", bs.map((b: Booking): string => b.src + (b.est ? "~" : "")).join(","));
  loadUser(null); setGateway(new Map<string, Price[]>());
}
console.log(bad ? bad + " failed" : "usage record: all checks passed");
if (bad) process.exit(1);
