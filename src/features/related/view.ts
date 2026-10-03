// agentglass — related events (r): everything around one event within ±N minutes in the same project, across all
// sessions and harnesses, with same-file conflicts (‼), cross-worktree overlaps (≈) and workspace clobbers flagged
// SPDX-License-Identifier: Apache-2.0
// Opened with r from the event detail, the transcript (cursor event) and the call graph (selected span). The build reads
// the candidate sessions in 50 ms slices per tick; what is loaded renders at once, the header counts the rest.
import type { Ev, Sess } from "../../model/types.ts";
import { S, say, type TV, type DV, type Mode } from "../../state.ts";
import { H, display } from "../../hooks.ts";
import { fit, fitStyled, fillTo, width, vwidth, clean } from "../../util/text.ts";
import { section } from "../../util/config.ts";
import { sessions, titleOf } from "../../model/sessions.ts";
import { harnessOf, sourceOf, window, parseEvents } from "../../harness/index.ts";
import { identOf } from "../query/project.ts";
import { ask } from "../../actions.ts";
import { C, RST, fg, bg } from "../../ui/theme.ts";
import { put, spin } from "../../ui/screen.ts";
import { openTranscript, shown } from "../../ui/transcript.ts";
import { ms } from "../callgraph/model.ts";
import { graphAnchor } from "../callgraph/view.ts";
import { parse } from "../query/parse.ts";
import { type Compiled, compile, sessMatches } from "../query/eval.ts";
import { type RelEv, type FileRef, KIND_SETS, relCfg, fileShown } from "./model.ts";
import { type Build, startBuild, stepBuild, repoll, isAnchor } from "./build.ts";

export const NAME = "related";
const STEPS = [2, 5, 10, 30, 60];
const KIND_NAMES = ["default kinds", "all kinds", "writes only"];
const GLYPH: { [k: string]: string } = { prompt: "❯", write: "✎", shell: "$", read: "○", agent: "↳", web: "◌", mcp: "◈", alert: "◆", commit: "●", tool: "⚒", assistant: "⏺", thinking: "∴" };
interface Back { mode: Mode; tv: TV | null; dv: DV | null; fview: string }
// as/aevs/ai: the anchor (rebuilds on +/-); vis: indexes into b.rows shown; sel/top: cursor and scroll over vis;
// inTx: a transcript opened from here (esc comes back); polled: last live repoll
export interface RState {
  b: Build; as: Sess; aevs: Ev[]; ai: number; minutes: number; cycle: number[]; fileOnly: boolean; own: boolean; kset: number;
  q: string; pred: Compiled | null; back: Back; inTx: boolean; vis: number[]; sel: number; top: number; ver: string; polled: number; centred: boolean;
}
const R: { st: RState | null; stack: RState[] } = { st: null, stack: [] };
const cfg = relCfg(section("related"));
let warned = false;

function stAt(): RState | null { return R.st; }
function rowAt(st: RState, i: number): RelEv | null { const k = i >= 0 && i < st.vis.length ? st.vis[i] ?? -1 : -1; return k >= 0 && k < st.b.rows.length ? st.b.rows[k] : null; }
function building(st: RState): boolean { return st.b.next < st.b.cands.length; }
function rowKey(r: RelEv): string { return r.sess + "\u0001" + r.kind + "\u0001" + r.evKind + "\u0001" + r.evId + "\u0001" + r.ts + "\u0001" + r.text; }

