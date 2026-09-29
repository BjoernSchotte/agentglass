// agentglass — header bar: logo, tabs, feature widgets, live/cpu/mem stats
// SPDX-License-Identifier: Apache-2.0
import { width, fitStyled, bytes } from "../util/text.ts";
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
  const right = fg(C.green) + "● " + live + " live" + RST + fg(C.dim) + " · " + RST + fg(C.yellow) + busy + " busy" + RST + fg(C.dim) + " · " + RST +
    fg(C.sub) + "cpu " + RST + fg(heat(cpu / 400)) + cpu.toFixed(1) + "% " + spark + RST + fg(C.dim) + " · " + RST +
    fg(C.text) + bytes(mem) + RST + fg(C.dim) + (W >= 190 ? "/" + bytes(TOTALMEM) + " · " + sessions.size + " sessions" : "") + " " + RST; // totals only when wide: widgets need the room
  const rw = width(right.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
  const free = Math.max(0, W - x - rw);
  let wid = "";
  if ((H.headerWidgets.length || H.headerFlex.length) && free > 1) {
    const parts: string[] = [];
    let used = 0;
    for (const f of H.headerWidgets) {
      const w = f(Math.max(0, free - 1 - used));
      if (!w) continue;
      parts.push(w); used += width(w.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")) + 1;
    }
    const room = free - 1 - used - 2;
    if (room > 8) for (const f of H.headerFlex) { const w = f(room); if (w) { parts.push(fg(C.line) + "│" + RST + " " + w); break; } }
    if (parts.length) wid = fitStyled(parts.join(" "), free - 1);
  }
  const ww = width(wid.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""));
  put(0, 0, s + wid + " ".repeat(Math.max(0, free - ww)) + (W - x > rw ? right : ""));
}
