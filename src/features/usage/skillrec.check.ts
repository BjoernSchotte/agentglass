// agentglass — self-check for skill attribution (skill-usage spec §3): scriptc build src/features/usage/skillrec.check.ts -o sr && ./sr
// SPDX-License-Identifier: Apache-2.0
import { type Acc, newAcc, bucket, tokens, usageExact, turn, skillLoad, skillUnload, skillRead, skillReadDone, skillListing, skillUsesOf } from "./record.ts";
import { type SkLoad, skillPath, skillReadCmd, skillHash, SA_L, SA_C, SA_T, SA_LU, SA_LM, SA_LC, SA_HU } from "./skillrec.ts";

let bad = 0;
function ok(what: string, c: boolean, info: string): void { if (!c) { bad++; console.log("FAIL " + what + (info ? ": " + info : "")); } }
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function sum4(x: number[]): number { return (x[0] ?? 0) + (x[1] ?? 0) + (x[2] ?? 0) + (x[3] ?? 0); }
function lj(x: number[]): string { return "[" + x.join(",") + "]"; }
// per load: no negative slot, short ≥ 0, ended loads say why; tail ⊆ load + carry
function inv(a: Acc, at: string): void {
  for (const l of a.sk) {
    let neg = l.short < 0;
    for (let i = 0; i < 4; i++) if ((l.lt[i] ?? 0) < 0 || (l.ct[i] ?? 0) < 0 || (l.tt[i] ?? 0) < 0 || (l.tt[i] ?? 0) > (l.lt[i] ?? 0) + (l.ct[i] ?? 0)) neg = true;
    ok(at + ": slots of " + l.name, !neg, lj(l.lt) + lj(l.ct) + lj(l.tt) + " short " + String(l.short));
    ok(at + ": why of " + l.name, (l.end === 0) === (l.why === ""), l.why);
  }
}
// Σ Day.sa token slots == Σ Acc.sk per bucket (g)
function saMatches(a: Acc, at: string): void {
  const s1 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; const s2 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const d of a.days.values()) for (const r of d.sa.values()) for (let i = 0; i < 12; i++) s1[i] = (s1[i] ?? 0) + (r[SA_L + i] ?? 0);
  for (const l of a.sk) for (let i = 0; i < 4; i++) { s2[i] = (s2[i] ?? 0) + (l.lt[i] ?? 0); s2[4 + i] = (s2[4 + i] ?? 0) + (l.ct[i] ?? 0); s2[8 + i] = (s2[8 + i] ?? 0) + (l.tt[i] ?? 0); }
  eq(at + ": Day.sa = Acc.sk", lj(s1), lj(s2));
}

// (0) SKILL.md paths and the shell commands that read them
eq("path codex", skillPath("/h/.codex/skills/ponytail/SKILL.md"), "ponytail");
eq("path plugin", skillPath("/h/.claude/plugins/cache/m/superpowers/5.1/skills/brainstorming/SKILL.md"), "superpowers:brainstorming");
eq("path codex plugin", skillPath("/h/.codex/plugins/cache/curated/github/0.1.8-abc/skills/gh-fix/SKILL.md"), "github:gh-fix");
eq("path marketplace", skillPath("/h/.claude/plugins/marketplaces/mk/plugins/tools/skills/x/SKILL.md"), "tools:x");
eq("path relative", skillPath("skills/a/SKILL.md"), "a");
eq("path no skills dir", skillPath("/r/docs/SKILL.md"), "");
eq("path other file", skillPath("/x/skills/a/README.md"), "");
eq("cmd sed", skillReadCmd("sed -n '1,200p' /x/skills/a/SKILL.md"), "/x/skills/a/SKILL.md");
eq("cmd cd &&", skillReadCmd("cd /x && cat skills/a/SKILL.md"), "skills/a/SKILL.md");
eq("cmd ls", skillReadCmd("ls /x/skills/a/SKILL.md"), "");
eq("cmd after pipe", skillReadCmd("echo x | cat /x/skills/a/SKILL.md"), "");
eq("cmd before pipe", skillReadCmd("cat /x/skills/a/SKILL.md | head -5"), "/x/skills/a/SKILL.md");
eq("cmd env + rtk", skillReadCmd("LC_ALL=C rtk read \"/x/skills/b c/SKILL.md\""), "/x/skills/b c/SKILL.md");
eq("cmd multi-line", skillReadCmd("git status\nnl -ba /x/skills/z/SKILL.md"), "/x/skills/z/SKILL.md");
eq("cmd bare SKILL.md", skillReadCmd("sed -n '1,260p' SKILL.md"), "");
eq("cmd wc", skillReadCmd("wc -l /x/skills/a/SKILL.md"), "");

