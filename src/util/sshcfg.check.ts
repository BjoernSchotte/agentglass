// agentglass — self-check for the ~/.ssh/config reader: scriptc build src/util/sshcfg.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { run } from "./fs.ts";
import { sshTarget, sshStamp, SSH } from "./sshcfg.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
// a temp home per run: ~/.ssh/config and its includes are fixtures, never the user's
const H = "/tmp/agsc-" + String(process.pid);
rmSync(H, { recursive: true, force: true });
const D = H + "/.ssh"; mkdirSync(D + "/conf.d", { recursive: true });
const F = D + "/config";
function put(p: string, body: string): void { writeFileSync(p, body); }
let bump = 10;
// a distinct mtime per edit, also on coarse clocks (touch -t: GNU and BSD)
function touch(p: string): void { bump++; run("touch", ["-t", "2001010112" + String(bump), p]); }
function T(alias: string): string { const t = sshTarget(alias, F); return t.host + (t.port ? ":" + t.port : ""); }

eq("default file under ~/.ssh", SSH.file.endsWith("/.ssh/config") ? "y" : SSH.file, "y");
eq("missing file", T("github-work"), "");
eq("missing stamp stable", sshStamp(F) === sshStamp(F) ? "y" : "n", "y");

put(F, [
  "# comment",
  "Host github-work gh-alt",
  "  HostName github.com",
  "  User git",
  "",
  "Host \"quoted\"",
  "\tHostName=Git.Example.COM",
  "Host lab-?",
  "  HostName %h.lan.example.com",
  "Host gitea",
  "  hostname git.example.com",
  "  Port 2222",
  "Host *.corp !skip.corp",
  "  HostName %h.example.org",
  "Host pct",
  "  HostName 100%%.example.com",
  "Host tok",
  "  HostName %r.example.com",
  "Host bogus",
  "  HostName bad host@x",
  "Host bogus2",
  "  HostName \"bad host\"",
  "Host first",
  "  HostName one.example.com",
  "Host first",
  "  HostName two.example.com",
  "  Port 2200",
  "Match host matchonly",
  "  HostName match.example.com",
  "Host six",
  "  HostName fe80::1",
  "Host *",
  "  ServerAliveInterval 30",
].join("\n") + "\n"); touch(F);
eq("alias", T("github-work"), "github.com");
eq("second pattern", T("gh-alt"), "github.com");
eq("alias case-insensitive", T("GitHub-Work"), "github.com");
eq("quoted pattern, = form, host lowercased", T("quoted"), "git.example.com");
eq("? wildcard + %h", T("lab-1"), "lab-1.lan.example.com");
eq("? is one char", T("lab-12"), "");
eq("keyword case-insensitive + Port", T("gitea"), "git.example.com:2222");
eq("* wildcard", T("build.corp"), "build.corp.example.org");
eq("negated pattern", T("skip.corp"), "");
eq("%% expands, % is no host char", T("pct"), "");
eq("unknown token → no mapping", T("tok"), "");
eq("trailing garbage ignored", T("bogus"), "");
eq("invalid HostName ignored", T("bogus2"), "");
eq("first value wins per keyword", T("first"), "one.example.com:2200");
eq("Match blocks never apply", T("matchonly"), "");
eq("ipv6 bracketed", T("six"), "[fe80::1]");
eq("no HostName for it", T("unknown-host"), "");

// a global section before the first Host applies to all hosts
put(F, "HostName global.example.com\nHost a\n  HostName a.example.com\n"); touch(F);
eq("global first wins", T("a"), "global.example.com");
eq("mtime change re-read", T("zzz"), "global.example.com");

// Include: relative to ~/.ssh, ~ expansion, globs in the last part, conditional inside a Host block, one level only
put(D + "/conf.d/10-work", "Host work\n  HostName work.example.com\nInclude deeper\n");
put(D + "/conf.d/20-home", "Host home\n  HostName home.example.com\n");
put(D + "/deeper", "Host deep\n  HostName deep.example.com\n");
put(D + "/cond", "HostName cond.example.com\nHost inner\n  HostName inner.example.com\n");
put(D + "/tilde", "Host tl\n  HostName tilde.example.com\n");
put(F, "Include conf.d/*\nInclude " + D + "/missing ~/.ssh/tilde\nHost outer\n  Include cond\nHost after\n  HostName after.example.com\n"); touch(F);
const keep = SSH.home; SSH.home = H;
eq("include glob 1", T("work"), "work.example.com");
eq("include glob 2", T("home"), "home.example.com");
eq("include ~ expansion", T("tl"), "tilde.example.com");
eq("second-level include ignored", T("deep"), "");
eq("include inside Host: applies to that host", T("outer"), "cond.example.com");
eq("include inside Host: its Host blocks need the outer match too", T("inner"), "");
eq("block after include", T("after"), "after.example.com");
// an included file edited (same main config): picked up by its own mtime
put(D + "/conf.d/20-home", "Host home\n  HostName home2.example.com\n"); touch(D + "/conf.d/20-home");
eq("include edit re-read", T("home"), "home2.example.com");
// a new file matching the glob: picked up through the directory's mtime
const s1 = sshStamp(F);
put(D + "/conf.d/30-new", "Host newer\n  HostName new.example.com\n"); touch(D + "/conf.d");
eq("new glob match", T("newer"), "new.example.com");
eq("stamp changes", sshStamp(F) !== s1 ? "y" : "n", "y");
SSH.home = keep;

// unreadable config: no mapping, no crash
put(F, "Host u\n  HostName u.example.com\n"); touch(F); eq("readable", T("u"), "u.example.com");
chmodSync(F, 0o000); touch(F);
eq("unreadable file", T("u"), "");
chmodSync(F, 0o644);
// an oversized file is not read
put(F, "Host big\n  HostName big.example.com\n" + "#".repeat(300000) + "\n"); touch(F);
eq("oversized file", T("big"), "");
// directory instead of a file
rmSync(F); mkdirSync(F); eq("config is a directory", T("u"), "");

rmSync(H, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "sshcfg ok");
if (bad) process.exit(1);
