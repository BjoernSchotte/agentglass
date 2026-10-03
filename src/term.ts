// agentglass — terminal lifecycle: raw mode, alt screen, mouse, focus reporting, size polling
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { S } from "./state.ts";
import { CSI } from "./ui/theme.ts";
import { H } from "./hooks.ts";

let rawH = 0; let rawW = 0;
// true = the size changed: the screen was cleared and the caller must render now (S.repaint forces the write)
export function termSize(): boolean {
  const r = spawnSync("stty", ["size"], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  const m = /(\d+)\s+(\d+)/.exec(r.stdout);
  const h = m ? Number(m[1]) : 24; const w = m ? Number(m[2]) : 80;
  if (!(h > 0 && w > 0 && (h !== rawH || w !== rawW))) return false; // the raw size: below the minimum S.H/S.W differ from it
  rawH = h; rawW = w;
  S.H = Math.max(10, h); S.W = Math.max(60, w); process.stdout.write(CSI + "2J"); S.repaint = true; S.dirty = true;
  return true;
}
// focus report token (ESC[?1004h): "in", "out", or "" for anything else; never handled as a key
export function focusOf(t: string): string { return t === "\x1b[I" ? "in" : t === "\x1b[O" ? "out" : ""; }
export function enter(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[?1004h" + CSI + "2J"); // ?7l: no autowrap, overlong rows never scroll; ?1004h: focus in/out reports
  S.repaint = true; S.dirty = true; // cleared (also after a suspend for an editor/attach): the next frame is written in full
  termSize();
}
export function leave(): void {
  process.stdout.write("\x1b[?1004l\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
export function quit(): never {
  for (const f of H.onQuit) { try { f(); } catch (e) { /* never block the exit */ } }
  leave(); process.exit(0);
}
