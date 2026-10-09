// agentglass — filter language in the TUI: the / input (live parse, completion), chips, pins keys, list/process hooks (spec §7)
// SPDX-License-Identifier: Apache-2.0
import { width, vwidth, fitStyled } from "../../util/text.ts";
import { S, say } from "../../state.ts";
import { H, tabAt, display, remoteRows } from "../../hooks.ts";
import type { Proc, Sess } from "../../model/types.ts";
import { newSess } from "../../model/types.ts";
import { sessions, buildView, loadHead, SG } from "../../model/sessions.ts";
import { buildProcView } from "../../model/procs.ts";
import { ask } from "../../actions.ts";
import { TERM } from "../../term.ts";
import { C, CSI, RST, fg } from "../../ui/theme.ts";
import { harnessIds, harnessOf } from "../../harness/index.ts";
import { ledger, callsOf, MOVED, moved, LGEN, unread } from "../usage/ledger.ts";
import { L, todayKey, lastDays, heavy } from "../usage/record.ts";
import { DICT } from "../usage/facts.ts";
import { mcpServer } from "../usage/calls.ts";
import { callDays, callCutoff } from "../usage/callcache.ts";
import type { Clause } from "./types.ts";
import { parse, print, printClause, quoteVal } from "./parse.ts";
import { attrOf, keys, aliases, opsOf, enumValues, EVK } from "./attrs.ts";
import { type Ctx, type Compiled, type RowMemo, EMPTY, compile, matchSession, matchSessionMemo, sessMatches, rowsPending, beyondRetention, oldestDay, numOf } from "./eval.ts";
import { addClause, addAll, effective, localFor, setLocal, pinAll, setPins, pinsText, shownText, restoredToast, initPins, configStore, hiddenByPins, onScopeChange, pinToast } from "./scope.ts";
import { contentSet, contentKnown, contentForget } from "./content.ts";
import { repoOf, repoShown } from "./project.ts";
import { REDACT } from "../redact-on.ts";

// ── compiled filters per tab ──
const comp = new Map<string, Compiled>();
// pins ∘ local of a tab, compiled (cached per canonical text, context and day for today/yesterday)
export function tabFilter(tab: string, ctx: Ctx): Compiled {
  const eff = effective(S.pins, localFor(tab)).cs;
  return compiledOf(eff, ctx);
}
function compiledOf(cs: Clause[], ctx: Ctx): Compiled {
  if (!cs.length) return EMPTY;
  const k = print(cs) + "|" + ctx + "|" + todayKey();
  const hit = comp.get(k); if (hit) return hit;
  const r = compile(cs, ctx); const f = r.f ?? EMPTY; // pins restored from an older version may name a key no longer known
  if (comp.size > 64) comp.clear();
  comp.set(k, f); return f;
}

