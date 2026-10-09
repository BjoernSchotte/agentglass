// agentglass — self-check for the event-kind filter controller: scriptc build src/ui/evfilter.check.ts -o ef && ./ef
// (GOLDEN_WRITE=1 rewrites chips-80.golden: review it)
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { run } from "../util/fs.ts";
import { type Ev, type Sess, newSess } from "../model/types.ts";
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { ESC_RE, width } from "../util/text.ts";
import { type Gap, PRESETS, VF_STORE, vfOf, vfSet, vfClear, preset, solo, invert, mask, shown, runs, gapText, matchCount, nextMatch, linked, setLinked,
  chipBar, chipKey, openBar, barOpen, viewKey, label, emptyText, flush, resetForTest, test } from "./evfilter.ts";
import { evxOf } from "../features/query/eval.ts";
import { kindsIn } from "../model/kinds.ts";
import { parseRef, canonicalUrl } from "../features/palette/ref.ts";
import { applyTarget } from "../features/palette/open.ts";
import "../features/evkinds.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ok(w: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + w); } }

const T = Date.parse("2026-10-01T09:00:00Z");
function ev(kind: string, text: string, sec: number, id: string): Ev { return { kind, text, ts: new Date(T + sec * 1000).toISOString(), id, full: "" }; }
// 0 prompt · 1 reply · 2 npm test · 3 failed · 4 mcp github · 5 result · 6 reply · 7 Edit · 8 ok · 9 git status · 10 ok · 11 reply (turn end) ·
// 12 prompt · 13 thinking · 14 Skill · 15 result · 16 reply
const evs: Ev[] = [
  ev("user", "fix the login", 0, ""), ev("assistant", "running the tests first", 1, ""),
  ev("tool", "Bash\u0000npm test", 2, "c1"), ev("result", "Exit code 1\nFAIL", 3, "c1"),
  ev("tool", "mcp__github__get_issue\u0000#1", 4, "c2"), ev("result", "issue body", 5, "c2"),
  ev("assistant", "the issue says…", 6, ""), ev("tool", "Edit\u0000/w/a.ts", 7, "c3"), ev("result", "ok", 8, "c3"),
  ev("tool", "Bash\u0000git status", 9, "c4"), ev("result", "clean", 10, "c4"), ev("assistant", "fixed", 11, ""),
  ev("user", "now load a skill", 12, ""), ev("thinking", "which one", 13, ""), ev("tool", "Skill\u0000brainstorming", 14, "c5"), ev("result", "loaded", 15, "c5"), ev("assistant", "loaded it", 16, ""),
];
const s: Sess = newSess("claude", "evf-test-1", "/k/evf-test-1.jsonl", false); s.size = 1;
for (const e of evs) s.evs.push(e);

const D = "/tmp/agentglass-evfilter-check-" + String(process.pid); rmSync(D, { recursive: true, force: true }); mkdirSync(D, { recursive: true });
VF_STORE.path = D + "/viewfilters.json"; VF_STORE.remember = true;
resetForTest();
function on(view: string): string { const m = mask(view, s, s.evs); const o: string[] = []; for (let i = 0; i < s.evs.length; i++) if (m[i] + 0 === 1) o.push(String(i)); return o.join(","); }