// the plan's worked example (Task 2 Step 1)
const T = "LOREMSKILLTEXT" + "x".repeat(3586); // 3600 bytes → S_est = ceil(3600 / 3.6) = 1000
const a = newAcc(); const iso = "2026-10-01T09:00:00.000Z"; const d = bucket(a, 0, iso); const M = "claude-sonnet-4-5";
function allEnded(why: string): boolean { for (const x of a.sk) if (x.end === 0 || x.why !== why) return false; return true; }
tokens(a, d, M, 10, 50, 0, 20000, 0); // r1: ctx 20010, no load
skillLoad(a, "alpha", "user", 1, iso, T, true, "/k/alpha", false);
tokens(a, d, M, 10, 50, 20000, 1500, 0); // r2: ctx 21510, growth 1500 → S = 1000, taken from w5
const A = a.sk[0] as SkLoad;
ok("load from write", A.S === 1000 && (A.lt[2] ?? 0) === 1000 && sum4(A.lt) === 1000, lj(A.lt));
ok("hash", A.hash === skillHash(T) && A.hash.length === 16, A.hash);
tokens(a, d, M, 10, 50, 21500, 100, 0); // r3: alpha carries 1000 from cache read
ok("carry from read", (A.ct[1] ?? 0) === 1000 && A.nq === 1, lj(A.ct));
skillLoad(a, "beta", "model", 2, iso, T, true, "/k/beta", false); skillLoad(a, "gamma", "model", 3, iso, T, true, "/k/gamma", false);
tokens(a, d, M, 0, 50, 900, 1200, 0); // r4: ctx 2100: no drop (2100 ≥ Σ S of sent loads = 1000)
const B = a.sk[1] as SkLoad; const G = a.sk[2] as SkLoad;
ok("no drop on one condition", A.end === 0 && B.end === 0 && G.end === 0, "");
ok("alpha carry r4", (A.ct[1] ?? 0) === 1900 && (A.ct[2] ?? 0) === 100 && A.nq === 2, lj(A.ct));
ok("beta load r4", B.S === 1000 && (B.lt[2] ?? 0) === 1000, lj(B.lt));
ok("gamma short", (G.lt[2] ?? 0) === 100 && G.short === 900, lj(G.lt) + " " + String(G.short));
ok("r4 never exceeds request", (1900 + 100 - 1000) + sum4(B.lt) + sum4(G.lt) === 2100, "");
inv(a, "r4"); saMatches(a, "r4");
tokens(a, d, M, 0, 50, 400, 0, 0); // r5: ctx 400 < 0.5 × 2100 and < 3000 → all three drop, nothing carried
ok("drop ends all", allEnded("drop") && A.nq === 2, String(A.nq));
inv(a, "r5"); saMatches(a, "r5");
eq("day load counts", String(((d.sa.get("alpha\t\t") ?? [])[SA_LU] ?? 0) + ((d.sa.get("beta\t\t") ?? [])[SA_LM] ?? 0)), "2");
eq("no text kept", String(JSON.stringify(a.sk).indexOf("LOREMSKILLTEXT")), "-1");

// (a) reload while open: two records, both carry; (b) after a compaction a reload is rel
{
  const b = newAcc(); const db = bucket(b, 0, iso);
  tokens(b, db, M, 0, 10, 0, 5000, 0);
  skillLoad(b, "alpha", "model", 1, iso, T, true, "/k/alpha", false);
  tokens(b, db, M, 0, 10, 5000, 1000, 0);
  skillLoad(b, "alpha", "model", 2, iso, T, true, "/k/alpha", false);
  tokens(b, db, M, 0, 10, 6000, 1000, 0);
  tokens(b, db, M, 0, 10, 7000, 0, 0);
  const x0 = b.sk[0] as SkLoad; const x1 = b.sk[1] as SkLoad;
  ok("reload: two records", b.sk.length === 2 && !x0.rel && !x1.rel, String(b.sk.length));
  ok("reload: both carry", (x0.ct[1] ?? 0) === 2000 && (x1.ct[1] ?? 0) === 1000, lj(x0.ct) + lj(x1.ct));
  skillUnload(b, 3, "compact");
  ok("compact ends both", x0.why === "compact" && x1.why === "compact" && x0.end === 3, x0.why);
  tokens(b, db, M, 0, 10, 2000, 0, 0);
  ok("ended loads carry nothing", x0.nq === 2 && x1.nq === 1, String(x0.nq) + "/" + String(x1.nq));
  skillLoad(b, "alpha", "user", 4, iso, T, true, "/k/alpha", false);
  ok("reload after compaction is rel", (b.sk[2] as SkLoad).rel, "");
  skillLoad(b, "alpha", "compact", 5, iso, T, true, "", false);
  ok("re-injection is not rel", !(b.sk[3] as SkLoad).rel, "");
  inv(b, "reload"); saMatches(b, "reload");
}