// ── matching session paths (list hooks, hidden count, CLI) ──
// live state and time change without a ledger tick: they are part of the cache key (and heads: cwd, branch and title of
// some harnesses come from a transcript's head, read in the background below); time in steps of step ms (timeStep)
function liveSig(step: number): string { let p = 0; let a = 0; let h = 0; for (const s of sessions.values()) { if (s.pid) p += s.pid; if (s.attention || s.stuck) a++; if (s.headDone) h++; } return String(p) + "/" + String(a) + "/" + String(h) + "/" + String(sessions.size) + "/" + String(step) + ":" + String(Math.floor(Date.now() / step)); }
// how often matches can change with time alone: a minute (the call rows' retention cutoff, day keys); an age clause
// sooner, by 1/60 of its duration (age < 30s: each second, age < 5m: every 5 s), never below a second (a frame's cadence)
export function timeStep(cs: Clause[]): number {
  let ms = 60000;
  for (const c of cs) {
    const a = attrOf(c.key); if (!a || a.key !== "age") continue;
    for (const v of c.vals) { const x = numOf("dur", v); if (x > 0) ms = Math.min(ms, Math.max(1000, Math.round(x / 60))); }
  }
  return ms;
}
// a clause on these needs every session's head (the list reads heads only for visible rows)
const HEADKEYS = ["repo", "worktree", "project.kind", "cwd", "branch", "title", "text", "agent", "model"];
function needsHeads(f: Compiled): boolean { for (const c of f.cs) if (HEADKEYS.indexOf(c.key) >= 0) return true; return false; }
let headsLeft = 0;
// ≤ 100 ms of head reads per tick while the Sessions filter needs them (the ledger's indexing slice); the list fills in as
// they arrive. Pending reads count as backlog: the tick runs at the indexing burst cadence instead of its stretched idle one
// (a restored repo pin would otherwise match nothing for minutes). While a filter is being typed only ≤ 12 ms: a key must
// never wait behind a 100 ms batch of head reads (#19)
H.onTick.push(() => {
  const f = tabFilter("Sessions", "list"); headsLeft = 0;
  if (f === EMPTY || !needsHeads(f)) return;
  const t0 = Date.now(); let read = 0; const slice = S.mode === "input" ? 12 : 100;
  for (const s of sessions.values()) { if (s.headDone) continue; if (Date.now() - t0 < slice) { loadHead(s); read++; } else headsLeft++; }
  if (read) S.dirty = true;
});
H.backlog.push(() => headsLeft > 0);
interface MP { key: string; paths: Set<string>; base: string; pos: number } // base: what a ledger move leaves; pos: MOVED.log read up to
const mp = new Map<string, MP>();
// per filter: each session's row verdict (eval.ts matchSessionMemo); a few filters at most are active at once
interface Memo { m: Map<string, RowMemo> } // scriptc: no Map as a Map value
const memos = new Map<string, Memo>();
function memoOf(k: string): Map<string, RowMemo> { let x = memos.get(k); if (!x) { if (memos.size > 8) memos.clear(); x = { m: new Map<string, RowMemo>() }; memos.set(k, x); } return x.m; }
let searchOk = true; // false while typing: a content clause never starts a search (enter does)
export const MPS = { asks: 0, sets: 0 }; // sets: a match set was made or changed (counts beside the list key on it) // matchingPaths calls (checks: a pass over sessions asks once, not per session — each ask walks them all)
// The Sessions list's call-row filter never blocks a frame (a pinned `tool is Bash` read every calls file before the first
// one): sessions whose calls file this run has not read yet are left out for now and read on the tick in ≤ 50 ms slices,
// newest first; each slice moves L.ver, so the list re-matches and fills in. Until all are read the box says
// "filtering n/m" and an empty list says so instead of "no sessions match". One-shot runs and other callers read at once.
const FILL = { on: false, fkey: "", total: 0, queue: [] as string[] };
function filling(): boolean { return FILL.on || TERM.tui; } // the TUI (from its first frame on) or a check
// the list's filter changed to one without call rows (or none): stop reading rows nobody asked for
function fillStop(): void { if (FILL.queue.length) FILL.queue = []; FILL.fkey = ""; FILL.total = 0; }
export function fillOnForTest(on: boolean): void { FILL.on = on; FILL.fkey = ""; FILL.queue = []; }
// The Stats and Repos aggregates of a call-row filter defer the same way: a pass leaves out the sessions whose rows are
// unread (eval.ts eachCall's later), queues them here per tab, newest first, and says "filtering n/m" until they are in;
// each slice moves L.ver, so the tab's cached aggregate is made again and its numbers settle at the eager ones
interface RF { key: string; total: number; left: number; queue: string[] }
const RFILL = new Map<string, RF>();
// the list to pass as eachCall's later: null = read at once (one-shot runs, checks without the fill, no row clauses)
export function rowsLater(f: Compiled): Sess[] | null { return filling() && (f.call.length > 0 || f.rowx.length > 0) ? [] : null; }
// after a pass of tab's aggregate (key: its cache key — the filter and the period): what it deferred is queued, n/m kept
export function rowsDeferred(tab: string, key: string, later: Sess[] | null): void {
  let r = RFILL.get(tab);
  if (!later || !later.length) { if (r) { r.queue = []; r.left = 0; r.total = 0; r.key = key; } return; }
  if (!r) { r = { key: "", total: 0, left: 0, queue: [] }; RFILL.set(tab, r); }
  later.sort((x: Sess, y: Sess) => x.mtime - y.mtime); // popped from the end: newest first
  const q: string[] = []; for (const s of later) q.push(s.path);
  if (r.key !== key) { r.key = key; r.total = q.length; } else r.total = Math.max(r.total, q.length);
  r.queue = q; r.left = q.length;
}
// tab's progress for the aggregate of key ({0, 0} = complete)
export function rowsFill(tab: string, key: string): { left: number; total: number } {
  const r = RFILL.get(tab); return r && r.key === key && r.left > 0 ? { left: r.left, total: r.total } : { left: 0, total: 0 };
}
function rowQueued(): boolean { for (const r of RFILL.values()) if (r.queue.length) return true; return false; }
// one slice of reads (the Sessions list's fill first, then the tabs'); true when it read something
export function fillStep(ms: number): boolean {
  if (!FILL.queue.length && !rowQueued()) return false;
  const t0 = Date.now(); let n = 0;
  const more = (): boolean => n === 0 || Date.now() - t0 < ms;
  while (FILL.queue.length && more()) { const p = FILL.queue.pop() ?? ""; const s = sessions.get(p); if (s) { callsOf(s); moved(p); n++; } }
  for (const r of RFILL.values()) while (r.queue.length && more()) {
    const p = r.queue.pop() ?? ""; const s = sessions.get(p); if (!s || !unread.has(p)) continue; // read since (the list's fill)
    callsOf(s); moved(p); n++;
  }
  if (n) { L.ver++; S.dirty = true; }
  return n > 0;
}
H.onTick.push(() => { fillStep(50); });
H.backlog.push(() => FILL.queue.length > 0 || rowQueued()); // the tick keeps its burst cadence while a filter fills in
export function fillState(f: Compiled): { left: number; total: number } { return f.key === FILL.fkey ? { left: FILL.queue.length, total: FILL.total } : { left: 0, total: 0 }; }
// the box subtitle's progress, the same in every tab: " · filtering n/m" ("" = complete)
export function fillChip(st: { left: number; total: number }): string { return st.left > 0 ? fg(C.yellow) + " · filtering " + String(st.total - st.left) + "/" + String(st.total) + RST : ""; }
// an empty list or table while rows are still being read says so instead of "nothing matches"
export function fillEmpty(st: { left: number; total: number }): string { return st.left > 0 ? "filtering… " + String(st.total - st.left) + "/" + String(st.total) + " — matches appear as call rows are read" : ""; }
// lazy: "" reads what it needs now; "list" (the Sessions list's own filter) defers unread rows and owns the "filtering"
// progress; "defer" defers the same way without it (counts beside the list: pins hide n, which settle as the rows arrive)
export function matchingPaths(f: Compiled, lazy = ""): Set<string> {
  MPS.asks++;
  const defer = lazy !== "" && filling() && (f.call.length > 0 || f.rowx.length > 0);
  const live = liveSig(timeStep(f.cs)) + "|" + String(callCutoff()); // the cut: midnight or a retention change
  const key = String(L.ver) + "|" + live;
  // a list fill of another filter ran or stopped since: this one's deferred sessions must be queued again
  const own = !(defer && lazy === "list" && FILL.fkey !== f.key);
  const mk = f.key + (defer ? "\u0000" + lazy : ""); const hit = mp.get(mk); if (hit && hit.key === key && own) return hit.paths;
  // a ledger move re-checks only the sessions that moved (call/day clauses alone: no session clause can change without
  // the ledger, the time and live parts are in base); the result equals a full re-match (eval.check / ui.check)
  const base = live + "|" + String(SG.gen) + "|" + String(MOVED.gen) + "|" + String(LGEN.reapply);
  if (hit && own && hit.base === base && !f.sess.length && !f.content.length && hit.pos <= MOVED.log.length) {
    const memo = memoOf(f.key);
    for (let i = hit.pos; i < MOVED.log.length; i++) {
      const s = sessions.get(MOVED.log[i] ?? ""); if (!s) continue;
      const was = hit.paths.has(s.path);
      const now = !(defer && rowsPending(f, s)) && matchSessionMemo(f, s, memo); // pending: still queued for the fill
      if (now !== was) { if (now) hit.paths.add(s.path); else hit.paths.delete(s.path); MPS.sets++; }
    }
    hit.pos = MOVED.log.length; hit.key = key;
    return hit.paths;
  }
  const out = new Set<string>(); const later: Sess[] = [];
  for (const s of sessions.values()) {
    // a model clause reads rows already in the session test: defer before it; other session clauses are cheap
    if (defer && rowsPending(f, s) && (f.rowx.length > 0 || sessMatches(f, s))) { later.push(s); continue; }
    if (matchSessionMemo(f, s, memoOf(f.key))) out.add(s.path);
  }
  if (lazy === "list" && !defer) fillStop(); // the list's filter no longer reads rows: the rest of an earlier fill is moot
  if (defer && lazy === "list") {
    later.sort((x: Sess, y: Sess) => x.mtime - y.mtime); // popped from the end: newest first
    const q: string[] = []; for (const s of later) q.push(s.path);
    if (f.key !== FILL.fkey) { FILL.fkey = f.key; FILL.total = q.length; } else FILL.total = Math.max(FILL.total, q.length);
    FILL.queue = q;
  }
  for (const c of f.content) {
    const q = c.vals[0] ?? "";
    if (!searchOk && !contentKnown(q)) continue;
    const cands = out.size <= 200 ? [...out] : null;
    const r = contentSet(q, cands);
    if (r.timedOut) { say("warn", "full-text search timed out after 30 s — content clause matches nothing"); out.clear(); break; }
    const neg = c.op === "!~";
    for (const p of [...out]) if (r.paths.has(p) === neg) out.delete(p);
  }
  if (mp.size > 32) mp.clear();
  mp.set(mk, { key, paths: out, base, pos: MOVED.log.length }); MPS.sets++;
  return out;
}
// does a session path pass f's content (full-text) clauses? Made once per pass over sessions or calls, asked per item
// (lazy "defer": rows unread in the TUI are left out, for aggregates that defer them too)
export function contentOk(f: Compiled, lazy = ""): (path: string) => boolean {
  if (!f.content.length) return (_p: string): boolean => true;
  const m = matchingPaths(f, lazy); return (p: string): boolean => m.has(p);
}
// top-level rows a clause list leaves (a parent stays when a subagent matches)
function countTop(cs: Clause[]): number {
  const f = compiledOf(cs, "list"); const m = matchingPaths(f, "defer"); let n = 0;
  for (const s of sessions.values()) {
    if (s.depth !== 0) continue;
    if (!cs.length || m.has(s.path)) { n++; continue; }
    for (const c of s.subs) if (m.has(c.path)) { n++; break; }
  }
  return n;
}
let hidKey = ""; let hidN = 0;
export function hiddenCount(tab: string): number {
  if (!S.pins.length) return 0;
  // the sets first (after a ledger move only the moved sessions are re-checked); the count is redone only when a set
  // changed, not on every ledger move
  const loc = localFor(tab); const eff = effective(S.pins, loc).cs;
  if (loc.length) matchingPaths(compiledOf(loc, "list"), "defer");
  if (eff.length) matchingPaths(compiledOf(eff, "list"), "defer");
  const k = print(S.pins) + "|" + print(loc) + "|" + String(MPS.sets) + "|" + String(SG.gen) + "|" + liveSig(Math.min(timeStep(S.pins), timeStep(loc)));
  if (k !== hidKey) { hidKey = k; hidN = hiddenByPins(tab, countTop); }
  return hidN;
}

