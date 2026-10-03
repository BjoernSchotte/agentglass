// agentglass — self-check for project identity (remote normalization, resolution, cache): scriptc build src/model/project.check.ts -o pc && ./pc
// SPDX-License-Identifier: Apache-2.0
import { iniRemotes, hasInclude, pickRemote, normRemote } from "./project.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
function N(raw: string): string { const n = normRemote(raw); return n ? n.key + " | " + n.label : "null"; }

// ── normalization table (spec 1.5) ──
eq("https .git", N("https://github.com/Me/X.git"), "git:github.com/me/x | Me/X");
eq("scp", N("git@github.com:me/x"), "git:github.com/me/x | me/x");
eq("ssh default port, trailing /", N("ssh://git@github.com:22/me/x/"), "git:github.com/me/x | me/x");
eq("host case + 443", N("https://GitHub.com:443/Me/X"), "git:github.com/me/x | Me/X");
eq("self-hosted keeps case", N("https://git.example.com/Me/X"), "git:git.example.com/Me/X | Me/X");
eq("self-hosted lower", N("https://git.example.com/me/x"), "git:git.example.com/me/x | me/x");
eq("custom port kept", N("ssh://git@git.example.com:2222/team/app.git"), "git:git.example.com:2222/team/app | team/app");
eq("gitlab subgroups", N("https://gitlab.com/Group/Sub/Proj"), "git:gitlab.com/group/sub/proj | Sub/Proj");
eq("userinfo token scrubbed", N("https://x-access-token:ghs_abc@github.com/o/r"), "git:github.com/o/r | o/r");
const tok = normRemote("https://x-access-token:ghs_abc@github.com/o/r");
eq("scrubbed url", tok ? tok.url : "", "https://github.com/o/r");
eq("http default port", N("http://git.example.com:80/a/b"), "git:git.example.com/a/b | a/b");
eq("alias → null", N("gh:owner/repo"), "null");
eq("collapse //", N("https://github.com//me//x.git/"), "git:github.com/me/x | me/x");
eq("one segment", N("https://git.example.com/solo"), "git:git.example.com/solo | solo");
eq("localhost ok", N("ssh://git@localhost/a/b"), "git:localhost/a/b | a/b");
eq("garbage", N("not a url"), "null");
eq("empty", N(""), "null");
const l1 = normRemote("/srv/git/x.git"); const l2 = normRemote("file:///srv/git/x.git");
eq("local path label", l1 ? l1.label : "", "x");
eq("local path key", l1 ? l1.key : "", "git:file/srv/git/x");
eq("file:// = path", l2 ? l2.key : "", l1 ? l1.key : "?");

// ── INI ──
const up = iniRemotes('[remote "upstream"]\n\turl = https://a/u\n[remote "origin"]\n\turl = https://a/o\n');
eq("ini count", String(up.length), "2");
const p1 = pickRemote(up); eq("origin wins", p1 ? p1.name + " " + p1.url : "", "origin https://a/o");
const p2 = pickRemote(iniRemotes('[remote "fork"]\nurl=https://a/f\n[remote "upstream"]\n url = https://a/u')); eq("upstream next", p2 ? p2.name : "", "upstream");
const p3 = pickRemote(iniRemotes('[remote "b"]\n url = https://a/b\n[remote "c"]\n url = https://a/c')); eq("first in file order", p3 ? p3.name : "", "b");
eq("no remotes", pickRemote(iniRemotes("[core]\n\tbare = false\n")) === null ? "null" : "x", "null");
eq("comment ignored", String(iniRemotes('[remote "o"]\n# url = x\n; url = y\n\turl = "https://q/r" ; trailing\n').map((r) => r.url).join(",")), "https://q/r");
eq("first url per section", iniRemotes('[remote "o"]\n url = https://a/1\n url = https://a/2').map((r) => r.url).join(","), "https://a/1");
eq("url outside remote", String(iniRemotes('[branch "main"]\n url = https://x/y').length), "0");
eq("includeIf", hasInclude('[core]\n[includeIf "gitdir:~/w/"]\n\tpath = x') ? "y" : "n", "y");
eq("include", hasInclude("[include]\n\tpath = x") ? "y" : "n", "y");
eq("no include", hasInclude('[remote "o"]\n url = include') ? "y" : "n", "n");

console.log(bad ? bad + " failed" : "project ok");
if (bad) process.exit(1);
