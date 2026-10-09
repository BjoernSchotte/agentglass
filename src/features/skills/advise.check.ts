// agentglass — self-check for skill advice A1–A6 (one case that fires and one near miss per rule) and the inventory scan:
// scriptc build src/features/skills/advise.check.ts -o sa && ./sa
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Advice, type CallStat, type SpanStat, type HostHash, advise, adviseB, adviceLines, parseAdvise, visAdvice, ADVISE_DEFAULTS } from "./advise.ts";
import { type InvSkill, inventory, frontOf } from "./inventory.ts";
import type { SkillRow, LoadRow } from "./model.ts";
import { setVis, parseHide } from "./vis.ts";

let bad = 0;
function ok(what: string, c: boolean, info: string): void { if (!c) { bad++; console.log("FAIL " + what + (info ? ": " + info : "")); } }
setVis([], false);
const D = Date.UTC(2026, 9, 1);
function row(name: string, o: { u?: number; m?: number; c?: number; s?: number; size?: number; usd?: number; tail?: number; hashes?: string[] }): SkillRow {
  return { name, loadsUser: o.u ?? 0, loadsModel: o.m ?? 0, loadsCompact: o.c ?? 0, sessions: o.s ?? 1, sizeP50: o.size ?? 1000, load: 1000, carry: 5000, tail: 3000,
    usd: o.usd ?? 1, carryUsd: (o.usd ?? 1) * 0.9, tailUsd: o.tail ?? 0, perSess: 0, share: 0.01, ctx: 1e6, tier: "exact", hashes: o.hashes ?? [], scope: "user", unpriced: false };
}
function ld(name: string, sess: string, trig: string, t: number, o: { end?: number; rel?: boolean; hash?: string; usd?: number; size?: number; turn?: number; te?: number; req?: number }): LoadRow {
  return { sess, i: 0, name, trig, t, turn: o.turn ?? 0, te: o.te ?? 0, end: o.end ?? 0, why: o.end ? "compact" : "", rel: o.rel ?? false, stub: false, bytes: 3600, size: o.size ?? 1000, tier: "exact",
    hash: o.hash ?? "", scope: "user", dir: "", requests: o.req ?? 3, n: 1, load: 1000, carry: 2000, tail: 0, usd: o.usd ?? 0.1, carryUsd: (o.usd ?? 0.1) / 2, tailUsd: 0, unpriced: false, off: -1, len: 0, rec: "", model: "m" };
}
const none = (s: string, t0: number, t1: number): CallStat => ({ n: 0, err: 0, kept: false });
const C = ADVISE_DEFAULTS;
const ctx = { days: 30, listed: new Map<string, number>(), requests: 1000 };
function ids(xs: Advice[]): string { return xs.map((a) => a.id + ":" + a.skill).join(","); }

// A1: big, mostly tail, in ≥ 3 sessions; near misses: 2 sessions, size just under, share just under
const a1 = advise([row("fat", { m: 3, s: 3, size: 2000, usd: 10, tail: 6 }), row("two", { m: 2, s: 2, size: 5000, usd: 10, tail: 9 }), row("small", { m: 3, s: 3, size: 1999, usd: 10, tail: 9 }), row("early", { m: 3, s: 3, size: 5000, usd: 10, tail: 5.99 })], [], ctx, [], C, none);
ok("A1 fires once", ids(a1) === "A1:fat", ids(a1));
ok("A1 evidence", a1.length === 1 && (a1[0] as Advice).evidence[0] === "tail carry $6.00 of $10.00 (60 %) over 3 sessions", a1.length ? (a1[0] as Advice).evidence[0] ?? "" : "");
// A2: by hand ≥ 3× in ≥ 3 sessions, never by the model
const l2 = [ld("manual", "s1", "user", D, {}), ld("manual", "s2", "user", D, {}), ld("manual", "s3", "user", D, {}), ld("near", "s1", "user", D, {}), ld("near", "s2", "user", D, {}), ld("near", "s2", "user", D + 1, {})];
const a2 = advise([row("manual", { u: 3, s: 3 }), row("near", { u: 3, s: 2 }), row("both", { u: 5, m: 1, s: 5 })], l2, ctx, [], C, none);
ok("A2", ids(a2) === "A2:manual", ids(a2));
// A3: a reload while the first is open, in ≥ 2 sessions; near miss: one session, or the first was compacted before
const l3 = [ld("dup", "s1", "model", D, {}), ld("dup", "s1", "model", D + 10, {}), ld("dup", "s2", "model", D, {}), ld("dup", "s2", "model", D + 10, {}),
  ld("once", "s1", "model", D, {}), ld("once", "s1", "model", D + 10, {}), ld("closed", "s1", "model", D, { end: D + 5 }), ld("closed", "s1", "model", D + 10, {}), ld("closed", "s2", "model", D, { end: D + 5 }), ld("closed", "s2", "model", D + 10, {})];
