// agentglass — triage scoring: scriptc build src/features/triage/score.check.ts -o tsc && ./tsc
// SPDX-License-Identifier: Apache-2.0
import { chi2, score, wscore, rank, fmtLift, fmtPct, CHI_SIG, type TRow } from "./score.ts";
let bad = 0;
function near(w: string, got: number, want: number): void { if (Math.abs(got - want) > 1e-4) { bad++; console.log("FAIL " + w + ": got " + got + " want " + want); } }
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
near("chi2 planted", chi2(30, 100, 50, 1000), 80.586121);
near("chi2 equal shares → 0 (clamped)", chi2(10, 100, 100, 1000), 0);
near("chi2 b = 0", chi2(5, 10, 0, 100), 41.490952);
near("chi2 tiny N", chi2(3, 5, 1, 10), 2.088068);
near("chi2 npm example", chi2(34, 100, 6, 100), 22.78125);
near("chi2 B = 0 → 0", chi2(3, 10, 0, 0), 0);
const s = score(30, 100, 50, 1000);
near("pS", s.pS, 0.3); near("pB", s.pB, 0.05); near("diff", s.diff, 0.25); near("lift", s.lift, 6);
eq("sig", String(s.sig), "true"); eq("lift fmt", fmtLift(s), "×6.0");
eq("new when b = 0", fmtLift(score(5, 10, 0, 100)), "new");
eq("tiny N not significant", String(score(3, 5, 1, 10).sig), "false");
eq("threshold", String(CHI_SIG), "6.63");
const w = wscore(4, 30, 100, 2, 10, 200);   // 4 rows, 30% of selection cost vs 2 rows, 5% of baseline cost
near("weighted diff", w.diff, 0.25); eq("weighted no chi2", String(w.chi2), "-1"); eq("weighted not sig", String(w.sig), "false"); eq("weighted support", String(w.a) + "/" + String(w.b), "4/2");
eq("pct", fmtPct(0.342), "34.2%");
// ranking: significant and non-significant rows in one list by diff; 3 per attr; support and 1% floor; under flips
const R = (attr: string, value: string, a: number, A: number, b: number, B: number): TRow => ({ attr, value, s: score(a, A, b, B) });
const rows: TRow[] = [R("program", "npm", 34, 100, 6, 100), R("program", "git", 20, 100, 18, 100), R("program", "ls", 10, 100, 9, 100), R("program", "make", 9, 100, 2, 100),
  R("branch", "wip", 3, 100, 1, 100), R("ext", "md", 2, 100, 0, 100), R("hour", "14", 1, 200, 0, 100), R("file", "/a", 4, 100, 0, 100), R("program", "cargo", 0, 100, 40, 100)];
eq("rank", rank(rows, false, 3, 3, "").map((r) => r.value).join(","), "npm,make,git,wip");
eq("expand lifts the cap", rank(rows, false, 3, 3, "program").map((r) => r.value).join(","), "npm,make,git,wip,ls");
eq("under-represented: only negative diffs (no over-represented rows trailing below)", rank(rows, true, 3, 3, "").map((r) => r.value).join(","), "");
const rows2 = rows.concat([R("program", "node", 5, 100, 30, 100), R("ext", "ts", 8, 100, 12, 100)]);
eq("under-represented: most negative first", rank(rows2, true, 3, 3, "").map((r) => r.value).join(","), "node,ts");
console.log(bad ? bad + " failed" : "triage scoring: all checks passed");
if (bad) process.exit(1);
