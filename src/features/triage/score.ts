// agentglass — triage scoring: share difference, lift, Yates-corrected 2×2 chi-square, ranking with per-attribute caps (spec §4)
// SPDX-License-Identifier: Apache-2.0
// Only + − × ÷ and abs/max: static scriptc builds have no Math.sqrt/log/pow. Significance marks a row, it never hides one.

export const CHI_SIG = 6.63; // p < 0.01 at 1 degree of freedom: stricter than 0.05 because many values are tested at once
export interface Score { a: number; A: number; b: number; B: number; pS: number; pB: number; diff: number /* pS − pB */; lift: number /* pS / pB; -1 = "new" (b = 0) */; chi2: number /* -1 = not computed (weighted) */; sig: boolean }
export interface TRow { attr: string; value: string; s: Score }

// χ² = N(|ad − bc| − N/2)² / ((a+b)(c+d)(a+c)(b+d)), c = A − a, d = B − b; 0 when a margin is 0
export function chi2(a: number, A: number, b: number, B: number): number {
  const c = A - a; const d = B - b; const N = A + B;
  const den = (a + b) * (c + d) * (a + c) * (b + d);
  if (den <= 0) return 0;
  const x = Math.max(0, Math.abs(a * d - b * c) - N / 2);
  return (N * x * x) / den;
}
export function score(a: number, A: number, b: number, B: number): Score {
  const pS = A > 0 ? a / A : 0; const pB = B > 0 ? b / B : 0; const x = chi2(a, A, b, B);
  return { a, A, b, B, pS, pB, diff: pS - pB, lift: b === 0 ? -1 : pS / pB, chi2: x, sig: x >= CHI_SIG };
}
// weight shares (cost, tokens, duration): a and b stay row counts (support), A and B are the groups' weights; no count test applies
export function wscore(a: number, wa: number, WA: number, b: number, wb: number, WB: number): Score {
  const pS = WA > 0 ? wa / WA : 0; const pB = WB > 0 ? wb / WB : 0;
  return { a, A: WA, b, B: WB, pS, pB, diff: pS - pB, lift: wb <= 0 ? -1 : pS / pB, chi2: -1, sig: false };
}
// files are high-cardinality: listed only with support ≥ 5
function support(attr: string, minSupport: number): number { return attr === "file" ? Math.max(5, minSupport) : minSupport; }
// rows with a ≥ minSupport and pS ≥ 1%, by diff (desc; under: asc), ties by support then value; ≤ cap per attr unless attr = expand
export function rank(rows: TRow[], under: boolean, cap: number, minSupport: number, expand: string): TRow[] {
  const keep: TRow[] = [];
  for (const r of rows) if (r.s.a >= support(r.attr, minSupport) && r.s.pS >= 0.01) keep.push(r);
  keep.sort((x: TRow, y: TRow): number => {
    const d = under ? x.s.diff - y.s.diff : y.s.diff - x.s.diff;
    if (d !== 0) return d;
    if (x.s.a !== y.s.a) return y.s.a - x.s.a;
    return x.attr + "\t" + x.value < y.attr + "\t" + y.value ? -1 : 1;
  });
  const per = new Map<string, number>(); const out: TRow[] = [];
  for (const r of keep) {
    const n = per.get(r.attr) ?? 0;
    if (r.attr !== expand && n >= cap) continue;
    per.set(r.attr, n + 1); out.push(r);
  }
  return out;
}
export function fmtLift(s: Score): string { return s.lift < 0 ? "new" : "×" + s.lift.toFixed(1); }
export function fmtPct(p: number): string { return (p * 100).toFixed(1) + "%"; }
