// agentglass — self-check for privacy mode: scriptc build src/features/redact.check.ts -o rdc && AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme ./rdc
// SPDX-License-Identifier: Apache-2.0
import { userInfo } from "node:os";
import type { Ev } from "../model/types.ts";
import { newSess } from "../model/types.ts";
import { HOME } from "../util/fs.ts";
import { width } from "../util/text.ts";
import { H, applyMeta, screenOut } from "../hooks.ts";
import { REDACT, scrubText, fakeProject } from "./redact.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": " + JSON.stringify(got)); } }
const user = userInfo().username;
ok("active", REDACT, "set AGENTGLASS_REDACT=1");

// fake project names keep the length, and the same real name always maps to the same fake
const reals: string[] = ["ab1", "acmecorp", "Kitchen Sink", "some-client-portal", "x".repeat(60)];
for (const r of reals) { const f = fakeProject(r); ok("fake len " + r, f.length === r.length && f === fakeProject(r.toUpperCase()), f); }

// identity: title/cwd/branch/name are overridden and stay overridden after parsing writes them again
const s = newSess("claude", "11111111-2222", "/tmp/x.jsonl", false);
s.cwd = HOME + "/code/secretproj/src"; s.title = "Fix the thing for ACME"; s.branch = "acme/login"; s.name = "my-session"; s.remote = "https://github.com/acmecorp/secretproj";
applyMeta(s);
const rm1 = s.remote;
ok("remote faked", rm1.startsWith("https://github.com/acme/") && rm1.indexOf("secretproj") < 0 && rm1.indexOf("acmecorp") < 0, rm1);
const t1 = s.title; const c1 = s.cwd;
ok("title faked", t1 !== "Fix the thing for ACME", t1);
ok("cwd faked", c1.indexOf("secretproj") < 0 && c1.endsWith("/src"), c1);
ok("branch faked", s.branch.startsWith("feat/"), s.branch);
ok("name faked", s.name !== "my-session", s.name);
s.cwd = HOME + "/code/secretproj/src"; s.title = "Fix the thing for ACME";
applyMeta(s);
s.remote = "https://github.com/acmecorp/secretproj";
applyMeta(s);
ok("stable", s.title === t1 && s.cwd === c1 && s.remote === rm1, s.title + " " + s.cwd + " " + s.remote);

// scrubber: same length, names and learned projects gone, box line stays aligned
const line = "│ /Users/" + user + "/code/secretproj/web · " + user.toUpperCase() + " · me@example.org · sk-" + "Ab3".repeat(10) + " │";
const out = scrubText(line);
ok("same width", width(out) === width(line), out);
ok("no user", out.toLowerCase().indexOf(user.toLowerCase()) < 0, out);
ok("no project", out.indexOf("secretproj") < 0, out);
ok("no email", out.indexOf("example.org") < 0, out);
ok("no key", out.indexOf("Ab3Ab3") < 0, out);
ok("words bound", scrubText("xsecretprojx") === "xsecretprojx", scrubText("xsecretprojx"));
const styled = "\x1b[2;3H\x1b[38;2;1;2;3m" + user + "\x1b[0m/secretproj";
const so = screenOut(styled);
ok("escapes intact", so.startsWith("\x1b[2;3H\x1b[38;2;1;2;3m") && so.indexOf("\x1b[0m/") > 0 && so.length === styled.length && so.indexOf(user) < 0, so);

// content: a non-keep session's events are synthetic, tool names survive
const evs: Ev[] = [{ kind: "user", text: "please fix ACME invoices", ts: "t", id: "", full: "" }, { kind: "tool", text: "Bash\u0000cat /secret/acme.txt", ts: "t", id: "a", full: "{}" }, { kind: "result", text: "ACME data", ts: "t", id: "a", full: "" }];
for (const f of H.events) f(s, evs, 0);
const all = evs.map((e) => e.text + e.full).join(" ");
ok("content faked", all.indexOf("ACME") < 0 && all.indexOf("acme") < 0, all);
ok("tool name kept", (evs[1] ?? evs[0]).text.startsWith("Bash\u0000"), (evs[1] ?? evs[0]).text);

// a line with an OSC 8 link: the escape (url) bytes stay as they are, only the visible text is scrubbed
const esc = "\x1b]8;;agentglass://open/claude/" + user + "\x1b\\";
const lk = "\x1b[1m" + esc + "home of " + user + "\x1b]8;;\x1b\\\x1b[0m";
const sl = screenOut(lk);
ok("link escape untouched", sl.indexOf(esc) === 4 && sl.indexOf("\x1b]8;;\x1b\\") > 0, sl);
ok("link text scrubbed", sl.slice(sl.indexOf(esc) + esc.length).indexOf(user) < 0, sl);

console.log(bad ? bad + " failed" : "ok");
process.exit(bad ? 1 : 0);