// no filter: everything
eq("no filter", on("transcript"), "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16");
// presets
const want = ["0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16", "14,15", "4,5", "2,3,9,10", "1,2,3", "0,2,3,11,12,16"];
for (let i = 0; i < PRESETS.length; i++) { preset("transcript", i); eq("preset " + (PRESETS[i]?.name ?? ""), on("transcript"), want[i] ?? ""); }
eq("preset label", label("transcript"), "my prompts + outcomes");
// errors + causes where the agent logs only thinking before the failing call (Gemini)
const gmS: Sess = newSess("gemini", "evf-test-g", "/k/evf-test-g.json", false); gmS.size = 1;
for (const e of [ev("user", "build it", 0, ""), ev("thinking", "run the check", 1, ""), ev("tool", "run_shell_command\u0000node -e x", 2, "g1"), ev("result", "[error] Exit Code: 3", 3, "g1")]) gmS.evs.push(e);
preset("transcript", 4); { const m = mask("transcript", gmS, gmS.evs); const o: string[] = []; for (let i = 0; i < gmS.evs.length; i++) if (m[i] + 0 === 1) o.push(String(i)); eq("causes: thinking before the call", o.join(","), "1,2,3"); }
preset("transcript", 5);
// solo on the mcp:github event: the kind, then its family, then nothing
vfClear("transcript");
eq("solo kind", solo("transcript", s, s.evs, 4), "mcp:github"); eq("solo kind shows", on("transcript"), "4,5"); eq("solo label", label("transcript"), "mcp:github only");
eq("solo family", solo("transcript", s, s.evs, 4), "mcp");
eq("solo clear", solo("transcript", s, s.evs, 4), ""); eq("solo cleared", vfOf("transcript").expr, "");
eq("solo on a failing test call: its specific kind", solo("transcript", s, s.evs, 2), "shell:test");
vfClear("transcript");
// invert
vfSet("transcript", "event.kind is skill"); invert("transcript");
eq("invert", on("transcript"), "0,1,2,3,4,5,6,7,8,9,10,11,12,13,16"); eq("invert label", label("transcript"), "not skill only");
invert("transcript");
// gap runs: one per hidden run, with family counts
const gs: Gap[] = runs("transcript", s, s.evs, 0, s.evs.length);
eq("runs", gs.map((g: Gap) => String(g.i) + "+" + String(g.hidden)).join(" "), "0+14 16+1");
eq("gap text", gapText(gs[0], 80), "┄ 14 hidden · reply 4 · shell 4 · edit 2 · error 2 · mcp 2 · prompt 2 ┄");
eq("gap text cut", gapText(gs[0], 40), "┄ 14 hidden · reply 4 · shell 4 … ┄");
const mc = matchCount("transcript", s, s.evs); eq("match count", String(mc.shown) + " of " + String(mc.total), "2 of 17");
// ] [ over matches, ends give -1
eq("next match", String(nextMatch("transcript", s, s.evs, 0, 1)), "14");
eq("next match again", String(nextMatch("transcript", s, s.evs, 14, 1)), "15");
eq("next at the end", String(nextMatch("transcript", s, s.evs, 15, 1)), "-1");
eq("previous match", String(nextMatch("transcript", s, s.evs, 16, -1)), "15");
eq("previous at the start", String(nextMatch("transcript", s, s.evs, 14, -1)), "-1");
// a bad expression keeps the filter and reports the caret column
const e1 = vfSet("transcript", "event.kind is shel");
ok("bad expression refused", e1 !== "" && vfOf("transcript").expr === "event.kind is skill");
const e2 = vfSet("transcript", "event.kind > skill");
ok("caret column", e2 !== "" && vfOf("transcript").errCol === 11 && vfOf("transcript").expr === "event.kind is skill");
eq("empty state", emptyText("transcript"), "no skill events in this session — esc clears the filter, K changes it");
// per view by default, one shared state when linked
vfSet("callgraph", "event.kind is shell");
eq("per view", vfOf("transcript").expr + " | " + vfOf("callgraph").expr, "event.kind is skill | event.kind is shell");
setLinked(true); ok("linked", linked());
eq("linked starts from the transcript's", vfOf("callgraph").expr, "event.kind is skill");
vfSet("transcript", "event.kind is mcp");
eq("linked change reaches the call graph", vfOf("callgraph").expr, "event.kind is mcp");
setLinked(false);
// rows without an events array (related, Wait): one EvX
ok("test one event", test("transcript", s, evxOf(s.evs[14], null, ["skill:load"])) && !test("transcript", s, evxOf(s.evs[4], null, ["mcp:github"])));
// pinned event clauses apply in every view on top of its own filter
vfClear("related"); S.pins = [{ key: "event.kind", op: "is", vals: ["shell"], neg: false, pinned: true }];
eq("pinned event clause", on("related"), "2,3,9,10"); S.pins = [];

// persistence: written a second after the last change (here: forced), read back by a fresh run
vfSet("transcript", "event.kind is skill"); vfSet("callgraph", "mcp.server is github"); invert("callgraph");
ok("flush writes", flush(true));
eq("file 0600", existsSync(VF_STORE.path) ? run("stat", process.platform === "darwin" ? ["-f", "%Lp", VF_STORE.path] : ["-c", "%a", VF_STORE.path]).trim() : "missing", "600");
resetForTest();
eq("restored transcript", vfOf("transcript").expr, "event.kind is skill");
eq("restored call graph", vfOf("callgraph").expr + " " + String(vfOf("callgraph").inv), "mcp.server is github true");
// filter.remember false: neither read nor written
resetForTest(); VF_STORE.remember = false;
eq("not read", vfOf("transcript").expr, "");
vfSet("transcript", "event.kind is edit"); ok("not written", !flush(true));
VF_STORE.remember = true; resetForTest();
eq("file unchanged", vfOf("transcript").expr, "event.kind is skill");

// deep links: f= and view= in the canonical link, read back by parseRef
const url = canonicalUrl(s, "call", "c1", "transcript", "event.kind is skill");
eq("canonical url", url, "agentglass://open/claude/evf-test-1#call=c1&view=transcript&f=event.kind%20is%20skill");
const r = parseRef(url); eq("parsed link", r.akey + "=" + r.aval + " view=" + r.view + " f=" + r.f, "call=c1 view=transcript f=event.kind is skill");
const r2 = parseRef("claude:evf-test-1#view=callgraph&f=" + encodeURIComponent("event.kind is_one_of mcp, error"));
eq("plain ref with view and f", r2.view + " | " + r2.f + " | " + r2.akey, "callgraph | event.kind is_one_of mcp, error | ");
ok("bad view refused", !parseRef("claude:evf-test-1#view=nope").ok);
ok("two anchors refused", !parseRef("claude:evf-test-1#call=a&ts=2026-10-01T09:00:00Z").ok);
// applyTarget: the link's filter set in its view before the view opens; a bad one is left out with a warning
applyTarget({ s, code: 0, cands: [], msg: "", cursor: 0, kind: "", ts: "", id: "", text: "", turn: -1, warn: "", ukey: "", uval: "", view: "transcript", f: "event.kind is mcp" });
eq("link applied", S.mode + " " + vfOf("transcript").expr, "transcript event.kind is mcp");
applyTarget({ s, code: 0, cands: [], msg: "", cursor: 0, kind: "", ts: "", id: "", text: "", turn: -1, warn: "", ukey: "", uval: "", view: "transcript", f: "event.kind is nope" });
ok("bad link filter said", S.toast.indexOf("not applied") >= 0 && vfOf("transcript").expr === "event.kind is mcp");
S.mode = "list"; S.tv = null;
eq("old links unchanged", parseRef("agentglass://open/claude/evf-test-1#call=toolu_1").aval, "toolu_1");