// ── chips ──
function chipOf(c: Clause, style: string): string {
  const vs: string[] = []; for (const v of c.vals) vs.push(display("filter:" + c.key, v, null));
  return style + printClause({ key: c.key, op: c.op, vals: vs, neg: c.neg, pinned: c.pinned }) + RST;
}
// the effective filter as styled chips within w columns: pinned ⚲ in the accent color, local plain, overridden pins struck,
// clauses that do not apply in this tab dim; "… +N" when they do not fit
export function chips(tab: string, ctx: Ctx, w: number): string {
  const loc = ctx === "procs" ? [] : localFor(tab);
  const eff = effective(S.pins, loc); const f = compiledOf(eff.cs, ctx);
  const parts: string[] = [];
  for (const c of eff.struck) parts.push(chipOf(c, fg(C.dim) + CSI + "9m" + "⚲ "));
  for (const c of eff.cs) {
    const dim = f.dimmed.indexOf(c) >= 0;
    parts.push(chipOf(c, dim ? fg(C.dim) + (c.pinned ? "⚲ " : "") : c.pinned ? fg(C.accent) + "⚲ " : fg(C.text)));
  }
  let out = ""; let shown = 0; const sep = fg(C.dim) + " · " + RST;
  for (let i = 0; i < parts.length; i++) {
    const next = (out ? out + sep : "") + (parts[i] ?? "");
    if (vwidth(next) + (i < parts.length - 1 ? 9 : 0) > w) break; // room for " · … +N"
    out = next; shown++;
  }
  if (shown === 0 && parts.length) { // not even one chip fits: cut the first one, so the bar never shows only "… +N"
    const more = parts.length > 1 ? fg(C.dim) + " +" + String(parts.length - 1) + RST : "";
    return fitStyled(parts[0] ?? "", Math.max(4, w - vwidth(more))) + more;
  }
  if (shown < parts.length) out += (out ? sep : "") + fg(C.dim) + "… +" + String(parts.length - shown) + RST;
  return out;
}