// ── open / back ──
export function relState(): RState | null { return R.st; } // checks
export function openRelated(s: Sess, evs: Ev[], i: number): void {
  if (!warned) { warned = true; if (cfg.warn) say("warn", cfg.warn); }
  const b = startBuild(s, evs, i, cfg.minutes, cfg.conflictMinutes);
  if (!b) { say("info", "this event has no time"); return; }
  const cycle = STEPS.slice(); if (cycle.indexOf(cfg.minutes) < 0) { cycle.push(cfg.minutes); cycle.sort((x: number, y: number) => x - y); }
  const cur = R.st; if (cur) R.stack.push(cur); // r again inside a transcript opened from here
  R.st = { b, as: s, aevs: evs, ai: i, minutes: cfg.minutes, cycle, fileOnly: false, own: true, kset: 0, q: "", pred: null,
    back: { mode: S.mode, tv: S.tv, dv: S.dv, fview: S.fview }, inTx: false, vis: [], sel: 0, top: 0, ver: "", polled: Date.now(), centred: false };
  stepBuild(b, 50, () => Date.now()); // the anchor's own rows in the first frame
  S.fview = NAME; S.mode = "view"; S.dirty = true;
}
function back(): void {
  const st = R.st; if (!st) return;
  S.mode = st.back.mode; S.tv = st.back.tv; S.dv = st.back.dv; S.fview = st.back.fview;
  R.st = R.stack.length ? R.stack.pop() ?? null : null;
}
function rebuild(st: RState, minutes: number): void {
  const b = startBuild(st.as, st.aevs, st.ai, minutes, cfg.conflictMinutes); if (!b) return;
  const r = rowAt(st, st.sel); const want = r ? rowKey(r) : "";
  st.b = b; st.minutes = minutes; st.ver = ""; st.centred = false;
  stepBuild(b, 50, () => Date.now());
  layout(st); if (want) select(st, want);
}

// ── visible rows ──
function anchorFiles(st: RState): FileRef[] { for (const r of st.b.rows) if (isAnchor(st.b, r)) return r.files; return []; }
function shares(a: FileRef[], b: FileRef[]): boolean { for (const f of a) for (const g of b) if (f.rel === g.rel) return true; return false; }
// the / filter: session clauses on the row's session, call clauses on tool rows (non-tool rows pass only without one)
function passes(st: RState, r: RelEv): boolean {
  const f = st.pred; if (!f) return true;
  const s = r.sess ? sessions.get(r.sess) ?? null : null;
  if (f.sess.length && (!s || !sessMatches(f, s))) return false;
  if (!f.event.length) return true;
  if (r.cat < 0 || !s) return false;
  const i = r.evText.indexOf("\u0000"); const args = i >= 0 ? r.evText.slice(i + 1) : "";
  for (const p of f.event) if (!p(s, "tool", r.tool, args)) return false;
  return true;
}
function layout(st: RState): void {
  const ks = KIND_SETS[st.kset] ?? []; const af = st.fileOnly ? anchorFiles(st) : [];
  const vis: number[] = [];
  for (let i = 0; i < st.b.rows.length; i++) {
    const r = st.b.rows[i];
    if (isAnchor(st.b, r)) { vis.push(i); continue; }
    if (ks.indexOf(r.kind) < 0) continue;
    if (!st.own && r.sess === st.b.anchor.sess) continue;
    if (st.fileOnly && !shares(r.files, af)) continue;
    if (!passes(st, r)) continue;
    vis.push(i);
  }
  st.vis = vis;
}
function select(st: RState, key: string): void { for (let i = 0; i < st.vis.length; i++) { const r = rowAt(st, i); if (r && rowKey(r) === key) { st.sel = i; return; } } }
function anchorIdx(st: RState): number { for (let i = 0; i < st.vis.length; i++) { const r = rowAt(st, i); if (r && isAnchor(st.b, r)) return i; } return 0; }
// re-layout when the rows or a view toggle changed; the cursor stays on its row
function sync(st: RState, rh: number): void {
  const v = String(st.b.rows.length) + "|" + String(st.b.flagged) + "|" + String(st.kset) + String(st.own) + String(st.fileOnly) + "|" + st.q;
  if (v === st.ver) return;
  const r = rowAt(st, st.sel); const want = r ? rowKey(r) : "";
  layout(st); st.ver = v;
  if (!st.centred) { st.sel = anchorIdx(st); st.top = Math.max(0, st.sel - Math.floor(rh / 2)); st.centred = true; }
  else if (want) select(st, want);
}
function rowsH(): number { return Math.max(1, S.H - 5); } // rows 3 … H-3: header, chips above, the full row and the footer below
function clampSel(st: RState, h: number): void {
  const n = st.vis.length;
  st.sel = Math.max(0, Math.min(st.sel, n - 1));
  if (st.sel < st.top) st.top = st.sel; else if (st.sel >= st.top + h) st.top = st.sel - h + 1;
  st.top = Math.max(0, Math.min(st.top, Math.max(0, n - h)));
}
function flagged(r: RelEv): boolean { return r.mark === "conflict" || r.mark === "overlap" || r.mark === "clobber"; }

