// agentglass — self-check for OSC 8 links in the TUI: the preview id, the transcript header, detail file rows; visible
// widths unchanged; none at all when hyperlinks are off (agent mode, --redact, unsupported terminals)
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync, rmSync } from "node:fs";
import { S } from "../../state.ts";
import { buf } from "../../ui/screen.ts";
import { renderSessions } from "../../ui/list.ts";
import { renderTranscript, openTranscript } from "../../ui/transcript.ts";
import { renderDetail, openDetail } from "../../ui/detail.ts";
import { vwidth, ESC_RE } from "../../util/text.ts";
import { setHyper, hyperMode } from "../../util/hyper.ts";
import { tmpDir, addSess, userLine } from "./fixture.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = tmpDir("hyper");
writeFileSync(dir + "/a b.txt", "x");
const read = JSON.stringify({ type: "assistant", timestamp: "2026-09-30T10:00:02.000Z", message: { id: "m1", model: "claude-sonnet-4-5", content: [{ type: "tool_use", id: "toolu_r", name: "Read", input: { file_path: dir + "/a b.txt" } }], usage: { input_tokens: 1, output_tokens: 1 } } });
const s = addSess(dir, "hhhhhh-0001", "links", [userLine("2026-09-30T10:00:01.000Z", "hi"), read], Date.now(), "");
S.W = 140; S.H = 30;
function frame(draw: () => void): string { buf.length = 0; draw(); return buf.join(""); }
// widths: every chunk's visible text is the same with and without links
function visible(f: string): string { return f.replace(ESC_RE, ""); }
setHyper(true);
S.sel = 0; const L1 = frame(renderSessions);
ok("preview id linked", L1.indexOf("\x1b]8;;agentglass://open/claude/hhhhhh-0001\x1b\\hhhhhh-0001\x1b]8;;\x1b\\") >= 0, "");
openTranscript(s); const T1 = frame(renderTranscript);
ok("transcript header linked", T1.indexOf("\x1b]8;;agentglass://open/claude/hhhhhh-0001\x1b\\hhhhhh-0") >= 0, "");
let ti = -1; const tv = S.tv; if (tv) for (let i = 0; i < tv.evs.length; i++) if (tv.evs[i].kind === "tool") ti = i;
openDetail(ti); const D1 = frame(renderDetail);
ok("detail file row linked (file://, encoded)", D1.indexOf("\x1b]8;;file://") >= 0 && D1.indexOf("/a%20b.txt\x1b\\") >= 0, "");
setHyper(false);
S.mode = "list"; S.tv = null; S.dv = null;
const L0 = frame(renderSessions);
ok("same visible list", visible(L0) === visible(L1), "");
ok("off: no OSC anywhere", L0.indexOf("\x1b]") < 0, "");
openTranscript(s); const T0 = frame(renderTranscript); openDetail(ti); const D0 = frame(renderDetail);
ok("off: transcript/detail clean", T0.indexOf("\x1b]") < 0 && D0.indexOf("\x1b]") < 0, "");
ok("detail: same visible text", visible(D0) === visible(D1), "");
for (const chunk of [L1, D1]) for (const l of chunk.split("\x1b[")) if (vwidth(l) > 400) ok("sane widths", false, String(vwidth(l)));
ok("redact (this check runs under it) forces off", !hyperMode({ TERM: "xterm-kitty" }, "on", true, false, true), "");
console.log(bad ? bad + " failed" : "hyperlinks: all checks passed");
rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
