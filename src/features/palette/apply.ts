// agentglass — the only way a handed-off link reaches the UI: it selects a row, opens a transcript (or the palette) and
// sets the focus. It never closes or answers a dialog: during a prompt or a confirm the link waits (newest wins).
// Imports are an allowlist (scripts/handoff-imports.test.sh).
// SPDX-License-Identifier: Apache-2.0
import { S, say } from "../../state.ts";
import { parseRef, resolve } from "./ref.ts";
import { applyTarget } from "./open.ts";
import { openPalette, closePalette } from "./view.ts";
import { titleOf } from "../../model/sessions.ts";

let pending = "";
export function queued(): string { return pending; }
function bell(): void { if (process.env.AGENTGLASS_NOTIFY !== "0") { try { process.stdout.write("\x07"); } catch (e) { /* no tty */ } } }
// "ok" | "ok palette" (ambiguous prefix) | "err not-found" | "err bad-request"
export function applyLink(ref: string, now: number): string {
  const r = parseRef(ref);
  if (!r.ok) return "err bad-request";
  const t = resolve(r);
  if (t.code === 3) return "err not-found";
  const amb = t.code === 4;
  if (S.mode === "input" || S.mode === "confirm") {
    pending = ref;
    say("info", "link received: " + (t.s ? titleOf(t.s) : r.sess + "…") + " — applies when you leave this prompt");
    return amb ? "ok palette" : "ok";
  }
  if (S.mode === "palette") closePalette();
  if (S.mode === "help") { S.mode = S.prevMode; S.helpScroll = 0; }
  if (amb) { openPalette("@" + r.sess); bell(); return "ok palette"; }
  applyTarget(t); bell();
  return "ok";
}
// on tick: the waiting link, once the dialog is gone
export function flushQueued(): void {
  if (!pending || S.mode === "input" || S.mode === "confirm") return;
  const ref = pending; pending = "";
  if (S.toast.startsWith("link received: ")) S.toast = ""; // "applies when you leave this prompt": it applies now
  applyLink(ref, Date.now());
}
