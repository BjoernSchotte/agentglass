// agentglass — the call graph with an event-kind filter: true time axis, ┄n ticks, the tree's hidden row, ] to the next
// shown span: scriptc build src/features/callgraph/view.check.ts -o cgv && ./cgv
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { type Sess, newSess } from "../../model/types.ts";
import { S } from "../../state.ts";
import { viewOf } from "../../hooks.ts";
import { ESC_RE } from "../../util/text.ts";
import { buf } from "../../ui/screen.ts";
import { onInput } from "../../input.ts";
import { VF_STORE, vfSet, vfClear, resetForTest } from "../../ui/evfilter.ts";
import { openGraph, cgState } from "./view.ts";
import "../evkinds.ts";

let bad = 0;
function eq(w: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + w + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function ok(w: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + w); } }

const D = "/tmp/agentglass-cgview-check-" + String(process.pid); rmSync(D, { recursive: true, force: true }); mkdirSync(D, { recursive: true });
VF_STORE.path = D + "/vf.json"; resetForTest();
const T = Date.parse("2026-10-01T09:00:00Z");
function iso(x: number): string { return new Date(T + x * 1000).toISOString(); }
function cu(x: number, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(x), message: { role: "user", content: text } }); }
function ca(x: number, id: string, name: string, input: string): string { return "{\"type\":\"assistant\",\"timestamp\":\"" + iso(x) + "\",\"message\":{\"id\":\"m" + id + "\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"" + id + "\",\"name\":\"" + name + "\",\"input\":" + input + "}]}}"; }
function tr(x: number, id: string, text: string): string { return JSON.stringify({ type: "user", timestamp: iso(x), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] } }); }
const L = [cu(0, "build it"),
  ca(10, "r1", "Read", "{\"file_path\":\"/w/a.ts\"}"), tr(20, "r1", "x"),
  ca(30, "b1", "Bash", "{\"command\":\"npm test\"}"), tr(60, "b1", "ok"),
  ca(70, "r2", "Read", "{\"file_path\":\"/w/b.ts\"}"), tr(75, "r2", "x"),
  ca(80, "e1", "Edit", "{\"file_path\":\"/w/a.ts\",\"old_string\":\"a\",\"new_string\":\"b\"}"), tr(85, "e1", "ok"),
  ca(90, "b2", "Bash", "{\"command\":\"git status\"}"), tr(100, "b2", "clean")];
const P = D + "/s.jsonl"; writeFileSync(P, L.join("\n") + "\n");
const s: Sess = newSess("claude", "cgview-1", P, false); s.size = statSync(P).size; s.mtime = T; s.cwd = D;
S.W = 100; S.H = 24;
openGraph(s);
const v = viewOf("call graph");
function frame(): string[] {
  buf.length = 0; if (v) v.render();
  const rows: string[] = []; for (let y = 0; y < S.H; y++) rows.push("");
  for (const b of buf) { const m = /^\x1b\[(\d+);(\d+)H/.exec(b); if (!m) continue; const y = Number(m[1] ?? "1") - 1; if (y >= 0 && y < S.H) rows[y] = b.slice(String(m[0] ?? "").length).replace(ESC_RE, ""); }
  return rows;
}
// the first column of every drawn span, by span index
function cols(): Map<number, number> { const c = cgState(); const o = new Map<number, number>(); for (let j = 0; j < c.hitI.length; j++) o.set(c.hitI[j] ?? -1, c.hitX0[j] ?? -1); return o; }
frame(); const all = cols();
const sp = cgState().spans;
const names: string[] = []; for (let i = 0; i < sp.length; i++) names.push((sp[i]?.name ?? "") + "@" + String(all.get(i) ?? -1));
eq("spans", sp.length >= 6 ? "ok" : names.join(" "), "ok");
vfSet("callgraph", "event.kind is shell");
const rows = frame(); const sh = cols();
let same = true; let shells = 0; let hiddenDrawn = 0;
for (let i = 0; i < sp.length; i++) {
  const x = sp[i]; if (!x || x.kind === 0) continue;
  if (x.name === "Bash") { shells++; if (sh.get(i) !== all.get(i)) same = false; }
  else if (sh.has(i)) hiddenDrawn++;
}
ok("shown spans keep their x (true axis)", same && shells === 2);
eq("hidden spans are not drawn", String(hiddenDrawn), "0");
ok("a ┄ tick marks hidden time", rows.join("\n").indexOf("┄") >= 0);
ok("header counts the spans", (rows[1] ?? "").indexOf("2 of 5 spans") >= 0);
// ] goes to the next shown span in time, [ back
eq("selection starts on the longest span", sp[cgState().sel]?.arg ?? "", "npm test");
onInput("]"); eq("] skips the hidden Read and Edit", sp[cgState().sel]?.arg ?? "", "git status");
onInput("["); eq("[ back", sp[cgState().sel]?.arg ?? "", "npm test");
onInput("["); eq("[ at the first match stays", sp[cgState().sel]?.arg ?? "", "npm test");
// the tree folds the hidden calls into one row
onInput("tab"); frame();
const tree = cgState().tree;
ok("tree: hidden row " + tree.join(" | "), tree.some((t: string) => t.startsWith("┄ 3 hidden · read 2 · edit 1")) && tree.some((t: string) => t.startsWith("Bash 2")));
onInput("tab");
// esc clears the filter first, a second esc goes back
onInput("esc"); eq("esc clears", S.mode + " " + S.fview, "view call graph");
frame(); eq("all spans again", String(cols().size), String(all.size));
vfClear("callgraph");
rmSync(D, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("call graph filter: ok");
