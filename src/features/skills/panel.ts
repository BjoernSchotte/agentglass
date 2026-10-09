// agentglass — the skills panel (S in Stats; S on a Repos project): per skill its loads (/ by you, ⚙ by the model),
// sessions, size, load / carry / tail tokens, share of context and $ over the opener's period and filter (skill-usage
// §6.6). ↵ lists the sessions that loaded it, a shows its advice (§8), v the text of its newest load
// SPDX-License-Identifier: Apache-2.0
import { clean, fit, fitStyled, fillTo, width, wrap } from "../../util/text.ts";
import type { Sess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { S, say, type Mode } from "../../state.ts";
import { H, type Ctx } from "../../hooks.ts";
import { C, CSI, RST, fg, bg } from "../../ui/theme.ts";
import { put, box } from "../../ui/screen.ts";
import { ledger, callsOf } from "../usage/ledger.ts";
import { callCutoff } from "../usage/callcache.ts";
import { type Acc, L, dayKey } from "../usage/record.ts";
import { LISTING } from "../usage/skillrec.ts";
import { kfmt, grp, money } from "../usage/costs.ts";
import { type Bill, asBill } from "../usage/billing.ts";
import { type Compiled, skillRows, skillRowMatches } from "../query/eval.ts";
import { addClause, localFor, setLocal, shownClause } from "../query/scope.ts";
import { type SkillRow, type LoadRow, skillTable, skillLoads, visRows } from "./model.ts";
import { type Advice, type CallStat, advise, adviseCfg, adviceLines, visAdvice } from "./advise.ts";
import { type InvSkill, inventory } from "./inventory.ts";
import { skillVis, HIDDEN } from "./vis.ts";
import { openSkillView } from "./view.ts";
import { addActions, keyAction, tabNamed } from "../palette/actions.ts";

export const SP_NAME = "skills";
// what the panel counts, from its opener: the sessions (every log once: subagents too, a session's copies each for what
// it booked, as Stats sums them), the local day keys, the filter (its skill clauses pick names), the subtitle, and the
// opener's period keys (d / w …: true when k was one)
export interface PanelScope { origin: string; label: () => string; days: () => string[]; sess: () => Sess[]; filter: () => Compiled; period: (k: string) => boolean; keys: string[][] }
export const SORTS = ["cost", "loads", "tail", "size", "share", "persess"];
const SORT_NAMES = ["$", "loads", "tail $", "size", "share", "$/session"];
interface PData { key: string; ver: number; at: number; rows: SkillRow[]; hidden: number; accs: Acc[]; ids: string[]; paths: string[]; usd: number; tok: number; carry: number; sessions: number; bill: Bill | ""; named: boolean; days: number }
const P = {
  sc: null as PanelScope | null, sort: 0, sel: "", top: 0, adv: false, advFor: "", advs: [] as Advice[], advKey: "",
  backMode: "list" as Mode, backView: "", d: null as PData | null, y0: 0, n: 0,
};
// the session a log counts for: a subagent's for its parent, a copy's for its session
function sidOf(s: Sess): string { return s.h + ":" + (s.parent || s.id); }

// the panel's table for a scope (checks call it directly): per skill over the scope's days, names through skillVis,
// omitted skills folded into one (hidden) row; with skill clauses in the filter only the names they match
export function panelData(sc: PanelScope, sort: string): PData {
  const days = sc.days(); const f = sc.filter();
  const accs: Acc[] = []; const ids: string[] = []; const paths: string[] = [];
  const named = f.skill.length > 0; const names = new Set<string>(); // scriptc: no Set | null
  let bill: Bill | "" = ""; let first = true;
  for (const s of sc.sess()) {
    const a = ledger.get(s.path); if (!a || !a.sk.length) continue;
    let inP = false; for (const dk of days) if (a.days.has(dk)) { inP = true; break; }
    if (!inP) continue;
    accs.push(a); ids.push(sidOf(s)); paths.push(s.path);
    if (named) for (const q of skillRows(s)) if (skillRowMatches(f, q)) names.add(q.name);
    const b = asBill(s.bill); if (first) { bill = b; first = false; } else if (bill !== b) bill = "";
  }
  let all = skillTable(accs, ids, days, sort);
  if (named) all = all.filter((r: SkillRow) => names.has(r.name));
  const v = visRows(all);
  let usd = 0; let tok = 0; let carry = 0; const ss = new Set<string>();
  for (const r of v.rows) { usd += r.usd; tok += r.load + r.carry; carry += r.carry; }
  for (const id of ids) ss.add(id);
  return { key: "", ver: L.ver, at: Date.now(), rows: v.rows, hidden: v.hidden, accs, ids, paths, usd, tok, carry, sessions: ss.size, bill, named, days: days.length };
}
function data(): PData | null {
  const sc = P.sc; if (!sc) return null;
  const sort = SORTS[P.sort] ?? "cost";
  const key = sc.origin + "|" + sc.days().join(",") + "|" + sc.filter().key + "|" + sort;
  const d = P.d;
  if (d && d.key === key && (d.ver === L.ver || Date.now() - d.at < 2000)) return d; // the ledger moves while agents run: at most every 2 s
  const n = panelData(sc, sort); n.key = key; P.d = n;
  return n;
}

// ── formatting: the CLI's columns (agentglass skills), coloured; narrow drops load, / and ⚙, then tail ──
function usd(x: number, tier: string, unpriced: boolean, bill: Bill | ""): string { if (tier === "?" && x <= 0) return "?"; return money(x, bill, tier === "≈") + (unpriced ? "+" : ""); }
interface Col { h: string; w: number; drop: number; f: (r: SkillRow, b: Bill | "") => string; c: string }
const COLS: Col[] = [
  { h: "loads", w: 6, drop: 9, c: C.text, f: (r: SkillRow, b: Bill | ""): string => grp(r.loadsUser + r.loadsModel + r.loadsCompact) },
  { h: "/", w: 4, drop: 1, c: C.sub, f: (r: SkillRow, b: Bill | ""): string => r.name === LISTING ? "·" : String(r.loadsUser) },
  { h: "⚙", w: 4, drop: 1, c: C.sub, f: (r: SkillRow, b: Bill | ""): string => r.name === LISTING ? "·" : String(r.loadsModel) },
  { h: "sess", w: 5, drop: 9, c: C.text, f: (r: SkillRow, b: Bill | ""): string => grp(r.sessions) },
  { h: "size", w: 7, drop: 9, c: C.sub, f: (r: SkillRow, b: Bill | ""): string => r.tier === "?" && r.sizeP50 === 0 ? "?" : kfmt(r.sizeP50) },
  { h: "load", w: 7, drop: 1, c: C.sub, f: (r: SkillRow, b: Bill | ""): string => kfmt(r.load) },
  { h: "carry", w: 8, drop: 9, c: C.text, f: (r: SkillRow, b: Bill | ""): string => kfmt(r.carry) },
  { h: "tail", w: 7, drop: 2, c: C.sub, f: (r: SkillRow, b: Bill | ""): string => kfmt(r.tail) },
  { h: "share", w: 7, drop: 9, c: C.sub, f: (r: SkillRow, b: Bill | ""): string => (r.share * 100).toFixed(1) + " %" },
  { h: "$", w: 9, drop: 9, c: C.yellow, f: (r: SkillRow, b: Bill | ""): string => usd(r.usd, r.tier, r.unpriced, b) },
  { h: "$/sess", w: 9, drop: 9, c: C.yellow, f: (r: SkillRow, b: Bill | ""): string => usd(r.perSess, r.tier, r.unpriced, b) },
  { h: "tier", w: 5, drop: 9, c: C.dim, f: (r: SkillRow, b: Bill | ""): string => r.tier === "exact" ? "" : r.tier },
];
function lp(s: string, w: number): string { const n = width(s); return n >= w ? fit(s, w) : " ".repeat(w - n) + s; }
function colsFor(w: number): { cols: Col[]; nw: number } {
  let cols = COLS.slice();
  const sum = (cs: Col[]): number => { let n = 0; for (const c of cs) n += c.w; return n; };
  for (const lvl of [1, 2]) if (sum(cols) + 14 > w) cols = cols.filter((c: Col) => c.drop > lvl);
  return { cols, nw: Math.max(14, Math.min(30, w - sum(cols))) };
}
function headLine(w: number): string { const x = colsFor(w); let h = fit("skill", x.nw); for (const c of x.cols) h += lp(c.h, c.w); return fg(C.dim) + fitStyled(h, w) + RST; }
function rowLine(r: SkillRow, w: number, on: boolean, b: Bill | ""): string {
  const x = colsFor(w); const sb = on ? bg(C.sel) : "";
  const nc = r.name === HIDDEN || r.name === LISTING ? C.sub : C.cyan;
  let l = sb + fg(nc) + (on ? CSI + "1m" : "") + fit(clean(r.name), x.nw) + RST + sb;
  for (const c of x.cols) l += fg(c.c) + lp(c.f(r, b), c.w) + RST + sb;
  return l;
}
// the summary line: how many skills, their $ and tokens, how much of it is carry, the sort
function summary(d: PData): string {
  const dot = fg(C.dim) + " · " + RST;
  let n = 0; let lst = false; for (const r of d.rows) { if (r.name === LISTING) lst = true; else if (r.name !== HIDDEN) n++; }
  return fg(C.text) + CSI + "1m" + String(n) + RST + fg(C.sub) + (n === 1 ? " skill" : " skills") + (d.hidden ? " + " + String(d.hidden) + " hidden" : "") + (lst ? " + listing" : "") + RST + dot +
    fg(C.yellow) + money(d.usd, d.bill) + RST + fg(C.sub) + " in " + grp(d.sessions) + (d.sessions === 1 ? " session" : " sessions") + (d.named ? " with matching skills" : "") + RST + dot +
    fg(C.text) + kfmt(d.tok) + RST + fg(C.sub) + " tok, carry " + (d.tok > 0 ? String(Math.round((d.carry / d.tok) * 100)) : "0") + " %" + RST + dot + fg(C.sub) + "sorted by " + RST + fg(C.accent) + (SORT_NAMES[P.sort] ?? "$") + RST + fg(C.dim) + " (s)" + RST;
}

// ── advice (a): computed once per panel data for every skill, the selected row's items shown ──
function adviceFor(d: PData): Advice[] {
  const key = d.key + "|" + String(d.ver);
  if (P.advKey === key) return P.advs;
  const loads = skillLoads(d.accs, d.paths);
  const listed = new Map<string, number>(); let reqs = 0;
  for (const a of d.accs) { reqs += a.rq; for (const n of a.lst) listed.set(n, (listed.get(n) ?? 0) + 1); }
  const repos: string[] = []; for (const p of d.paths) { const s = sessions.get(p); if (s && s.cwd && repos.indexOf(s.cwd) < 0 && repos.length < 200) repos.push(s.cwd); }
  const cut = callCutoff();
  // A5's error rate from the loading session's call rows (loads carry its path)
  const calls = (sid: string, t0: number, t1: number): CallStat => {
    const s = sessions.get(sid); if (!s) return { n: 0, err: 0, kept: false };
    const r = callsOf(s); let n = 0; let e = 0;
    for (let i = 0; i < r.n; i++) { const t = r.t[i] + 0; if (t >= t0 && t < t1) { n++; if (r.err[i] + 0 > 0) e++; } }
    return { n, err: e, kept: r.n > 0 || s.mtime >= cut };
  };
  const real = skillTable(d.accs, d.ids, P.sc ? P.sc.days() : null, "cost");
  const inv: InvSkill[] = inventory(repos);
  P.advs = visAdvice(advise(real, loads, { days: Math.max(1, d.days), listed, requests: reqs }, inv, adviseCfg(), calls)); P.advKey = key;
  return P.advs;
}

// ── open / close ──
// the panel for scope sc, its cursor on the skill shown as at ("" = the first row)
export function openSkillsPanel(sc: PanelScope, at: string): void {
  P.sc = sc; P.d = null; P.sel = at; P.top = 0; P.adv = false; P.advKey = "";
  if (S.mode !== "view" || S.fview !== SP_NAME) { P.backMode = S.mode; P.backView = S.fview; }
  S.fview = SP_NAME; S.mode = "view";
}
function back(): void { S.mode = P.backMode; S.fview = P.backView; P.sc = null; P.d = null; P.advs = []; P.advKey = ""; }
function selIdx(d: PData): number { for (let i = 0; i < d.rows.length; i++) if (d.rows[i].name === P.sel) return i; return 0; }
function selRow(d: PData): SkillRow | null { const i = selIdx(d); return i < d.rows.length ? d.rows[i] : null; }

// ── drawing (also for checks: panelLines) ──
function build(W: number, Ht: number): string[] {
  const sc = P.sc; const d = data(); if (!sc || !d) return [];
  const iw = W - 4; const out: string[] = [];
  out.push(summary(d));
  if (!d.rows.length) {
    out.push("");
    out.push(fg(C.dim) + (d.named ? "no skill matches the filter in this period" : "no skill loads in this period") + " — " + (sc.keys.length ? sc.keys.map((k: string[]): string => k[0] ?? "").join("/") + " switch the period, " : "") + "esc back" + RST);
    out.push(fg(C.dim) + "skills are counted from Claude, Codex, pi, OpenCode and Gemini logs" + RST);
    return out;
  }
  out.push(" " + headLine(iw - 1)); // over the rows' cursor column
  const si = selIdx(d); const sel = d.rows[si]; P.sel = sel ? sel.name : "";
  // the advice pane takes the lower part: its lines for the selected skill
  const al: string[] = [];
  if (P.adv && sel) {
    const xs = adviceFor(d).filter((a: Advice): boolean => a.skill === sel.name);
    al.push(fg(C.line) + "─".repeat(iw) + RST);
    if (!xs.length) for (const x of wrap("no advice for " + clean(sel.name) + " in this period (thresholds: config skills.advise.*) · a closes", iw)) al.push(fg(C.dim) + x + RST);
    for (const a of xs) { const ls = adviceLines(a); for (let i = 0; i < ls.length; i++) { const col = i === 0 ? fg(C.yellow) + CSI + "1m" : ls[i]?.startsWith("   →") ? fg(C.green) : fg(C.sub); const ws = wrap(clean(ls[i] ?? ""), iw); for (let j = 0; j < ws.length; j++) al.push(col + (j > 0 ? "     " : "") + (ws[j] ?? "") + RST); } }
  }
  const room = Math.max(3, Ht - 4 - out.length - Math.min(al.length, Math.floor((Ht - 4) / 2)));
  if (si < P.top) P.top = si; else if (si >= P.top + room) P.top = si - room + 1;
  P.top = Math.max(0, Math.min(P.top, Math.max(0, d.rows.length - room)));
  P.y0 = 2 + out.length; P.n = Math.min(room, d.rows.length - P.top);
  for (let i = P.top; i < d.rows.length && i < P.top + room; i++) out.push((i === si ? fg(C.accent) + "▌" + RST : " ") + rowLine(d.rows[i], iw - 1, i === si, d.bill));
  if (al.length) { while (out.length < 2 + room) out.push(""); for (const l of al.slice(0, Math.max(0, Ht - 4 - out.length))) out.push(l); }
  return out;
}
// plain lines at W × H (goldens)
export function panelLines(W: number, Ht: number): string[] { return build(W, Ht).map((x: string): string => x.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+$/, "")); }
function render(): void {
  const sc = P.sc; if (!sc) return;
  const W = S.W; const Ht = S.H; const iw = W - 4;
  box(0, 1, W, Ht - 2, "skills", sc.label(), true);
  const ls = build(W, Ht);
  for (let r = 0; r < Ht - 4; r++) { const f = fitStyled(ls[r] ?? "", iw); put(1, 2 + r, " " + f + fillTo(f, iw) + " "); }
}