// ── the / input ──
let editTab = ""; let before: Clause[] = [];
function tabName(): string { if (S.tab === 0) return "Sessions"; const t = tabAt(S.tab - 2); return t ? t.name : ""; }
function ctxOf(tab: string): Ctx { return tab === "Sessions" ? "list" : "stats"; }
export function openFilterInput(tab: string): void {
  editTab = tab; before = localFor(tab); S.inputErr = ""; cyc.cands = [];
  ask("filter " + tab.toLowerCase(), "query", print(before));
}
function changed(): void { S.sel = 0; buildView(); S.dirty = true; }
// a typed expression → its clauses, or the error to show; typing never starts a full-text search
function check(text: string, typing: boolean): { cs: Clause[]; err: string } {
  const p = parse(text); S.inputErrCol = p.err ? p.err.col : -1; // the footer marks it (the caret of the CLI)
  if (p.err) return { cs: [], err: p.err.msg + (p.err.col > 0 ? " (column " + String(p.err.col + 1) + ")" : "") };
  const r = compile(effective(S.pins, p.cs).cs, ctxOf(editTab));
  if (r.err) return { cs: [], err: r.err.msg };
  if (typing) for (const c of p.cs) if (c.key === "content" && !contentKnown(c.vals[0] ?? "")) return { cs: [], err: "↵ runs the full-text search" };
  return { cs: p.cs, err: "" };
}
// typing "too", "tool" or "tool " is the start of a clause, not a text search, and "an" after a filter the start of
// "and": the last valid filter stays until it parses
function startsClause(text: string, cs: Clause[]): boolean {
  const last = cs.length ? cs[cs.length - 1] : null;
  if (!last || last.key !== "text" || last.op !== "~") return false;
  const w = (last.vals.join(" ")).toLowerCase(); const tail = text.trimEnd();
  if (!w || !tail.toLowerCase().endsWith(w) || tail.endsWith("\"")) return false;
  if (cs.length > 1 && "and".startsWith(w)) return true;
  for (const k of keys().concat(aliases())) if (k.startsWith(w)) return true;
  return false;
}
// while typing: a filter over call rows (tens of ms on a large ledger) applies once the keys pause, others at once
let typedGen = 0;
function applyTyped(tab: string, cs: Clause[]): void {
  const g = ++typedGen;
  const now = (): void => { if (g !== typedGen || S.mode !== "input") return; searchOk = false; setLocal(tab, cs); searchOk = true; };
  if (compiledOf(effective(S.pins, cs).cs, ctxOf(tab)).needsCalls) setTimeout(now, 120); else now();
}
function onQuery(ev: string, text: string): boolean {
  if (ev === "change" && !completing) cyc.cands = [];
  if (ev === "change") {
    const r = check(text, true); S.inputErr = r.err;
    if (!r.err && !startsClause(text, r.cs)) applyTyped(editTab, r.cs);
    return false;
  }
  if (ev === "esc") { typedGen++; S.inputErr = ""; S.inputErrCol = -1; setLocal(editTab, before); return false; }
  if (ev === "enter") {
    typedGen++;
    const r = check(text, false);
    if (r.err) { S.inputErr = r.err; return true; }
    for (const c of r.cs) if (c.key === "content") contentForget(c.vals[0] ?? "");
    const m = addAll([], r.cs);
    S.inputErr = ""; setLocal(editTab, m.cs);
    if (m.notes.length) say("info", m.notes.join(" · "));
    return false;
  }
  if (ev === "tab") { tabComplete(); return false; }
  return false;
}
function onPins(ev: string, text: string): boolean {
  if (ev === "change" && !completing) cyc.cands = [];
  if (ev === "change") { const p = parse(text); S.inputErr = p.err ? p.err.msg : ""; S.inputErrCol = p.err ? p.err.col : -1; return false; }
  if (ev === "enter") {
    const e = setPins(text);
    if (e) { S.inputErr = e.msg; S.inputErrCol = e.col; return true; }
    S.inputErr = ""; pinToast(S.pins.length ? "pinned: " + shownText(S.pins, " and ") : "pins cleared");
    return false;
  }
  if (ev === "tab") { tabComplete(); return false; }
  S.inputErr = ""; return false;
}
function onContent(ev: string, text: string): boolean {
  if (ev !== "enter") return false;
  const q = text.trim(); const tab = editTab || "Sessions";
  const rest: Clause[] = []; for (const c of localFor(tab)) if (c.key !== "content") rest.push(c);
  if (!q) { setLocal(tab, rest); return false; }
  contentForget(q);
  setLocal(tab, addClause(rest, { key: "content", op: "~", vals: [q], neg: false, pinned: false }).cs);
  let n = 0; const m = matchingPaths(tabFilter(tab, ctxOf(tab))); for (const s of sessions.values()) if (m.has(s.path)) n++;
  say("info", String(n) + " sessions contain “" + q + "”");
  return false;
}
H.input.push((action: string, ev: string, text: string): boolean => {
  if (action === "query") return onQuery(ev, text);
  if (action === "pins") return onPins(ev, text);
  if (action === "content") return onContent(ev, text);
  return false;
});

