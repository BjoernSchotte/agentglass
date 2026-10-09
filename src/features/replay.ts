// agentglass — session replay: P in the transcript plays it back as a time-lapse, paced by the events' own timestamps
// SPDX-License-Identifier: Apache-2.0
import { S, type TV } from "../state.ts";
import { H } from "../hooks.ts";
import { C, CSI, RST, fg } from "../ui/theme.ts";
import { active, mask } from "../ui/evfilter.ts";

const SPEEDS = [1, 4, 16, 64];
const R = { tv: null as TV | null, on: false, paused: false, sp: 2, next: 0 };

function ms(ts: string): number { const v = ts ? new Date(ts).getTime() : 0; return v > 0 ? v : 0; }
function speed(): number { return SPEEDS[R.sp] ?? 16; }
// the transcript's kind filter: replay reveals only the events it shows (hidden ones become its gap lines)
function on(t: TV, i: number): boolean { return !active("transcript") || mask("transcript", t.s, t.evs)[i] + 0 === 1; }
// the next shown event at or after i (evs.length: none)
function nextOn(t: TV, i: number): number { let j = Math.max(0, i); while (j < t.evs.length && !on(t, j)) j++; return j; }
// real wait before revealing evs[i]: the recorded gap to the shown event before it, clamped, sped up
function delay(t: TV, i: number): number {
  if (i < 1 || i >= t.evs.length) return 0;
  let p = i - 1; while (p > 0 && !on(t, p)) p--;
  const a = ms(t.evs[p].ts); const b = ms(t.evs[i].ts);
  const gap = a && b ? Math.max(40, Math.min(2500, b - a)) : 300;
  return gap / speed();
}
function stop(): void {
  const t = R.tv;
  if (t) { t.limit = -1; t.follow = true; }
  R.on = false; R.tv = null;
}
function start(t: TV): void {
  // from the cursor if the user moved it up, else from the top
  const from = !t.follow && t.cur >= 0 && t.cur < t.evs.length - 1 ? t.cur + 1 : 1;
  t.limit = Math.min(from, t.evs.length); t.follow = true;
  R.tv = t; R.on = true; R.paused = false; R.next = Date.now() + delay(t, nextOn(t, t.limit));
}
// reveal up to the next shown event; at the end the replay hands back to live follow
function step(t: TV): void {
  t.limit = nextOn(t, t.limit) + 1; t.follow = true;
  const nx = nextOn(t, t.limit);
  if (nx >= t.evs.length) stop();
  else R.next = Date.now() + delay(t, nx);
}
// ←: back to before the previous shown event
function back(t: TV): void { let j = Math.max(1, t.limit - 1); while (j > 1 && !on(t, j - 1)) j--; t.limit = j; t.follow = true; }
function hms(ts: string): string {
  const v = ms(ts);
  if (!v) return "--:--:--";
  const d = new Date(v);
  const p = (n: number): string => (n < 10 ? "0" : "") + n;
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

export function replaying(): boolean { return R.on; }
H.fastArmed.push(replaying);
H.onFastTick.push(() => {
  const t = R.tv;
  if (!R.on || !t) return false;
  if (S.tv !== t) { stop(); return false; } // transcript closed or switched (n/N/u)
  if (R.paused || S.mode !== "transcript" || Date.now() < R.next) return false;
  step(t);
  return true;
});

H.keys.push((mode: string, k: string) => {
  if (mode !== "transcript") return false;
  const t = S.tv;
  if (!t) return false;
  if (!R.on || R.tv !== t) {
    if (k !== "P") return false;
    if (t.evs.length > 1) start(t);
    return true;
  }
  if (k === "P" || k === "esc") stop();
  else if (k === " ") { R.paused = !R.paused; if (!R.paused) R.next = Date.now() + delay(t, nextOn(t, t.limit)); }
  else if (k === "+" || k === "=") R.sp = Math.min(SPEEDS.length - 1, R.sp + 1);
  else if (k === "-") R.sp = Math.max(0, R.sp - 1);
  else if (k === "right") step(t);
  else if (k === "left") { R.paused = true; back(t); }
  else return false;
  return true;
});

H.headerWidgets.push((w: number) => {
  const t = R.tv;
  if (!R.on || !t || S.tv !== t || w < 12) return "";
  const i = Math.min(t.limit, t.evs.length);
  const last = i > 0 ? t.evs[i - 1].ts : "";
  return fg(R.paused ? C.yellow : C.green) + CSI + "1m" + (R.paused ? "⏸ " : "▶ ") + speed() + "×" + RST +
    fg(C.dim) + " · " + RST + fg(C.text) + hms(last) + RST + fg(C.dim) + " · " + RST + fg(C.sub) + i + "/" + t.evs.length + RST;
});

H.footerHints.push((mode: string) => {
  if (mode !== "transcript") return [];
  return R.on && R.tv === S.tv ? [["␣", "pause", "1"], ["+/-", "speed"], ["←/→", "step"], ["P", "stop", "1"]] : [["P", "replay"]]; // tier 1 while it plays: kept before the transcript's own keys
});

H.helpSections.push({ name: "replay", ctx: "transcript", keys: [
  ["P", "replay as a time-lapse (from the cursor, else from the top)"], ["␣", "pause / resume"],
  ["+  -", "speed 1× 4× 16× 64×"], ["→  ←", "step one event forward / back (back pauses)"], ["P  esc", "stop, back to live follow"],
  ["", "with a kind filter (K) it plays only the shown events, with their real time gaps"] ] });
