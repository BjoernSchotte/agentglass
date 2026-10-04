// agentglass — self-check for the footer hints: scriptc build src/ui/footer.check.ts -o foc && ./foc
// SPDX-License-Identifier: Apache-2.0
import { fitHints, hintsWidth, toastLines } from "./footer.ts";
import { width } from "../util/text.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const cmp = [["?", "keys"], ["^K", "palette"], ["tab", "section"], ["↑↓", "row"], ["↵", "drill-down"], ["␣", "fold"], ["[/]", "side"], ["a/b", "edit group"],
  ["x", "swap"], ["S", "subagents"], ["t", "triage"], ["1/2", "transcript"], ["esc", "back"]];
const ks: string[] = []; const ws: string[] = []; for (const x of cmp) { ks.push(x[0] ?? ""); ws.push(x[1] ?? ""); }
function shown(k: string[], n: number, tail: boolean): string { const o: string[] = []; for (let i = 0; i < k.length; i++) if (i < n || (tail && i === k.length - 1)) o.push(k[i]); return o.join(" "); }
// wide enough: everything, two spaces apart
const all = fitHints(ks, ws, 200);
ok("fits: all, gap 2", all.n === cmp.length && all.gap === 2 && !all.cut, shown(ks, all.n, all.tail));
// 80 columns (the compare view): ? first, esc back last, the rest in order until the room ends, one-space gaps
for (const W of [80, 100, 120]) {
  const f = fitHints(ks, ws, W - 1); const sh = shown(ks, f.n, f.tail);
  ok(W + ": within the room", hintsWidth(ks, ws, f.n, f.tail, f.gap, f.cut) <= W - 1, String(hintsWidth(ks, ws, f.n, f.tail, f.gap, f.cut)));
  ok(W + ": ? keys first", sh.startsWith("? "), sh);
  ok(W + ": esc back kept last", f.tail && sh.endsWith(" esc"), sh);
  ok(W + ": cut marked", f.cut && f.n > 2, sh);
}
// a tail that is not esc/q (Sessions list: D trash) is simply dropped first
const lk = ["?", "↵", "/", "D"]; const lw = ["keys", "open", "filter", "trash"];
const fl = fitHints(lk, lw, 22);
ok("plain tail dropped", shown(lk, fl.n, fl.tail) === "? ↵" && fl.cut && !fl.tail, shown(lk, fl.n, fl.tail));
// toasts wrap at word boundaries (the restored-pins start toast at 80 columns), at most 3 lines, the last cut with …
const pinT = "pinned: repo is agentglass · harness is claude · tool is Bash — P edits, P then enter on empty unpins";
const tl = toastLines(pinT, 70, 3);
ok("toast wraps", tl.length === 2 && tl.join(" ") === pinT, JSON.stringify(tl));
ok("toast lines fit", tl.every((l: string) => width(l) <= 70), JSON.stringify(tl));
ok("short toast: one line", toastLines("copied", 70, 3).length === 1, "");
const huge = toastLines("word ".repeat(100), 20, 3);
ok("capped at 3, cut with …", huge.length === 3 && (huge[2] ?? "").endsWith("…") && width(huge[2] ?? "") <= 20, JSON.stringify(huge));
const longw = toastLines("x".repeat(50), 20, 3);
ok("a word longer than the line is split", longw.length === 3 && longw.every((l: string) => width(l) <= 20), JSON.stringify(longw));
console.log(bad ? bad + " failed" : "footer: all checks passed");
process.exit(bad ? 1 : 0);
