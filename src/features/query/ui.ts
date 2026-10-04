// agentglass — filter language in the TUI: the / input (live parse, completion), chips, pins keys, list/process hooks (spec §7)
// SPDX-License-Identifier: Apache-2.0
import { width, vwidth, fitStyled } from "../../util/text.ts";
import { S, say } from "../../state.ts";
import { H, tabAt, display } from "../../hooks.ts";
import type { Proc } from "../../model/types.ts";
import { newSess } from "../../model/types.ts";
import { sessions, buildView, loadHead } from "../../model/sessions.ts";
import { buildProcView } from "../../model/procs.ts";
import { ask } from "../../actions.ts";
import { C, CSI, RST, fg } from "../../ui/theme.ts";
import { harnessIds, harnessOf } from "../../harness/index.ts";
import { ledger } from "../usage/ledger.ts";
import { L, todayKey } from "../usage/record.ts";
import { DICT } from "../usage/facts.ts";
import { mcpServer } from "../usage/calls.ts";
import { callDays } from "../usage/callcache.ts";
import type { Clause } from "./types.ts";
import { parse, print, printClause, quoteVal } from "./parse.ts";
import { attrOf, keys, aliases, opsOf, enumValues } from "./attrs.ts";
import { type Ctx, type Compiled, EMPTY, compile, matchSession } from "./eval.ts";
import { addClause, addAll, effective, localFor, setLocal, pinAll, setPins, initPins, configStore, hiddenByPins, onScopeChange } from "./scope.ts";
import { contentSet, contentKnown, contentForget } from "./content.ts";
import { repoOf } from "./project.ts";

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
// live state and age change without a ledger tick: they are part of the cache key
// (and heads: cwd, branch and title of some harnesses come from a transcript's head, read in the background below)
function liveSig(): string { let p = 0; let a = 0; let h = 0; for (const s of sessions.values()) { if (s.pid) p += s.pid; if (s.attention || s.stuck) a++; if (s.headDone) h++; } return String(p) + "/" + String(a) + "/" + String(h) + "/" + String(sessions.size) + "/" + String(Math.floor(Date.now() / 60000)); }
// a clause on these needs every session's head (the list reads heads only for visible rows)
const HEADKEYS = ["repo", "worktree", "project.kind", "cwd", "branch", "title", "text", "agent", "model"];
function needsHeads(f: Compiled): boolean { for (const c of f.cs) if (HEADKEYS.indexOf(c.key) >= 0) return true; return false; }
let headsLeft = 0;
// ≤ 100 ms of head reads per tick while the Sessions filter needs them (the ledger's indexing slice); the list fills in as
// they arrive. Pending reads count as backlog: the tick runs at the indexing burst cadence instead of its stretched idle one
// (a restored repo pin would otherwise match nothing for minutes)
H.onTick.push(() => {
  const f = tabFilter("Sessions", "list"); headsLeft = 0;
  if (f === EMPTY || !needsHeads(f)) return;
  const t0 = Date.now(); let read = 0;
  for (const s of sessions.values()) { if (s.headDone) continue; if (Date.now() - t0 < 100) { loadHead(s); read++; } else headsLeft++; }
  if (read) S.dirty = true;
});
H.backlog.push(() => headsLeft > 0);
interface MP { key: string; paths: Set<string> }
const mp = new Map<string, MP>();
let searchOk = true; // false while typing: a content clause never starts a search (enter does)
export function matchingPaths(f: Compiled): Set<string> {
  const key = String(L.ver) + "|" + liveSig();
  const hit = mp.get(f.key); if (hit && hit.key === key) return hit.paths;
  const out = new Set<string>();
  for (const s of sessions.values()) if (matchSession(f, s, null)) out.add(s.path);
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
  mp.set(f.key, { key, paths: out });
  return out;
}
// top-level rows a clause list leaves (a parent stays when a subagent matches)
function countTop(cs: Clause[]): number {
  const f = compiledOf(cs, "list"); const m = matchingPaths(f); let n = 0;
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
  const k = print(S.pins) + "|" + print(localFor(tab)) + "|" + String(L.ver) + "|" + liveSig();
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
  const p = parse(text);
  if (p.err) return { cs: [], err: p.err.msg + (p.err.col > 0 ? " (column " + String(p.err.col + 1) + ")" : "") };
  const r = compile(effective(S.pins, p.cs).cs, ctxOf(editTab));
  if (r.err) return { cs: [], err: r.err.msg };
  if (typing) for (const c of p.cs) if (c.key === "content" && !contentKnown(c.vals[0] ?? "")) return { cs: [], err: "↵ runs the full-text search" };
  return { cs: p.cs, err: "" };
}
// typing "too", "tool" or "tool " is the start of a clause, not a text search: the last valid filter stays until it parses
function startsClause(text: string, cs: Clause[]): boolean {
  const last = cs.length ? cs[cs.length - 1] : null;
  if (!last || last.key !== "text" || last.op !== "~") return false;
  const w = (last.vals.join(" ")).toLowerCase(); const tail = text.trimEnd();
  if (!w || !tail.toLowerCase().endsWith(w) || tail.endsWith("\"")) return false;
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
  if (ev === "esc") { typedGen++; S.inputErr = ""; setLocal(editTab, before); return false; }
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
  if (ev === "change") { const p = parse(text); S.inputErr = p.err ? p.err.msg : ""; return false; }
  if (ev === "enter") {
    const e = setPins(text);
    if (e) { S.inputErr = e.msg; return true; }
    S.inputErr = ""; say("info", S.pins.length ? "pinned: " + print(S.pins) : "pins cleared");
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
      if (key === "tool") for (const [n, st] of d.tt) bump(m, n, st.n);
      else if (key === "server") for (const [n, st] of d.tt) bump(m, mcpServer(n), st.n);
      else if (key === "program") for (const [k, c] of d.prog) bump(m, k.slice(k.indexOf("\t") + 1), c.n);
      else for (const k of d.files.keys()) { const p = k.slice(k.indexOf("\t") + 1); const b = p.slice(p.lastIndexOf("/") + 1); const i = b.lastIndexOf("."); if (i > 0) bump(m, b.slice(i + 1).toLowerCase(), 1); }
    }
  } else if (key === "model") { for (const n of DICT.model.names) bump(m, n, 1); for (const s of sessions.values()) bump(m, s.model, 1); }
  else if (key === "session") { for (const s of sessions.values()) if (!s.parent) bump(m, s.h + ":" + s.id, Math.max(s.last, s.mtime)); } // newest first
  else for (const s of sessions.values()) bump(m, key === "repo" ? repoOf(s) : key === "branch" ? s.branch : key === "agent" ? s.kind : "", 1);
  const vals = topOf(m); freq.set(key, { ver: L.ver, vals });
  return vals;
}
function valuesOf(k: string): string[] {
  const a = attrOf(k); if (!a) return [];
  if (a.type === "enum") return enumValues(a);
  if (a.type === "bool") return ["true", "false"];
  if (a.type === "date") return ["today", "yesterday", "-7d", "-30d"];
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
    if (t === "and" || t === ",") break;
    if (t.endsWith("one_of") && attrOf(before[j - 1] ?? "")) { const had = before.slice(j + 1); return valuesOf(before[j - 1] ?? "").map(quoteVal).filter((v: string) => had.indexOf(v) < 0); }
    if (isOp(t)) break;
  }
  return keyList();
}
// tab candidates for the word being typed: keys, then the key's operators, then values
export function complete(text: string, cursorAtEnd: boolean): string[] {
  if (!cursorAtEnd) return [];
  const w = words(text); const cur = (w[w.length - 1] ?? "").toLowerCase();
  const out: string[] = []; for (const c of candidates(w.slice(0, -1))) if (c.toLowerCase().startsWith(cur) && out.indexOf(c) < 0) out.push(c);
  return out;
}
// repeated tab cycles through the candidates of the word the first tab completed
interface Cyc { base: string; cands: string[]; i: number; last: string }
const cyc: Cyc = { base: "", cands: [], i: 0, last: "" };
let completing = false; // a change made by tab itself keeps the cycle; any other edit starts over
function tabComplete(): void {
  const t: string = S.inputText;
  if (cyc.cands.length && t === cyc.last) cyc.i = (cyc.i + 1) % cyc.cands.length;
  else {
    const cands = complete(t, true); if (!cands.length) return;
    const w = words(t); const cur: string = w[w.length - 1] ?? "";
    cyc.base = t.slice(0, t.length - cur.length); cyc.cands = cands; cyc.i = 0;
  }
  const next: string = cyc.base + (cyc.cands[cyc.i] ?? "") + " ";
  S.inputText = next; cyc.last = next;
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
  if (k === "P" && (S.tab <= 1 || tab === "Stats" || tab === "Repos")) { S.inputErr = ""; editTab = tab; cyc.cands = []; ask("pins (all tabs)", "pins", print(S.pins)); return true; }
  if (tab === "Stats" || tab === "Repos") {
    if (k === "/") { openFilterInput(tab); return true; }
    if (k === "p") { say("info", pinAll(tab)); return true; }
    return false;
  }
  if (S.tab !== 0) return false;
  if (k === "/") { openFilterInput("Sessions"); return true; }
  if (k === "F") { editTab = "Sessions"; ask("full-text", "content", contentQuery("Sessions")); return true; }
  if (k === "h") { cycleHarness("Sessions"); return true; }
  if (k === "l") { toggleLive("Sessions"); return true; }
  if (k === "p") { say("info", pinAll("Sessions")); return true; }
  if (k === "esc") { if (localFor("Sessions").length) { setLocal("Sessions", []); if (S.pins.length) say("info", "filter cleared — pins stay (P edits pins)"); } return true; }
  return false;
});

