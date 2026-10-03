// agentglass — Processes tab: harness process table, cpu/mem graphs, process tree
// SPDX-License-Identifier: Apache-2.0
import { totalmem } from "node:os";
import { clean, fit, fitStyled, fillTo, bytes, home } from "../util/text.ts";
import { S } from "../state.ts";
import { display, boxChips } from "../hooks.ts";
import { titleOf } from "../model/sessions.ts";
import { procs, procView, allProcs, hist, procAt, procSess, tmuxTarget } from "../model/procs.ts";
import { C, CSI, RST, fg, bg, heat } from "./theme.ts";
import { put, box, badge, BADGE_W, braille, gauge } from "./screen.ts";

export const TOTALMEM = totalmem();

export function renderProcs(): void {
  const W = S.W;
  const bodyH = S.H - 2;
  const th = Math.max(6, Math.floor(bodyH * 0.5));
  S.listX = 0; S.listY = 3; S.listH = th - 3; S.listW = W;
  const listH = S.listH;
  const hid = procs.length - procView.length; const ch = boxChips("processes", Math.max(10, W - 40));
  box(0, 1, W, th, "harness processes", (ch ? ch + " " : "") + procView.length + " roots" + (hid > 0 ? " · pins hide " + hid : ""), S.mode === "list");
  const cols = fg(C.dim) + CSI + "1m" + fit("  PID", 8) + fit("AGENT", BADGE_W + 1) + fit("CPU%", 7) + fit("MEM", 7) + fit("KIDS", 5) + fit("UP", 12) + fit("CPU GRAPH", 17) + fit("SESSION / CWD", W - 69) + RST;
  put(1, 2, cols);
  if (S.psel >= procView.length) S.psel = Math.max(0, procView.length - 1);
  if (S.psel < S.ptop) S.ptop = S.psel;
  if (S.psel >= S.ptop + listH) S.ptop = S.psel - listH + 1;
  for (let r = 0; r < listH; r++) {
    const p = procAt(S.ptop + r);
    if (!p) { put(1, 3 + r, " ".repeat(W - 2)); continue; }
    const on = S.ptop + r === S.psel;
    const b = on ? bg(C.sel) : "";
    const s = procSess(p);
    const sCwd: string = s ? s.cwd : ""; const pCwd: string = home(display("cwd", p.cwd, null));
    const where = s ? clean(titleOf(s)) + "  " + (sCwd !== "" ? home(sCwd) : pCwd) : pCwd !== "" ? pCwd : display("args", p.args, null);
    const ph0 = hist.get(p.pid) ?? [];
    const g = braille(ph0, 16, 1, Math.max(20, Math.max(...ph0)))[0];
    put(1, 3 + r, b + (on ? fg(C.accent) + "❯" : " ") + fg(C.sub) + fit(String(p.pid), 7) + RST + badge(p.h) + b + " " + fg(heat(p.tcpu / 100)) + fit(p.tcpu.toFixed(1), 7) + fg(C.text) + fit(bytes(p.trss), 7) +
      fg(C.sub) + fit(String(p.kids), 5) + fit(p.etime, 12) + fg(heat(Math.min(1, p.tcpu / 100))) + g + " " + (s ? fg(C.text) : fg(C.dim)) + fit(where, W - 69) + RST);
  }
  // detail
  const p = procAt(S.psel);
  const dy = 1 + th; const dh = bodyH - th;
  box(0, dy, W, dh, p ? "pid " + p.pid + " · " + p.h : "detail", p ? "cpu " + p.tcpu.toFixed(1) + "% · " + bytes(p.trss) : "", false);
  const gw = Math.min(40, Math.floor(W * 0.35));
  const lines: string[] = [];
  if (p) {
    const hh = hist.get(p.pid) ?? [];
    const gh = Math.max(2, Math.min(8, dh - 6));
    const peak = Math.max(10, Math.max(...hh));
    const gl = braille(hh, gw, gh, peak);
    for (let i = 0; i < gh; i++) lines.push(fg(heat(1 - i / gh)) + gl[i] + RST);
    lines.push(fg(C.dim) + fit("cpu (" + (hh.length * 1.5).toFixed(0) + "s)  peak " + peak.toFixed(0) + "%", gw) + RST);
    lines.push(fg(C.dim) + "mem " + RST + gauge(p.trss / TOTALMEM, gw - 11) + fg(C.sub) + " " + fit((p.trss / TOTALMEM * 100).toFixed(1) + "%", 6) + RST);
    const tt = tmuxTarget(p.pid);
    lines.push(fg(C.dim) + "tty " + RST + fg(C.sub) + fit(p.tty + (tt ? "  tmux " + tt : ""), gw - 4) + RST);
  }
  // tree to the right
  const tree: string[] = [];
  if (p) {
    tree.push(fg(C.text) + CSI + "1m" + clean(display("args", p.args, null)) + RST);
    tree.push(fg(C.purple) + home(display("cwd", p.cwd, null)) + RST);
    const walk = (pid: number, depth: number): void => {
      for (const q of allProcs.values()) {
        if (q.ppid !== pid) continue;
        tree.push(fg(C.line) + "  ".repeat(depth) + "└─ " + fg(C.sub) + fit(String(q.pid), 7) + fg(heat(q.cpu / 100)) + fit(q.cpu.toFixed(1) + "%", 7) + fg(C.dim) + fit(bytes(q.rss), 7) + fg(q.h ? C.claude : C.text) + clean(display("args", q.args, null)) + RST);
        if (depth < 6) walk(q.pid, depth + 1);
      }
    };
    walk(p.pid, 0);
  }
  const tw = W - gw - 8;
  for (let r = 0; r < dh - 2; r++) {
    const l = lines[r] ?? ""; const t = tree[r] ?? "";
    const tv2 = t ? fitStyled(t, tw) : "";
    put(1, dy + 1 + r, " " + l + fillTo(l, gw) + "  " + fg(C.line) + "│ " + RST + tv2 + fillTo(tv2, tw) + " ");
  }
}
