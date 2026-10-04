// agentglass — self-check for the ? popup layout: scriptc build src/ui/help.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { helpLayout, renderHelp } from "./help.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); }
// a feature view registered last (like compare): its section is far below the first page
H.helpSections.push({ name: "zzview", ctx: "zzview", keys: [["a", "one"], ["b", "two"], ["c", "three"]] });
S.prevMode = "view"; S.fview = "zzview";
for (const W of [80, 120]) {
  const l = helpLayout(W); const col = l.two && plain(l.right[l.at] ?? "").indexOf("ZZVIEW") >= 0 ? l.right : l.left;
  ok(W + " cols: at names the section", plain(col[l.at] ?? "").indexOf("ZZVIEW") >= 0 && plain(col[l.at] ?? "").indexOf("current view") >= 0, plain(col[l.at] ?? ""));
  ok(W + " cols: end is its last key", plain(col[l.end] ?? "").indexOf("three") >= 0, plain(col[l.end] ?? ""));
  // opening ? scrolls there when the first page cuts it
  S.W = W; S.H = 24; S.mode = "help"; S.helpScroll = 0; S.helpJump = true; renderHelp();
  ok(W + " cols: opened at the section", S.helpScroll > 0 && S.helpScroll <= l.at && !S.helpJump, String(S.helpScroll) + " at " + String(l.at));
}
// a section on the first page (sessions from the list): no jump, the global keys stay in sight
S.prevMode = "list"; S.tab = 0; S.W = 80; S.H = 40; S.helpScroll = 0; S.helpJump = true; renderHelp();
ok("sessions: stays at the top", S.helpScroll === 0, String(S.helpScroll));
// a scrolled popup that is opened again starts over (top, or the section)
S.prevMode = "list"; S.tab = 1; S.helpScroll = 7; S.helpJump = true; renderHelp();
const pl = helpLayout(80);
ok("processes: reopened at its section, not the old scroll", S.helpScroll === pl.at && pl.at > 0, String(S.helpScroll) + " at " + String(pl.at));
console.log(bad ? bad + " failed" : "help: all checks passed");
process.exit(bad ? 1 : 0);