const a3 = advise([row("dup", { m: 4, s: 2 }), row("once", { m: 2 }), row("closed", { m: 4, s: 2 })], l3, ctx, [], C, none);
ok("A3", ids(a3) === "A3:dup", ids(a3));
// A4: ≥ 3 loads lost to compaction
const l4 = [ld("lost", "s1", "model", D, { rel: true }), ld("lost", "s2", "model", D, { rel: true }), ld("lost", "s3", "model", D, { rel: true }), ld("rare", "s1", "model", D, { rel: true }), ld("rare", "s2", "model", D, { rel: true })];
const a4 = advise([row("lost", { m: 3, s: 3 }), row("rare", { m: 2, s: 2 })], l4, ctx, [], C, none);
ok("A4", ids(a4) === "A4:lost", ids(a4));
// A5: two versions with ≥ 3 sessions each → a delta table; near miss: 2 sessions on the new side
const l5: LoadRow[] = [];
for (let i = 0; i < 3; i++) { l5.push(ld("ver", "a" + String(i), "model", D + i, { hash: "1111111111111111", usd: 0.1, size: 1000 })); l5.push(ld("ver", "b" + String(i), "model", D + 86400000 * 5 + i, { hash: "2222222222222222", usd: 0.3, size: 3000 })); }
for (let i = 0; i < 3; i++) l5.push(ld("vnear", "a" + String(i), "model", D + i, { hash: "3333333333333333" }));
for (let i = 0; i < 2; i++) l5.push(ld("vnear", "b" + String(i), "model", D + 86400000 * 5 + i, { hash: "4444444444444444" }));
const a5 = advise([row("ver", { m: 6, s: 6, hashes: ["1111111111111111", "2222222222222222"] }), row("vnear", { m: 5, s: 5, hashes: ["3333333333333333", "4444444444444444"] })], l5, ctx, [], C,
  (s: string, t0: number, t1: number): CallStat => ({ n: 10, err: s.startsWith("b") ? 3 : 1, kept: true })).filter((a: Advice) => a.id === "A5"); // (ver and vnear share their turns: A8 too)
ok("A5", ids(a5) === "A5:ver", ids(a5));
// A5 says so when call rows are not kept for every session, and gives no rate when one side has none
const a5p = advise([row("ver", { m: 6, s: 6, hashes: ["1111111111111111", "2222222222222222"] })], l5, ctx, [], C,
  (s: string, t0: number, t1: number): CallStat => ({ n: s === "a0" ? 0 : 10, err: s.startsWith("b") ? 3 : 1, kept: s !== "a0" }));
ok("A5 partial call rows", ((a5p[0] as Advice).evidence[1] ?? "").endsWith("call errors 10 % → 30 % (call rows of 2/3 → 3/3 sessions)"), a5p.length ? (a5p[0] as Advice).evidence.join(" | ") : "");
const a5n = advise([row("ver", { m: 6, s: 6, hashes: ["1111111111111111", "2222222222222222"] })], l5, ctx, [], C,
  (s: string, t0: number, t1: number): CallStat => ({ n: 0, err: 0, kept: s.startsWith("b") }));