// ── completion ──
// most frequent values of a text attribute in the data (≤ 20), cached per ledger version
const freq = new Map<string, { ver: number; vals: string[] }>();
function bump(m: Map<string, number>, k: string, n: number): void { if (k) m.set(k, (m.get(k) ?? 0) + n); }
function topOf(m: Map<string, number>): string[] { return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 20).map((e) => e[0]); }
function frequent(key: string): string[] {
  const hit = freq.get(key); if (hit && hit.ver === L.ver) return hit.vals;
  const m = new Map<string, number>();
  if (key === "tool" || key === "server" || key === "program" || key === "ext") {
    for (const a of ledger.values()) for (const d of a.days.values()) {
      if (key === "tool") { for (const [n, st] of heavy(d).tt) if (!REDACT || display("tool", n, null) === n) bump(m, n, st.n); } // --redact: a tool named after a custom agent is not offered
      else if (key === "server") for (const [n, st] of heavy(d).tt) bump(m, mcpServer(n), st.n);
      else if (key === "program") for (const [k, c] of heavy(d).prog) bump(m, REDACT ? display("prog", k.slice(k.indexOf("\t") + 1), null) : k.slice(k.indexOf("\t") + 1), c.n); // --redact: the shown fakes, never a real name
      else for (const k of heavy(d).files.keys()) { const p = k.slice(k.indexOf("\t") + 1); const b = p.slice(p.lastIndexOf("/") + 1); const i = b.lastIndexOf("."); if (i > 0) bump(m, b.slice(i + 1).toLowerCase(), 1); }
    }
  } else if (key === "model") { for (const n of DICT.model.names) bump(m, n, 1); for (const s of sessions.values()) bump(m, s.model, 1); }
  else if (key === "session") { for (const s of sessions.values()) if (!s.parent) bump(m, s.h + ":" + s.id, Math.max(s.last, s.mtime)); } // newest first
  // --redact: the shown (fake) repo labels and branches, which match their own sessions too: no real name on the input line
  else for (const s of sessions.values()) bump(m, key === "repo" ? (REDACT ? repoShown(s) : repoOf(s)) : key === "branch" ? s.branch : key === "agent" ? s.kind : "", 1);
  const vals = topOf(m); freq.set(key, { ver: L.ver, vals });
  return vals;
}
function valuesOf(k: string): string[] {
  const a = attrOf(k); if (!a) return [];
  if (a.type === "enum") return enumValues(a);
  if (a.type === "bool") return ["true", "false"];
  if (a.type === "date") return ["today", "yesterday", "-7d", "-30d"];
  if (a.key === "mcp.server" || a.key === "shell.family") { const v = EVK.values(a.key); return v.length || a.key === "shell.family" ? v : frequent("server"); }
  if (a.type === "text" || a.type === "path") return frequent(a.key);
  return a.type === "usd" || a.type === "dur" ? ["unknown"] : [];
}
const OPW = ["is", "is_not", "is_one_of", "is_not_one_of", "~", "!~", ">", ">=", "<", "<=", "=", "!="];
function isOp(w: string): boolean { return OPW.indexOf(w.toLowerCase()) >= 0; }
// words of the text (the cursor is at its end); the last one is "" after a blank
function words(text: string): string[] { return text.split(/\s+/); }
function keyList(): string[] { const all = keys().concat(aliases()); return all.slice().sort((a, b) => a.length - b.length || all.indexOf(a) - all.indexOf(b)); }
function candidates(before: string[]): string[] {
  const n = before.length; if (!n) return keyList();
  const last = before[n - 1] ?? ""; const prev = n >= 2 ? before[n - 2] ?? "" : "";
  if (isOp(last) && attrOf(prev)) return valuesOf(prev).map(quoteVal);           // key op ▏ → values
  const la = attrOf(last); if (la && !isOp(prev)) return opsOf(la);               // key ▏ → its operators
  for (let j = n - 1; j >= 1; j--) {                                               // inside an is_one_of list → more values
    const t = (before[j] ?? "").toLowerCase();
    if (t === "and") break;
    if (t.endsWith("one_of") && attrOf(before[j - 1] ?? "")) { const had = before.slice(j + 1); return valuesOf(before[j - 1] ?? "").map(quoteVal).filter((v: string) => had.indexOf(v) < 0); }
    if (isOp(t)) break;
  }
  return keyList();
}
// tab candidates for the word being typed: keys, then the key's operators, then values; commas split words as blanks do
// (harness is_one_of claude,c → claude,codex), the part before the word's last comma stays
export function complete(text: string, cursorAtEnd: boolean): string[] {
  if (!cursorAtEnd) return [];
  const w = words(text); const last = w[w.length - 1] ?? ""; const k = last.lastIndexOf(",");
  const pre = last.slice(0, k + 1); const cur = last.slice(k + 1).toLowerCase();
  const before: string[] = []; for (const x of w.slice(0, -1).concat([pre])) for (const p of x.split(",")) if (p) before.push(p);
  // after a comma both readings stay open (pi, codex = one more value; pi, cost > 2 = a new clause): values, then keys
  const comma = k >= 0 || (w[w.length - 2] ?? "").endsWith(",");
  const cs = comma ? candidates(before).concat(keyList()) : candidates(before);
  const out: string[] = []; for (const c of cs) if (c.toLowerCase().startsWith(cur) && out.indexOf(pre + c) < 0) out.push(pre + c);
  return out;
}
// repeated tab cycles through the candidates of the word the first tab completed (every filter input shares this)
export interface Cyc { base: string; cands: string[]; i: number; last: string }
export function newCyc(): Cyc { return { base: "", cands: [], i: 0, last: "" }; }
// the text after a tab on t, "" when nothing completes; a unique completion does not cycle: tab goes on to the next word
export function cycleNext(c: Cyc, t: string): string {
  if (c.cands.length > 1 && t === c.last) c.i = (c.i + 1) % c.cands.length;
  else {
    const cands = complete(t, true); if (!cands.length) return "";
    const w = words(t); const cur: string = w[w.length - 1] ?? "";
    c.base = t.slice(0, t.length - cur.length); c.cands = cands; c.i = 0;
  }
  c.last = c.base + (c.cands[c.i] ?? "") + " ";
  return c.last;
}
// a filter input's error text ("" = valid, empty = `empty`), its parse error's column into S.inputErrCol (the footer
// marks it, the CLI's caret)
export function exprErr(t: string, ctx: Ctx, empty: string): string {
  S.inputErrCol = -1;
  if (!t.trim()) return empty;
  const p = parse(t); if (p.err) { S.inputErrCol = p.err.col; return p.err.msg; }
  const c = compile(p.cs, ctx); return c.err ? c.err.msg : "";
}
const cyc = newCyc();
let completing = false; // a change made by tab itself keeps the cycle; any other edit starts over
function tabComplete(): void {
  const next = cycleNext(cyc, S.inputText); if (!next) return;
  S.inputText = next;
  completing = true; for (const f of H.input) f(S.inputAction, "change", next); completing = false;
}