// ── hooks into the list and the process table ──
H.listFilter.push((s) => { const f = tabFilter("Sessions", "list"); return f === EMPTY || matchingPaths(f).has(s.path); });
H.listFiltering.push(() => tabFilter("Sessions", "list") !== EMPTY);
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
  const hid = hiddenCount("Sessions");
  const tail = (headsLeft > 0 ? fg(C.dim) + " · reading " + String(headsLeft) + RST : "") + (hid > 0 ? fg(C.yellow) + " · pins hide " + String(hid) + RST : "") + (f.needsCalls ? " " + callsChip(f) : "");
  return chips("Sessions", "list", Math.max(8, w - vwidth(tail))) + tail;
});
H.emptyText.push((where: string): string => {
  if (where !== "sessions" || tabFilter("Sessions", "list") === EMPTY) return "";
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
].concat(wrapKeys(64)) });

// ── restored pins: announced on start so they never look like missing sessions ──
const startToast = initPins(configStore());
if (startToast) { say(startToast.startsWith("saved") ? "warn" : "info", startToast); S.toastMs = 6000; }
// "calls ≤ 90 d" while call clauses are active: call rows are kept that long, day buckets forever
export function callsChip(f: Compiled): string { return f.needsCalls ? fg(C.dim) + "calls ≤ " + String(callDays()) + " d" + RST : ""; }