// (c) tail: carry after the loading turn ends lands in tt; te set at the turn
{
  const c = newAcc(); const dc = bucket(c, 0, iso);
  turn(c, 0, iso, 1);
  tokens(c, dc, M, 0, 10, 0, 5000, 0);
  skillLoad(c, "alpha", "user", 1, iso, T, true, "/k/alpha", false);
  tokens(c, dc, M, 0, 10, 5000, 1000, 0);
  tokens(c, dc, M, 0, 10, 6000, 0, 0);
  const l = c.sk[0] as SkLoad;
  ok("no tail inside the turn", sum4(l.tt) === 0 && l.te === 0, lj(l.tt));
  turn(c, Date.parse("2026-10-01T09:05:00.000Z"), "2026-10-01T09:05:00.000Z", 1);
  ok("te at the next prompt", l.te === Date.parse("2026-10-01T09:05:00.000Z"), String(l.te));
  tokens(c, dc, M, 0, 10, 6000, 200, 0);
  ok("tail carry", (l.tt[1] ?? 0) === 1000 && (l.ct[1] ?? 0) === 2000, lj(l.tt) + lj(l.ct));
  const sub = newAcc(); sub.sub = true; turn(sub, 0, iso, 2);
  ok("subagent turns count for skills, not for the day", sub.tq === 2 && sub.days.size === 0, String(sub.tq));
  saMatches(c, "tail");
}

// (d) harness-priced: the skills' $ share ≤ the request's
{
  const e = newAcc(); const de = bucket(e, 0, iso);
  usageExact(e, de, "some-unpriced-model", 100, 50, 0, 5000, 0, 0.05);
  skillLoad(e, "alpha", "model", 1, iso, T, true, "/k/alpha", false); skillLoad(e, "beta", "model", 1, iso, T, true, "/k/beta", false);
  usageExact(e, de, "some-unpriced-model", 100, 50, 5000, 3000, 0, 0.10);
  usageExact(e, de, "some-unpriced-model", 100, 50, 8000, 0, 0, 0.10);
  let hu = 0; for (const l of e.sk) hu += l.hu;
  ok("hu ≤ usd", hu > 0 && hu <= 0.2 + 1e-12, String(hu));
  let rowHu = 0; for (const [k, r] of de.sa) if (k.indexOf("\t=") >= 0) rowHu += r[SA_HU] ?? 0;
  ok("hu in harness rows", Math.abs(rowHu - hu) < 1e-12, String(rowHu));
  // r2: 8150 tokens weighed by count, 2000 of them the skills' (both loads 1000 from w5): 0.10 × 2000 / 8150
  ok("hu share r2", Math.abs(((e.sk[0] as SkLoad).hu + (e.sk[1] as SkLoad).hu) - (0.10 * 2000 / 8150 + 0.10 * 2000 / 8150)) < 1e-9, String((e.sk[0] as SkLoad).hu));
}

// (e) unknown text: counted, never carried; (h) no growth (cache expiry): the size from the text
{
  const f = newAcc(); const df = bucket(f, 0, iso);
  tokens(f, df, M, 0, 10, 0, 5000, 0);
  skillLoad(f, "ghost", "model", 1, iso, "", false, "", false);
  tokens(f, df, M, 0, 10, 5000, 900, 0);
  const l = f.sk[0] as SkLoad;
  ok("unknown size", l.S === -1 && l.bytes === -1 && sum4(l.lt) === 0 && sum4(l.ct) === 0 && !l.pend, String(l.S));
  eq("unknown counted", String(((df.sa.get("ghost\t\t") ?? [])[SA_LM] ?? 0)), "1");
  skillLoad(f, "alpha", "model", 2, iso, T, true, "/k/alpha", false);
  tokens(f, df, M, 0, 10, 0, 5900, 0); // ctx equal to the last: no growth → S_est
  const h = f.sk[1] as SkLoad;
  ok("no growth: S_est", h.S === 1000 && (h.lt[2] ?? 0) === 1000, String(h.S) + lj(h.lt));
}

