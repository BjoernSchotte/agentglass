// agentglass — self-check for the ledger cache codec (round trip of billing/unpriced fields): scriptc build src/features/usage/codec.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { accOut, accIn, VERSION, readable, rlOut, rlIn } from "./codec.ts";
import { newAcc, bucket, tokens, usageExact, credits, reasoning, L, tool, pend, file, heavy } from "./record.ts";
import { type Obj, parse } from "../../util/json.ts";

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
ok("version", VERSION === 13, String(VERSION)); // 13 = perf-baseline (the heavy day maps as JSON text: a v12 build would read them empty; v12 caches still read); 12 = harness-correctness (Gemini call errors + models, pi /skill); 11 = Acc.vcs git refs (git-linkage); 10 = Acc.rs (otlp-export); 9 = repo-view Day.act + Acc.al; 8 = filter-language call rows + t0; 7 = honest-costs (nightly builds from main wrote it without the call rows)
ok("reads v12 and its own version only", readable(12) && readable(VERSION) && !readable(11) && !readable(VERSION + 1), "");
ok("day present", !!e, [...b.days.keys()].join(","));
if (e) {
  ok("unk", e.unk === d.unk, String(e.unk));
  ok("um", e.um.get("gpt-x-unknown") === 900, [...e.um.keys()].join(","));
  ok("uc", e.uc === 7, String(e.uc));
  ok("cp", (e.cp.get("openrouter") ?? 0) === 0.5 && Math.abs((e.cp.get("") ?? 0) - (d.cp.get("") ?? 0)) < 1e-12, [...e.cp.keys()].join(","));
  ok("hc", e.hc.length === 24 && Math.abs((e.hc[h] ?? 0) - (d.hc[h] ?? 0)) < 1e-12, e.hc.join(","));
  const m0 = d.mt.get("claude-sonnet-4-5") ?? []; const m1 = e.mt.get("claude-sonnet-4-5") ?? [];
  ok("mt", m1.length === 5 && m1.join() === m0.join() && e.mt.size === d.mt.size, m1.join());
}
ok("rs round trip", b.rs === 42, String(b.rs));
ok("acc fields", b.t0 === a.t0 && b.uc === 7 && b.bill === "metered" && b.plan === "team" && b.billSrc === "session" && b.unk === a.unk && b.cost === a.cost, JSON.stringify(o["t"]));
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
