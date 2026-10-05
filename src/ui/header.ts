// agentglass — header bar: logo, tabs, feature widgets, live/cpu/mem stats
// SPDX-License-Identifier: Apache-2.0
import { width, fitStyled, bytes, ESC_RE } from "../util/text.ts";
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { sessions, working } from "../model/sessions.ts";
import { procs, cpuHist } from "../model/procs.ts";
import { C, CSI, RST, fg, bg, heat } from "./theme.ts";
import { put, braille } from "./screen.ts";
import { TOTALMEM } from "./procs.ts";

// clickable tab spans, rebuilt every frame
export const tabX0: number[] = []; export const tabX1: number[] = [];

export function renderHeader(): void {
  const W = S.W;
  let live = 0; let busy = 0;
  for (const s of sessions.values()) if (s.pid) { live++; if (working(s)) busy++; }
  const cpu = cpuHist.length ? cpuHist[cpuHist.length - 1] : 0;
  let mem = 0; for (const p of procs) mem += p.trss;
  const tabs = ["Sessions", "Processes"];
  for (const t of H.tabs) tabs.push(t.name);
  const spark = braille(cpuHist, W >= 150 ? 16 : 6, 1, Math.max(100, Math.max(...cpuHist.slice(-32))))[0];
  const sep = fg(C.dim) + " · " + RST;
  // the stats on the right, widest first; they step down so the widgets (alarms ◆ ⚠, cost) keep a place: the live
  // count goes last, as "●N" before it goes
  const stats = (lvN: string, bzN: string, cpuT: string, memT: string): string[] => {
    const lv = fg(C.green) + "● " + lvN + " live" + RST; const bz = fg(C.yellow) + bzN + " busy" + RST;
    const cpuS = fg(C.sub) + "cpu " + RST + fg(heat(cpu / 400)) + cpuT + "% " + spark + RST;
    return [lv + sep + bz + sep + cpuS + sep + fg(C.text) + memT + RST + fg(C.dim) + (W >= 190 ? "/" + bytes(TOTALMEM) + " · " + sessions.size + " sessions" : "") + " " + RST, // totals only when wide: widgets need the room
      lv + sep + bz + " ", lv + " ", fg(C.green) + "●" + lvN + RST + " ", ""];
  };
  const rights = stats(String(live), String(busy), cpu.toFixed(1), bytes(mem));
  // the step is chosen on the widths with counts of two digits and cpu/memory at five characters: a count gaining a digit
  // (9 → 10 live) or cpu crossing 10% must not flip the stats (or the tab names) from one tick to the next
  const wide = stats(String(live).padStart(2, "0"), String(busy).padStart(2, "0"), cpu.toFixed(1).padStart(5, "0"), bytes(mem).padStart(5, "0"));
  // full tab names; when they leave no room for a widget with something to say (alarms, cost) or for the live count,
  // the other tabs show only their number key (the count tells more than the names, which the keys 1-4 do not need)
  let L = layout(W, tabs, false, wide);
  if (L.lost || L.ri === wide.length - 1 || L.k < fits(Math.max(0, W - L.x)).length) {
    const K = layout(W, tabs, true, wide);
    if (L.lost || K.k > L.k || (K.k === L.k && K.ri < L.ri && L.ri === wide.length - 1)) L = K;
  }
  tabX0.length = 0; tabX1.length = 0;
  for (let i = 0; i < L.x0.length; i++) { tabX0.push(L.x0[i]); tabX1.push(L.x1[i]); }
  const rw = width(wide[L.ri].replace(ESC_RE, "")); const sh = rights[L.ri]; // shown left-aligned in the measured width
  const right = sh + " ".repeat(Math.max(0, rw - width(sh.replace(ESC_RE, ""))));
  const free = Math.max(0, W - L.x - rw); const wid = widgets(free);
  const ww = width(wid.replace(ESC_RE, ""));
  put(0, 0, L.x > W ? fitStyled(L.s, W) : L.s + wid + " ".repeat(Math.max(0, free - ww)) + (W - L.x > rw ? right : "")); // a badge can push the last tabs off a very narrow row
}
interface Layout { s: string; x: number; x0: number[]; x1: number[]; ri: number; k: number; lost: boolean }
// logo + tabs (compact: the inactive ones as their number) and which of the right-hand stats fit beside the widgets;
// k: how many widgets keep their place; lost: a widget has something to say but no room
function layout(W: number, tabs: string[], compact: boolean, rights: string[]): Layout {
  let s = bg(C.accent) + fg(C.panel) + CSI + "1m" + " ◈ agentglass " + RST + " ";
  let x = width(" ◈ agentglass  "); const x0: number[] = []; const x1: number[] = [];
  for (const f of H.headerBadge) { const b = f(); if (b) { s += b + " "; x += width(b.replace(ESC_RE, "")) + 1; } } // never dropped: the tabs move over
  for (let i = 0; i < tabs.length; i++) {
    const t = compact && i !== S.tab ? " " : " " + tabs[i] + " ";
    s += (i === S.tab ? bg(C.sel) + fg(C.text) + CSI + "1m" + CSI + "4m" : fg(C.sub)) + (i + 1) + t + RST + " ";
    x0.push(x); x += width(t) + 2; x1.push(i === tabs.length - 1 ? x + 1 : x);
  }
  // the widest stats beside every widget with something to say; when even "●N" leaves no room for them all, the last
  // widgets give way (registered by rank: alarms before cost), and the stats go only when nothing else fits
  const want = fits(Math.max(0, W - x)).length;
  let ri = rights.length - 1; let k = want;
  for (; k >= 0 && ri === rights.length - 1; k--) {
    for (let i = 0; i < rights.length - 1; i++) {
      const rw = width(rights[i].replace(ESC_RE, ""));
      if (W - x > rw && fits(W - x - rw).length >= k) { ri = i; break; }
    }
  }
  return { s, x, x0, x1, ri, k: ri === rights.length - 1 ? fits(Math.max(0, W - x)).length : k + 1, lost: want === 0 && fixed(W) !== "" };
}
// the fixed-size header widgets that fit in free columns ("" = none)
function fixed(free: number): string { return fits(free).join(" "); }
function fits(free: number): string[] {
  const parts: string[] = []; let used = 0;
  if (free > 1) for (const f of H.headerWidgets) {
    const w = f(Math.max(0, free - 1 - used)); const ww = width(w.replace(ESC_RE, ""));
    if (!w || ww > free - 1 - used) continue; // not every widget sizes itself (the alarm counts)
    parts.push(w); used += ww + 1;
  }
  return parts;
}
// those plus the flexible one (the ticker) in the rest; called once a frame: the ticker keeps its slot width
function widgets(free: number): string {
  if (!(H.headerWidgets.length || H.headerFlex.length) || free <= 1) return "";
  const fx = fixed(free); const parts: string[] = fx ? [fx] : [];
  const room = free - 1 - (fx ? width(fx.replace(ESC_RE, "")) + 1 : 0) - 2;
  if (room > 8) for (const f of H.headerFlex) { const w = f(room); if (w) { parts.push(fg(C.line) + "│" + RST + " " + w); break; } }
  return parts.length ? fitStyled(parts.join(" "), free - 1) : "";
}
