// agentglass — a tiny TUI to browse, watch and steer coding-agent sessions
// (Claude Code ~/.claude, Codex ~/.codex, fx ~/.fx). Built as a native binary with scriptc.
// SPDX-License-Identifier: Apache-2.0
import { S } from "./state.ts";
import { H, tabAt } from "./hooks.ts";
import { scan, buildView } from "./model/sessions.ts";
import { refreshProcs, refreshSlow } from "./model/procs.ts";
import { C, CSI } from "./ui/theme.ts";
import { buf, put, renderModal } from "./ui/screen.ts";
import { renderHeader } from "./ui/header.ts";
import { renderFooter } from "./ui/footer.ts";
import { renderSessions } from "./ui/list.ts";
import { renderProcs } from "./ui/procs.ts";
import { renderTranscript } from "./ui/transcript.ts";
import { renderDetail } from "./ui/detail.ts";
import { renderHelp } from "./ui/help.ts";
import { tokens, keyName, onInput, onMouse } from "./input.ts";
import { enter, quit, termSize } from "./term.ts";
// feature modules: import each once here for its side effects (they register on H)
import "./features/replay.ts";
import "./features/cli.ts";
import "./features/themes.ts";
import "./features/ticker.ts";

function render(): void {
  buf.length = 0;
  buf.push("\x1b[?2026h");
  renderHeader();
  const mode = S.mode; const pm = S.prevMode;
  if (mode === "detail" || (mode !== "list" && S.dv && pm === "detail")) { renderTranscript(); renderDetail(); }
  else if (mode === "transcript" || (mode !== "list" && S.tv && pm === "transcript")) renderTranscript();
  else if (S.tab === 0) renderSessions();
  else if (S.tab === 1) renderProcs();
  else { // feature tab: blank body, no built-in list mouse area
    S.listH = 0;
    for (let y = 1; y < S.H - 1; y++) put(0, y, CSI + "2K");
    const t = tabAt(S.tab - 2); if (t) t.render();
  }
  renderFooter();
  if (mode === "confirm") renderModal("confirm", [S.confirmText, "", "y  yes      n / esc  cancel"], C.yellow);
  if (mode === "help") renderHelp();
  buf.push("\x1b[?2026l");
  process.stdout.write(buf.join(""));
}

function main(): void {
  const args = process.argv.slice(2);
  for (const f of H.cli) if (f(args)) return;
  if (!process.stdin.isTTY) { console.error("agentglass needs an interactive terminal"); process.exit(1); }
  enter();
  scan(); refreshProcs(); refreshSlow(); buildView();
  render();
  process.stdin.on("data", (d: Uint8Array) => {
    for (const t of tokens(new TextDecoder("utf-8").decode(d))) {
      if (t.startsWith("\x1b[<")) onMouse(t); else onInput(keyName(t));
    }
    render();
  });
  process.on("SIGTERM", () => quit());
  let tick = 0;
  setInterval(() => {
    tick++; S.frame++;
    termSize();
    if (tick % 3 === 0) { refreshProcs(); }
    if (tick % 6 === 0) { scan(); buildView(); }
    if (tick % 10 === 0) refreshSlow();
    if (S.mode === "list" && S.tab === 0) buildView();
    for (const f of H.onTick) f();
    render();
  }, 500);
  if (H.onFastTick.length) setInterval(() => {
    let dirty = false;
    for (const f of H.onFastTick) if (f()) dirty = true;
    if (dirty) render();
  }, 50);
}
main();
