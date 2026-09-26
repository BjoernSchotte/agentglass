// agentglass — terminal lifecycle: raw mode, alt screen, mouse, size polling
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { S } from "./state.ts";
import { CSI } from "./ui/theme.ts";
import { H } from "./hooks.ts";

export function termSize(): void {
  const r = spawnSync("stty", ["size"], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
  const m = /(\d+)\s+(\d+)/.exec(r.stdout);
  const h = m ? Number(m[1]) : 24; const w = m ? Number(m[2]) : 80;
  if (h > 0 && w > 0 && (h !== S.H || w !== S.W)) { S.H = Math.max(10, h); S.W = Math.max(60, w); process.stdout.write(CSI + "2J"); }
}
export function enter(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h" + CSI + "2J"); // ?7l: no autowrap, overlong rows never scroll
  termSize();
}
export function leave(): void {
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}
export function quit(): never {
  for (const f of H.onQuit) { try { f(); } catch (e) { /* never block the exit */ } }
  leave(); process.exit(0);
}
