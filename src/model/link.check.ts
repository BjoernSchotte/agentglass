import { linkByCwd } from "./link.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function show(m: Map<string, number>): string { let o = ""; for (const [k, v] of m) o += k + "=" + v + " "; return o; }
function hasPid(m: Map<string, number>, p: number): boolean { for (const v of m.values()) if (v === p) return true; return false; }
const S = (path: string, cwd: string, mtime: number, pid: number) => ({ path, id: path, h: "pi", cwd, mtime, pid, start: 0 });
const P = (pid: number, h: string, cwd: string) => ({ pid, h, cwd, start: 0, resume: "" });
const m = linkByCwd([P(10, "pi", "/w/a"), P(11, "pi", "/w/b"), P(12, "codex", "/w/a")],
  [S("old", "/w/a", 1, 0), S("new", "/w/a", 5, 0), S("b", "/w/b", 3, 0), S("c", "/w/c", 9, 0), S("taken", "/w/b", 8, 11)]);
ok("newest session in the cwd", m.get("new") === 10 && !m.has("old"), show(m));
ok("a process owning a session takes no other, linked sessions are skipped", !m.has("b") && !m.has("taken"), show(m));
ok("other harness ignored", !hasPid(m, 12), "");
ok("no process, no link", !m.has("c"), "");
ok("two procs, one cwd: one link each, newest first", linkByCwd([P(1, "pi", "/x"), P(2, "pi", "/x")], [S("p", "/x", 1, 0), S("q", "/x", 2, 0)]).size === 2, "");
const t = linkByCwd([P(1, "pi", "/x"), P(2, "pi", "/x")], [S("p", "/x", 1, 0), S("q", "/x", 2, 0)]);
ok("lowest pid gets the newest", t.get("q") === 1 && t.get("p") === 2, show(t));
const d = linkByCwd([P(7, "pi", "/y")], [S("run", "/y", 9, 99), S("prev", "/y", 4, 0)]); // 99 = a daemon running "run"
ok("the client of an already-live newest session links nothing", d.size === 0, show(d));
// Gemini rewrites an older session of the project when it starts: that file is the newest by mtime, but it started before
// the process did. With a known process start only sessions started since then are its own; none yet = no link
// times in tenths of a second (×100 ms: the 1 s slack is 10 units)
const G = (path: string, mtime: number, start: number) => ({ path, id: "id-" + path, h: "gemini", cwd: "/g", mtime: mtime * 100, pid: 0, start: start * 100 });
const GP = (pid: number, start: number, resume: string) => ({ pid, h: "gemini", cwd: "/g", start: start * 100, resume });
const g1 = linkByCwd([GP(5, 1000, "")], [G("old-rewritten", 9000, 100), G("mine", 8000, 1500)]);
ok("gemini: the session started after the process, not the rewritten old one", g1.get("mine") === 5 && !g1.has("old-rewritten"), show(g1));
const g2 = linkByCwd([GP(5, 1000, "")], [G("old-rewritten", 9000, 100)]);
ok("gemini: no session of its own yet: no link", g2.size === 0, show(g2));
const g3 = linkByCwd([GP(5, 0, "")], [G("resumed", 9000, 100), G("older", 100, 50)]);
ok("start unknown: the newest, as before", g3.get("resumed") === 5, show(g3));
// two Gemini processes a few seconds apart in one project: each its own session, whichever was written last (both
// started after the older process; the newer process's start tells them apart). Lowest pid first used to take the newest
const two = [G("a-sess", 9000, 11000), G("b-sess", 9500, 16000)];
const tw1 = linkByCwd([GP(5, 10000, ""), GP(6, 15000, "")], two);
ok("gemini: two procs a few s apart, each its own (newer written last)", tw1.get("a-sess") === 5 && tw1.get("b-sess") === 6, show(tw1));
const tw2 = linkByCwd([GP(5, 10000, ""), GP(6, 15000, "")], [G("a-sess", 9900, 11000), G("b-sess", 9500, 16000)]);
ok("gemini: two procs a few s apart, each its own (older written last)", tw2.get("a-sess") === 5 && tw2.get("b-sess") === 6, show(tw2));
const tw3 = linkByCwd([GP(6, 15000, ""), GP(5, 10000, "")], [G("a-sess", 9900, 11000), G("b-rewritten", 9950, 1000)]);
ok("gemini: the newer process before its first session takes no other", tw3.get("a-sess") === 5 && tw3.size === 1, show(tw3));
// the process start is a lower bound (etime: whole seconds) or exact (/proc): a header up to 1 s before it still counts
ok("gemini: header 0.5 s before the process start (clock rounding) is its own", linkByCwd([GP(5, 10000, "")], [G("mine", 9000, 9995)]).get("mine") === 5, "");
ok("gemini: header 5 s before the process start is not", linkByCwd([GP(5, 10000, "")], [G("old", 9000, 9950)]).size === 0, "");
// --resume: "latest" = the newest by start of those begun before the process (gemini's own pick), an id = that session,
// an index = gemini's numbering (by start, 1-based, sessions with messages only); an unknown id links nothing
const rs = [G("r1", 9000, 100), G("r2", 500, 200), G("r3", 400, 300), G("empty", 600, 350), G("other", 9500, 20000)];
const msgs = (p: string): number => p === "empty" ? 0 : 1;
ok("gemini --resume: the newest started before it", linkByCwd([GP(5, 1000, "latest")], rs, msgs).get("r3") === 5, show(linkByCwd([GP(5, 1000, "latest")], rs, msgs)));
ok("gemini --resume <id>", linkByCwd([GP(5, 1000, "id-r2")], rs, msgs).get("r2") === 5, show(linkByCwd([GP(5, 1000, "id-r2")], rs, msgs)));
ok("gemini --resume <index>", linkByCwd([GP(5, 1000, "1")], rs, msgs).get("r1") === 5 && linkByCwd([GP(5, 1000, "3")], rs, msgs).get("r3") === 5, show(linkByCwd([GP(5, 1000, "1")], rs, msgs)));
ok("gemini --resume <unknown id>: no link", linkByCwd([GP(5, 1000, "nope")], rs, msgs).size === 0, show(linkByCwd([GP(5, 1000, "nope")], rs, msgs)));
const rf = linkByCwd([GP(5, 1000, ""), GP(7, 1500, "id-r1")], [G("r1", 9000, 100), G("mine", 8000, 1200)], msgs);
ok("gemini: a resume and a new one in one project", rf.get("r1") === 7 && rf.get("mine") === 5, show(rf));
// an in-TUI /resume: the process records into an older session from then on; its own startup session stays empty. A
// lone process takes the older one once it got a message after the process started (the startup rewrite appends no
// message), unless another process held it since (a headless --resume run)
const last = new Map<string, number>([["mine", 0], ["old", 1200], ["old-sum", 50], ["mine-chat", 1100]]);
const lm = (p: string): number => (last.get(p) ?? 0) * 100;
const tu1 = linkByCwd([GP(5, 1000, "")], [G("old", 1300, 100), G("mine", 1050, 1010)], lm);
ok("gemini: an older session written by the lone process since its start (in-TUI resume)", tu1.get("old") === 5 && tu1.size === 1, show(tu1));
const tu2 = linkByCwd([GP(5, 1000, "")], [G("old-sum", 1300, 100), G("mine", 1050, 1010)], lm);
ok("gemini: an older session only rewritten (summary) stays unlinked", tu2.get("mine") === 5 && tu2.size === 1, show(tu2));
const tu3 = linkByCwd([GP(5, 1000, "")], [G("old", 1300, 100), G("mine", 1050, 1010)], lm, (p: string, pid: number, since: number): boolean => p === "old");
ok("gemini: an older session another process held since this start (headless run) stays unlinked", tu3.get("mine") === 5 && tu3.size === 1, show(tu3));
const tu4 = linkByCwd([GP(5, 1000, ""), GP(6, 1005, "")], [G("old", 1300, 100), G("mine", 1050, 1010)], lm);
ok("gemini: two processes in the project: no guess which resumed it", !tu4.has("old"), show(tu4));
last.set("mine", 1250);
const tu5 = linkByCwd([GP(5, 1000, "")], [G("old", 1300, 100), G("mine", 1260, 1010)], lm);
ok("gemini: its own session written after the older one: its own", tu5.get("mine") === 5 && tu5.size === 1, show(tu5));
console.log(bad ? bad + " failed" : "link: all checks passed"); process.exit(bad ? 1 : 0);
