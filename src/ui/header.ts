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
  const tabs = [" Sessions ", " Processes "];
  for (const t of H.tabs) tabs.push(" " + t.name + " ");
  let x = 0;
  let s = bg(C.accent) + fg(C.panel) + CSI + "1m" + " ◈ agentglass " + RST + " ";
  x = 16;
  tabX0.length = 0; tabX1.length = 0;
  for (let i = 0; i < tabs.length; i++) {
    s += (i === S.tab ? bg(C.sel) + fg(C.text) + CSI + "1m" + CSI + "4m" : fg(C.sub)) + (i + 1) + tabs[i] + RST + " ";
    tabX0.push(x);
    x += tabs[i].length + 2;
    tabX1.push(i === tabs.length - 1 ? x + 1 : x);
  }
  const spark = braille(cpuHist, W >= 150 ? 16 : 6, 1, Math.max(100, Math.max(...cpuHist.slice(-32))))[0];
  const sep = fg(C.dim) + " · " + RST; const lv = fg(C.green) + "● " + live + " live" + RST; const bz = fg(C.yellow) + busy + " busy" + RST;
  const cpuS = fg(C.sub) + "cpu " + RST + fg(heat(cpu / 400)) + cpu.toFixed(1) + "% " + spark + RST;
  // the stats on the right, widest first; below 100 columns they step down so the widgets (alarms ◆ ⚠, cost) keep a
  // place (wider: the established split, cpu and memory stay)
  const rights = [lv + sep + bz + sep + cpuS + sep + fg(C.text) + bytes(mem) + RST + fg(C.dim) + (W >= 190 ? "/" + bytes(TOTALMEM) + " · " + sessions.size + " sessions" : "") + " " + RST, // totals only when wide: widgets need the room
    lv + sep + bz + " ", lv + " ", ""];
  const want = W < 100 && fixed(Math.max(0, W - x)) !== ""; // a widget has something to say
  let right = ""; let rw = 0;
  for (const r of rights) {
    right = r; rw = width(r.replace(ESC_RE, ""));
    if (W - x > rw && (!want || fixed(W - x - rw) !== "")) break;
  }
  const free = Math.max(0, W - x - rw); const wid = widgets(free);
  const ww = width(wid.replace(ESC_RE, ""));
  put(0, 0, s + wid + " ".repeat(Math.max(0, free - ww)) + (W - x > rw ? right : ""));
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
