// agentglass — Sessions tab: the session/subagent list and the preview panel
// SPDX-License-Identifier: Apache-2.0
import { base } from "../util/json.ts";
import { width, clean, fit, fitStyled, fillTo, ago, bytes, home, localHM } from "../util/text.ts";
import type { Sess } from "../model/types.ts";
import { S } from "../state.ts";
import { H, BADGE_SLOT, enrich } from "../hooks.ts";
import { loadHead, loadTail, titleOf, working, activity, subActive, activeSubs, isOpen, parentOf, sessAt, current } from "../model/sessions.ts";
import { tmuxTarget } from "../model/procs.ts";
import { C, CSI, RST, fg, bg } from "./theme.ts";
import { put, box, badge, BADGE_W, spin } from "./screen.ts";
import { evLines } from "./transcript.ts";

// mouse hit map for the preview, rebuilt every frame
export const prevKind: number[] = []; export const prevIdx: number[] = []; // per preview row: 0 none, 1 subagent (idx into prevKids), 2 event (idx into prevSess.evs)
export const prevKids: Sess[] = [];

function statusGlyph(s: Sess): string {
  if (s.pid) {
    const busy = working(s) || Date.now() - s.mtime < 8000;
    return busy ? fg(C.green) + spin() + RST : fg(C.yellow) + "●" + RST;
  }
  if (Date.now() - s.mtime < 120000) return fg(C.green) + "○" + RST;
  return fg(C.dim) + "·" + RST;
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
  const chips = (S.hfilter ? S.hfilter + " · " : "") + (S.liveOnly ? "live · " : "") + (S.filter ? "/" + S.filter + " · " : "") + (S.fullq ? "F:" + S.fullq + " · " : "");
  box(0, 1, listW, lh, "sessions", chips + (S.view.length ? S.sel + 1 : 0) + "/" + S.view.length, S.mode === "list");
  if (S.sel < S.top) S.top = S.sel;
  if (S.sel >= S.top + listH) S.top = S.sel - listH + 1;
  const top = S.top;
  const iw = listW - 2;
  const slot = H.rowBadges.length ? BADGE_SLOT : 0;
  let pending = 0;
  for (let r = 0; r < listH; r++) {
    const s = sessAt(top + r);
    if (!s) { put(1, 2 + r, " ".repeat(iw)); continue; }
    if (!s.headDone && pending < 40) { loadHead(s); pending++; }
    const on = top + r === S.sel;
    const b = on ? bg(C.sel) : "";
    const cursor = b + (on ? fg(C.accent) + "❯" : " ") + RST + b;
    const tstyle = on ? fg(C.text) + CSI + "1m" : fg(C.sub);
    if (s.depth === 1) {
      const nx = sessAt(top + r + 1);
      const branch = nx && nx.depth === 1 ? "├─" : "└─";
      const glyph = subActive(s) ? fg(C.cyan) + spin() : fg(C.dim) + "·";
      const who = s.name ? s.name + " · " : "";
      put(1, 2 + r, cursor + "   " + fg(C.line) + branch + " " + glyph + RST + b + " " + fg(C.purple) + fit(s.kind, 16) + fg(C.dim) + fit(ago(s.mtime), 5) + RST + b + badgeSlot(s, b) + tstyle + fit(clean(who + titleOf(s)), iw - 30 - slot) + RST);
      continue;
    }
    const proj = base(s.cwd) || "?";
    const chip = s.subs.length ? (isOpen(s) ? "▾" : "▸") + "⑂" + activeSubs(s) + "/" + s.subs.length : "";
    const cw2 = chip ? Math.min(12, width(chip) + 1) : 0;
    const tw = iw - 21 - BADGE_W - cw2 - slot;
    const row = cursor + statusGlyph(s) + b + " " + badge(s.h) + b + fg(C.dim) + fit(ago(s.last), 4) + RST + b + fg(C.purple) + fit(proj, 13) + RST + b + " " + badgeSlot(s, b) +
      tstyle + fit(clean(titleOf(s)), tw) + RST + b + (activeSubs(s) ? fg(C.cyan) : fg(C.dim)) + fit(chip, cw2) + RST;
    put(1, 2 + r, row);
  }
  const s = current();
  const px = wide ? listW : 0; const py = wide ? 1 : 1 + lh; const pw = wide ? W - listW : W; const ph = wide ? bodyH : bodyH - lh;
  box(px, py, pw, ph, "preview", s ? s.h + " · " + bytes(s.size) : "", false);
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
    kv("id", s.id, C.sub);
    kv("cwd", home(s.cwd), C.purple);
    if (s.branch) kv("branch", s.branch, C.green);
    if (s.model) kv("model", s.model, C.cyan);
    kv("updated", ago(s.mtime) + " ago · " + new Date(s.mtime).toISOString().slice(0, 10) + " " + localHM(new Date(s.mtime).toISOString()), C.sub);
    if (s.pid) { const t = tmuxTarget(s.pid); kv("process", "pid " + s.pid + (s.status ? " · " + s.status : "") + (s.name ? " · " + s.name : "") + (t ? " · tmux " + t : ""), C.green); }
    else kv("process", s.archived ? "archived" : "not running", C.dim);
    if (s.depth === 1 || s.parent) { const par = parentOf(s); kv("subagent", s.kind + (s.name ? " · " + s.name : "") + (par ? "  ↰ " + titleOf(par) : ""), C.cyan); }
    for (const f of H.previewSections) for (const l of f(s, iw2)) lines.push(fitStyled(l, iw2));
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
    const act: string[] = []; const actEv: number[] = [];
    for (let i = Math.max(0, s.evs.length - 25); i < s.evs.length; i++) { evLines(s.evs[i], iw2, false, act); while (actEv.length < act.length) actEv.push(i); }
    const room = ph - 2 - lines.length;
    const from = Math.max(0, act.length - room);
    for (let i = from; i < act.length; i++) { lines.push(act[i]); hit(2, actEv[i]); }
  }
  for (let r = 0; r < ph - 2; r++) put(px + 1, py + 1 + r, " " + (lines[r] ?? "") + CSI + "0m" + " ".repeat(0) + fillTo(lines[r] ?? "", iw2) + " ");
}
