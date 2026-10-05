// agentglass — self-check for the palette's ranking of projects and sessions: fuzzy score + standing (fixture items)
// SPDX-License-Identifier: Apache-2.0
import { match } from "./fuzzy.ts";
import { type Standing, standing } from "./rank.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const NOW = 1790000000000; const H = 3600000; const D = 24 * H;
interface Fx { text: string; st: Standing }
function st(live: boolean, ago: number, gone: boolean, remote: boolean, worktree: boolean): Standing { return { live, last: NOW - ago, gone, remote, worktree }; }
// the items in their natural order (as collect() builds them), ranked as rank() does: the texts that come first
function ranked(fx: Fx[], q: string): string[] {
  const hs = fx.map((f: Fx) => f.text);
  const m = match(hs, hs.map((h: string) => h.toLowerCase()), q, null, 200, fx.map((f: Fx) => standing(f.st, NOW)));
  return m.hits.map((h) => hs[h.i] ?? "");
}

ok("standing bounds", standing(st(true, 0, false, true, false), NOW) === 9 && standing(st(false, 30 * D, true, false, true), NOW) === -8, "");
// release QA: `#agentgl` put two removed review worktrees above the main repo (a start-of-title match beat everything)
const projs: Fx[] = [
  { text: "BjoernSchotte/agentglass", st: st(true, 60000, false, true, false) },
  { text: "agentglass-qa-tui-filter-ux-review", st: st(false, 2 * D, true, false, false) },
  { text: "agentglass-palette-review", st: st(false, 3 * D, true, false, false) },
  { text: "agentglass", st: st(false, 5 * H, false, false, false) }, // a clone without a remote (npx opensrc), used today
  { text: "acme/widget", st: st(false, 10 * D, false, true, false) },
];
const pa = ranked(projs, "agentgl");
ok("#agentgl: the main repo first", pa[0] === "BjoernSchotte/agentglass", pa.join(" | "));
ok("#agentgl: an existing clone before removed worktrees", pa[1] === "agentglass", pa.join(" | "));
ok("#agentglass: the main repo first", ranked(projs, "agentglass")[0] === "BjoernSchotte/agentglass", ranked(projs, "agentglass").join(" | "));
// a clearly better match still wins (fzf): a word start in a removed dir beats a mid-word hit in the live main repo
const pr = ranked(projs.concat([{ text: "glass-tools", st: st(false, 40 * D, true, false, false) }]), "glass");
ok("a clearly better match beats standing", pr[0] === "glass-tools" && pr.indexOf("BjoernSchotte/agentglass") > 0, pr.join(" | "));
const pf = ranked(projs, "agrev");
ok("abbreviation of a worktree: it ranks first", pf[0] === "agentglass-qa-tui-filter-ux-review" || pf[0] === "agentglass-palette-review", pf.join(" | "));
// sessions: same title in a live and an old session — live first, also when the old one sits earlier in the natural order
const ss: Fx[] = [
  { text: "Todo web app · agtest-x-opencode · OpenCode · ses_old", st: st(false, 9 * D, true, false, false) },
  { text: "Build the todo web app · agentglass · pi · ses_live", st: st(true, 30000, false, false, false) },
];
const sa = ranked(ss, "todo");
ok("@todo: the live session before an old one in a removed dir", sa[0] === ss[1].text, sa.join(" | "));
// a clearly better match in an old session still wins: contiguous word vs scattered letters
const sb: Fx[] = [
  { text: "Analyze Campfire code · (no prompt yet) · Claude · main", st: st(true, 0, false, false, false) },
  { text: "Copy session id helper · agentglass · Claude · old", st: st(false, 30 * D, false, false, false) },
];
ok("@copy: contiguous in an old session beats scattered in a live one", ranked(sb, "copy")[0] === sb[1].text, ranked(sb, "copy").join(" | "));
// main checkout over a linked worktree, same title and age
const sw: Fx[] = [
  { text: "Fix flaky check · agentglass · Claude · fix/x · w1", st: st(false, 2 * H, false, false, true) },
  { text: "Fix flaky check · agentglass · Claude · main · m1", st: st(false, 2 * H, false, false, false) },
];
ok("@flaky: the main checkout before its worktree", ranked(sw, "flaky")[0] === sw[1].text, ranked(sw, "flaky").join(" | "));
console.log(bad ? bad + " failed" : "rank: all checks passed");
if (bad) process.exit(1);