ok("A5 no call rows", ((a5n[0] as Advice).evidence[1] ?? "").endsWith("call errors: no call rows kept for the older version (filter.callDays)"), a5n.length ? (a5n[0] as Advice).evidence.join(" | ") : "");
ok("A5 table", a5.length === 1 && ((a5[0] as Advice).evidence[1] ?? "") === "sessions 3 → 3 · size 1.0k → 3.0k tok · $/session $0.10 → $0.30 · tail 0 % → 0 % · call errors 10 % → 30 %", a5.length ? (a5[0] as Advice).evidence.join(" | ") : "");

// A6: listed names never loaded (Claude/Codex listings) and the inventory; a manual-only skill is not reported
const home = join(process.env.HOME ?? "/tmp", "inv-home");
rmSync(home, { recursive: true, force: true });
const sk = (d: string, body: string): void => { mkdirSync(join(home, ".claude", "skills", d), { recursive: true }); writeFileSync(join(home, ".claude", "skills", d, "SKILL.md"), body); };
sk("used", "---\nname: used\ndescription: LOREMDESC used one\n---\nbody");
sk("unused", "---\nname: unused\ndescription: LOREMDESC " + "x".repeat(350) + "\n---\nbody");
sk("manual", "---\nname: manual\ndescription: LOREMDESC\ndisable-model-invocation: true\n---\n");
const inv = inventory([], home);
ok("inventory", inv.map((s: InvSkill) => s.name + ":" + String(s.descBytes) + ":" + String(s.manual)).sort().join(",") === "manual:9:true,unused:360:false,used:18:false", inv.map((s: InvSkill) => s.name + ":" + String(s.descBytes)).join(","));
const listed = new Map<string, number>(); listed.set("used", 4); listed.set("ghost", 4);
const a6 = advise([row("used", { m: 1 }), row("(listing)", { c: 4, usd: 2 })], [ld("used", "s1", "model", D, {})], { days: 30, listed, requests: 100 }, inv, C, none);
ok("A6", ids(a6) === "A6:ghost,A6:unused", ids(a6));
// 360 bytes at Claude's divisor 2.6: 139 tok per request
ok("A6 inventory tokens", a6.length === 2 && ((a6[1] as Advice).evidence[0] ?? "").indexOf("≈ 139 tok per request, ≈ 13.9k tok") >= 0, a6.length > 1 ? (a6[1] as Advice).evidence[0] ?? "" : "");
let all = ""; for (const a of a6) all += adviceLines(a).join("\n");
ok("description text never shown", all.indexOf("LOREMDESC") < 0, "");
ok("frontmatter folded description", (frontOf("---\ndescription: >\n  ab\n  cd\n---\n", "d") ?? { name: "", descBytes: 0, manual: false }).descBytes === 6, "");

// ordering by $ at stake, rendering, hiding
const mix = advise([row("fat", { m: 3, s: 3, size: 4000, usd: 10, tail: 8 }), row("lost", { m: 3, s: 3 })], l4, ctx, [], C, none);
ok("ordered by severity", ids(mix) === "A1:fat,A4:lost", ids(mix));
ok("rendered", adviceLines(mix[0] as Advice).join("\n") === "A1 carried too long · fat · $8.00 / 30 days\n   tail carry $8.00 of $10.00 (80 %) over 3 sessions\n   size 4.0k tok, carried 5.0k tok after loading\n   → split SKILL.md: keep the decision part, move details to references/ read on demand", adviceLines(mix[0] as Advice).join("\n"));
setVis(parseHide([{ match: "fat", mode: "omit" }, { match: "lost", mode: "name" }]).rules, false);
const hv = visAdvice(mix);
ok("hidden advice", hv.length === 1 && hv[0] !== undefined && (hv[0] as Advice).skill !== "lost" && (hv[0] as Advice).skill.length === 4, ids(hv));
setVis([], false);
// config
const pc = parseAdvise({ minSizeTok: 500, tailShare: 2, minSessions: "x", idleShare: 0.4, overlap: 0, driftDays: 14 });
ok("config", pc.cfg.minSizeTok === 500 && pc.cfg.tailShare === 0.6 && pc.cfg.minSessions === 3 && pc.cfg.idleShare === 0.4 && pc.cfg.overlap === 0.6 && pc.cfg.driftDays === 14 && pc.bad.length === 3, pc.bad.join("; "));

