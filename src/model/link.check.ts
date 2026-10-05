import { linkByCwd } from "./link.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function show(m: Map<string, number>): string { let o = ""; for (const [k, v] of m) o += k + "=" + v + " "; return o; }
function hasPid(m: Map<string, number>, p: number): boolean { for (const v of m.values()) if (v === p) return true; return false; }
const S = (path: string, cwd: string, mtime: number, pid: number) => ({ path, h: "pi", cwd, mtime, pid, start: 0 });
const P = (pid: number, h: string, cwd: string) => ({ pid, h, cwd, after: 0 });
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
// the process did. With a known process start (after) only sessions started since then are its own; none yet = no link
const G = (path: string, mtime: number, start: number) => ({ path, h: "gemini", cwd: "/g", mtime, pid: 0, start });
const g1 = linkByCwd([{ pid: 5, h: "gemini", cwd: "/g", after: 1000 }], [G("old-rewritten", 9000, 100), G("mine", 8000, 1500)]);
ok("gemini: the session started after the process, not the rewritten old one", g1.get("mine") === 5 && !g1.has("old-rewritten"), show(g1));
const g2 = linkByCwd([{ pid: 5, h: "gemini", cwd: "/g", after: 1000 }], [G("old-rewritten", 9000, 100)]);
ok("gemini: no session of its own yet: no link", g2.size === 0, show(g2));
const g3 = linkByCwd([{ pid: 5, h: "gemini", cwd: "/g", after: 0 }], [G("resumed", 9000, 100), G("older", 100, 50)]);
ok("start unknown or a resume: the newest, as before", g3.get("resumed") === 5, show(g3));
console.log(bad ? bad + " failed" : "link: all checks passed"); process.exit(bad ? 1 : 0);
