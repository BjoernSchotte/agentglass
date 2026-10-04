// agentglass — security self-check for the link hand-off core: strict requests, the rate limit, view-only apply
// SPDX-License-Identifier: Apache-2.0
import { existsSync, rmSync } from "node:fs";
import { S, type TV } from "../../state.ts";
import { onInput } from "../../input.ts";
import { harnessIds } from "../../harness/index.ts";
import { tmpDir, addSess, convo } from "./fixture.ts";
import { parseRequest, allow, type Rate } from "./handoff.ts";
import { applyLink, flushQueued, queued } from "./apply.ts";
import { P } from "./view.ts";
import "../redact.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
for (const h of harnessIds()) process.env["AGENTGLASS_" + h.toUpperCase()] = "true";
function tvNow(): TV | null { return S.tv; }
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
function req(s: string): string { const r = parseRequest(enc(s)); return r.err ? "ERR " + r.err : r.ref; }

ok("valid", req("open abc123\n") === "abc123", req("open abc123\n"));
ok("valid url", req("open agentglass://open/claude/abc123#call=t1\n") === "agentglass://open/claude/abc123#call=t1", "");
ok("1025 bytes", req("open " + "a".repeat(1019) + "\n") === "ERR bad-request", String(("open " + "a".repeat(1019) + "\n").length));
ok("1024 bytes passes the size check (the ref grammar then refuses > 512)", parseRequest(enc("open " + "a".repeat(1018) + "\n")).err === "bad-request", "");
ok("no newline", req("open abc123") === "ERR bad-request", "");
ok("two newlines", req("open abc123\n\n") === "ERR bad-request", "");
ok("newline inside", req("open abc\n123\n") === "ERR bad-request", "");
ok("ESC inside", req("open abc\x1b123\n") === "ERR bad-request", "");
ok("BEL inside", req("open abc\x07123\n") === "ERR bad-request", "");
ok("DEL inside", req("open abc\x7f123\n") === "ERR bad-request", "");
ok("OPEN", req("OPEN abc123\n") === "ERR bad-request", "");
ok("send", req("send abc123\n") === "ERR bad-request", "");
ok("two spaces", req("open  abc123\n") === "ERR bad-request", "");
ok("path", req("open ../x\n") === "ERR bad-request", "");
ok("empty ref", req("open \n") === "ERR bad-request", "");
const inv = new Uint8Array([111, 112, 101, 110, 32, 97, 98, 99, 49, 50, 0xff, 10]);
ok("invalid UTF-8", parseRequest(inv).err === "bad-request", "");
const trunc = new Uint8Array([111, 112, 101, 110, 32, 97, 98, 99, 49, 50, 0xc3, 10]);
ok("truncated UTF-8", parseRequest(trunc).err === "bad-request", "");
// rate: 10 per rolling minute
const r: Rate = { at: [] };
let all = true; for (let i = 0; i < 10; i++) if (!allow(r, 1000)) all = false;
ok("10 allowed", all, ""); ok("11th refused", !allow(r, 1000), ""); ok("a minute later", allow(r, 61001), "");

// apply: list mode → the transcript at the anchor (no BEL: AGENTGLASS_NOTIFY=0)
const dir = tmpDir("handoff");
const a = addSess(dir, "aaaaaa-0001", "first", convo(1), Date.now() - 5000, "");
const b = addSess(dir, "aaaaaa-0002", "second", convo(2), Date.now() - 1000, "");
const c = addSess(dir, "cccccc-0003", "third", convo(3), Date.now() - 9000, "");
ok("apply → ok", applyLink("cccccc-0003#call=toolu_03", Date.now()) === "ok", "");
const tv = tvNow();
ok("transcript open at the anchor", S.mode === "transcript" && tv !== null && tv.s === c && tv.focusText === "toolu_03", S.mode);
onInput("esc");
// confirm mode: queued, the dialog untouched, the newest link wins, applied after esc; trash never ran
S.sel = S.view.indexOf(a); onInput("D");
ok("confirm open", S.mode === "confirm" && S.confirmAction === "trash", S.mode);
ok("link during confirm → ok", applyLink("aaaaaa-0002", Date.now()) === "ok", "");
ok("dialog untouched", S.mode === "confirm" && S.confirmAction === "trash", S.mode);
ok("toast says queued", S.toast.indexOf("link received: ") === 0 && S.toast.indexOf("applies when you leave this prompt") > 0 && S.toast.indexOf("second") < 0, S.toast);
applyLink("cccccc-0003", Date.now());
ok("newest link kept", queued() === "cccccc-0003", queued());
flushQueued(); ok("still confirm: nothing applied", S.mode === "confirm", S.mode);
onInput("esc"); flushQueued();
const tv2 = tvNow();
ok("applied after esc", S.mode === "transcript" && tv2 !== null && tv2.s === c, S.mode);
ok("trash never ran", existsSync(a.path), "");
onInput("esc");
// input mode: the half-typed text stays
S.sel = S.view.indexOf(b); onInput("s"); S.inputText = "half typed";
ok("link during input → ok", applyLink("aaaaaa-0001", Date.now()) === "ok", "");
ok("input untouched", S.mode === "input" && S.inputText === "half typed", S.mode + " " + S.inputText);
onInput("esc"); flushQueued();
ok("applied after the prompt closed", S.mode === "transcript" && tvNow()?.s === a, S.mode);
ok("the \"applies when you leave\" toast is gone once applied", S.toast.indexOf("link received") < 0, S.toast);
onInput("esc");
// unknown → not-found; ambiguous → the palette prefilled
ok("unknown → not-found", applyLink("zzzzzz-9", Date.now()) === "err not-found", "");
ok("bad → bad-request", applyLink("../x", Date.now()) === "err bad-request", "");
ok("ambiguous → ok palette", applyLink("aaaaaa", Date.now()) === "ok palette", "");
ok("palette prefilled", S.mode === "palette" && P.q === "@aaaaaa", S.mode + " " + P.q);
console.log(bad ? bad + " failed" : "handoff: all checks passed");
rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
