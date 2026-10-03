// agentglass — the Ctrl+K palette: one fuzzy finder over actions, sessions, projects and tabs, drawn over the origin view
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { width, fit, ago, numAt } from "../../util/text.ts";
import type { Sess } from "../../model/types.ts";
import { S, say } from "../../state.ts";
import { H, type Ctx, type Action, tabAt } from "../../hooks.ts";
import { sessions, loadHead, titleOf, parentOf } from "../../model/sessions.ts";
import { harnessOf, sourceOf } from "../../harness/index.ts";
import { C, CSI, RST, fg, bg } from "../../ui/theme.ts";
import { put } from "../../ui/screen.ts";
import { openTranscript } from "../../ui/transcript.ts";
import { copyText, resume } from "../../actions.ts";
import { onInput } from "../../input.ts";
import { identOf, repoShown } from "../query/project.ts";
import { identNow } from "../../model/project.ts";
import { realCwd } from "../../hooks.ts";
import { base } from "../../util/json.ts";
import { localFor, setLocal, addClause } from "../query/scope.ts";
import { REDACT } from "../redact-on.ts";
import { type Hit, match } from "./fuzzy.ts";
import { ctxNow, restore } from "./actions.ts";
import { selectRow } from "./open.ts";
import { mruLoad, mruSave, mruTouch, mruBoost, mruList } from "./mru.ts";

// kind: action | session | project | tab; text = what is matched and shown (the visible, under --redact fake, text)
export interface Item { id: string; kind: string; text: string; hint: string; s: Sess | null; act: Action | null; proj: string; tab: number }
// one level of the palette: the main list, or a session's actions (→)
interface Level { items: Item[]; q: string; scope: number; selId: string }
const SCOPES = ["all", "actions", "sessions", "projects", "tabs"];
const KIND = ["", "action", "session", "project", "tab"];
const PREFIX = ["", ">", "@", "#", ":"];
const MAXROWS = 15;
export const P = {
  origin: null as Ctx | null, top: 0, tvScroll: 0, tvCur: 0, tvFollow: false, dvScroll: 0,
  items: [] as Item[], hays: [] as string[], lows: [] as string[],
  q: "", scope: 0, help: false, // help: "?" alone lists the prefixes
  hits: [] as Hit[], sel: 0, scroll: 0, selId: "",
  levels: [] as Level[], // the main list while a second level is shown
  prevQ: "", prevAll: null as number[] | null, // incremental narrowing: the last query's matches
  box: [0, 0, 0, 0] as number[], // x, y, w, h of the last drawn box (mouse)
  rowY: 0, // screen row of the first result
};
// typed accessors: scriptc cannot index with a number read from a for-of over another array
function itemAt(i: number): Item { return P.items[i]; }
function hayAt(i: number): string { return P.hays[i]; }
function lowAt(i: number): string { return P.lows[i]; }
function hitItem(k: number): Item { return itemAt(P.hits[k].i); }
export const MRU_FILE = process.env.AGENTGLASS_PALETTE_FILE || join(HOME, ".agentglass", "palette.json");
let loaded = false;