// ── phase B ──
// A7: model loads, then no call in their turn: 3 of 5 (60 %) fire; 2 of 5 do not; a turn still running is not judged
{
  const mk = (name: string, idle: number): LoadRow[] => { const o: LoadRow[] = []; for (let i = 0; i < 5; i++) o.push(ld(name, name + String(i), "model", D + i * 1000, { turn: 1, te: D + i * 1000 + 500, usd: 0.2 })); for (let i = 0; i < idle; i++) (o[i] as LoadRow).sess = name + "-idle" + String(i); return o; };
  const callsA7 = (s: string, t0: number, t1: number): CallStat => ({ n: s.indexOf("-idle") >= 0 ? 0 : 4, err: 0, kept: true });
  const l7 = mk("broad", 3).concat(mk("fine", 2)).concat([ld("open", "o1", "model", D, { turn: 1 }), ld("open", "o2", "model", D, { turn: 1 }), ld("open", "o3", "model", D, { turn: 1 }), ld("open", "o4", "model", D, { turn: 1 }), ld("open", "o5", "model", D, { turn: 1 })]);
  const a7 = advise([row("broad", { m: 5, s: 5 }), row("fine", { m: 5, s: 5 }), row("open", { m: 5, s: 5 })], l7, ctx, [], C, callsA7).filter((a: Advice) => a.id === "A7");
  ok("A7 fires on 3 of 5", ids(a7) === "A7:broad", ids(a7));
  ok("A7 evidence", a7.length === 1 && ((a7[0] as Advice).evidence[0] ?? "").startsWith("loaded by the model 5×, then no tool call in that turn (or gone within a request) 3× (60 %)"), a7.length ? (a7[0] as Advice).evidence[0] ?? "" : "");
  // a load dropped within one request counts as idle without call rows
  const gone: LoadRow[] = []; for (let i = 0; i < 5; i++) gone.push(ld("drop", "d" + String(i), "model", D, { end: D + 10, req: i < 3 ? 1 : 5, turn: 1, te: D + 100 }));
  ok("A7: gone within a request", ids(advise([row("drop", { m: 5, s: 5 })], gone, ctx, [], C, (s: string, t0: number, t1: number): CallStat => ({ n: 2, err: 0, kept: true })).filter((a: Advice) => a.id === "A7")) === "A7:drop", "");
}
// A8: two skills in the same 5 turns (and one more each): Jaccard 5/7 ≥ 0.6; near miss: 4 shared turns
{
  const l8: LoadRow[] = [];
  for (let i = 0; i < 6; i++) l8.push(ld("tdd", "s" + String(i), "model", D, { turn: 1 }));
  for (let i = 0; i < 5; i++) l8.push(ld("tests", "s" + String(i), "model", D, { turn: 1 })); l8.push(ld("tests", "x9", "model", D, { turn: 1 }));
  for (let i = 0; i < 6; i++) l8.push(ld("lint", "s" + String(i), "model", D, { turn: 2 }));
  for (let i = 0; i < 4; i++) l8.push(ld("fmt", "s" + String(i), "model", D, { turn: 2 })); for (let i = 0; i < 2; i++) l8.push(ld("fmt", "y" + String(i), "model", D, { turn: 2 }));
  const a8 = advise([row("tdd", { m: 6, s: 6, usd: 3 }), row("tests", { m: 6, s: 6, usd: 1 }), row("lint", { m: 6, s: 6 }), row("fmt", { m: 6, s: 6 })], l8, ctx, [], C, none).filter((a: Advice) => a.id === "A8");
  ok("A8 fires on the cheaper of the pair", ids(a8) === "A8:tests", ids(a8));
  ok("A8 evidence names the other", a8.length === 1 && ((a8[0] as Advice).evidence[0] ?? "") === "loaded together with tdd in 5 turns (overlap 71 % of the turns either was loaded in)", a8.length ? (a8[0] as Advice).evidence[0] ?? "" : "");
  setVis(parseHide([{ match: "tdd", mode: "omit" }]).rules, false);
  ok("A8: a hidden partner is not named", advise([row("tdd", { m: 6, s: 6, usd: 3 }), row("tests", { m: 6, s: 6, usd: 1 })], l8, ctx, [], C, none).filter((a: Advice) => a.id === "A8").length === 0, "");
  setVis([], false);
}
// A9: 10 loading turns vs 10 other turns of the same project, test pass rates side by side; near miss: 9 turns
{
  const l9: LoadRow[] = []; for (let i = 0; i < 10; i++) l9.push(ld("tdd", "p" + String(i), "user", D + i * 10000, { turn: 1, te: D + i * 10000 + 5000 }));
  const sp = (s: string, t0: number, t1: number): SpanStat => t1 === Infinity ? { n: 10, err: 2, tests: 4, testsOk: 2, commits: 1, kept: true } : { n: 5, err: 0, tests: 2, testsOk: 2, commits: 1, kept: true };
  const inp = { sessions: l9.map((l: LoadRow) => l.sess), repo: (s: string): string => "repo:x", turns: (s: string): number => 2, span: sp };
  const a9 = adviseB([row("tdd", { u: 10, s: 10 })], l9, inp, [], C, D);
  ok("A9 fires", ids(a9) === "A9:tdd", ids(a9));
  ok("A9 evidence", a9.length === 1 && (a9[0] as Advice).evidence.join(" | ") === "turns that loaded it 10 vs the same projects' other turns 10 (correlation, not cause) | test runs passed 100 % vs 0 % · commits per turn 1.00 vs 0.00 · call errors 0 % vs 40 %", a9.length ? (a9[0] as Advice).evidence.join(" | ") : "");
  ok("A9 near miss: 9 turns", adviseB([row("tdd", { u: 9, s: 9 })], l9.slice(1), { sessions: inp.sessions, repo: inp.repo, turns: inp.turns, span: sp }, [], C, D).length === 0, "");
  ok("A9 rendered as correlation", adviceLines(a9[0] as Advice)[0] === "A9 outcome (correlation, not cause) · tdd", adviceLines(a9[0] as Advice)[0] ?? "");
}
// A10: one name, two hashes on two hosts within 7 days; near miss: the other version is older than 7 days, or one host
{
  const hh: HostHash[] = [{ host: "ws", name: "deploy", hash: "aaaaaaaa11111111", at: D }, { host: "vm1", name: "deploy", hash: "bbbbbbbb22222222", at: D - 86400000 },
    { host: "ws", name: "old", hash: "cccccccc33333333", at: D }, { host: "vm1", name: "old", hash: "dddddddd44444444", at: D - 8 * 86400000 },
    { host: "ws", name: "local", hash: "eeeeeeee55555555", at: D }, { host: "ws", name: "local", hash: "ffffffff66666666", at: D }];
  const a10 = adviseB([], [], { sessions: [], repo: (s: string): string => "", turns: (s: string): number => 0, span: (s: string, t0: number, t1: number): SpanStat => ({ n: 0, err: 0, tests: 0, testsOk: 0, commits: 0, kept: false }) }, hh, C, D);
  ok("A10", ids(a10) === "A10:deploy", ids(a10));
  ok("A10 evidence", a10.length === 1 && (a10[0] as Advice).evidence.join(" | ") === "2 versions on 2 hosts in 7 days | ws: aaaaaaaa (last loaded 2026-10-01) | vm1: bbbbbbbb (last loaded 2026-09-30)", a10.length ? (a10[0] as Advice).evidence.join(" | ") : "");
}

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok skill advice");
