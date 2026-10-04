// agentglass — self-check for transcript event lines (width, no lost text): scriptc build src/ui/transcript.check.ts -o tc && ./tc
// SPDX-License-Identifier: Apache-2.0
import { width } from "../util/text.ts";
import { evLines } from "./transcript.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;]*m/g, ""); }
function lines(kind: string, text: string, w: number, expand: boolean): string[] {
  const out: string[] = []; evLines({ kind, text, ts: "2026-10-04T14:11:21.000Z", id: "", full: "" }, w, expand, out);
  const o: string[] = []; for (const l of out) o.push(plain(l)); return o;
}
function widest(ls: string[]): number { let m = 0; for (const l of ls) m = Math.max(m, width(l)); return m; }
// the shown text without blanks (lines break inside words), minus the glyphs and the time stamp
function text(ls: string[], drop: string[]): string { let o = ""; for (const l of ls) for (const t of l.split(/\s+/)) if (t && drop.indexOf(t) < 0 && !/^\d\d:\d\d$/.test(t)) o += t; return o; }

const prompt = "Add a filter bar (all/active/done) and a counter of open items to the todo app, run node --check on app.js, then commit.";
for (const w of [40, 56, 80]) {
  const ls = lines("user", prompt, w, false);
  eq("user prompt fits " + String(w), String(widest(ls) <= w), "true");
  eq("user prompt keeps every character at " + String(w), text(ls, ["❯"]), prompt.split(" ").join(""));
}
const cmd = "cd /tmp/agtest-qa-tui-pi && git add -A && git commit -m \"feat: add all/active/done filter bar and open-item counter\" && git status --short && git log --oneline";
for (const w of [40, 56, 80]) {
  const cut = lines("tool", "bash\u0000" + cmd, w, false); // more than 3 lines: the last one ends in " …"
  eq("cut tool call fits " + String(w), String(widest(cut) <= w), "true");
  const all = lines("tool", "bash\u0000" + cmd, w, true);
  eq("tool call fits " + String(w), String(widest(all) <= w), "true");
}

console.log(bad ? bad + " failed" : "transcript: all checks passed");
if (bad) process.exit(1);
