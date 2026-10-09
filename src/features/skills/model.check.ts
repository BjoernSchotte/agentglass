// agentglass — self-check for the skills read model (tables, timelines, pricing at read time, invariants, hiding):
// scriptc build src/features/skills/model.check.ts -o sm && ./sm
// SPDX-License-Identifier: Apache-2.0
import { type Acc, newAcc, bucket, tokens, usageExact, turn, skillLoad, skillUnload } from "../usage/record.ts";
import { loadUser, cost, resolve } from "../usage/pricing.ts";
import { SA_L, SA_C } from "../usage/skillrec.ts";
import { type SkillRow, type LoadRow, skillTable, skillLoads, skillCheck, sizeFill, bucketUsd, visRows, visLoads } from "./model.ts";
import { setVis, parseHide } from "./vis.ts";

let bad = 0;
function ok(what: string, c: boolean, info: string): void { if (!c) { bad++; console.log("FAIL " + what + (info ? ": " + info : "")); } }
function near(x: number, y: number): boolean { return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)); }
setVis([], false);
const T = "LOREMSKILLTEXT" + "x".repeat(3586); // 1000 tokens
const iso = "2026-10-01T09:00:00.000Z"; const M = "claude-sonnet-4-5";
// session s1: alpha (user) + beta (model), table-priced; a tail after the next prompt; then a compaction
const a1 = newAcc(); const d1 = bucket(a1, 0, iso);
turn(a1, 0, iso, 1);
tokens(a1, d1, M, 0, 10, 0, 20000, 0);
skillLoad(a1, "alpha", "user", 1, iso, T, true, "/h/.claude/skills/alpha", false);
skillLoad(a1, "beta", "model", 2, iso, T, true, "/h/.claude/skills/beta", false);
tokens(a1, d1, M, 0, 10, 20000, 2500, 0);
tokens(a1, d1, M, 0, 10, 22500, 100, 0);
turn(a1, 0, iso, 1);
tokens(a1, d1, M, 0, 10, 22600, 100, 0);
skillUnload(a1, 9, "compact");
// session s2: alpha again (other text: another hash) + gamma with an unknown size; harness-priced
const a2 = newAcc(); const d2 = bucket(a2, 0, iso);
usageExact(a2, d2, "gpt-unpriced-x", 0, 10, 0, 9000, 0, 0.02);
skillLoad(a2, "alpha", "model", 3, iso, T + "y".repeat(360), true, "/h/.claude/skills/alpha", false);
skillLoad(a2, "gamma", "model", 4, iso, "", false, "", false);
usageExact(a2, d2, "gpt-unpriced-x", 0, 10, 9000, 2000, 0, 0.05);
usageExact(a2, d2, "gpt-unpriced-x", 0, 10, 11000, 0, 0, 0.03);

const as: Acc[] = [a1, a2]; const ids = ["s1", "s2"];
const rows = skillTable(as, ids, null, "cost");
const by = (n: string): SkillRow => { for (const r of rows) if (r.name === n) return r; return rows[0] as SkillRow; };
ok("three skills", rows.length === 3, rows.map((r) => r.name).join(","));
const A = by("alpha"); const B = by("beta"); const G = by("gamma");
ok("alpha over two sessions", A.sessions === 2 && A.loadsUser === 1 && A.loadsModel === 1 && A.hashes.length === 2, JSON.stringify(A));
// Σ table tokens = Σ Day.sa slots
let saL = 0; let saC = 0; for (const a of as) for (const d of a.days.values()) for (const x of d.sa.values()) { for (let i = 0; i < 4; i++) { saL += x[SA_L + i] ?? 0; saC += x[SA_C + i] ?? 0; } }
let tL = 0; let tC = 0; for (const r of rows) { tL += r.load; tC += r.carry; }
ok("table = Day.sa", tL === saL && tC === saC && tL > 0, String(tL) + "/" + String(saL));
// $: s1's alpha priced per bucket now + s2's alpha reported $
const p = resolve(M, ""); const pc = p ? p.p : null;
const s1Alpha = pc ? cost(pc, 0, 0, 0, 1000, 0) + cost(pc, 0, 0, 2000, 0, 0) : -1; // load from w5; carry r3 + r4 from cache reads
const l2 = skillLoads([a2], ["s2"]); const s2Alpha = (l2[0] as LoadRow).usd;
ok("alpha $ = table + reported", near(A.usd, s1Alpha + s2Alpha) && s2Alpha > 0 && s2Alpha <= 0.05, String(A.usd) + " vs " + String(s1Alpha + s2Alpha));
ok("bucketUsd", near(bucketUsd(M, "", [0, 2000, 1000, 0]), s1Alpha) && bucketUsd("gpt-unpriced-x", "", [1, 0, 0, 0]) === -1 && bucketUsd(M, "", [0, 0, 0, 0]) === 0, "");
ok("tail", B.tail === 1000 && B.tailUsd > 0 && near(B.tailUsd, pc ? cost(pc, 0, 0, 1000, 0, 0) : -1), String(B.tail));
ok("perSess", near(A.perSess, A.usd / 2), "");
ok("share", A.share > 0 && A.share < 1 && near(A.share, (A.load + A.carry) / A.ctx), String(A.share));
ok("tier: unknown size", G.tier === "?" && G.sizeP50 === 0 && G.load === 0, G.tier);
ok("sizes", A.sizeP50 === 1000 && B.sizeP50 === 1000, String(A.sizeP50));
const byLoads = skillTable(as, ids, null, "loads");
ok("sort by loads", (byLoads[0] as SkillRow).name === "alpha", (byLoads[0] as SkillRow).name);
ok("period filter", skillTable(as, ids, ["1999-01-01"], "cost").length === 0, "");

