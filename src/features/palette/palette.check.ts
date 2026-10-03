// agentglass — self-check for the Ctrl+K palette: keys, scopes, ranking, restore on esc, redaction, MRU
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { S, type TV, type DV } from "../../state.ts";
import { H } from "../../hooks.ts";
import { onInput, keyName, tokens } from "../../input.ts";
import { renderTranscript, openTranscript } from "../../ui/transcript.ts";
import { buf } from "../../ui/screen.ts";
import { screenOut } from "../../hooks.ts";
import { harnessIds } from "../../harness/index.ts";
import { tmpDir, addSess, convo } from "./fixture.ts";
import { P, renderPalette, selected, rows } from "./view.ts";
import { mruLoad, mruTouch, mruSave, mruList } from "./mru.ts";
import "./links.ts";
import "../replay.ts";
import "../themes.ts";
import "../query/ui.ts";
import "../callgraph/view.ts";
import "../redact.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
for (const h of harnessIds()) process.env["AGENTGLASS_" + h.toUpperCase()] = "true";
process.env["DISPLAY"] = ""; process.env["WAYLAND_DISPLAY"] = ""; process.env["TMUX"] = "";
function key(raw: string): void { for (const t of tokens(raw)) onInput(keyName(t)); }
function type(t: string): void { for (const ch of Array.from(t)) key(ch); }
function tvNow(): TV | null { return S.tv; }
function dvNow(): DV | null { return S.dv; }

ok("ctrl-k name", keyName("\x0b") === "ctrl-k" && keyName("\x10") === "ctrl-p" && keyName("\x0e") === "ctrl-n", keyName("\x0b"));
const dir = tmpDir("palette");
// the checks run under --redact: titles are fakes (matching runs on them), ids stay real
const s1 = addSess(dir, "aaaaaa-0001", "Fix timezone bug in reports", convo(1), Date.now() - 50000, "");
const s2 = addSess(dir, "bbbbbb-0002", "Write the release notes", convo(2), Date.now() - 1000, "");
addSess(dir, "cccccc-0003", "unrelated cleanup", convo(3), Date.now() - 90000, "");
const sec = addSess(dir, "dddddd-0004", "secret zebra migration", convo(4), Date.now() - 99000, "");

function state(): string {
  const tv = tvNow(); const dv = dvNow();
  return JSON.stringify({ mode: S.mode, prev: S.prevMode, tab: S.tab, sel: S.sel, top: S.top, tvs: tv ? tv.scroll : -1, tvc: tv ? tv.cur : -1, tvf: tv ? tv.follow : false, dvs: dv ? dv.scroll : -1 });
}
// opens from list, transcript, detail and the call graph; esc restores exactly, also after typing, scrolling, a 2nd level
S.sel = 1; S.top = 0;
let before = state();
key("\x0b"); ok("opens from list", S.mode === "palette" && S.prevMode === "list", S.mode);
type("fx tmz"); key("\x1b[B"); key("\x1b[A");
key("\x1b"); ok("esc restores list", state() === before, state() + " vs " + before);
openTranscript(s1); renderTranscript();
const tv0 = tvNow(); if (tv0) { tv0.cur = 1; tv0.scroll = 0; tv0.follow = false; }
before = state();
key("\x0b"); ok("opens from transcript", S.mode === "palette" && S.prevMode === "transcript", S.mode);
type("@"); key("\x1b[C"); ok("→ second level on a session", P.levels.length === 1, String(P.levels.length)); key("\x1b[D");
key("\x1b"); ok("esc restores transcript", state() === before, state() + " vs " + before);
onInput("enter"); ok("in detail", S.mode === "detail", S.mode);
const dv0 = dvNow(); if (dv0) dv0.scroll = 2;
before = state();
key("\x0b"); ok("opens from detail", S.mode === "palette" && S.prevMode === "detail", S.mode);
type("abc"); key("\x0b"); ok("ctrl-k closes and restores", state() === before, state() + " vs " + before);
onInput("esc"); onInput("esc"); ok("back in list", S.mode === "list", S.mode);
S.sel = 0; onInput("c"); ok("call graph view", S.mode === "view", S.mode);
key("\x0b"); ok("opens from the call graph", S.mode === "palette" && S.prevMode === "view", S.mode); key("\x1b");
ok("back in the view", S.mode === "view", S.mode); onInput("esc");
// input/confirm: ignored; help: closes help and opens
onInput("s"); ok("input mode", S.mode === "input", S.mode); S.inputText = "half";
key("\x0b"); ok("ignored in input", S.mode === "input" && S.inputText === "half", S.mode + " " + S.inputText); onInput("esc");
S.sel = 0; onInput("D"); ok("confirm mode", S.mode === "confirm", S.mode);
key("\x0b"); ok("ignored in confirm", S.mode === "confirm", S.mode); onInput("n");
onInput("?"); key("\x0b"); ok("help → palette", S.mode === "palette" && S.prevMode === "list", S.mode + " " + S.prevMode); key("\x1b");

