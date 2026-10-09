// agentglass — Y copies a link: the session (list) or the event under the transcript cursor (call= for a tool call or
// its result, else ts=); also "Copy link" in the palette
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { remoteOnly } from "../../model/remote.ts";
import { H, type Ctx } from "../../hooks.ts";
import { current } from "../../model/sessions.ts";
import { copyText } from "../../actions.ts";
import { canonicalUrl } from "./ref.ts";
import { vfOf } from "../../ui/evfilter.ts";
import { addActions, keyAction, inSessions, inTranscript } from "./actions.ts";

// the anchor of an event: a call's id (tool call or result), else its timestamp, else none
export function anchorOf(e: Ev | null): string[] {
  if (!e) return ["", ""];
  if ((e.kind === "tool" || e.kind === "result") && e.id) return ["call", e.id];
  return e.ts ? ["ts", e.ts] : ["", ""];
}
export function linkOf(s: Sess, e: Ev | null): string { const a = anchorOf(e); return canonicalUrl(s, a[0] ?? "", a[1] ?? ""); }
// the transcript's link carries its event filter (f=): the receiver sees the same events
function txLink(s: Sess, e: Ev | null): string { const a = anchorOf(e); const f = vfOf("transcript").expr; return canonicalUrl(s, a[0] ?? "", a[1] ?? "", f ? "transcript" : "", f); }
function cursorEv(): Ev | null {
  const tv = S.tv; if (!tv || !tv.evs.length) return null;
  const i = tv.cur >= 0 && tv.cur < tv.evs.length ? tv.cur : tv.evs.length - 1;
  return tv.evs[i];
}
H.keys.push((mode: string, k: string): boolean => {
  if (k !== "Y") return false;
  if (mode === "list" && S.tab === 0) { const s = current(); if (s && !remoteOnly(s, "a link")) copyText(linkOf(s, null), "link"); return true; }
  if (mode === "transcript" && S.tv) { copyText(txLink(S.tv.s, cursorEv()), "link"); return true; }
  return false;
});
addActions([
  keyAction("session.copyLink", "Session", "Copy link (agentglass://)", "Y", "Y", inSessions),
  keyAction("transcript.copyLink", "Transcript", "Copy link to the event under the cursor", "Y", "Y", inTranscript),
]);
H.sessionActions.push((s: Sess) => ({ id: "copyLink", title: "Copy link (agentglass://)", group: "Session", keys: "Y", when: (c: Ctx): boolean => true, run: (c: Ctx): void => { if (!remoteOnly(s, "a link")) copyText(linkOf(s, null), "link"); } }));
