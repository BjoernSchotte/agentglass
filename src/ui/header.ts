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
  const sep = fg(C.dim) + " · " + RST; const lv = fg(C.green) + "● " + live + " live" + RST; const bz = fg(C.yellow) + busy + " busy" + RST;
  const cpuS = fg(C.sub) + "cpu " + RST + fg(heat(cpu / 400)) + cpu.toFixed(1) + "% " + spark + RST;
  // the stats on the right, widest first; below 100 columns they step down so the widgets (alarms ◆ ⚠, cost) keep a
  // place (wider: the established split, cpu and memory stay)
  const rights = [lv + sep + bz + sep + cpuS + sep + fg(C.text) + bytes(mem) + RST + fg(C.dim) + (W >= 190 ? "/" + bytes(TOTALMEM) + " · " + sessions.size + " sessions" : "") + " " + RST, // totals only when wide: widgets need the room
    lv + sep + bz + " ", lv + " ", ""];
  // full tab names; when they leave no room for a widget with something to say (alarms, cost) or for anything at all
  // on the right (60 columns), the other tabs show only their number key
  let L = layout(W, tabs, false, rights);
  if (L.lost || (L.ri === rights.length - 1 && fixed(Math.max(0, W - L.x)) === "")) L = layout(W, tabs, true, rights);
  tabX0.length = 0; tabX1.length = 0;
  for (let i = 0; i < L.x0.length; i++) { tabX0.push(L.x0[i]); tabX1.push(L.x1[i]); }
  const right = rights[L.ri]; const rw = width(right.replace(ESC_RE, ""));
  const free = Math.max(0, W - L.x - rw); const wid = widgets(free);
  const ww = width(wid.replace(ESC_RE, ""));
  put(0, 0, L.s + wid + " ".repeat(Math.max(0, free - ww)) + (W - L.x > rw ? right : ""));
}
interface Layout { s: string; x: number; x0: number[]; x1: number[]; ri: number; lost: boolean }
// logo + tabs (compact: the inactive ones as their number) and which of the right-hand stats fit beside the widgets;
// lost: a widget has something to say but no room
function layout(W: number, tabs: string[], compact: boolean, rights: string[]): Layout {
  let s = bg(C.accent) + fg(C.panel) + CSI + "1m" + " ◈ agentglass " + RST + " ";
  let x = width(" ◈ agentglass  "); const x0: number[] = []; const x1: number[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const t = compact && i !== S.tab ? " " : " " + tabs[i] + " ";
    s += (i === S.tab ? bg(C.sel) + fg(C.text) + CSI + "1m" + CSI + "4m" : fg(C.sub)) + (i + 1) + t + RST + " ";
    x0.push(x); x += width(t) + 2; x1.push(i === tabs.length - 1 ? x + 1 : x);
  }
  const want = W < 100 && fixed(Math.max(0, W - x)) !== ""; // a widget has something to say
  let ri = 0;
  for (; ri < rights.length; ri++) {
    const rw = width(rights[ri].replace(ESC_RE, ""));
    if (W - x > rw && (!want || fixed(W - x - rw) !== "")) break;
  }
  if (ri === rights.length) ri = rights.length - 1;
  return { s, x, x0, x1, ri, lost: W < 100 && fixed(Math.max(0, W - x)) === "" && fixed(W) !== "" };
}
// the fixed-size header widgets that fit in free columns ("" = none)
function fixed(free: number): string {
  const parts: string[] = []; let used = 0;
  if (free > 1) for (const f of H.headerWidgets) {
    const w = f(Math.max(0, free - 1 - used)); const ww = width(w.replace(ESC_RE, ""));
    if (!w || ww > free - 1 - used) continue; // not every widget sizes itself (the alarm counts)
    parts.push(w); used += ww + 1;
  }
  return parts.join(" ");
}
// those plus the flexible one (the ticker) in the rest; called once a frame: the ticker keeps its slot width
function widgets(free: number): string {
  if (!(H.headerWidgets.length || H.headerFlex.length) || free <= 1) return "";
  const fx = fixed(free); const parts: string[] = fx ? [fx] : [];
  const room = free - 1 - (fx ? width(fx.replace(ESC_RE, "")) + 1 : 0) - 2;
  if (room > 8) for (const f of H.headerFlex) { const w = f(room); if (w) { parts.push(fg(C.line) + "│" + RST + " " + w); break; } }
  return parts.length ? fitStyled(parts.join(" "), free - 1) : "";
}
