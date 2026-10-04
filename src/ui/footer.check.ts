// agentglass — self-check for the footer hints: scriptc build src/ui/footer.check.ts -o foc && ./foc
// SPDX-License-Identifier: Apache-2.0
import { fitHints, hintsWidth, toastLines, renderFooter, tierOf, footX0, footX1, footKey } from "./footer.ts";
import { width } from "../util/text.ts";
import { type Mode, S } from "../state.ts";
import { buf } from "./screen.ts";
// the features whose hints the Sessions list, the transcript and the views show
import "../features/compare/marks.ts";
import "../features/vcs/view.ts";
import "../features/callgraph/view.ts";
import "../features/triage/view.ts";
import "../features/repos/tab.ts";
import "../features/replay.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""); }
// the footer row as text: the last put() on the bottom line
function footer(mode: Mode, tab: number, W: number): string {
  S.W = W; S.H = 30; S.mode = mode; S.tab = tab; S.toast = ""; buf.length = 0; renderFooter();
  const at = "\x1b[" + String(S.H) + ";1H"; let row = "";
  for (const b of buf) if (b.startsWith(at)) row = plain(b.slice(at.length));
  return row.replace(/\s+$/, "");
}
function tiers(ks: string[]): number[] { const o: number[] = []; for (const k of ks) o.push(tierOf(k)); return o; }
function shown(ks: string[], show: boolean[]): string { const o: string[] = []; for (let i = 0; i < ks.length; i++) if (show[i]) o.push(ks[i]); return o.join(" "); }

// ── fitHints: by tier, the earlier first within a tier, shown in display order ──
const cmp = [["?", "keys"], ["^K", "palette"], ["tab", "section"], ["↑↓", "row"], ["↵", "drill-down"], ["␣", "fold"], ["[/]", "side"], ["a/b", "edit group"],
  ["x", "swap"], ["S", "subagents"], ["t", "triage"], ["1/2", "transcript"], ["esc", "back"]];
const ks: string[] = []; const ws: string[] = []; for (const x of cmp) { ks.push(x[0] ?? ""); ws.push(x[1] ?? ""); }
const ps = tiers(ks); ps[ps.length - 1] = 0; // the footer pins the closing esc
const all = fitHints(ks, ws, ps, 200);
ok("fits: all, gap 2", all.show.every((x: boolean) => x) && all.gap === 2 && !all.cut, shown(ks, all.show));
for (const W of [60, 80, 100]) {
  const f = fitHints(ks, ws, ps, W - 1); const sh = shown(ks, f.show);
  ok(W + ": within the room", hintsWidth(ks, ws, f.show, f.gap, f.cut) <= W - 1, String(hintsWidth(ks, ws, f.show, f.gap, f.cut)));
  ok(W + ": ? first, ↵ kept, esc last", sh.startsWith("? ") && sh.indexOf("↵") > 0 && sh.endsWith(" esc") && f.cut, sh);
  ok(W + ": ↑↓ (tier 3) goes before tier-2 hints", !f.show[3] || f.show.every((x: boolean) => x), sh);
}
// the lowest tier goes first, then the last of a tier: a tier-2 hint early in the list survives a later one
const f2 = fitHints(["?", "a", "b", "↵", "c"], ["keys", "aaaa", "bbbb", "open", "cccc"], [0, 2, 2, 1, 2], 25);
ok("tiers: ? ↵ a", shown(["?", "a", "b", "↵", "c"], f2.show) === "? a ↵", shown(["?", "a", "b", "↵", "c"], f2.show));

// ── the real footer, every mode at 80 and 60 columns: within the width, the essentials there ──
for (const W of [80, 60]) {
  const l = footer("list", 0, W);
  ok(W + " sessions: fits", width(l) <= W - 1, l);
  ok(W + " sessions: ? ↵ open / filter", l.startsWith("? keys") && l.indexOf("↵ open") > 0 && l.indexOf("/ filter") > 0 && l.endsWith("…"), l);
  ok(W + " sessions: kill/trash dropped before the rest", l.indexOf("D trash") < 0 && l.indexOf("x kill") < 0, l);
  const p = footer("list", 1, W);
  ok(W + " processes: ↵ session … q quit", width(p) <= W - 1 && p.indexOf("↵ session") > 0 && p.endsWith("q quit"), p);
  const t = footer("transcript", 0, W);
  ok(W + " transcript: ↵ details … esc back", width(t) <= W - 1 && t.indexOf("↵ details") > 0 && t.endsWith("esc back"), t);
  const d = footer("detail", 0, W);
  ok(W + " detail: esc back last", width(d) <= W - 1 && d.endsWith("esc back"), d);
  const pa = footer("palette", 0, W);
  ok(W + " palette: ↵ run … esc close", width(pa) <= W - 1 && pa.indexOf("↵ run") > 0 && pa.endsWith("esc close"), pa);
}
// the click map follows what is shown: one hit per clickable shown key, inside the row, "↵" → enter
footer("list", 0, 80);
ok("clicks: enter and / mapped", footKey.indexOf("enter") >= 0 && footKey.indexOf("/") >= 0, footKey.join(","));
ok("clicks: inside the row", footX1.every((x: number) => x <= 79) && footX0.every((x: number, i: number) => x < (footX1[i] ?? 0)), footX0.join(",") + " / " + footX1.join(","));
const row = footer("list", 0, 80); const ix = footKey.indexOf("/");
ok("clicks: / hit is over its hint", ix >= 0 && Array.from(row).slice(footX0[ix] ?? 0, footX1[ix] ?? 0).join("") === "/ filter", Array.from(row).slice(footX0[ix] ?? 0, footX1[ix] ?? 0).join(""));
const pr = footer("list", 1, 80); const iq = footKey.indexOf("q");
ok("clicks: q hit after the …", iq >= 0 && Array.from(pr).slice(footX0[iq] ?? 0, footX1[iq] ?? 0).join("") === "q quit", Array.from(pr).slice(footX0[iq] ?? 0, footX1[iq] ?? 0).join(""));
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