function sessText(s: Sess): string {
  const par = s.parent ? parentOf(s) : null;
  const o: string[] = [(s.parent ? "⑂ " + (s.kind || "subagent") + " " : "") + titleOf(s)];
  if (par) o.push(titleOf(par));
  const p = projOf(s); if (p.key) o.push(p.label);
  o.push(harnessOf(s.h).label);
  if (s.branch) o.push(s.branch);
  o.push(s.id);
  return o.join(" · ");
}
function sessHint(s: Sess): string { return (s.cost >= 0 ? "$" + s.cost.toFixed(2) + " " : "") + ago(s.mtime) + (s.pid ? " ●" : ""); }
// a session's project (repo-view identity: a repo and its worktrees are one): key groups, label is shown (faked under
// --redact), val is the repo clause value (the identity key; under --redact the shown label, which the repo key also takes)
function projOf(s: Sess): { key: string; label: string; val: string } {
  const rc = realCwd(s);
  const id = identOf(s) ?? (rc ? identNow(rc) : null); // not resolved yet (the Repos tab resolves in the background): now, cached
  if (!id && !rc) return { key: "", label: "", val: "" };
  const label = repoShown(s);
  if (!id || id.kind === "none") return { key: "cwd:" + base(rc.replace(/\/+$/, "")), label, val: base(rc.replace(/\/+$/, "")).toLowerCase() };
  const k = id.key; const v = REDACT ? label : k;
  return { key: k, label, val: v.toLowerCase() };
}
function itemOfSess(s: Sess): Item { return { id: "session:" + s.h + ":" + s.id, kind: "session", text: sessText(s), hint: sessHint(s), s, act: null, proj: "", tab: -1 }; }
function actItem(a: Action): Item { return { id: "act:" + a.id, kind: "action", text: a.group + ": " + a.title, hint: a.keys, s: null, act: a, proj: "", tab: -1 }; }
function tabItem(name: string, n: number, hint: string): Item { return { id: "tab:" + name, kind: "tab", text: name, hint, s: null, act: null, proj: "", tab: n }; }
// collected once per open: sessions (live first, newest first), projects (last active first), actions valid here, tabs
function collect(c: Ctx): Item[] {
  const ss: Sess[] = []; for (const s of sessions.values()) ss.push(s);
  ss.sort((a, b) => (b.pid ? 1 : 0) - (a.pid ? 1 : 0) || b.mtime - a.mtime);
  const t0 = Date.now(); // titles come from the log's head: read the newest ones within a frame's budget (the list does the same lazily)
  for (const s of ss) { if (Date.now() - t0 > 60) break; if (!s.headDone) loadHead(s); }
  const out: Item[] = [];
  for (const s of ss) out.push(itemOfSess(s));
  const projs = new Map<string, { n: number; last: number; label: string; val: string }>();
  for (const s of ss) {
    const p = projOf(s); if (!p.key) continue;
    const e = projs.get(p.key); if (e) { e.n++; if (s.mtime > e.last) e.last = s.mtime; } else projs.set(p.key, { n: 1, last: s.mtime, label: p.label, val: p.val });
  }
  const ps: string[] = []; for (const k of projs.keys()) ps.push(k);
  ps.sort((a, b) => (projs.get(b)?.last ?? 0) - (projs.get(a)?.last ?? 0));
  for (const k of ps) { const e = projs.get(k); if (e) out.push({ id: "project:" + k, kind: "project", text: e.label, hint: String(e.n) + " · " + ago(e.last), s: null, act: null, proj: e.val, tab: -1 }); }
  for (const a of H.actions) if (a.keys && a.when(c)) out.push(actItem(a)); // key bindings first, palette-only ones (themes) after
  for (const a of H.actions) if (!a.keys && a.when(c)) out.push(actItem(a));
  out.push(tabItem("Sessions", 0, "1")); out.push(tabItem("Processes", 1, "2"));
  for (let i = 0; i < H.tabs.length; i++) out.push(tabItem(H.tabs[i].name, i + 2, i + 3 <= 9 ? String(i + 3) : ""));
  if (c.sess && (c.mode === "transcript" || (c.mode === "list" && c.tab === 0))) out.push(tabItem("Call graph", -2, "c"));
  out.push(tabItem("Help", -3, "?"));
  return out;
}
function setItems(items: Item[]): void {
  P.items = items; P.hays = items.map((i: Item) => i.text); P.lows = P.hays.map((h: string) => h.toLowerCase());
  P.prevQ = ""; P.prevAll = null;
}
export function openPalette(prefill: string): void {
  if (S.mode === "input" || S.mode === "confirm" || S.mode === "palette") return;
  if (S.mode === "help") { S.mode = S.prevMode; S.helpScroll = 0; }
  if (!loaded) { loaded = true; mruLoad(MRU_FILE); }
  const c = ctxNow();
  P.origin = c; P.top = S.top;
  const tv = S.tv; const dv = S.dv;
  P.tvScroll = tv ? tv.scroll : 0; P.tvCur = tv ? tv.cur : 0; P.tvFollow = tv ? tv.follow : false; P.dvScroll = dv ? dv.scroll : 0;
  setItems(collect(c));
  P.levels = []; P.q = prefill; P.scope = 0; P.sel = 0; P.scroll = 0; P.selId = "";
  S.prevMode = S.mode; S.mode = "palette";
  rank();
}
// the effective scope and the query without its prefix
function scopeOf(): number { if (P.levels.length) return 0; const i = PREFIX.indexOf(P.q.charAt(0)); return i > 0 ? i : P.scope; } // a session's actions: one list
function query(): string { return P.levels.length || PREFIX.indexOf(P.q.charAt(0)) <= 0 ? P.q : P.q.slice(1); }
// the items in scope, as indexes into P.items, in their natural order (recency)
function inScope(sc: number): number[] { const o: number[] = []; for (let i = 0; i < P.items.length; i++) if (sc === 0 || itemAt(i).kind === KIND[sc]) o.push(i); return o; }
function rank(): void {
  P.help = !P.levels.length && P.q === "?";
  const sc = scopeOf(); const q = query(); const now = Date.now();
  const idx = inScope(sc);
  if (P.help) { P.hits = []; P.sel = 0; return; }
  if (!q.trim()) { // empty query: recent picks, then the 20 newest sessions, then the actions valid here (one scope: all of it)
    const hits: Hit[] = []; const seen = new Set<number>();
    const add = (i: number): void => { if (!seen.has(i)) { seen.add(i); hits.push({ i, score: 0, pos: [] }); } };
    if (sc === 0 && !P.levels.length) {
      for (const r of mruList()) for (const i of idx) if (itemAt(i).id === r.id) add(i);
      let n = 0; for (const i of idx) if (itemAt(i).kind === "session" && n < 20) { add(i); n++; }
      for (const i of idx) if (itemAt(i).kind === "action") add(i);
      for (const i of idx) if (itemAt(i).kind === "tab") add(i);
    } else for (const i of idx) add(i);
    P.hits = hits.slice(0, 200);
  } else {
    const hays: string[] = []; const lows: string[] = []; const bonus: number[] = [];
    for (const i of idx) { hays.push(hayAt(i)); lows.push(lowAt(i)); bonus.push(mruBoost(itemAt(i).id, now)); }
    const key = String(sc) + "\u0000" + q;
    const prev = P.prevAll !== null && P.prevQ !== "" && key.startsWith(P.prevQ) ? P.prevAll : null; // a longer query only narrows
    const m = match(hays, lows, q, prev, 200, bonus);
    P.prevQ = key; P.prevAll = m.all;
    const hits: Hit[] = [];
    for (const h of m.hits) hits.push({ i: numAt(idx, h.i, 0), score: h.score, pos: h.pos });
    P.hits = hits;
  }
  // the selection follows its item across re-ranking
  let at = -1; for (let k = 0; k < P.hits.length; k++) if (hitItem(k).id === P.selId) { at = k; break; }
  P.sel = at >= 0 ? at : 0;
  P.selId = P.hits.length ? hitItem(P.sel).id : "";
}
export function rows(): Item[] { return P.hits.map((h: Hit) => itemAt(h.i)); }
export function selected(): Item | null { return P.sel >= 0 && P.sel < P.hits.length ? hitItem(P.sel) : null; }
function move(d: number): void {
  if (!P.hits.length) return;
  P.sel = Math.max(0, Math.min(P.hits.length - 1, P.sel + d));
  P.selId = hitItem(P.sel).id;
}
// back to the origin exactly as it was: mode, tab, selection, list and transcript scroll, the open detail
function restoreAll(): void {
  const c = P.origin; if (!c) return;
  restore(c); S.top = P.top;
  const tv = S.tv; if (tv) { tv.scroll = P.tvScroll; tv.cur = P.tvCur; tv.follow = P.tvFollow; }
  const dv = S.dv; if (dv) dv.scroll = P.dvScroll;
}
export function closePalette(): void { restoreAll(); P.levels = []; P.origin = null; }
function gone(s: Sess): boolean { if (sourceOf(s.h).stat(s)) return false; say("warn", "that session is no longer on disk"); return true; }
function toList(): void { S.mode = "list"; S.prevMode = "list"; S.tv = null; S.dv = null; }
// the Sessions tab filtered to one project (pins stay); val = the identity key, label for the toast
function projClause(val: string, label: string): void {
  toList(); S.tab = 0;
  setLocal("Sessions", addClause(localFor("Sessions"), { key: "repo", op: "is", vals: [val], neg: false, pinned: false }).cs);
  say("info", "Sessions: project " + label);
}
// a session's own actions (→): each selects the session first, so the action sees what a key press on its row sees
function subItems(s: Sess): Item[] {
  const mk = (id: string, title: string, keys: string, run: () => void): Item =>
    ({ id: "sub:" + id, kind: "action", text: title, hint: keys, s: null, act: { id, title, group: "Session", keys, when: (c: Ctx): boolean => true, run: (c: Ctx): void => run() }, proj: "", tab: -1 });
  const onRow = (k: string): (() => void) => (): void => { toList(); if (selectRow(s)) onInput(k); else say("warn", "the session is hidden by the filter — esc clears it"); };
  const o: Item[] = [
    mk("open", "Open transcript", "↵", (): void => { if (!gone(s)) { toList(); selectRow(s); openTranscript(s); } }),
    mk("callgraph", "Call graph", "c", onRow("c")),
    mk("send", "Send prompt…", "s", onRow("s")),
    mk("resume", "Resume interactively", "R", (): void => resume(s)),
    mk("copyId", "Copy session id", "y", (): void => copyText(s.id, s.id)),
  ];
  for (const f of H.sessionActions) { const a = f(s); if (a) o.push({ id: "sub:" + a.id, kind: "action", text: a.title, hint: a.keys, s: null, act: a, proj: "", tab: -1 }); }
  o.push(mk("project", "Filter to its project", "", (): void => { const p = projOf(s); if (p.key) projClause(p.val, p.label); else say("info", "no project known for this session"); }));
  return o;
}
function runItem(it: Item): void {
  const c = P.origin; if (!c) return;
  if (it.id.startsWith("sub:") === false) mruTouch(it.id, Date.now());
  closePalette(); // restores mode, tab and selection: the action sees the same state as a key press there
  const a = it.act; const s = it.s;
  if (a) a.run(c);
  else if (s) { if (!gone(s)) { toList(); selectRow(s); openTranscript(s); } }
  else if (it.kind === "project") projClause(it.proj, it.text);
  else if (it.kind === "tab") {
    if (it.tab >= 0) { toList(); S.tab = it.tab; }
    else if (it.tab === -2) onInput("c");
    else onInput("?");
  }
}
function enterSub(): void {
  const it = selected(); const s = it ? it.s : null;
  if (!s) return;
  P.levels.push({ items: P.items, q: P.q, scope: P.scope, selId: P.selId });
  setItems(subItems(s)); P.q = ""; P.selId = ""; rank();
}
function leaveSub(): void {
  const l = P.levels.pop(); if (!l) return;
  setItems(l.items); P.q = l.q; P.scope = l.scope; P.selId = l.selId; rank();
}
export function paletteKey(k: string): void {
  const page = Math.max(1, visibleRows() - 1);
  if (k === "esc" || k === "ctrl-k" || k === "ctrl-c") { if (k === "esc" && P.levels.length) { leaveSub(); return; } closePalette(); return; }
  if (k === "enter") { const it = selected(); if (it) runItem(it); return; }
  if (k === "up" || k === "ctrl-p") move(-1);
  else if (k === "down" || k === "ctrl-n") move(1);
  else if (k === "pgup") move(-page);
  else if (k === "pgdn") move(page);
  else if (k === "home") move(-P.hits.length);
  else if (k === "end") move(P.hits.length);
  else if (k === "wheelup") move(-3);
  else if (k === "wheeldown") move(3);
  else if (k === "right") { const it = selected(); if (it && it.s && !P.levels.length) enterSub(); }
  else if (k === "left") { if (P.levels.length) leaveSub(); }
  else if (k === "tab") { if (!P.levels.length) { P.scope = (P.scope + 1) % SCOPES.length; if (PREFIX.indexOf(P.q.charAt(0)) > 0) P.q = P.q.slice(1); P.selId = ""; rank(); } }
  else {
    const was = P.q;
    if (k === "bs") P.q = Array.from(P.q).slice(0, -1).join("");
    else if (k === "ctrl-u") P.q = "";
    else if (k === "ctrl-w") P.q = P.q.replace(/\S*\s*$/, "");
    else if (k.length <= 2 && k.charCodeAt(0) >= 32) P.q += k;
    if (P.q !== was) rank();
  }
}

