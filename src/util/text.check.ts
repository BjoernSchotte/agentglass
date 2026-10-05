// agentglass — self-check for styled-text widths: scriptc build src/util/text.check.ts -o tc && ./tc
// SPDX-License-Identifier: Apache-2.0
import { width, vwidth, fillTo, fitStyled, ESC_RE, localDay, localHM, wrap } from "./text.ts";
import { link, hyperMode, fileUrl, setHyper } from "./hyper.ts";
import { RST } from "../ui/theme.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const st = "\x1b[38;2;1;2;3m\x1b[1m5h 15%\x1b[0m \x1b[2m7d 71%\x1b[0m";
ok("escapes take no columns", vwidth(st) === 13, String(vwidth(st)));
ok("width() counts escape bodies (why vwidth exists)", width(st) > vwidth(st), String(width(st)));
ok("wide glyphs", vwidth("\x1b[1m≈$1 ✦ 日本\x1b[0m") === 10, String(vwidth("\x1b[1m≈$1 ✦ 日本\x1b[0m")));
ok("fillTo pads to the visible width", fillTo(st, 20).length === 7, String(fillTo(st, 20).length));
ok("fitStyled keeps escapes, cuts visible", vwidth(fitStyled(st, 4)) === 4, String(vwidth(fitStyled(st, 4))));
// the local day and the local clock name the same moment (TZ=Pacific/Kiritimati / America/Adak differ from UTC by a day here)
const at = "2026-10-03T22:16:00.000Z"; const d = new Date(at);
ok("localDay is the local calendar day", localDay(at) === String(d.getFullYear()) + "-10-" + String(d.getDate()).padStart(2, "0") && localHM(at).length === 5, localDay(at));

// OSC 8 links: escape bytes take no columns, a cut inside a link closes it before RST
setHyper(true);
const L = link("agentglass://open/x", "abc");
ok("link form", L === "\x1b]8;;agentglass://open/x\x1b\\abc\x1b]8;;\x1b\\", JSON.stringify(L));
ok("fillTo over a link", fillTo(L, 10).length === 7, String(fillTo(L, 10).length));
ok("vwidth over a link", vwidth(L) === 3, String(vwidth(L)));
const bel = "\x1b]8;;u\x07abc\x1b]8;;\x07";
ok("BEL-terminated link", vwidth(bel) === 3 && fillTo(bel, 10).length === 7, String(vwidth(bel)));
const cut = fitStyled("\x1b[1m" + link("u", "abcdef") + "gh", 4);
ok("cut inside a link: visible", vwidth(cut) === 4 && cut.replace(ESC_RE, "") === "abcd", JSON.stringify(cut));
ok("cut inside a link: closed before RST", cut.endsWith("\x1b]8;;\x1b\\" + RST) && cut.indexOf("gh") < 0, JSON.stringify(cut));
const whole = fitStyled(link("u", "ab") + "cd", 10);
ok("no extra close when the link ended", whole.split("\x1b]8;;").length === 3, JSON.stringify(whole));
// a url longer than any fixed lookahead: still one zero-width escape, the cut still closes the link
const longL = link("https://x/" + "a".repeat(5000), "abcdef") + "gh";
const lcut = fitStyled(longL, 4);
ok("long url: visible", lcut.replace(ESC_RE, "") === "abcd" && lcut.indexOf("aaaa") > 0, String(lcut.replace(ESC_RE, "").length));
ok("long url: closed", lcut.endsWith("\x1b]8;;\x1b\\" + RST), JSON.stringify(lcut.slice(-20)));
ok("unterminated OSC: its bytes count as text, nothing hangs", vwidth(fitStyled("\x1b]8;;u" + "b".repeat(3000), 5)) <= 5, "");
ok("link() strips control chars from the url", link("a\x1bb\x07c\nd", "t").indexOf("abcd") > 0, JSON.stringify(link("a\x1bb\x07c\nd", "t")));
setHyper(false);
ok("off → plain text", link("u", "abc") === "abc", link("u", "abc"));
// enablement table
const kitty: Record<string, string> = { TERM: "xterm-kitty" };
const tm: Record<string, string> = { TERM: "xterm-kitty", TMUX: "/tmp/tmux-1/default,1,0" };
ok("agent → off", !hyperMode(kitty, "on", true, true, false), "");
ok("redact → off", !hyperMode(kitty, "on", true, false, true), "");
ok("tmux auto → off", !hyperMode(tm, "auto", true, false, false), "");
ok("screen auto → off", !hyperMode({ TERM: "screen-256color", VTE_VERSION: "7000" }, "auto", true, false, false), "");
ok("kitty auto tty → on", hyperMode(kitty, "auto", true, false, false), "");
ok("kitty auto non-tty → off", !hyperMode(kitty, "auto", false, false, false), "");
ok("on in tmux → on", hyperMode(tm, "on", true, false, false), "");
ok("off with kitty → off", !hyperMode(kitty, "off", true, false, false), "");
ok("env wins over config", hyperMode({ AGENTGLASS_HYPERLINKS: "on" }, "off", true, false, false) && !hyperMode({ TERM: "xterm-kitty", AGENTGLASS_HYPERLINKS: "off" }, "on", true, false, false), "");
ok("vte ≥ 5000", hyperMode({ VTE_VERSION: "6003" }, "auto", true, false, false) && !hyperMode({ VTE_VERSION: "4800" }, "auto", true, false, false), "");
ok("iTerm/WezTerm/vscode/ghostty/WT", hyperMode({ TERM_PROGRAM: "WezTerm" }, "auto", true, false, false) && hyperMode({ WT_SESSION: "x" }, "auto", true, false, false) && !hyperMode({ TERM_PROGRAM: "Apple_Terminal" }, "auto", true, false, false), "");
ok("fileUrl encodes", fileUrl("/a b/c").indexOf("/a%20b/c") > 0 && fileUrl("/a b/c").startsWith("file://"), fileUrl("/a b/c"));
// prose wraps at blanks (no "a|pp.js"); a word longer than half the line, and code (words off), still split anywhere
const jw = (s: string, w: number, words: boolean): string => JSON.stringify(wrap(s, w, words));
ok("wrap: words", jw("run node --check on app.js", 12, true) === JSON.stringify(["run node", "--check on", "app.js"]), jw("run node --check on app.js", 12, true));
ok("wrap: blank at the break goes", jw("abc def ghi", 7, true) === JSON.stringify(["abc def", "ghi"]), jw("abc def ghi", 7, true));
ok("wrap: long word split", jw("a /tmp/agtest-qarender-pi/index.html", 12, true) === JSON.stringify(["a /tmp/agtes", "t-qarender-p", "i/index.html"]), jw("a /tmp/agtest-qarender-pi/index.html", 12, true));
ok("wrap: chars by default", jw("run node --check", 6, false) === JSON.stringify(["run no", "de --c", "heck"]), jw("run node --check", 6, false));
console.log(bad ? bad + " failed" : "text: all checks passed");
if (bad) process.exit(1);
