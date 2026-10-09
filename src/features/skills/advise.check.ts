// agentglass — self-check for skill advice A1–A6 (one case that fires and one near miss per rule) and the inventory scan:
// scriptc build src/features/skills/advise.check.ts -o sa && ./sa
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Advice, advise, adviceLines, parseAdvise, visAdvice, ADVISE_DEFAULTS } from "./advise.ts";
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
function ld(name: string, sess: string, trig: string, t: number, o: { end?: number; rel?: boolean; hash?: string; usd?: number; size?: number }): LoadRow {
  return { sess, i: 0, name, trig, t, turn: 0, te: 0, end: o.end ?? 0, why: o.end ? "compact" : "", rel: o.rel ?? false, stub: false, bytes: 3600, size: o.size ?? 1000, tier: "exact",
    hash: o.hash ?? "", scope: "user", dir: "", requests: 3, n: 1, load: 1000, carry: 2000, tail: 0, usd: o.usd ?? 0.1, carryUsd: (o.usd ?? 0.1) / 2, tailUsd: 0, unpriced: false, off: -1, len: 0, rec: "", model: "m" };
}
const none = (s: string, t0: number, t1: number): { n: number; err: number } => ({ n: 0, err: 0 });
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
  (s: string, t0: number, t1: number): { n: number; err: number } => ({ n: 10, err: s.startsWith("b") ? 3 : 1 }));
ok("A5", ids(a5) === "A5:ver", ids(a5));
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
ok("A6 inventory tokens", a6.length === 2 && ((a6[1] as Advice).evidence[0] ?? "").indexOf("≈ 100 tok per request, ≈ 10.0k tok") >= 0, a6.length > 1 ? (a6[1] as Advice).evidence[0] ?? "" : "");
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
const pc = parseAdvise({ minSizeTok: 500, tailShare: 2, minSessions: "x" });
ok("config", pc.cfg.minSizeTok === 500 && pc.cfg.tailShare === 0.6 && pc.cfg.minSessions === 3 && pc.bad.length === 2, pc.bad.join("; "));

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok skill advice");
