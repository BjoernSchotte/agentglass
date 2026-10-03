// agentglass — self-check for the palette's fuzzy matcher: scriptc build src/features/palette/fuzzy.check.ts -o fz && ./fz
// SPDX-License-Identifier: Apache-2.0
import { type Hit, terms, scoreTerm, match, NO_MATCH } from "./fuzzy.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function sc(hay: string, q: string): number { const t = terms(q); const p: number[] = []; let s = 0; for (const x of t) { const v = scoreTerm(hay, hay.toLowerCase(), x.t, x.cs, p); if (v === NO_MATCH) return -1e9; s += v; } return s; }
function run(hs: string[], q: string): Hit[] { return match(hs, hs.map((h: string) => h.toLowerCase()), q, null, 200, null).hits; }
function ids(hs: Hit[]): string { return hs.map((h: Hit) => String(h.i)).join(","); }

ok("terms split + smart case", JSON.stringify(terms(" fx  Tmz ")) === '[{"t":"fx","cs":false},{"t":"Tmz","cs":true}]', JSON.stringify(terms(" fx  Tmz ")));
const T = ["Fix timezone bug in reports", "prefix bug", "Fix bug", "unrelated"];
const h1 = run(T, "fx tmz");
ok("fx tmz finds the title", h1.length === 1 && h1[0].i === 0, ids(h1));
ok("boundary beats mid-word", sc("Fix bug", "fix") > sc("prefix bug", "fix"), sc("Fix bug", "fix") + " vs " + sc("prefix bug", "fix"));
ok("consecutive beats scattered", sc("abcxyz", "abc") > sc("axbxcx", "abc"), sc("abcxyz", "abc") + " vs " + sc("axbxcx", "abc"));
ok("camelCase hump scores", sc("openTranscript", "ot") > sc("opentranscript", "ot"), sc("openTranscript", "ot") + " vs " + sc("opentranscript", "ot"));
ok("smart case: Fix does not match fix bug", sc("fix bug", "Fix") === NO_MATCH, String(sc("fix bug", "Fix")));
ok("smart case: fix matches Fix bug", sc("Fix bug", "fix") !== NO_MATCH, String(sc("Fix bug", "fix")));
ok("AND over terms", sc("Fix bug", "fix zz") === NO_MATCH && sc("Fix bug", "fix bug") !== NO_MATCH, "");
const longWeak = "Global: Keyboard shortcuts and a long tail of words (help)";
ok("a weak match in a long item still matches (negative score)", sc(longWeak, "a") !== NO_MATCH && sc(longWeak, "a") < 0 && run([longWeak], "a").length === 1, String(sc(longWeak, "a")));
const p: number[] = []; scoreTerm("a-b-abc", "a-b-abc", "abc", false, p);
ok("backward pass tightens the window", JSON.stringify(p) === "[4,5,6]", JSON.stringify(p));
const hm = match(["Fix bug", "fix"], ["fix bug", "fix"], "fi", null, 200, null);
ok("pos kept per hit", JSON.stringify(hm.hits[0].pos) === "[0,1]", JSON.stringify(hm.hits[0].pos));
ok("shorter item wins a tie", hm.hits[0].i === 1, ids(hm.hits));
const bm = match(["Fix bug", "fix"], ["fix bug", "fix"], "fi", null, 200, [5, 0]);
ok("bonus lifts an item", bm.hits[0].i === 0, ids(bm.hits));

// incremental narrowing equals a full rescore, also when more than max items matched the shorter query
const words = ["fix", "timezone", "tmzone", "report", "refactor", "fixture", "zone"];
const big: string[] = []; for (let i = 0; i < 20000; i++) big.push("session " + String(i) + " " + (words[i % words.length] ?? ""));
const low = big.map((h: string) => h.toLowerCase());
const q = "fix tmzone";
let prev: number[] | null = null; let maxMs = 0; let same = true;
for (let k = 1; k <= q.length; k++) {
  const sub = q.slice(0, k);
  const t0 = Date.now();
  const inc = match(big, low, sub, prev, 200, null);
  const dt = Date.now() - t0; if (dt > maxMs) maxMs = dt;
  const full = match(big, low, sub, null, 200, null);
  if (ids(inc.hits) !== ids(full.hits)) { same = false; console.log("differs at " + JSON.stringify(sub)); }
  prev = inc.all;
}
ok("incremental == full", same, "");
const f3 = match(big, low, "fixt", null, 200, null);
ok("keeps max hits, all matches in .all", f3.hits.length === 200 && f3.all.length > 200, f3.hits.length + " " + f3.all.length);
ok("20k items < 15 ms per keystroke", maxMs < 15, String(maxMs) + " ms");
console.log(bad ? bad + " failed" : "fuzzy: all checks passed (20k max " + String(maxMs) + " ms)");
if (bad) process.exit(1);