// ranking and scopes
key("\x0b"); type("aa 01");
const top = selected(); ok("fuzzy abbreviation ranks the session first", top !== null && top.s === s1, top ? top.text : "none");
key("\x1b"); key("\x0b"); type("@");
ok("@ = sessions only", rows().length > 0 && rows().every((r) => r.kind === "session"), rows().map((r) => r.kind).join(","));
key("\x1b"); key("\x0b"); type(">");
ok("> = actions only", rows().length > 0 && rows().every((r) => r.kind === "action"), rows().map((r) => r.kind).join(","));
key("\x1b"); key("\x0b"); type("#");
ok("# = projects only", rows().length > 0 && rows().every((r) => r.kind === "project"), rows().map((r) => r.kind).join(","));
key("\x1b"); key("\x0b"); type(":");
ok(": = tabs only", rows().length > 0 && rows().every((r) => r.kind === "tab"), rows().map((r) => r.kind).join(","));
key("\x1b"); key("\x0b");
const sc: number[] = []; for (let i = 0; i < 5; i++) { sc.push(P.scope); key("\t"); }
ok("tab cycles 5 scopes", JSON.stringify(sc) === "[0,1,2,3,4]" && P.scope === 0, JSON.stringify(sc));
type("?"); ok("? lists the prefixes", P.help, String(P.help)); key("\x1b");
// selection kept by id across re-ranking
key("\x0b"); type("@00");
const want = rows().find((r) => r.s === s2); ok("second session listed", want !== undefined, rows().map((r) => r.text).join(" | "));
while (selected() !== null && selected()?.s !== s2 && P.sel < rows().length - 1) key("\x1b[B");
type("2"); ok("selection kept by id", selected()?.s === s2, selected()?.text ?? "none");
key("\x1b");
// enter: a session opens its transcript; an action equals its key
key("\x0b"); type("@bbbbbb"); key("\r"); ok("enter opens the transcript", S.mode === "transcript" && tvNow()?.s === s2, S.mode);
onInput("esc"); S.sel = 1;
key("\x0b"); type(">fold"); key("\r"); const viaPalette = state();
S.sel = 1; onInput(" "); ok("enter on an action == its key (space)", viaPalette !== "" && S.mode === "list", viaPalette);
// second level: 7 entries
key("\x0b"); type("@bbbbbb"); key("\x1b[C"); ok("7 session actions", rows().length === 7, rows().map((r) => r.text).join(" | "));
key("\x1b[D"); ok("← back to the list", P.levels.length === 0 && P.q === "@bbbbbb", P.q); key("\x1b");
key("\x0b"); key("\t"); key("\t"); type("bbbbbb"); key("\x1b[C"); ok("→ after tab-scoping to sessions: 7 actions", rows().length === 7, String(rows().length)); key("\x1b"); key("\x1b");
// redaction: rows show fake titles; a real-only word finds nothing; the kept session matches its real title
key("\x0b"); type("@zebra"); ok("real title word finds nothing", rows().length === 0, rows().map((r) => r.text).join(" | "));
key("\x1b"); key("\x0b"); type("@" + sec.title.split(" ")[0]); ok("the fake title matches", rows().some((r) => r.s === sec), sec.title);
key("\x1b"); key("\x0b");
buf.length = 0; renderPalette(); const frame = buf.map((x: string) => screenOut(x)).join("");
ok("frame has no real titles", frame.indexOf("secret zebra") < 0, "");
ok("status row", frame.indexOf("esc close") >= 0, "");
ok("redacted title shown", frame.indexOf(sec.title.slice(0, 10)) >= 0, sec.title);
key("\x1b");
// MRU: ids only, ≤ 50, not under --redact, corrupt → [], an MRU id ranks above an equal-score item
const mf = dir + "/palette.json";
for (let i = 0; i < 60; i++) mruTouch("session:claude:id" + String(i), 1000 + i);
mruTouch("session:claude:" + s2.id, 5000);
mruSave(mf, false);
const txt = readFileSync(mf, "utf8");
ok("mru ids only", txt.indexOf("release") < 0 && txt.indexOf("Write") < 0 && txt.indexOf("\"v\":1") >= 0, txt.slice(0, 80));
ok("mru ≤ 50", mruLoad(mf).length === 50 && mruLoad(mf)[0].id === "session:claude:" + s2.id, String(mruLoad(mf).length));
mruSave(dir + "/p2.json", true); ok("no write under --redact", !existsSync(dir + "/p2.json"), "");
writeFileSync(dir + "/bad.json", "{nope"); ok("corrupt → []", mruLoad(dir + "/bad.json").length === 0, "");
mruTouch("act:filter.live", Date.now()); mruTouch("act:filter.harness", Date.now() - 2 * 86400000);
key("\x0b"); type(">live"); ok("mru list kept", mruList().length > 0, "");
key("\x1b"); key("\x0b"); type(">filter"); const r0 = rows();
ok("recent action ranks first", r0.length > 1 && r0[0].id === "act:filter.live", r0.map((r) => r.id).join(","));
key("\x1b");
console.log("\n" + (bad ? bad + " failed" : "palette: all checks passed"));
rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