// ── keys ──
function cycleHarness(tab: string): void {
  for (const p of S.pins) if (p.key === "harness" && (p.op === "is" || p.op === "is_one_of")) { say("info", "harness is pinned — P edits pins"); }
  const loc = localFor(tab); let cur = ""; const rest: Clause[] = [];
  for (const c of loc) { if (c.key === "harness" && c.op === "is" && c.vals.length === 1) cur = c.vals[0] ?? ""; else rest.push(c); }
  const ids = [""].concat(harnessIds()); const next = ids[(ids.indexOf(cur) + 1) % ids.length] ?? "";
  if (next) rest.push({ key: "harness", op: "is", vals: [next], neg: false, pinned: false });
  setLocal(tab, rest);
  say("info", next ? "harness: " + harnessOf(next).label : "all harnesses");
}
function toggleLive(tab: string): void {
  const loc = localFor(tab); const rest: Clause[] = []; let had = false;
  for (const c of loc) { if (c.key === "live" && c.op === "is" && (c.vals[0] ?? "") === "true") had = true; else rest.push(c); }
  if (!had) rest.push({ key: "live", op: "is", vals: ["true"], neg: false, pinned: false });
  setLocal(tab, rest);
}
function contentQuery(tab: string): string { for (const c of localFor(tab)) if (c.key === "content" && c.op === "~") return c.vals.join(" "); return ""; }
H.keys.push((mode: string, k: string): boolean => {
  if (mode !== "list") return false;
  const tab = tabName();
  if (k === "P" && (S.tab <= 1 || tab === "Stats" || tab === "Repos" || tab === "Wait")) { S.inputErr = ""; editTab = tab; cyc.cands = []; ask("pins (all tabs)", "pins", pinsText()); return true; }
  if (tab === "Stats" || tab === "Repos" || tab === "Wait") { // Wait: its footer and help always offered / p P
    if (k === "/") { openFilterInput(tab); return true; }
    if (k === "p") { pinToast(pinAll(tab)); return true; }
    return false;
  }
  if (S.tab !== 0) return false;
  if (k === "/") { openFilterInput("Sessions"); return true; }
  if (k === "F") { editTab = "Sessions"; ask("full-text", "content", contentQuery("Sessions")); return true; }
  if (k === "h") { cycleHarness("Sessions"); return true; }
  if (k === "l") { toggleLive("Sessions"); return true; }
  if (k === "p") { pinToast(pinAll("Sessions")); return true; }
  if (k === "esc") { if (localFor("Sessions").length) { setLocal("Sessions", []); if (S.pins.length) say("info", "filter cleared — pins stay (P edits pins)"); } return true; }
  return false;
});

