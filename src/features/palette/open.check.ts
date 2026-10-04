// agentglass — self-check for agentglass open: start-cursor transcripts, applyTarget, Y links
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, statSync, rmSync } from "node:fs";
import { S, type TV } from "../../state.ts";
import { onInput } from "../../input.ts";
import { renderTranscript } from "../../ui/transcript.ts";
import { harnessIds } from "../../harness/index.ts";
import { tmpDir, addSess, convo, userLine, textLine, toolLine, resultLine } from "./fixture.ts";
import { parseRef, resolve } from "./ref.ts";
import { applyTarget } from "./open.ts";
import { linkOf } from "./links.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
for (const h of harnessIds()) process.env["AGENTGLASS_" + h.toUpperCase()] = "true";
process.env["DISPLAY"] = ""; process.env["WAYLAND_DISPLAY"] = ""; process.env["TMUX"] = "";
function tvNow(): TV | null { return S.tv; }
const dir = tmpDir("open");
// a 16 MB log whose anchored call lies before the 6 MB tail, with a gap between the link window and the tail
const big: string[] = [userLine("2026-09-30T09:00:00.000Z", "start")];
const pad = "x".repeat(3000);
for (let i = 0; i < 300; i++) big.push(textLine("2026-09-30T09:00:01.000Z", "p" + String(i), pad));
big.push(toolLine("2026-09-30T09:30:00.000Z", "mo", "toolu_old", "ls")); big.push(resultLine("2026-09-30T09:30:01.000Z", "toolu_old", "ok"));
const g = addSess(dir, "gggggg-0007", "big", big, Date.now(), "");
const fill: string[] = []; for (let i = 0; i < 5000; i++) fill.push(textLine("2026-09-30T10:00:00.000Z", "q" + String(i), pad));
fill.push(textLine("2026-09-30T11:00:00.000Z", "last", "the very end"));
appendFileSync(g.path, fill.join("\n") + "\n"); g.size = statSync(g.path).size;
const t = resolve(parseRef("gggggg-0007#call=toolu_old"));
ok("resolved before the tail", t.cursor > 0 && t.cursor < g.size - 6291456, String(t.cursor));
applyTarget(t); renderTranscript();
const tv = tvNow();
ok("transcript open", S.mode === "transcript" && tv !== null && tv.s === g, S.mode);
if (tv) {
  ok("first event: showing from …", tv.evs.length > 0 && tv.evs[0].kind === "meta" && tv.evs[0].text.indexOf("showing from") === 0 && tv.evs[0].text.indexOf("opened by link") > 0, tv.evs.length ? tv.evs[0].text : "");
  let at = -1; for (let i = 0; i < tv.evs.length; i++) if (tv.evs[i].kind === "tool" && tv.evs[i].id === "toolu_old") at = i;
  ok("anchored event loaded", at > 0, String(at));
  ok("cursor on it (focused)", tv.cur === at && !tv.follow, String(tv.cur) + " vs " + String(at));
  let gap = false; for (const e of tv.evs) if (e.kind === "meta" && e.text.indexOf("not shown") > 0) gap = true;
  ok("gap meta", gap, "");
  const last = tv.evs[tv.evs.length - 1];
  ok("ends at the file's end", last.kind === "assistant" && last.text === "the very end", last.text.slice(0, 30));
  onInput("G"); renderTranscript(); ok("G follows the live end", tv.follow && tv.cur === tv.evs.length - 1, String(tv.cur));
}
onInput("esc");
// a subagent target: parent expanded, its row selected, the subagent's transcript open with the focus
const par = addSess(dir, "pppppp-0001", "parent", convo(1), Date.now() - 5000, "");
const sub = addSess(dir, "agent-sub-01", "sub", convo(2), Date.now() - 4000, "pppppp-0001");
for (let i = 0; i < 4; i++) addSess(dir, "zzzzzz-00" + String(i), "other", convo(3), Date.now() - 1000 - i, "");
S.sel = 0;
const ts = resolve(parseRef("agent-sub-01#call=toolu_02"));
applyTarget(ts); renderTranscript();
ok("subagent row selected", S.view.indexOf(sub) === S.sel && S.view.indexOf(par) >= 0, String(S.sel) + " " + String(S.view.indexOf(sub)));
const tv2 = tvNow();
ok("subagent transcript focused on the call", tv2 !== null && tv2.s === sub && tv2.cur >= 0 && tv2.evs[tv2.cur].id === "toolu_02", tv2 ? String(tv2.cur) : "none");
// links: a tool event → #call=, a user event → #ts=
if (tv2) {
  let ti = -1; let ui = -1; for (let i = 0; i < tv2.evs.length; i++) { if (tv2.evs[i].kind === "tool") ti = i; if (tv2.evs[i].kind === "user") ui = i; }
  ok("tool → call=", ti >= 0 && linkOf(sub, tv2.evs[ti]) === "agentglass://open/claude/agent-sub-01#call=toolu_02", ti >= 0 ? linkOf(sub, tv2.evs[ti]) : "");
  ok("user → ts=", ui >= 0 && linkOf(sub, tv2.evs[ui]).endsWith("#ts=2026-09-30T10:00:01.000Z"), ui >= 0 ? linkOf(sub, tv2.evs[ui]) : "");
  tv2.cur = ui; S.toast = ""; onInput("Y");
  ok("Y in the transcript copies", S.toast.indexOf("copied link") === 0, S.toast);
}
onInput("esc"); S.toast = ""; onInput("Y"); ok("Y in the list copies", S.toast.indexOf("copied link") === 0, S.toast);
ok("not found → 3, ambiguous → 4", resolve(parseRef("nonexist-1")).code === 3 && resolve(parseRef("zzzzzz")).code === 4, "");
console.log("\n" + (bad ? bad + " failed" : "open: all checks passed"));
rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
