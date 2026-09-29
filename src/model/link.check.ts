import { linkByCwd } from "./link.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function show(m: Map<string, number>): string { let o = ""; for (const [k, v] of m) o += k + "=" + v + " "; return o; }
function hasPid(m: Map<string, number>, p: number): boolean { for (const v of m.values()) if (v === p) return true; return false; }
const S = (path: string, cwd: string, mtime: number, pid: number) => ({ path, h: "pi", cwd, mtime, pid });
const m = linkByCwd([{ pid: 10, h: "pi", cwd: "/w/a" }, { pid: 11, h: "pi", cwd: "/w/b" }, { pid: 12, h: "codex", cwd: "/w/a" }],
  [S("old", "/w/a", 1, 0), S("new", "/w/a", 5, 0), S("b", "/w/b", 3, 0), S("c", "/w/c", 9, 0), S("taken", "/w/b", 8, 11)]);
ok("newest session in the cwd", m.get("new") === 10 && !m.has("old"), show(m));
ok("a process owning a session takes no other, linked sessions are skipped", !m.has("b") && !m.has("taken"), show(m));
ok("other harness ignored", !hasPid(m, 12), "");
ok("no process, no link", !m.has("c"), "");
ok("two procs, one cwd: one link each, newest first", linkByCwd([{ pid: 1, h: "pi", cwd: "/x" }, { pid: 2, h: "pi", cwd: "/x" }], [S("p", "/x", 1, 0), S("q", "/x", 2, 0)]).size === 2, "");
const t = linkByCwd([{ pid: 1, h: "pi", cwd: "/x" }, { pid: 2, h: "pi", cwd: "/x" }], [S("p", "/x", 1, 0), S("q", "/x", 2, 0)]);
ok("lowest pid gets the newest", t.get("q") === 1 && t.get("p") === 2, show(t));
const d = linkByCwd([{ pid: 7, h: "pi", cwd: "/y" }], [S("run", "/y", 9, 99), S("prev", "/y", 4, 0)]); // 99 = a daemon running "run"
ok("the client of an already-live newest session links nothing", d.size === 0, show(d));
console.log(bad ? bad + " failed" : "link: all checks passed"); process.exit(bad ? 1 : 0);