// ── hooks into the list and the process table ──
// fleet: a remote row is matched on its own (session clauses; it has no calls, days or content here) — once per filter a
// toast says so when such a clause hides the remote rows
const RT = { told: "" };
function remoteMatch(f: Compiled, s: Sess): boolean { return !f.content.length && matchSession(f, s, null); }
H.listFilter.push(() => {
  const f = tabFilter("Sessions", "list"); if (f === EMPTY) { fillStop(); return null; }
  const m = matchingPaths(f, "list");
  if ((f.call.length || f.day.length || f.rowx.length || f.content.length) && RT.told !== f.key && remoteRows().length) { RT.told = f.key; say("info", "remote rows have no calls/days: this filter hides them"); }
  return (s: Sess): boolean => s.host ? remoteMatch(f, s) : m.has(s.path);
});
H.procFilter.push((p: Proc): boolean => {
  if (!S.pins.length) return true;
  const f = compiledOf(S.pins, "procs"); if (f === EMPTY) return true;
  const s = newSess(p.h, "", "", false); s.cwd = p.cwd; s.pid = p.pid; // a process is a session with only these four attributes
  return matchSession(f, s, null);
});
onScopeChange(() => { changed(); buildProcView(); });
H.boxChips.push((where: string, w: number): string => {
  if (where === "processes") return chips("Processes", "procs", w);
  if (where !== "sessions") return "";
  const f = tabFilter("Sessions", "list"); if (f === EMPTY) return "";
  // while the rows fill in, "pins hide n" would count the unread sessions as hidden: it shows once the fill is done
  const fl = fillState(f); const hid = fl.left > 0 ? 0 : hiddenCount("Sessions"); const all: string[] = []; const cc = callsChip(f, all);
  const tail = fillChip(fl) + (headsLeft > 0 ? fg(C.dim) + " · reading " + String(headsLeft) + RST : "") + (hid > 0 ? fg(C.yellow) + " · pins hide " + String(hid) + RST : "") + (cc ? " " + cc : "");
  return chips("Sessions", "list", Math.max(8, w - vwidth(tail))) + tail;
});
H.emptyText.push((where: string): string => {
  if (where !== "sessions" || tabFilter("Sessions", "list") === EMPTY) return "";
  const fl = fillState(tabFilter("Sessions", "list"));
  if (fl.left > 0) return fg(C.yellow) + fillEmpty(fl) + RST;
  const hid = hiddenCount("Sessions");
  return fg(C.sub) + "no sessions match" + (hid > 0 ? " — " + String(hid) + " hidden by pins (P edits)" : localFor("Sessions").length ? " — esc clears the filter" : "") + RST;
});