// ── text ──
function off(dt: number): string {
  const s = Math.round(Math.abs(dt) / 1000); const m = Math.floor(s / 60); const x = s % 60;
  return (s === 0 ? " " : dt < 0 ? "-" : "+") + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0");
}
// the end of a long name: worktrees of one repo usually differ in their suffix (app-wt, app-fix)
function tailFit(v: string, n: number): string { const c: string[] = []; for (const ch of v) c.push(ch); return c.length <= n ? v + " ".repeat(n - c.length) : "…" + c.slice(c.length - n + 1).join(""); }
function clock(t: number): string { const d = new Date(t); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0"); }
function dur(m: number): string { const s = Math.round(m / 1000); return s < 60 ? String(s) + "s" : String(Math.floor(s / 60)) + "m" + (s % 60 ? String(s % 60).padStart(2, "0") + "s" : ""); }
function who(path: string): string { const s = sessions.get(path); return s ? harnessOf(s.h).mark + " " + clean(titleOf(s)) : "(gone)"; }
const wts = new Map<string, string>();
function worktree(path: string): string {
  const hit = wts.get(path); if (hit !== undefined) return hit;
  const s = sessions.get(path); const id = s ? identOf(s) : null;
  const w = id && id.worktree && s ? display("repo", id.worktree, s) : "";
  if (id) wts.set(path, w);
  return w;
}
// the flag's note: with whom and how far apart
function note(st: RState, r: RelEv): string {
  if (!flagged(r)) return "";
  const o = r.withS[0] ?? ""; const other = st.b.rows.find((x: RelEv) => x.sess === o && x.kind === "write" && Math.abs(x.t - r.t) === r.dt);
  const rel = other ? (other.t <= r.t ? " earlier" : " later") : "";
  const more = r.withS.length > 1 ? " +" + String(r.withS.length - 1) : "";
  if (r.race) return "parent wrote while its subagent ran";
  if (r.mark === "conflict") return "also edited by " + who(o) + more + " " + dur(r.dt) + rel;
  if (r.mark === "overlap") return "same file in " + (worktree(o) || "another clone") + ": " + who(o) + more + " " + dur(r.dt) + rel;
  return "may discard " + who(o) + more + "'s edits from " + dur(r.dt) + " before";
}
function rowText(r: RelEv): string {
  if (r.kind === "write" && r.files.length) return r.files.map((f: FileRef) => fileShown(f)).join(" ");
  if (r.kind === "commit" && !r.sess) return clean(r.text.replace(/^commit \(no session\) /, "")); // the columns say "(no session) ● commit"
  return clean(r.text);
}
function status(r: RelEv): string {
  const p: string[] = [];
  if (r.err) p.push(fg(C.red) + "✗" + RST);
  if (r.add || r.del) p.push(fg(C.green) + "+" + String(r.add) + RST + " " + fg(C.red) + "−" + String(r.del) + RST);
  return p.join(" ");
}

// ── render ──
// long labels when they fit, else the short ones (80 columns: label, window, counts, flags and progress stay visible)
function header(st: RState, w: number): string {
  const b = st.b;
  const n = new Set<string>(); for (const r of b.rows) if (r.sess) n.add(r.sess);
  const ev = String(st.vis.length) + (st.vis.length === b.rows.length ? "" : "/" + String(b.rows.length));
  const make = (short: boolean): string => {
    const parts = [fg(C.accent) + "related" + RST, b.scope === "cwd" ? "(same cwd: no project)" : b.label || "(project unknown)",
      "±" + String(st.minutes) + "m " + (short ? "@ " : "around ") + clock(b.anchor.t), String(n.size) + (short ? " sess" : " sessions"), ev + (short ? " ev" : " events")];
    if (b.flagged) parts.push(fg(C.red) + "‼ " + String(b.flagged) + RST);
    if (building(st)) parts.push(fg(C.yellow) + spin() + (short ? " " : " loading ") + String(b.next) + "/" + String(b.cands.length) + RST);
    if (b.more) parts.push(fg(C.dim) + "+" + String(b.more) + (short ? " more" : " more sessions not shown") + RST);
    if (b.capped) parts.push(fg(C.yellow) + (short ? "16 MB cap" : "16 MB read cap reached") + RST);
    if (b.live) parts.push(fg(C.green) + "● live" + RST);
    return " " + parts.join(fg(C.dim) + " · " + RST);
  };
  const l = make(false); return vwidth(l) <= w ? l : make(true);
}
function chips(st: RState): string {
  const c: string[] = [KIND_NAMES[st.kset] ?? ""];
  if (!st.own) c.push("own session hidden"); if (st.fileOnly) c.push("anchor's files only");
  if (st.q) c.push("filter: " + st.q);
  if (st.b.tsMissing) c.push("some logs carry no timestamps: tail only");
  return " " + fg(C.dim) + c.join(" · ") + RST;
}
function line(st: RState, r: RelEv, w: number, on: boolean): string {
  const a = isAnchor(st.b, r);
  const mk = a ? fg(C.accent) + "▶" : r.mark === "overlap" ? fg(C.yellow) + "≈" : flagged(r) ? fg(C.red) + "‼" : " ";
  const tint = r.sess === st.b.anchor.sess || !r.h ? C.text : harnessOf(r.h).color();
  const s = r.sess ? sessions.get(r.sess) : undefined;
  const ttl = s ? harnessOf(s.h).mark + " " + fit(clean(titleOf(s)), 16) : fit(r.sess ? "(gone)" : "(no session)", 18);
  const wt = r.sess && r.sess !== st.b.anchor.sess ? worktree(r.sess) : "";
  const aw = worktree(st.b.anchor.sess);
  const wtag = wt && wt !== aw ? tailFit(wt, 6) + " " : "";
  const k = (GLYPH[r.kind] ?? "·") + " " + fit(r.tool || r.kind, w >= 100 ? 10 : 6);
  const nt = note(st, r); const stt = status(r);
  const left = mk + RST + " " + fg(C.dim) + off(r.t - st.b.anchor.t) + " " + (w >= 70 ? clock(r.t) + " " : "") + RST + fg(tint) + ttl + RST + " " + fg(C.dim) + wtag + RST + fg(tint) + k + RST + " ";
  const lw = width(left.replace(/\x1b\[[0-9;]*m/g, ""));
  const tail = [stt, nt ? fg(flagged(r) && r.mark !== "overlap" ? C.red : C.yellow) + nt + RST : ""].filter((x: string) => x.length > 0).join(" ");
  const tw = width(tail.replace(/\x1b\[[0-9;]*m/g, ""));
  const room = Math.max(0, w - lw - 1);
  const textW = tw ? Math.max(Math.min(12, room), room - tw - 1) : room;
  const body = fg(a ? C.text : tint) + fit(rowText(r), textW) + RST + (tw && room - textW > 1 ? " " + fitStyled(tail, room - textW - 1) : "");
  const l = fitStyled(left + body, w);
  return on ? bg(C.sel) + l.split(RST).join(RST + bg(C.sel)) + fillTo(l, w) + RST : l;
}
// the view's lines for rows 1 … h (styled, each exactly w wide): header, chips, events, the selected row in full
export function viewLines(st: RState, w: number, h: number): string[] {
  sync(st, h - 3); clampSel(st, h - 3);
  const L: string[] = [fitStyled(header(st, w), w), fitStyled(chips(st), w)];
  const rh = h - 3;
  for (let y = 0; y < rh; y++) {
    const r = rowAt(st, st.top + y);
    if (!r) { L.push(y === 1 && !st.vis.length ? fitStyled("  " + fg(C.dim) + (building(st) ? "reading sessions…" : "nothing in this window — + widens it, k shows more kinds") + RST, w) : ""); continue; }
    L.push(line(st, r, w, st.top + y === st.sel));
  }
  const r = rowAt(st, st.sel);
  let info = "";
  if (r) { // the selected row in full: whole text, every file, the note, then whose
    const s = r.sess ? sessions.get(r.sess) : undefined;
    const files = r.files.map((f: FileRef) => (f.top && f.top !== st.b.anchor.top ? (worktree(r.sess) || "other") + ":" : "") + fileShown(f)).join(" ");
    const nt = note(st, r);
    info = clock(r.t) + " · " + (r.kind === "write" && files ? files : clean(r.text)) + (nt ? " · " + nt : "") + (s ? " · " + harnessOf(s.h).label + " · " + clean(titleOf(s)) : "");
  }
  L.push(fg(C.sub) + fit(" " + info, w) + RST);
  return L.map((l: string) => l + fillTo(l, w));
}
function render(): void {
  const st = stAt(); if (!st) return;
  const L = viewLines(st, S.W, S.H - 2);
  for (let y = 0; y < L.length; y++) put(0, 1 + y, L[y] ?? "");
}

// ── keys ──
function step(st: RState, d: number): void {
  const i = st.cycle.indexOf(st.minutes); // the configured value is in the cycle
  const j = Math.max(0, Math.min(st.cycle.length - 1, i + d));
  const m = st.cycle[j] ?? st.minutes;
  if (m === st.minutes) { say("info", "window is already ±" + String(m) + " min"); return; }
  rebuild(st, m); say("info", "window ±" + String(m) + " min");
}
function jump(st: RState, d: number): void {
  for (let k = 1; k <= st.vis.length; k++) {
    const i = ((st.sel + d * k) % st.vis.length + st.vis.length) % st.vis.length;
    const r = rowAt(st, i); if (r && flagged(r)) { st.sel = i; return; }
  }
  say("info", "no flagged rows in this view");
}
// the first timestamp the transcript's last 6 MB starts with (0: it holds the whole log, or no time found)
function tailStart(s: Sess): number {
  const src = sourceOf(s.h); const span = window(src, 6291456);
  if (s.size <= span) return 0;
  const at = src.align(s, s.size - span);
  for (const l of src.lines(s, at, Math.min(s.size, at + window(src, 65536))).lines) { const evs: Ev[] = []; parseEvents(s.h, l, evs, s); for (const e of evs) { const t = ms(e.ts); if (t) return t; } }
  return 0;
}
function enter(st: RState): void {
  const r = rowAt(st, st.sel); if (!r) return;
  if (!r.sess) { say("info", "no session recorded this commit (it came from the reflog)"); return; }
  const s = sessions.get(r.sess); if (!s) { say("warn", "that session is gone"); return; }
  const ts = tailStart(s);
  if (ts && r.t < ts) { say("info", "event is older than the loaded transcript (last 6 MB)"); return; }
  openTranscript(s);
  const t = S.tv; if (t) { t.focusKind = r.evKind; t.focusTs = r.ts; t.focusText = r.evId || r.evText; }
  st.inTx = true;
}
function keyView(st: RState, k: string): boolean {
  const h = rowsH();
  if (k === "?") return false;
  if (k === "esc" || k === "q" || k === "bs" || k === "backspace" || k === "left") { back(); return true; }
  if (k === "up") st.sel--; // k is the kind-set key here (spec 6): ↑ moves up
  else if (k === "down" || k === "j") st.sel++;
  else if (k === "wheelup") st.sel -= 3;
  else if (k === "wheeldown") st.sel += 3;
  else if (k === "pgup") st.sel -= h - 1;
  else if (k === "pgdn" || k === " ") st.sel += h - 1;
  else if (k === "g" || k === "home") st.sel = 0;
  else if (k === "G" || k === "end") st.sel = st.vis.length - 1;
  else if (k === "enter" || k === "right") enter(st);
  else if (k === "+" || k === "=") step(st, 1);
  else if (k === "-" || k === "_") step(st, -1);
  else if (k === "k") { st.kset = (st.kset + 1) % KIND_SETS.length; say("info", KIND_NAMES[st.kset] ?? ""); }
  else if (k === "o") { st.own = !st.own; say("info", st.own ? "own session shown" : "own session hidden"); }
  else if (k === "f") {
    if (!st.fileOnly && !anchorFiles(st).length) { say("info", "the anchor event names no files"); return true; }
    st.fileOnly = !st.fileOnly; say("info", st.fileOnly ? "only events touching the anchor's files" : "all files");
  }
  else if (k === "n") jump(st, 1);
  else if (k === "N") jump(st, -1);
  else if (k === "/") { S.inputErr = ""; ask("filter related (tool is Bash, harness is codex, file ~ src/)", NAME, st.q); }
  else if (k === "0") { st.centred = false; st.ver = ""; }
  return true;
}
function filterErr(t: string): string { if (!t.trim()) return ""; const p = parse(t); if (p.err) return p.err.msg; const c = compile(p.cs, "watch"); return c.err ? c.err.msg : ""; }

// ── registration ──
H.views.push({ name: NAME, render });
H.keys.push((mode: string, k: string): boolean => {
  const st = stAt();
  if (st && st.inTx && mode === "transcript" && (k === "esc" || k === "q" || k === "left")) { S.tv = null; S.mode = "view"; S.fview = NAME; st.inTx = false; return true; }
  if (k === "r" && (mode === "detail" || mode === "transcript")) {
    const t = S.tv; if (!t) return false;
    const i = mode === "detail" && S.dv ? S.dv.idx : t.cur >= 0 ? t.cur : shown(t) - 1;
    if (i < 0 || i >= t.evs.length) { say("info", "no event selected"); return true; }
    openRelated(t.s, t.evs, i); return true;
  }
  if (k === "r" && mode === "view" && S.fview === "call graph") {
    const a = graphAnchor(); if (!a) { say("info", "select a span with an event first"); return true; }
    openRelated(a.s, a.evs, a.i); return true;
  }
  if (mode !== "view" || S.fview !== NAME || !st) return false;
  return keyView(st, k);
});
H.mouse.push((mode: string, b: number, x: number, y: number, press: boolean): boolean => {
  const st = stAt();
  if (mode !== "view" || S.fview !== NAME || !st || y === S.H - 1) return false;
  if (b === 64 || b === 65) { keyView(st, b === 64 ? "wheelup" : "wheeldown"); return true; }
  if (!press || b !== 0) return false; // right-click falls through to esc = back
  const i = st.top + (y - 3);
  if (y >= 3 && y < 3 + rowsH() && i < st.vis.length) { if (i === st.sel) enter(st); else st.sel = i; }
  return true;
});
H.input.push((action: string, ev: string, text: string): boolean => {
  if (action !== NAME) return false;
  const st = stAt(); if (!st) return false;
  if (ev === "change") { S.inputErr = filterErr(text); return false; }
  if (ev === "esc") { S.inputErr = ""; return false; }
  if (ev !== "enter") return false;
  const e = filterErr(text); if (e) { S.inputErr = e; say("warn", e); return true; } // the last valid filter stays
  const t = text.trim();
  st.q = t; st.pred = t ? compile(parse(t).cs, "watch").f : null;
  return false;
});
H.onTick.push(() => {
  const st = stAt(); if (!st) return;
  if (S.fview !== NAME || (S.mode !== "view" && S.mode !== "help" && S.mode !== "input")) return;
  if (building(st)) { stepBuild(st.b, 50, () => Date.now()); S.dirty = true; return; }
  if (Date.now() - st.polled >= 2000) { st.polled = Date.now(); if (repoll(st.b, 50, () => Date.now())) S.dirty = true; }
});
H.backlog.push(() => { const st = stAt(); return st !== null && S.fview === NAME && S.mode === "view" && building(st); });
H.footerHints.push((mode: string): string[][] => {
  if (mode === "detail" || mode === "transcript") return R.st && R.st.inTx && mode === "transcript" ? [["r", "related"], ["esc", "back to related"]] : [["r", "related"]];
  if (mode === "view" && S.fview === "call graph") return [["r", "related"]];
  if (mode !== "view" || S.fview !== NAME) return [];
  return [["↵", "open"], ["+/-", "window"], ["k", "kinds"], ["f", "files"], ["n/N", "flagged"], ["/", "filter"]]; // 80 columns; o and the rest: ?
});
H.helpSections.push({ name: "related events", ctx: NAME, keys: [
  ["r", "related events around the event (detail, transcript cursor, call graph span)"],
  ["", "±N min in the same project, all sessions and harnesses; ▶ anchor · ‼ same file by two sessions or a git stash/checkout/reset over another's edits · ≈ same file in another worktree"],
  ["↑↓ j  g G  pgup pgdn", "move"], ["↵  click again", "open that session's transcript at the event (esc comes back)"],
  ["+  -", "window 2 / 5 / 10 / 30 / 60 min"], ["k", "kinds: default → all (reads, web, mcp) → writes only"], ["f", "only events touching the anchor's files"],
  ["o", "own session on / off"], ["n  N", "next / previous flagged row"], ["/", "filter: tool is Bash, harness is codex, file ~ src/ …"], ["esc  q", "back"],
  ["", "config related.minutes (10), related.conflictMinutes (10); writes through shell commands (sed -i, >) are not seen"]] });
