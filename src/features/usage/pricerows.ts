// agentglass — per-model price rows (what `agentglass prices` lists and the Stats price panel shows): usage, cost and
// where each model's price comes from, built from the ledger's day buckets (Day.mt/um) and priced-token rows (Day.tp)
// SPDX-License-Identifier: Apache-2.0
import { type Acc, mkey } from "./record.ts";
import { type Price, resolve, aliasOf, communitySource } from "./pricing.ts";
import { harnessOf, isHarness } from "../../harness/index.ts";

// src: user | alias | gateway | community | built-in | harness | unpriced (JSON names); more = further sources of the
// model's other providers; part = a share of its cost was reported by the harness (rh: which) and is never re-priced
export interface PProv { prov: string; src: string; via: string; p: Price | null }
export interface PRow {
  model: string; src: string; via: string; more: number; part: boolean; dead: boolean; p: Price | null; prov: string;
  inTok: number; outTok: number; cr: number; cw: number; tok: number; unk: number; cost: number; reported: number; est: number; rh: string;
  provs: PProv[];
}
export interface SessAcc { a: Acc; h: string }
interface Grp { prov: string; model: string; tok: number }
function harnessLabel(h: string): string { return h && isHarness(h) ? harnessOf(h).label : h; }
// rows of every model with usage on the given local days (null = all days), unpriced first (by tokens), then cost desc
export function priceRows(list: SessAcc[], days: string[] | null): PRow[] {
  const by = new Map<string, PRow>(); const grps = new Map<string, Grp[]>(); const rep = new Map<string, number>(); // "<model>\t<harness>" → reported cost
  const row = (m: string): PRow => {
    let r = by.get(m);
    if (!r) { r = { model: m, src: "", via: "", more: 0, part: false, dead: false, p: null, prov: "", inTok: 0, outTok: 0, cr: 0, cw: 0, tok: 0, unk: 0, cost: 0, reported: 0, est: 0, rh: "", provs: [] }; by.set(m, r); grps.set(m, []); }
    return r;
  };
  for (const x of list) {
    for (const [k, d] of x.a.days) {
      if (days && days.indexOf(k) < 0) continue;
      const tab = new Map<string, number>(); // model → table-priced cost of this day
      for (const [tk, t] of d.tp) {
        const t1 = tk.indexOf("\t"); const t2 = tk.indexOf("\t", t1 + 1);
        const prov = tk.slice(t1 + 1, t2); const m = mkey(tk.slice(t2 + 1));
        const n = (t[0] ?? 0) + (t[1] ?? 0) + (t[2] ?? 0) + (t[3] ?? 0) + (t[4] ?? 0); const usd = t[5] ?? -1;
        row(m); const gs = grps.get(m) ?? [];
        let g: Grp | null = null; for (const y of gs) if (y.prov === prov) { g = y; break; }
        if (!g) { g = { prov, model: m, tok: 0 }; gs.push(g); }
        g.tok += n;
        if (usd > 0) { tab.set(m, (tab.get(m) ?? 0) + usd); const rr = resolve(tk.slice(t2 + 1), prov); if (rr && rr.src === "alias") { const e = row(m); e.est = e.est + usd; } }
      }
      for (const [m, v] of d.mt) {
        const r = row(m);
        r.inTok += v[0] ?? 0; r.outTok += v[1] ?? 0; r.cr += v[2] ?? 0; r.cw += v[3] ?? 0; r.cost += v[4] ?? 0;
        const own = (v[4] ?? 0) - (tab.get(m) ?? 0); // the rest was reported by the harness (pi, OpenCode, fx) or kiro credits
        if (own > 1e-9) { r.reported += own; const rk = m + "\t" + x.h; rep.set(rk, (rep.get(rk) ?? 0) + own); }
      }
      for (const [m, n] of d.um) { const u = row(m); u.unk = u.unk + n; }
    }
  }
  const out: PRow[] = [];
  for (const r of by.values()) {
    r.tok = r.inTok + r.outTok + r.cr + r.cw;
    const gs = (grps.get(r.model) ?? []).slice(); gs.sort((a, b) => b.tok - a.tok);
    let best = ""; let bv = 0; // the harness that reported most of it
    for (const [rk, v] of rep) if (v > bv && rk.startsWith(r.model + "\t") && rk.indexOf("\t") === r.model.length) { bv = v; best = rk.slice(r.model.length + 1); }
    if (bv > 0) r.rh = harnessLabel(best);
    if (!gs.length) { r.src = r.reported > 0 ? "harness" : "unpriced"; if (r.tok + r.unk > 0 || r.cost > 0) out.push(r); continue; }
    const srcs = new Set<string>();
    let first = true;
    for (const g of gs) {
      const z = resolve(r.model, g.prov); const src = z ? z.src : "unpriced";
      srcs.add(src);
      if (first) { first = false; r.prov = g.prov; r.src = src; r.via = z ? z.via : ""; r.p = z ? z.p : null; continue; }
      if (src !== r.src || (z ? z.via : "") !== r.via) r.provs.push({ prov: g.prov, src, via: z ? z.via : "", p: z ? z.p : null });
    }
    r.more = srcs.size - 1;
    r.part = r.reported > 1e-9;
    if (r.src === "unpriced") { const t = aliasOf(r.model); if (t) { r.dead = true; r.via = t; } }
    out.push(r);
  }
  out.sort((x, y) => {
    const ux = x.src === "unpriced" ? 1 : 0; const uy = y.src === "unpriced" ? 1 : 0;
    if (ux !== uy) return uy - ux;
    if (ux) return (y.unk + y.tok) - (x.unk + x.tok) || (x.model < y.model ? -1 : 1);
    return y.cost - x.cost || y.tok - x.tok || (x.model < y.model ? -1 : x.model > y.model ? 1 : 0);
  });
  return out;
}
// the harness-reported note (spec Decision 1): "" when the model has no reported cost
export function reportedNote(r: PRow): string {
  if (r.reported <= 0) return "";
  if (r.rh === "Kiro" || r.rh === "kiro") return "cost from kiro credits × kiroCreditUsd — a user price does not change it";
  return "cost reported by " + (r.rh || "the harness") + " — a user price applies only to its unpriced messages";
}
// derived cache rates as numbers (never -1)
export function rates(p: Price): number[] {
  return [p.i, p.o, p.cr >= 0 ? p.cr : p.i * 0.1, p.cw >= 0 ? p.cw : p.i * 1.25, p.cw1 >= 0 ? p.cw1 : p.i * 2];
}
// the TUI short form of a source: user, ≈ <target>, gw <provider>, litellm / models.dev, built-in, harness, unpriced
export function srcLabel(r: PRow): string {
  let s = r.src === "alias" ? "≈ " + r.via : r.src === "gateway" ? "gw " + r.via : r.src === "community" ? (r.via || communitySource() || "community") : r.src;
  if (r.dead) s = "≈ " + r.via + " (unpriced)";
  if (r.more > 0) s += " +" + r.more;
  if (r.part && r.src !== "harness") s += " +harness";
  return s;
}