// timeline
const tl = skillLoads(as, ids);
ok("timeline", tl.map((r) => r.sess + ":" + r.name + ":" + r.trig + ":" + r.tier).join(",") === "s1:alpha:user:exact,s1:beta:model:exact,s2:alpha:model:exact,s2:gamma:model:?", tl.map((r) => r.name).join(","));
ok("ended state", (tl[0] as LoadRow).why === "compact" && (tl[2] as LoadRow).end === 0, "");
sizeFill(tl);
ok("sizeFill: name p50, tier ≈", (tl[3] as LoadRow).size === -1, String((tl[3] as LoadRow).size)); // gamma has no known load: stays unknown
const tl2 = skillLoads([a1, a2], ids); (tl2[3] as LoadRow).name = "alpha"; (tl2[3] as LoadRow).hash = ""; sizeFill(tl2);
ok("sizeFill: from the same name", (tl2[3] as LoadRow).size === 1000 && (tl2[3] as LoadRow).tier === "≈", String((tl2[3] as LoadRow).size));

// invariants
ok("skillCheck ok", skillCheck(as, ids).length === 0, skillCheck(as, ids).join("; "));
const br = newAcc(); const db = bucket(br, 0, iso); tokens(br, db, M, 0, 1, 100, 0, 0);
skillLoad(br, "x", "model", 1, iso, T, true, "", false); tokens(br, db, M, 0, 1, 100, 0, 0);
(br.sk[0] as { ct: number[] }).ct[1] = 5000; (br.sk[0] as { why: string }).why = "drop";
const v = skillCheck([br], ["broken"]);
ok("skillCheck reports", v.length >= 2 && v.join(" ").indexOf("context") >= 0 && v.join(" ").indexOf("state") >= 0, v.join("; "));

// re-pricing: a 2× cache-read price scales carry $ by exactly the cache-read share
const before = by("beta").carryUsd;
const pr = pc ? pc.cr >= 0 ? pc.cr : pc.i * 0.1 : 0;
loadUser({ "claude-sonnet-4-5": { input: pc ? pc.i : 3, output: pc ? pc.o : 15, cacheRead: pr * 2, cacheWrite: pc ? (pc.cw >= 0 ? pc.cw : pc.i * 1.25) : 3.75 } });
const after = skillTable(as, ids, null, "cost"); let b2 = 0; for (const r of after) if (r.name === "beta") b2 = r.carryUsd;
ok("re-priced carry", near(b2, before * 2) && before > 0, String(before) + " → " + String(b2));
loadUser(null);

// hiding: omit folds into one (hidden) row keeping the totals; name fakes
setVis(parseHide([{ match: "beta", mode: "omit" }, { match: "gamma", mode: "omit" }, { match: "alpha", mode: "name" }]).rules, false);
const vr = visRows(skillTable(as, ids, null, "cost"));
let tot0 = 0; for (const r of rows) tot0 += r.load + r.carry; let tot1 = 0; for (const r of vr.rows) tot1 += r.load + r.carry;
ok("hidden row keeps totals", vr.hidden === 2 && vr.rows.length === 2 && tot0 === tot1 && vr.rows.some((r) => r.name === "(hidden)"), vr.rows.map((r) => r.name).join(","));
ok("name mode fakes", !vr.rows.some((r) => r.name === "alpha") && vr.rows.some((r) => r.name.length === 5 && r.name !== "(hidden)"), vr.rows.map((r) => r.name).join(","));
ok("omitted loads leave the timeline", visLoads(skillLoads(as, ids)).length === 2, "");
setVis(parseHide([{ match: "x", mode: "name" }]).rules, false);
const vn = skillCheck([br], ["broken"]).join("; ");
ok("skillCheck names through skillVis", vn.indexOf("(x)") < 0 && vn.indexOf("broken#sk0 (") >= 0, vn);
setVis(parseHide([{ match: "x", mode: "omit" }]).rules, false);
ok("skillCheck omit", skillCheck([br], ["broken"]).join("; ").indexOf("broken#sk0 ((hidden))") >= 0, skillCheck([br], ["broken"]).join("; "));
setVis([], false);

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok skills model");
