// agentglass — frame diff: a built frame is written only when it differs from the last one written
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";

let last = "";
// true = written; S.repaint (screen cleared, e.g. resize) forces the write of an identical frame
export function flush(frame: string, out: (s: string) => void): boolean {
  if (!S.repaint && frame === last) return false;
  out(frame); last = frame; S.repaint = false;
  return true;
}
// a write of part of the screen (the header row on a marquee step): the screen no longer shows the last full frame
export function partial(s: string, out: (s: string) => void): void { out(s); last = ""; }
// forget the last frame (focus-in: the terminal may have dropped what it showed)
export function resetFrame(): void { last = ""; }