// ── help ──
function wrapKeys(n: number): string[][] {
  const rows: string[][] = []; let line = "";
  for (const k of keys()) { if (line && width(line) + 1 + width(k) > n) { rows.push([rows.length ? "" : "keys", line]); line = ""; } line += (line ? " " : "") + k; }
  if (line) rows.push([rows.length ? "" : "keys", line]);
  return rows;
}
H.helpSections.push({ name: "filter  (/ on Sessions and Stats; the same grammar as --filter)", ctx: "sessions", keys: [
  ["key op value", "repo is agentglass · tool is_one_of Bash Edit · cost > 2 · model ~ opus"],
  ["operators", "is =  is_not !=  is_one_of  is_not_one_of  ~ (contains)  !~  >  >=  <  <="],
  ["and  ,  not  -", "terms AND; not / - negates; bare words match title, path, id, harness"],
  ["values", "$0.50  40k  1.5M  100KB  500ms  30s  2m  1h  3d  20%  today  yesterday  -7d  mo…su  unknown"],
  ["tab", "complete key, operator, value (again: next candidate)"],
  ["↵  esc", "apply (invalid input stays open) · cancel, restoring the previous filter"],
  ["p", "pin this tab's filter: it applies on every tab and is remembered"],
  ["P", "edit the pins (empty + ↵ unpins); config filter.remember: false forgets them"],
  ["h  l  F", "harness is … (cycle) · live is true (toggle) · content ~ \"…\" (full-text)"],
  ["esc (list)", "clear this tab's filter; pins stay"],
  ["filtering n/m", "call rows read in the background; matches fill in"],
].concat(wrapKeys(64)) });

// ── restored pins: announced on start so they never look like missing sessions; the info toast is built then, not
// here: --redact's display hooks (they mask pinned values) may register after this module ──
const startToast = initPins(configStore());
if (startToast.startsWith("saved")) { say("warn", startToast); S.toastMs = 6000; }
else if (startToast) H.start.push(() => { say("info", restoredToast()); S.toastMs = 6000; });
// "calls ≤ 90 d" while call clauses are active and the counted days (period: the view's, [] = all history) reach
// before the oldest day that keeps call rows: those are kept that long, day buckets forever
export function callsChip(f: Compiled, period: string[]): string {
  if (!f.needsCalls) return "";
  const keep: string[] = lastDays(callDays()); const cut: string = keep.length ? keep[0] : "";
  if (!beyondRetention(f.dayKeys, period, oldestDay(f), cut)) return "";
  return fg(C.dim) + "calls ≤ " + String(callDays()) + " d" + RST;
}
