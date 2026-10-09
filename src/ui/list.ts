// agentglass — Sessions tab: the session/subagent list and the preview panel
// SPDX-License-Identifier: Apache-2.0
import { base } from "../util/json.ts";
import { width, vwidth, clean, fit, fitStyled, fillTo, ago, bytes, home, localHM, localDay } from "../util/text.ts";
import type { Ev, Sess } from "../model/types.ts";
import { S } from "../state.ts";
import { H, BADGE_SLOT, enrich, boxChips, emptyText, rowPrefix } from "../hooks.ts";
import { loadHead, loadTail, titleOf, working, activity, subActive, activeSubs, isOpen, parentOf, sessAt, current, isLive, FRESH } from "../model/sessions.ts";
import { paneOfPid, paneText, paneTextIn } from "../mux/index.ts";
import { herdrRow } from "../mux/rowstate.ts";
import { C, CSI, RST, fg, bg } from "./theme.ts";
import { put, box, badge, BADGE_W, spin } from "./screen.ts";
import { evLines } from "./transcript.ts";
import { sourceOf } from "../harness/index.ts";
import { scrubRemote, remoteLabel } from "../util/giturl.ts";
import { link, sessUrl } from "../util/hyper.ts";
import { kindIds, kindVer } from "../model/kinds.ts";
import { mask as vfMask, fstate, active as vfActive, runs as vfRuns, gapText } from "./evfilter.ts";

// mouse hit map for the preview, rebuilt every frame
export const prevKind: number[] = []; export const prevIdx: number[] = []; // per preview row: 0 none, 1 subagent (idx into prevKids), 2 event (idx into prevSess.evs)
export const prevKids: Sess[] = [];
// the preview's activity lines (the last 25 events wrapped and styled) while the session's events are the same array (a
// tail read makes a new one), at the same width and colors: formatting them was the bulk of a frame
// With the preview's event-kind filter (ui/evfilter.ts, view "preview": linked views or the palette set it) the last 25 shown
// events, each run of hidden ones between them as one dim gap line
const ACT = { evs: [] as Ev[], n: -1, w: -1, theme: "", fk: "", lines: [] as string[], ev: [] as number[] };
export function actLines(s: Sess, w: number): string[] {
  const theme = C.text + C.cyan + C.dim + C.sel + C.sub + C.line + C.yellow + C.purple; // every color evLines uses: a theme may change any one
  const act = vfActive("preview"); const fk = act ? fstate("preview") + "|" + String(kindIds(s, s.evs).length) + ":" + String(kindVer(s.evs)) : "";
  if (ACT.evs === s.evs && ACT.n === s.evs.length && ACT.w === w && ACT.theme === theme && ACT.fk === fk) return ACT.lines;
  ACT.evs = s.evs; ACT.n = s.evs.length; ACT.w = w; ACT.theme = theme; ACT.fk = fk; ACT.lines = []; ACT.ev = [];
  const m = act ? vfMask("preview", s, s.evs) : null;
  let from = Math.max(0, s.evs.length - 25);
  if (m) { let k = 0; from = s.evs.length; while (from > 0 && k < 25) { from--; if (m[from] + 0 === 1) k++; } }
  for (let i = from; i < s.evs.length;) {
    if (!m || m[i] + 0 === 1) { evLines(s.evs[i], w, false, ACT.lines); while (ACT.ev.length < ACT.lines.length) ACT.ev.push(i); i++; continue; }
    let j = i; while (j < s.evs.length && m[j] + 0 === 0) j++;
    const g = vfRuns("preview", s, s.evs, i, j)[0];
    ACT.lines.push(fg(C.dim) + (g ? gapText(g, w) : "┄ " + String(j - i) + " hidden ┄") + RST); ACT.ev.push(i);
    i = j;
  }
  return ACT.lines;
}