// ── drawing ──
function visibleRows(): number { return S.H < 12 ? 5 : Math.max(1, Math.min(MAXROWS, S.H - 7)); }
function glyph(it: Item): string {
  const s = it.s;
  if (s) { const ad = harnessOf(s.h); return fg(ad.color()) + fit(ad.glyph, 2) + RST; }
  return fg(C.dim) + (it.kind === "action" ? "› " : it.kind === "project" ? "# " : it.kind === "tab" ? ": " : "  ") + RST;
}
// text cut to w columns with the matched characters in the accent color
function marked(t: string, pos: number[], w: number, base: string): string {
  let o = ""; let n = 0; let on = false; let i = 0;
  const full = width(t) <= w;
  for (const ch of t) {
    const c = width(ch);
    if (!full && n + c > w - 1) { o += (on ? RST + base : "") + "…"; n++; on = false; break; }
    const m = pos.indexOf(i) >= 0;
    if (m && !on) { o += fg(C.accent) + CSI + "1m"; on = true; } else if (!m && on) { o += RST + base; on = false; }
    o += ch; n += c; i += ch.length;
  }
  return o + (on ? RST + base : "") + " ".repeat(Math.max(0, w - n));
}
function thousands(n: number): string { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
export function renderPalette(): void {
  const W = S.W; const w = Math.max(40, Math.min(100, W - 4));
  const nr = visibleRows();
  const h = nr + 3; // top border (title), input, results, bottom border (status)
  const x0 = Math.floor((W - w) / 2); const y0 = Math.max(1, Math.floor((S.H - h) / 3));
  P.box = [x0, y0, w, h]; P.rowY = y0 + 2;
  const bc = fg(C.accent); const iw = w - 2;
  const title = " Go to… "; const sc = " " + (P.levels.length ? "session actions" : SCOPES[scopeOf()]) + " ";
  put(x0, y0, bc + "╭─" + CSI + "1m" + fg(C.text) + title + RST + bc + "─".repeat(Math.max(0, w - 4 - width(title) - width(sc))) + fg(C.dim) + sc + bc + "─╮" + RST);
  const ph = P.levels.length ? "actions for this session — ← back" : "actions, sessions, projects, tabs — > @ # : ?";
  const inp = P.q ? fg(C.text) + fit(P.q + "▏", iw - 3) : fg(C.text) + "▏" + fg(C.dim) + fit(ph, iw - 4);
  put(x0, y0 + 1, bc + "│" + RST + bg(C.panel) + fg(C.accent) + CSI + "1m› " + RST + bg(C.panel) + inp + RST + bc + "│" + RST);
  if (P.sel < P.scroll) P.scroll = P.sel;
  if (P.sel >= P.scroll + nr) P.scroll = P.sel - nr + 1;
  P.scroll = Math.max(0, Math.min(P.scroll, Math.max(0, P.hits.length - nr)));
  const hints = W >= 50;
  const lines: string[] = [];
  if (P.help) {
    const hp = [["›  >", "actions — every key binding by name"], ["@", "sessions — all harnesses, subagents too"], ["#", "projects — filter the Sessions list"], [":", "tabs and views"], ["tab", "cycle the scope instead of typing a prefix"], ["→", "on a session: its actions"]];
    for (const r of hp) lines.push(bg(C.panel) + " " + fg(C.accent) + CSI + "1m" + fit(r[0] ?? "", 6) + RST + bg(C.panel) + fg(C.sub) + fit(r[1] ?? "", iw - 7));
  } else if (!P.hits.length) {
    const none = scopeOf() === 2 && !inScope(2).length ? "no sessions" : "no match — tab to change scope";
    lines.push(bg(C.panel) + fg(C.dim) + " " + fit(none, iw - 1));
  }
  for (let r = 0; r < nr; r++) {
    let l = "";
    if (lines.length) l = r < lines.length ? lines[r] : bg(C.panel) + " ".repeat(iw);
    else {
      const k = P.scroll + r;
      if (k >= P.hits.length) l = bg(C.panel) + " ".repeat(iw);
      else {
        const hit = P.hits[k]; const it = itemAt(hit.i); const on = k === P.sel;
        const base = (on ? bg(C.sel) : bg(C.panel)) + fg(on ? C.text : C.sub);
        const hint = hints && it.hint ? " " + it.hint + " " : "";
        const tw = iw - 4 - width(hint);
        l = base + (on ? fg(C.accent) + "▌" : " ") + RST + base + glyph(it) + base + " " + marked(it.text, hit.pos, tw, base) + fg(C.dim) + hint + RST;
      }
    }
    put(x0, P.rowY + r, bc + "│" + RST + l + RST + bc + "│" + RST);
  }
  const shown = P.help ? "" : (P.hits.length ? String(P.sel + 1) + " of " + thousands(P.hits.length) + (P.hits.length >= 200 ? "+" : "") + " · " : "");
  const st = " " + shown + "↵ open · " + (P.levels.length ? "← back" : "→ actions") + " · tab scope · esc close ";
  const sw = Math.min(width(st), w - 4);
  put(x0, y0 + h - 1, bc + "╰" + "─".repeat(Math.max(0, w - 3 - sw)) + fg(C.dim) + fit(st, sw) + bc + "─╯" + RST);
  const sh = bg(C.shadow) + " " + RST; // drop shadow, like help
  for (let r = 1; r < h; r++) put(x0 + w, y0 + r, sh);
  put(x0 + 1, y0 + h, bg(C.shadow) + " ".repeat(w) + RST);
}
// wheel scrolls, a click on a row runs it, a click outside the box closes the palette
export function paletteMouse(b: number, x: number, y: number, press: boolean): boolean {
  if (b === 64 || b === 65) { paletteKey(b === 64 ? "wheelup" : "wheeldown"); return true; }
  if (!press) return true;
  const bx = numAt(P.box, 0, 0); const by = numAt(P.box, 1, 0); const bw = numAt(P.box, 2, 0); const bh = numAt(P.box, 3, 0);
  if (x < bx || x >= bx + bw || y < by || y >= by + bh) { closePalette(); return true; }
  if (b !== 0) return true;
  const r = y - P.rowY;
  if (r >= 0 && r < visibleRows() && P.scroll + r < P.hits.length && !P.help) { P.sel = P.scroll + r; P.selId = hitItem(P.sel).id; const it = selected(); if (it) runItem(it); }
  return true;
}

H.modal.push((mode: string, k: string): boolean => {
  if (mode === "palette") { paletteKey(k); return true; }
  if (k !== "ctrl-k") return false;
  if (mode !== "input" && mode !== "confirm") openPalette(""); // a dialog keeps its keys: ignored there
  return true;
});
H.mouse.push((mode: string, b: number, x: number, y: number, press: boolean): boolean => mode === "palette" ? paletteMouse(b, x, y, press) : false);
H.overlays.push(() => { if (S.mode === "palette") renderPalette(); });
H.onQuit.push(() => mruSave(MRU_FILE, REDACT));
