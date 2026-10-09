// agentglass — the transcript with an event-kind filter: gap lines, match count, ↵ on a gap, the empty state, replay over
// shown events and the footer at 80 columns: scriptc build src/ui/transcript-filter.check.ts -o tf && ./tf
// (GOLDEN_WRITE=1 rewrites transcript-footer-80.golden: review it)
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { type Sess, newSess } from "../model/types.ts";
import { S } from "../state.ts";
import { ESC_RE } from "../util/text.ts";
import { buf } from "./screen.ts";
import { onInput } from "../input.ts";
import { openTranscript, renderTranscript, moveCur } from "./transcript.ts";
import { renderFooter } from "./footer.ts";
import { VF_STORE, vfSet, vfClear, mask, resetForTest } from "./evfilter.ts";
import { replaying } from "../features/replay.ts";
import "../features/evkinds.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ok(w: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + w); } }

const D = "/tmp/agentglass-tfilter-check-" + String(process.pid); rmSync(D, { recursive: true, force: true }); mkdirSync(D, { recursive: true });
VF_STORE.path = D + "/viewfilters.json"; resetForTest();
const T = Date.parse("2026-10-01T09:00:00Z");
function iso(x: number): string { return new Date(T + x * 1000).toISOString(); }
function cu(x: number, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(x), message: { role: "user", content: text } }); }
function ca(x: number, blocks: string): string { return "{\"type\":\"assistant\",\"timestamp\":\"" + iso(x) + "\",\"message\":{\"id\":\"m" + String(x) + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[" + blocks + "]}}"; }
function tu(id: string, name: string, input: string): string { return "{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":" + input + "}"; }
function txt(t: string): string { return "{\"type\":\"text\",\"text\":" + JSON.stringify(t) + "}"; }
function tr(x: number, id: string, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(x), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } }); }
const L: string[] = [cu(0, "fix the login")];
for (let k = 0; k < 6; k++) { L.push(ca(1 + k * 4, txt("step " + String(k)))); L.push(ca(2 + k * 4, tu("b" + String(k), "Bash", "{\"command\":\"npm test\"}"))); L.push(tr(3 + k * 4, "b" + String(k), k === 2 ? "Exit code 1" : "ok")); }
L.push(ca(30, tu("s1", "Skill", "{\"skill\":\"brainstorming\"}"))); L.push(tr(31, "s1", "loaded"));
L.push(ca(32, tu("r1", "Read", "{\"file_path\":\"/w/a.ts\"}"))); L.push(tr(33, "r1", "x")); L.push(ca(34, txt("done")));
const P = D + "/s.jsonl"; writeFileSync(P, L.join("\n") + "\n");
const s: Sess = newSess("claude", "tfilter-1", P, false); s.size = statSync(P).size; s.mtime = T; s.cwd = D;
S.W = 80; S.H = 24;
openTranscript(s);
// the screen as text rows: each put() placed at its column
function screen(): string[] {
  const W = S.W; const cells: string[] = []; for (let i = 0; i < S.H * W; i++) cells.push(" ");
  for (const b of buf) {
    const m = /^\x1b\[(\d+);(\d+)H/.exec(b); if (!m) continue;
    const y = Number(m[1] ?? "1") - 1; let x = Number(m[2] ?? "1") - 1; if (y < 0 || y >= S.H) continue;
    const t = b.slice(String(m[0] ?? "").length).replace(ESC_RE, "");
    for (const ch of t) { if (x >= 0 && x < W) cells[y * W + x] = ch; x++; }
  }
  const rows: string[] = []; for (let y = 0; y < S.H; y++) rows.push(cells.slice(y * W, y * W + W).join(""));
  return rows;
}
function render(): string[] { buf.length = 0; renderTranscript(); return screen(); }
const tv = S.tv; if (!tv) { console.log("FAIL no transcript"); process.exit(1); }
render();
const n = tv.evs.length;
eq("events read", String(n), "24");

// event.kind is skill: the skill call and its result, gap lines with counts around them, the header's match count
vfSet("transcript", "event.kind is skill");
let rows = render();
const body = rows.slice(2, S.H - 2).map((r: string) => r.slice(2, S.W - 2).trim()).filter((r: string) => r.length > 0);
eq("gap before", body[0] ?? "", "┄ 19 hidden · shell 12 · reply 6 · error 2 · prompt 1 ┄");
ok("skill call shown", (body[1] ?? "").indexOf("⚒ Skill(brainstorming)") >= 0);
eq("gap after", body[body.length - 1] ?? "", "┄ 3 hidden · read 2 · reply 1 ┄");
ok("header count", (rows[1] ?? "").indexOf("2 of 24 events") >= 0);
s.title = "a prompt long enough to fill the whole header line of the transcript box at eighty columns and more"; rows = render();
ok("header count beside a long title: " + (rows[1] ?? ""), (rows[1] ?? "").indexOf("2 of 24 events") >= 0 && (rows[1] ?? "").indexOf("a prompt long") >= 0);
s.title = "";
// the cursor stops on the gap line, ↵ shows that run once, the filter stays
tv.follow = false; moveCur(tv, -100, S.H - 4);
eq("cursor on the first gap", String(tv.cur), "0");
onInput("enter");
rows = render();
ok("run expanded", rows.join("\n").indexOf("fix the login") >= 0 && rows.join("\n").indexOf("┄ 19 hidden") < 0);
ok("still filtered after", tv.lines.join("\n").indexOf("┄ 3 hidden") >= 0);
// esc clears the filter (and only then goes back)
onInput("esc"); eq("esc clears first", S.mode, "transcript");
rows = render(); ok("all events again", rows.join("\n").indexOf("hidden ·") < 0);

// the empty state names the filter and the keys
vfSet("transcript", "event.kind is web");
rows = render();
eq("empty state", (rows[2] ?? "").slice(2, S.W - 2).trim(), "no web events in this session — esc clears the filter, K changes it");
ok("one gap for everything", rows.join("\n").indexOf("┄ 24 hidden") >= 0);

// replay plays the shown events only
vfSet("transcript", "event.kind is_one_of skill error");
const m = mask("transcript", s, tv.evs);
tv.follow = true; onInput("P");
const seen: number[] = [];
for (let k = 0; k < 30 && replaying(); k++) { seen.push(tv.limit - 1); onInput("right"); }
let allShown = true; for (let j = 0; j < seen.length; j++) { const i = (seen[j] ?? 0) + 0; if (i > 0 && i < m.length && m[i] + 0 !== 1) allShown = false; }
ok("replay steps over shown events only " + seen.join(","), allShown && seen.length >= 3 && !replaying() && S.mode === "transcript");

// the footer at 80 columns: no filter, a filter, the chip bar
const F: string[] = [];
function foot(what: string): void { buf.length = 0; S.mode = "transcript"; renderFooter(); for (const b of buf) if (b.startsWith("\x1b[" + String(S.H) + ";1H")) F.push(what + "\t" + b.slice(("\x1b[" + String(S.H) + ";1H").length).replace(ESC_RE, "").trimEnd()); }
vfClear("transcript"); foot("no filter");
vfSet("transcript", "event.kind is skill"); foot("skill only");
onInput("K"); foot("chip bar"); onInput("esc");
const GP = (process.env.AGENTGLASS_SRC || "src") + "/ui/transcript-footer-80.golden";
if (process.env.GOLDEN_WRITE === "1") { writeFileSync(GP, F.join("\n") + "\n"); console.log("transcript-footer-80.golden written: review it"); process.exit(1); }
const gw = readFileSync(GP, "utf8").split("\n").filter((l: string) => l.length > 0);
for (let i = 0; i < Math.max(gw.length, F.length); i++) eq("footer golden " + String(i + 1), F[i] ?? "(none)", gw[i] ?? "(none)");

rmSync(D, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("transcript filter: ok");