// SKILL.md reads: two partial reads of one file in one turn → one load, ≈; a later turn → a reload; counted as model use
{
  const g = newAcc(); const dg = bucket(g, 0, iso);
  turn(g, 0, iso, 1);
  tokens(g, dg, M, 0, 10, 0, 5000, 0);
  skillRead(g, "c1", "/h/.codex/skills/alpha/SKILL.md");
  skillReadDone(g, dg, "c1", 1, iso, "x".repeat(1800), false);
  tokens(g, dg, M, 0, 10, 5000, 600, 0);
  skillRead(g, "c2", "/h/.codex/skills/alpha/SKILL.md");
  skillReadDone(g, dg, "c2", 2, iso, "y".repeat(1800), true);
  tokens(g, dg, M, 0, 10, 5600, 600, 0);
  const l = g.sk[0] as SkLoad;
  ok("partial reads: one load", g.sk.length === 1 && l.bytes === 3600 && l.est && l.trig === "model" && l.rd, String(g.sk.length) + " " + String(l.bytes));
  ok("grown part sent as load", sum4(l.lt) === 1000 && (l.ct[1] ?? 0) === 500, lj(l.lt) + lj(l.ct));
  turn(g, 0, iso, 1);
  skillRead(g, "c3", "/h/.codex/skills/alpha/SKILL.md");
  skillReadDone(g, dg, "c3", 3, iso, "x".repeat(1800), false);
  ok("later turn: reload", g.sk.length === 2, String(g.sk.length));
  skillRead(g, "c4", "/h/README.md");
  skillReadDone(g, dg, "c4", 4, iso, "x", false);
  ok("not a skill file", g.sk.length === 2, "");
  eq("model uses", JSON.stringify(skillUsesOf([g], null)), "[{\"name\":\"alpha\",\"source\":\"model\",\"n\":2}]");
  // a skill tool's load being sent: a read of the same skill is part of it
  const t2 = newAcc(); const dt = bucket(t2, 0, iso);
  skillLoad(t2, "beta", "model", 1, iso, T, true, "/h/.claude/skills/beta", false);
  skillRead(t2, "c5", "/h/.claude/skills/beta/SKILL.md");
  skillReadDone(t2, dt, "c5", 2, iso, T, false);
  ok("tool load + read: one load", t2.sk.length === 1 && (t2.sk[0] as SkLoad).bytes === 3600, String(t2.sk.length));
}

// listing: a new one replaces the open one (relist), names kept
{
  const h = newAcc();
  skillListing(h, 1, iso, "- a: x\n- b: y", ["a", "b"]);
  skillListing(h, 2, iso, "- a: x\n- b: y\n- c: z", ["a", "b", "c"]);
  ok("relist", h.sk.length === 2 && (h.sk[0] as SkLoad).why === "relist" && (h.sk[1] as SkLoad).end === 0 && (h.sk[1] as SkLoad).trig === "listing", "");
  eq("listing names", h.lst.join(","), "a,b,c");
  let lc = 0; for (const dd of h.days.values()) lc += ((dd.sa.get("(listing)\t\t") ?? [])[SA_LC] ?? 0);
  eq("listing counted as injected", String(lc), "2");
}

// the cap: beyond 400 loads the oldest ended ones fold per name, tokens kept
{
  const k = newAcc(); const dk = bucket(k, 0, iso);
  for (let i = 0; i < 405; i++) { skillLoad(k, "s" + String(i % 3), "model", i + 1, iso, "x".repeat(36), true, "", false); tokens(k, dk, M, 0, 1, 1000, 20, 0); skillUnload(k, i + 1, "compact"); }
  let n = 0; let lt = 0; for (const l of k.sk) { n += l.n; lt += sum4(l.lt); }
  ok("cap holds", k.sk.length <= 400 && n === 405 && lt === 405 * 10, String(k.sk.length) + " " + String(n) + " " + String(lt));
  saMatches(k, "cap");
}
void SA_C; void SA_T;

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("ok skill attribution");
