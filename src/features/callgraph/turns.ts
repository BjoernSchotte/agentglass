// agentglass — turn segmentation shared by the call graph and the OTLP export: one pure state machine over events
// SPDX-License-Identifier: Apache-2.0
// A turn opens on a top-level prompt, on Codex's "turn started" (its prompt follows) or on activity with no turn open
// (prompt outside the read window, or a late event after a quiet close); it closes on "turn complete…"/"turn aborted",
// on the next opener, or from outside (closeQuiet: the export's completeness rule).
import type { Ev } from "../../model/types.ts";

export type Step = "open" | "close" | "none";
// n = turns opened so far (1-based index of the current one); closedBy = "" | "marker" | "next" | "quiet" | "aborted";
// prompt = the open turn still waits for its prompt (codex "turn started" first); late = the open turn continues one closed by quiet time
export interface TurnCursor { open: boolean; n: number; closedBy: string; prompt: boolean; late: boolean }
export function newCursor(): TurnCursor { return { open: false, n: 0, closedBy: "", prompt: false, late: false }; }
export function abortedBy(e: Ev): boolean { return e.kind === "meta" && e.text === "turn aborted"; }
function closer(e: Ev): boolean { return e.kind === "meta" && (e.text.startsWith("turn complete") || e.text === "turn aborted"); }
function start(c: TurnCursor, prompt: boolean, late: boolean): Step {
  if (c.open) c.closedBy = "next";
  c.open = true; c.n++; c.prompt = prompt; c.late = late;
  return "open";
}
// top = an event of the root session (a subagent's prompt never opens a turn)
export function feed(c: TurnCursor, e: Ev, top: boolean): Step {
  if (!top) return "none";
  if (e.kind === "user") {
    if (c.open && c.prompt) { c.prompt = false; return "none"; } // the prompt of a turn opened by "turn started"
    return start(c, false, false);
  }
  if (e.kind === "meta") {
    if (e.text === "turn started") return start(c, true, false);
    if (closer(e) && c.open) { c.open = false; c.prompt = false; c.closedBy = abortedBy(e) ? "aborted" : "marker"; return "close"; }
    return "none";
  }
  if (!c.open) return start(c, false, c.closedBy === "quiet");
  return "none";
}
export function closeQuiet(c: TurnCursor): void { if (c.open) { c.open = false; c.prompt = false; c.closedBy = "quiet"; } }