// the chip bar at 80 columns (golden), and its keys
resetForTest(); vfClear("transcript");
S.W = 80; const KM = kindsIn(s, s.evs); openBar("transcript", (): Map<string, number> => KM);
const lines: string[] = [];
// in the golden: > before the cursor's chip, ~ before a hidden one
const snap = (what: string): void => { lines.push(what + "\t" + chipBar("transcript", KM, 78).split("\u001b[7m").join(">").split("\u001b[9m").join("~").replace(ESC_RE, "")); };
snap("open");
const narrow = (what: string): void => { lines.push(what + "\t" + chipBar("transcript", KM, 36).split("\u001b[7m").join(">").split("\u001b[9m").join("~").replace(ESC_RE, "")); };
narrow("narrow first"); for (let k = 0; k < 5; k++) chipKey("transcript", KM, "right"); narrow("narrow sixth");
ok("narrow fits 36", width(chipBar("transcript", KM, 36).replace(ESC_RE, "")) <= 36);
chipKey("transcript", KM, "home");
ok("bar fits 78", width(chipBar("transcript", KM, 78).replace(ESC_RE, "")) <= 78);
chipKey("transcript", KM, "right"); chipKey("transcript", KM, " "); snap("reply hidden");
eq("␣ writes the chips' clause", vfOf("transcript").expr, "event.kind is_one_of prompt shell edit mcp skill error");
chipKey("transcript", KM, " "); eq("␣ again: all", vfOf("transcript").expr, "");
chipKey("transcript", KM, "right"); chipKey("transcript", KM, "enter"); snap("shell kinds");
chipKey("transcript", KM, " "); eq("one kind off keeps its siblings", vfOf("transcript").expr, "event.kind is_one_of prompt reply shell:vcs edit mcp skill error");
chipKey("transcript", KM, " "); eq("all its kinds again: the family", vfOf("transcript").expr, "");
chipKey("transcript", KM, "esc"); ok("esc leaves the kinds level first", barOpen("transcript"));
chipKey("transcript", KM, "!"); eq("! inverts", label("transcript"), "not all events");
chipKey("transcript", KM, "2"); eq("2 skills", on("transcript"), "14,15");
chipKey("transcript", KM, "L"); ok("L links", linked()); chipKey("transcript", KM, "L");
chipKey("transcript", KM, "esc"); ok("esc closes", !barOpen("transcript"));
const GP = (process.env.AGENTGLASS_SRC || "src") + "/ui/chips-80.golden";
if (process.env.GOLDEN_WRITE === "1") { writeFileSync(GP, lines.join("\n") + "\n"); console.log("chips-80.golden written: review it"); process.exit(1); }
const gw = readFileSync(GP, "utf8").split("\n").filter((l: string) => l.length > 0);
for (let i = 0; i < Math.max(gw.length, lines.length); i++) eq("chips golden " + String(i + 1), lines[i] ?? "(none)", gw[i] ?? "(none)");

// the view keys: K opens, i solos, ! inverts, ] [ move, esc clears (handled), other keys pass (-2)
vfClear("transcript");
eq("K", String(viewKey("transcript", s, s.evs, 0, "K")), "-1"); chipKey("transcript", KM, "esc");
eq("i", String(viewKey("transcript", s, s.evs, 14, "i")), "-1"); eq("i solo", vfOf("transcript").expr, "event.kind is skill:load");
eq("]", String(viewKey("transcript", s, s.evs, 0, "]")), "14");
eq("esc clears", String(viewKey("transcript", s, s.evs, 0, "esc")), "-1"); eq("cleared", vfOf("transcript").expr, "");
eq("esc without a filter passes", String(viewKey("transcript", s, s.evs, 0, "esc")), "-2");
eq("j passes", String(viewKey("transcript", s, s.evs, 0, "j")), "-2");
ok("shown()", shown("transcript", s, s.evs, 3));

// palette: the seven "Show only …" entries
const names: string[] = []; for (const a of H.actions) if (a.group === "Events" && a.title.startsWith("Show ")) names.push(a.title);
eq("palette entries", names.join(" | "), "Show only skills | Show only MCP calls | Show only errors and their causes | Show only shell | Show only file edits | Show only my prompts | Show all events");

rmSync(D, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("event filter controller: ok");