// the status glyph's kind: b busy (spinner; also while herdr sees the agent working with its log quiet: a long tool run,
// a thinking model), l live idle ●, r recent ○, o old ·
export function glyphKind(s: Sess): string {
  if (s.host) return isLive(s) ? (s.status === "busy" ? "b" : "l") : FRESH.ok(s.host) && Date.now() - s.mtime < 120000 ? "r" : "o"; // a remote row: as its report says while fresh
  if (s.pid) return working(s) || Date.now() - s.mtime < 8000 || herdrRow(s) === "working" ? "b" : "l";
  return Date.now() - s.mtime < 120000 ? "r" : "o";
}
function statusGlyph(s: Sess): string {
  const k = glyphKind(s);
  return k === "b" ? fg(C.green) + spin() + RST : k === "l" ? fg(C.yellow) + "●" + RST : k === "r" ? fg(C.green) + "○" + RST : fg(C.dim) + "·" + RST;
}
// what the Sessions list and its preview show, without drawing them (main.ts: a frame is built when it moved). Each row
// as renderSessions draws it from these inputs; the preview by its session's fields, last events (the tail is read here
// as the frame would), its subagents and the usage its sections show
function rowKey(s: Sess, sub: boolean, last: boolean): string {
  const k = (sub ? (subActive(s) ? "A" : "a") + s.kind + "|" + agoK(s.mtime) + "|" + s.name + (last ? "L" : "") : glyphKind(s) + s.h + "|" + agoK(s.last) + "|" + s.cwd + "|" + (s.host ? (FRESH.ok(s.host) ? "f" : "s" + agoK(s.rat)) + "|" : "") +
    (s.subs.length ? (isOpen(s) ? "v" : ">") + String(activeSubs(s)) + "/" + String(s.subs.length) : ""));
  let b = ""; for (const f of H.rowBadges) b += f(s);
  return k + "|" + titleOf(s) + "|" + rowPrefix(s) + b + "|" + herdrRow(s);
}
function usageKey(s: Sess): string {
  return String(s.inTok) + "," + String(s.outTok) + "," + String(s.cacheRTok) + "," + String(s.cacheWTok) + "," + String(s.cost) + "," + String(s.unkTok) + "," + String(s.unkCr) + "," +
    String(s.tools) + "," + String(s.linesAdd) + "," + String(s.linesDel) + "," + s.bill + s.plan + s.billSrc + (s.attention ? "!" : "") + s.stuck;
}
// which sessions the visible rows show and each one's glyph kind (busy, live, recent, old): an unfocused TUI draws a
// change here at once (main.ts), the rest at its 5 s beat
export function listPresence(): string {
  let o = String(S.view.length);
  for (let r = 0; r < S.listH; r++) { const s = sessAt(S.top + r); if (!s) break; o += "|" + s.path + (s.depth === 1 ? (subActive(s) ? "A" : "a") : glyphKind(s)); }
  return o;
}
// clock false: without the "ago" texts (an unfocused TUI draws for a change of data, not of the clock)
const SIGT = { clock: true };
function agoK(t: number): string { return SIGT.clock ? ago(t) : ""; }
export function listSig(clock: boolean = true): string {
  SIGT.clock = clock;
  const o: string[] = [String(S.W) + "x" + String(S.H), String(S.top), String(S.sel), String(S.listH), String(S.view.length), boxChips("sessions", S.W)];
  for (let r = 0; r < S.listH; r++) {
    const s = sessAt(S.top + r); if (!s) break;
    const nx = sessAt(S.top + r + 1);
    o.push(rowKey(s, s.depth === 1, !(nx && nx.depth === 1)));
  }
  const s = current();
  if (s) {
    if (s.headDone) loadTail(s); // as the frame reads it (a head is read by the frame itself)
    const e = s.evs.length ? s.evs[s.evs.length - 1] : null;
    o.push(s.path + "|" + bytes(s.size) + "|" + (s.headDone ? "h" : "") + s.cwd + "|" + s.branch + "|" + s.remote + "|" + s.model + "|" + agoK(s.mtime) + "|" + String(s.pid) + s.status + s.name + "|" +
      (s.pid ? paneText(paneOfPid(s.pid)) : "") + "|" + (s.parent ? titleOf(parentOf(s) ?? s) : "") + "|" + String(s.evs.length) + (e ? e.kind + e.ts + String(e.text.length) : "") + "|" + usageKey(s));
    // the preview lists the 6 most active subagents (renderSessions' order); the usage sums all of them
    let u = 0; for (const c of s.subs) u += c.cost + c.inTok + c.outTok + c.cacheRTok + c.cacheWTok + c.tools + c.linesAdd + c.linesDel + c.unkTok;
    o.push(String(s.subs.length) + ":" + String(u));
    if (s.subs.length) for (const c of s.subs.slice().sort((a, b) => (subActive(b) ? 1 : 0) - (subActive(a) ? 1 : 0) || b.mtime - a.mtime).slice(0, 6))
      o.push(c.path + (subActive(c) ? "A" : "a") + agoK(c.mtime) + "|" + titleOf(c) + "|" + activity(c));
  }
  return o.join("\n");
}
// H.rowBadges slot: only takes room when a feature registered one
function badgeSlot(s: Sess, b: string): string {
  if (!H.rowBadges.length) return "";
  let g = ""; for (const f of H.rowBadges) g += f(s);
  const f = fitStyled(g, BADGE_SLOT);
  return f + b + fillTo(f, BADGE_SLOT);
}
export function renderSessions(): void {
  const W = S.W; const Ht = S.H;
  const wide = W >= 110;
  const bodyH = Ht - 2;
  S.listW = wide ? Math.floor(W * 0.52) : W;
  const lh = wide ? bodyH : Math.max(6, Math.floor(bodyH * 0.55));
  S.listX = 0; S.listY = 2; S.listH = lh - 2;
  const listH = S.listH; const listW = S.listW;
  const count = (S.view.length ? S.sel + 1 : 0) + "/" + S.view.length;
  const chips = boxChips("sessions", Math.max(8, listW - 16 - count.length));
  box(0, 1, listW, lh, "sessions", chips ? chips + " " + fg(C.dim) + count + RST : count, S.mode === "list");
  if (S.sel < S.top) S.top = S.sel;
  if (S.sel >= S.top + listH) S.top = S.sel - listH + 1;
  const top = S.top;
  const iw = listW - 2;
  const slot = H.rowBadges.length ? BADGE_SLOT : 0;
  let pending = 0;
  for (let r = 0; r < listH; r++) {
    const s = sessAt(top + r);
    if (!s) { const e = r === 0 && !S.view.length ? emptyText("sessions") : ""; put(1, 2 + r, e ? " " + fitStyled(e, iw - 1) + fillTo(fitStyled(e, iw - 1), iw - 1) : " ".repeat(iw)); continue; }
    if (!s.headDone && pending < 40) { loadHead(s); pending++; }
    const on = top + r === S.sel;
    const b = on ? bg(C.sel) : "";
    const cursor = b + (on ? fg(C.accent) + "❯" : " ") + RST + b;
    const tstyle = on ? fg(C.text) + CSI + "1m" : fg(C.sub);
    const pre = rowPrefix(s); const pw = pre ? vwidth(pre) : 0; const px = pre ? pre + RST + b : "";
    if (s.depth === 1) {
      const nx = sessAt(top + r + 1);
      const branch = nx && nx.depth === 1 ? "├─" : "└─";
      const glyph = subActive(s) ? fg(C.cyan) + spin() : fg(C.dim) + "·";
      const who = s.name ? s.name + " · " : "";
      put(1, 2 + r, cursor + "   " + fg(C.line) + branch + " " + glyph + RST + b + " " + fg(C.purple) + fit(s.kind, 16) + fg(C.dim) + fit(ago(s.mtime), 5) + RST + b + badgeSlot(s, b) + px + tstyle + fit(clean(who + titleOf(s)), iw - 30 - slot - pw) + RST);
      continue;
    }
    const proj = base(s.cwd) || "?";
    const chip = s.subs.length ? (isOpen(s) ? "▾" : "▸") + "⑂" + activeSubs(s) + "/" + s.subs.length : "";
    const cw2 = chip ? Math.min(12, width(chip) + 1) : 0;
    const tw = iw - 21 - BADGE_W - cw2 - slot - pw;
    const stale = s.host !== "" && !FRESH.ok(s.host); // a stale remote row: dimmed, the age of its report with a "?"
    const row = cursor + statusGlyph(s) + b + " " + badge(s.h) + b + fg(C.dim) + fit(stale ? ago(s.rat) + "?" : ago(s.last), 4) + RST + b + fg(stale ? C.dim : C.purple) + fit(proj, 13) + RST + b + " " + badgeSlot(s, b) +
      px + (stale ? fg(C.dim) : tstyle) + fit(clean(titleOf(s)), tw) + RST + b + (activeSubs(s) ? fg(C.cyan) : fg(C.dim)) + fit(chip, cw2) + RST;
    put(1, 2 + r, row);
  }
  const s = current();
  const px = wide ? listW : 0; const py = wide ? 1 : 1 + lh; const pw = wide ? W - listW : W; const ph = wide ? bodyH : bodyH - lh;
  box(px, py, pw, ph, "preview", s ? s.h + (sourceOf(s.h).unit === 1 ? " · " + bytes(s.size) : "") : "", false); // a row cursor is no size
  const iw2 = pw - 4;
  const lines: string[] = [];
  prevKind.length = 0; prevIdx.length = 0; prevKids.length = 0; S.prevSess = s; S.prevY0 = py + 1; S.prevX0 = px; S.prevX1 = px + pw;
  const hit = (kind: number, idx: number): void => { while (prevKind.length < lines.length - 1) { prevKind.push(0); prevIdx.push(0); } prevKind.push(kind); prevIdx.push(idx); };
  if (s) {
    if (!s.headDone) loadHead(s);
    loadTail(s);
    enrich(s);
    lines.push(fg(C.text) + CSI + "1m" + fit(clean(titleOf(s)), iw2) + RST);
    const kv = (k: string, v: string, c: string): void => { lines.push(fg(C.dim) + fit(k, 9) + RST + fg(c) + fit(clean(v), iw2 - 9) + RST); };
    const idf = fit(clean(s.id), iw2 - 9); const idt = idf.trimEnd(); // the id links to the session (OSC 8 terminals)
    lines.push(fg(C.dim) + fit("id", 9) + RST + fg(C.sub) + link(sessUrl(s.h, s.id), idt) + idf.slice(idt.length) + RST);
    kv("cwd", home(s.cwd), C.purple);
    if (s.branch) kv("branch", s.branch, C.green);
    if (s.remote) { const r = scrubRemote(s.remote); if (r) kv("remote", remoteLabel(r), C.green); }
    if (s.model) kv("model", s.model, C.cyan);
    kv("updated", ago(s.mtime) + " ago · " + localDay(new Date(s.mtime).toISOString()) + " " + localHM(new Date(s.mtime).toISOString()), C.sub); // both local: a UTC day next to a local clock was off by one around midnight
    if (s.host) { for (const f of H.remoteCard) for (const l of f(s, iw2)) lines.push(fitStyled(l, iw2)); } // a remote row: its report's facts, nothing read here
    else if (s.pid) { const pre = "pid " + s.pid + (s.status ? " · " + s.status : "") + (s.name ? " · " + s.name : ""); const t = paneTextIn(paneOfPid(s.pid), iw2 - 9 - Array.from(pre).length - 3); kv("process", pre + (t ? " · " + t : ""), C.green); }
    else kv("process", s.archived ? "archived" : "not running", C.dim);
    if (!s.host && (s.depth === 1 || s.parent)) { const par = parentOf(s); kv("subagent", s.kind + (s.name ? " · " + s.name : "") + (par ? "  ↰ " + titleOf(par) : ""), C.cyan); }
    if (!s.host) for (const f of H.previewSections) for (const l of f(s, iw2)) lines.push(fitStyled(l, iw2));
    if (s.subs.length) {
      lines.push(fg(C.line) + "─ " + fg(C.cyan) + "subagents " + fg(C.dim) + activeSubs(s) + " active / " + s.subs.length + RST);
      const kids = s.subs.slice().sort((a, b) => (subActive(b) ? 1 : 0) - (subActive(a) ? 1 : 0) || b.mtime - a.mtime).slice(0, 6);
      for (const c of kids) {
        loadTail(c);
        const g = subActive(c) ? fg(C.cyan) + spin() : fg(C.dim) + "·";
        prevKids.push(c);
        lines.push(g + " " + fg(C.purple) + fit(c.kind, 14) + fg(C.dim) + fit(ago(c.mtime), 5) + fg(C.sub) + fit(clean(titleOf(c)), Math.max(10, Math.floor((iw2 - 21) / 2))) + fg(C.dim) + " " + fit(clean(activity(c)), Math.max(0, iw2 - 22 - Math.max(10, Math.floor((iw2 - 21) / 2)))) + RST);
        hit(1, prevKids.length - 1);
      }
    }
    lines.push(fg(C.line) + "─".repeat(iw2) + RST);
    actLines(s, iw2); const act = ACT.lines; const actEv = ACT.ev;
    const room = ph - 2 - lines.length;
    const from = Math.max(0, act.length - room);
    for (let i = from; i < act.length; i++) { lines.push(act[i]); hit(2, actEv[i]); }
  }
  for (let r = 0; r < ph - 2; r++) put(px + 1, py + 1 + r, " " + (lines[r] ?? "") + CSI + "0m" + " ".repeat(0) + fillTo(lines[r] ?? "", iw2) + " ");
}
