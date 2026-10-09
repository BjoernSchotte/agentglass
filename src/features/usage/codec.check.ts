// agentglass — self-check for the ledger cache codec (round trip of billing/unpriced fields): scriptc build src/features/usage/codec.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { accOut, accIn, VERSION, readable, rlOut, rlIn } from "./codec.ts";
import { newAcc, bucket, tokens, usageExact, credits, reasoning, L, tool, pend, file, heavy, turn, skillLoad, skillUnload, skillListing } from "./record.ts";
import { type Obj, parse } from "../../util/json.ts";
import { moIn } from "./owners.ts";
import type { SkLoad } from "./skillrec.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const a = newAcc(); const iso = "2026-10-01T09:30:00.000Z"; const h = new Date(iso).getHours();
const d = bucket(a, 0, iso);
tokens(a, d, "claude-sonnet-4-5", 1000, 100, 0, 0, 0);
tokens(a, d, "gpt-x-unknown", 900, 0, 0, 0, 0);
usageExact(a, d, "whatever", 10, 0, 0, 0, 0, 0.5, "openrouter");
credits(a, d, 7);
reasoning(a, d, 42);
a.bill = "metered"; a.plan = "team"; a.billSrc = "session"; a.t0 = 1759312800000;
const o = accOut(a, 64); const js = JSON.stringify(o);
const back = parse(js);
const b = accIn(back ?? {});
const e = b.days.get([...a.days.keys()][0] ?? "");
ok("version", VERSION === 19, String(VERSION)); // 19 = skill loads (Acc.sk) + per-skill day rows (Day.sa): older caches re-index; 18 = Claude prompt ownership in background continuations (v17 loads; its continuations re-index); 17 = Day.tp priced-token rows (model-prices: re-price in place); 16 = Claude twins: the project dir its cwd names owns the shared messages (v15 caches gave them to the first path, re-index); 15 = cross-file message ownership (Acc.mo/mc: copies of a message another log owns book nothing; older caches double count, re-index); 14 = Claude messages at their final output_tokens (Acc.ids with booked output: v12/v13 caches under-count, re-index); 13 = perf-baseline (the heavy day maps as JSON text: a v12 build would read them empty; v12 caches still read); 12 = harness-correctness (Gemini call errors + models, pi /skill); 11 = Acc.vcs git refs (git-linkage); 10 = Acc.rs (otlp-export); 9 = repo-view Day.act + Acc.al; 8 = filter-language call rows + t0; 7 = honest-costs (nightly builds from main wrote it without the call rows)
ok("reads its own version only", readable(VERSION) && !readable(18) && !readable(17) && !readable(16) && !readable(15) && !readable(14) && !readable(13) && !readable(12) && !readable(VERSION + 1), "");
ok("day present", !!e, [...b.days.keys()].join(","));
if (e) {
  ok("unk", e.unk === d.unk, String(e.unk));
  ok("tp round-trip", e.tp.size === d.tp.size && e.tp.size === 2 && (e.tp.get(h + "\t\tgpt-x-unknown") ?? []).join(",") === "900,0,0,0,0,-1" && Math.abs(((e.tp.get(h + "\t\tclaude-sonnet-4-5") ?? [])[5] ?? 0) - (1000 * 3 + 100 * 15) / 1e6) < 1e-12, [...e.tp.keys()].join("|"));
  ok("um", e.um.get("gpt-x-unknown") === 900, [...e.um.keys()].join(","));
  ok("uc", e.uc === 7, String(e.uc));
  ok("cp", (e.cp.get("openrouter") ?? 0) === 0.5 && Math.abs((e.cp.get("") ?? 0) - (d.cp.get("") ?? 0)) < 1e-12, [...e.cp.keys()].join(","));
  ok("hc", e.hc.length === 24 && Math.abs((e.hc[h] ?? 0) - (d.hc[h] ?? 0)) < 1e-12, e.hc.join(","));
  const m0 = d.mt.get("claude-sonnet-4-5") ?? []; const m1 = e.mt.get("claude-sonnet-4-5") ?? [];
  ok("mt", m1.length === 5 && m1.join() === m0.join() && e.mt.size === d.mt.size, m1.join());
}
ok("rs round trip", b.rs === 42, String(b.rs));
ok("acc fields", b.t0 === a.t0 && b.uc === 7 && b.bill === "metered" && b.plan === "team" && b.billSrc === "session" && b.unk === a.unk && b.cost === a.cost, JSON.stringify(o["t"]));
// owned message ids (with times) and skipped copies round-trip; the owned list stays text until something reads it
{
  const x = newAcc(); x.mo.set("msg_1", 1759312800000); x.mo.set("msg_2", 1759312800500); x.mo.set("u:abc", 1759312700000); x.mc.set("msg_0", "/p/o.jsonl"); x.xs.add("3c4e27dd-7185-40bd-a29f-8ca06a57d08c");
  const y = accIn(parse(JSON.stringify(accOut(x, 64))) ?? {});
  ok("mo stays text", y.mo.size === 0 && y.mv.length > 0, y.mv);
  const m = moIn(y.mv);
  ok("mo round trip", m.get("msg_1") === 1759312800000 && m.get("msg_2") === 1759312800500 && m.get("u:abc") === 1759312700000 && m.size === 3, y.mv);
  ok("mc round trip", y.mc.get("msg_0") === "/p/o.jsonl" && y.mc.size === 1, JSON.stringify(accOut(y, 64)["mc"]));
  ok("xs round trip", y.xs.has("3c4e27dd-7185-40bd-a29f-8ca06a57d08c") && y.xs.size === 1, JSON.stringify(accOut(y, 64)["xs"]));
  ok("undecoded mo written back as is", JSON.stringify(accOut(y, 64)["mo"]) === JSON.stringify(y.mv), "");
}
// skill loads and per-skill day rows round-trip; no skill text in the cache; no sk key for a session without loads
{
  const T = "LOREMSKILLTEXT" + "x".repeat(3586); const si = "2026-10-01T09:00:00.000Z";
  const x = newAcc(); const dx = bucket(x, 0, si);
  skillListing(x, 1, si, "- a: lorem", ["a", "b"]);
  tokens(x, dx, "claude-sonnet-4-5", 0, 10, 0, 5000, 0);
  skillLoad(x, "acme:alpha", "user", 2, si, T, true, "/h/.claude/plugins/c/acme/1.0/skills/alpha", false, 1234);
  skillLoad(x, "ghost", "model", 3, si, "", false, "", false);
  tokens(x, dx, "claude-sonnet-4-5", 0, 10, 5000, 1100, 0);
  turn(x, 0, si, 1);
  tokens(x, dx, "claude-sonnet-4-5", 0, 10, 6000, 0, 0);
  skillUnload(x, 4, "compact");
  skillLoad(x, "acme:alpha", "user", 5, si, T, true, "/h/.claude/plugins/c/acme/1.0/skills/alpha", false).stub = true;
  tokens(x, dx, "claude-sonnet-4-5", 0, 10, 1000, 2000, 0);
  tokens(x, dx, "claude-sonnet-4-5", 0, 10, 100, 0, 0); // a drop
  skillLoad(x, "beta", "model", 6, si, T, true, "/r/.claude/skills/beta", true); // still pending
  const js2 = JSON.stringify(accOut(x, 64));
  const y = accIn(parse(js2) ?? {});
  ok("no skill text in the cache", js2.indexOf("LOREMSKILLTEXT") < 0, "");
  const strip = (l: SkLoad): string =>
    [l.name, l.trig, l.t, l.tu, l.te, l.rq0, l.bytes, l.S, l.hash, l.dir, l.scope, l.end, l.why, l.rel, l.stub, l.pend, l.short, l.nq, l.lt.join("/"), l.ct.join("/"), l.tt.join("/"), l.hb.join("/"), l.hu, l.hl, l.ht, l.off, l.len, l.rec, l.mdl, l.prov, l.est, l.n, l.rd, l.h1, l.h2, l.pg].join("|");
  ok("loads round trip", y.sk.length === x.sk.length && y.sk.length === 5 && y.sk.map(strip).join("\n") === x.sk.map(strip).join("\n"), y.sk.map(strip).join("\n") + "\n---\n" + x.sk.map(strip).join("\n"));
  ok("load states", x.sk.map((l) => (l.end === 0 ? (l.pend ? "pend" : "open") : l.why) + (l.S < 0 ? "?" : "")).join(",") === "compact,compact,compact?,drop,pend", x.sk.map((l) => l.why).join(","));
  ok("scope", y.sk.length > 1 && (y.sk[1] as SkLoad).scope === "plugin", "");
  ok("counters", y.rq === x.rq && y.tq === 1 && y.lastCtx === x.lastCtx && y.lst.join(",") === "a,b", String(y.rq) + " " + String(y.lastCtx));
  const dy = y.days.get([...x.days.keys()][0] ?? "");
  let same = !!dy && dx.sa.size === 6; // load counts per name (no model) + tokens per name and model
  if (dy) { same = same && dy.sa.size === dx.sa.size; for (const [k, r] of dx.sa) if ((dy.sa.get(k) ?? []).join() !== r.join()) same = false; }
  ok("sa round trip", same, [...dx.sa.keys()].join("|"));
  const z = newAcc(); tokens(z, bucket(z, 0, si), "claude-sonnet-4-5", 1, 1, 0, 0, 0);
  const zs = JSON.stringify(accOut(z, 64));
  ok("no sk/sa/ls keys without skills", zs.indexOf("\"sk\"") < 0 && zs.indexOf("\"sa\"") < 0 && zs.indexOf("\"ls\"") < 0, zs.slice(0, 300));
}
// an older 9-element t: uc defaults to 0
const old: Obj = {}; for (const k of Object.keys(o)) old[k] = o[k];
old["t"] = [1, 2, 3, 4, 5, 6, 7, 8, 9];
ok("old t", accIn(old).uc === 0 && accIn(old).del === 9 && accIn(old).rs === 0, "");
ok("no secret-shaped keys", js.indexOf("\"env\"") < 0 && js.indexOf("\"key\"") < 0 && js.indexOf("\"token\"") < 0, js.slice(0, 200));
// Codex rate limits outlive the indexing that found them: a warm start reads no codex line, the cache carries them
{
  L.rl = [{ pct: 12.5, min: 300, reset: 1791116828000 }, { pct: 64, min: 10080, reset: 1791368828000 }]; L.rlAt = 1791109000000;
  const ro = parse(JSON.stringify(rlOut()));
  L.rl = []; L.rlAt = 0; rlIn(ro);
  ok("rate limits round trip", L.rlAt === 1791109000000 && L.rl.map((w) => [w.pct, w.min, w.reset].join("/")).join(" ") === "12.5/300/1791116828000 64/10080/1791368828000", JSON.stringify(L.rl));
  L.rl = [{ pct: 1, min: 300, reset: 1 }]; L.rlAt = 1791200000000; rlIn(ro);
  ok("rate limits: a newer in-memory reading wins", L.rl.length === 1 && L.rlAt === 1791200000000, JSON.stringify(L.rl));
  L.rl = []; L.rlAt = 0; rlIn(null); rlIn(parse("{\"at\":5,\"ws\":[[\"x\"]]}"));
  ok("rate limits: missing or malformed = none", L.rl.length === 0, JSON.stringify(L.rl));
}
// the heavy day maps (tools, programs, commands, files) come back as text: undecoded until heavy(), written out as they came
{
  const h = newAcc(); const hd = bucket(h, 0, iso);
  const st = tool(h, hd, "Bash", "claude-sonnet-4-5", 0);
  pend(h, hd, st, "Bash", "c1", 1759312800000, iso, "npm test", ["npm test"]);
  file(h, hd, "Edit", "/w/a.ts", 2, 1);
  const o1 = accOut(h, 64); const back1 = accIn(parse(JSON.stringify(o1)) ?? {});
  const d1 = [...back1.days.values()][0];
  ok("heavy undecoded after load", !!d1 && d1.hx === null && d1.hv.length > 0, d1 ? String(d1.hv.length) : "no day");
  const o2 = accOut(back1, 64);
  ok("undecoded heavy written as it came", JSON.stringify(o2) === JSON.stringify(o1), JSON.stringify(o2).slice(0, 200));
  if (d1) {
    const x = heavy(d1);
    ok("heavy decodes tools", (x.tt.get("Bash")?.n ?? 0) === 1, [...x.tt.keys()].join(","));
    ok("heavy decodes commands", (x.cmds.get("Bash\tnpm test")?.n ?? 0) === 1 && (x.prog.get("Bash\tnpm")?.n ?? 0) === 1, [...x.cmds.keys()].join(","));
    ok("heavy decodes files", (x.files.get("Edit\t/w/a.ts")?.add ?? 0) === 2, [...x.files.keys()].join(","));
    ok("decoded heavy drops the text", d1.hx !== null && d1.hv === "", d1.hv.slice(0, 40));
    ok("decoded heavy round-trips", JSON.stringify(accOut(back1, 64)) === JSON.stringify(o1), "");
  }
  // a day written before "hv" (the same keys inline) is read at once
  const js1 = JSON.stringify(o1); const raw = [...accIn(parse(js1) ?? {}).days.values()][0]?.hv ?? "";
  const pat = "\"hv\":" + JSON.stringify(raw); const at = js1.indexOf(pat);
  const d2 = [...accIn(parse(js1.slice(0, at) + raw.slice(1, -1) + js1.slice(at + pat.length)) ?? {}).days.values()][0];
  ok("a day without hv keeps its maps", !!d2 && d2.hx !== null && (heavy(d2).cmds.get("Bash\tnpm test")?.n ?? 0) === 1, d2 ? String(d2.hv.length) : "no day");
}
console.log(bad ? bad + " failed" : "codec: all checks passed");
if (bad) process.exit(1);