// ── keys ──
function move(d: PData, n: number): void { const i = Math.max(0, Math.min(d.rows.length - 1, selIdx(d) + n)); const r = d.rows[i]; if (r) P.sel = r.name; }
function sessionsOf(r: SkillRow): void {
  if (r.name === HIDDEN) { say("info", "hidden by skills.hide — its sessions are not listed"); return; }
  const c = { key: "skill", op: "is", vals: [r.name], neg: false, pinned: false };
  setLocal("Sessions", addClause(localFor("Sessions"), c).cs);
  back(); S.tab = 0; S.mode = "list"; S.fview = ""; S.sel = 0;
  say("info", "sessions: " + shownClause(c) + " — esc clears");
}
function viewNewest(d: PData, r: SkillRow): void {
  if (r.name === HIDDEN) { say("info", "hidden by skills.hide"); return; }
  const rows = skillLoads(d.accs, d.paths); let best: LoadRow | null = null;
  const days = P.sc ? P.sc.days() : [];
  for (const l of rows) if (skillVis(l.name).shown === r.name && (!best || l.t > best.t) && (days.length === 0 || dayIn(l.t, days))) best = l;
  if (!best) { say("info", "no load of " + r.name + " in this period"); return; }
  openSkillView(sessions.get(best.sess) ?? null, best);
}
function dayIn(t: number, days: string[]): boolean { return t > 0 && days.indexOf(dayKey(new Date(t))) >= 0; }
function key(k: string): boolean {
  const sc = P.sc; const d = data(); if (!sc || !d) return false;
  if (k === "esc" || k === "q" || k === "backspace") { if (P.adv) P.adv = false; else back(); return true; }
  const r = selRow(d); const page = Math.max(1, P.n - 1);
  if (k === "up" || k === "k" || k === "wheelup") move(d, -1);
  else if (k === "down" || k === "j" || k === "wheeldown") move(d, 1);
  else if (k === "pgup") move(d, -page);
  else if (k === "pgdn") move(d, page);
  else if (k === "home" || k === "g") move(d, -d.rows.length);
  else if (k === "end" || k === "G") move(d, d.rows.length);
  else if (k === "s") { P.sort = (P.sort + 1) % SORTS.length; P.d = null; say("info", "skills sorted by " + (SORT_NAMES[P.sort] ?? "$")); }
  else if (k === "enter") { if (r) sessionsOf(r); }
  else if (k === "a") { P.adv = !P.adv; }
  else if (k === "v") { if (r) viewNewest(d, r); }
  else if (sc.period(k)) { P.d = null; P.advKey = ""; }
  else if (k === "?") return false;
  return true;
}
H.views.push({ name: SP_NAME, render });
H.keys.push((mode: string, k: string): boolean => mode === "view" && S.fview === SP_NAME ? key(k) : false);
H.mouse.push((mode: string, b: number, x: number, y: number, press: boolean): boolean => {
  if (mode !== "view" || S.fview !== SP_NAME || y === S.H - 1) return false;
  const d = data(); if (!d) return false;
  if (b === 64 || b === 65) { move(d, b === 64 ? -3 : 3); return true; }
  if (!press || b !== 0) return false;
  const i = P.top + (y - P.y0);
  if (y >= P.y0 && y < P.y0 + P.n && i < d.rows.length) { const r = d.rows[i]; if (r && r.name === P.sel) sessionsOf(r); else if (r) P.sel = r.name; }
  return true;
});
H.footerHints.push((mode: string): string[][] => {
  if (mode !== "view" || S.fview !== SP_NAME) return [];
  const sc = P.sc; const o: string[][] = [["↑↓", "skill"], ["↵", "sessions"], ["a", P.adv ? "hide advice" : "advice"], ["v", "view skill"], ["s", "sort"]];
  return o.concat(sc ? sc.keys : [], [["esc", "back"]]);
});
H.helpSections.push({ name: "skills panel", ctx: SP_NAME, keys: [
  ["S", "Stats: skills of the period and filter · Repos: skills of the selected project"], ["↑↓ jk", "select a skill"],
  ["↵  click again", "the sessions that loaded it (Sessions tab, filter skill is <name>)"], ["a", "advice for the selected skill (carried too long, never auto-loaded, …)"],
  ["v", "view skill: the text its newest load put into the context"], ["s", "sort: $, loads, tail $, size, share, $/session"], ["d  w", "period (as the tab that opened it)"], ["esc", "back"],
  ["", "loads: / by you, ⚙ by the model, the rest re-injected after a compaction · load = its first request, carry = every later one, tail = carry after its turn"],
  ["", "share = its tokens / the input + cached tokens of the sessions that loaded it · (listing) = the names and descriptions sent with every request · ≈ size inferred, ? unknown"]] });
addActions([
  keyAction("stats.skills", "Stats", "Stats: skills panel (loads, carry, $ per skill)", "S", "S", (c: Ctx): boolean => tabNamed(c, "Stats")),
  keyAction("repos.skills", "Repos", "Repos: skills of the selected project", "S", "S", (c: Ctx): boolean => tabNamed(c, "Repos")),
]);
// fleet (features/fleet/tui.ts) and others: what the panel shows now (its rows, scope origin), for a host column or tests
export function panelState(): { open: boolean; origin: string; sel: string; sort: string; adv: boolean } { return { open: P.sc !== null, origin: P.sc ? P.sc.origin : "", sel: P.sel, sort: SORTS[P.sort] ?? "cost", adv: P.adv }; }
export function panelKey(k: string): boolean { return key(k); }
