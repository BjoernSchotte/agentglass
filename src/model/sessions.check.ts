// agentglass — self-check for the live probe: scriptc build src/model/sessions.check.ts -o ssc && ./ssc
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { newSess, type Sess } from "./types.ts";
import { H } from "../hooks.ts";
import { sessions, probeLive, scan } from "./sessions.ts";
import { CLAUDE } from "../util/fs.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agentglass-probe-check-" + String(process.pid); // per process: concurrent suite runs
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const pa = dir + "/a.jsonl"; const pb = dir + "/b.jsonl";
writeFileSync(pa, "{\"x\":1}\n"); writeFileSync(pb, "{\"x\":1}\n");
const a = newSess("claude", "a", pa, false); a.pid = 1;
const b = newSess("claude", "b", pb, false);
for (const s of [a, b]) { const st = statSync(s.path); s.size = st.size; s.mtime = st.mtimeMs; sessions.set(s.path, s); }

eq("unchanged", String(probeLive()), "false");
appendFileSync(pa, "{\"x\":2}\n"); appendFileSync(pb, "{\"x\":2}\n");
eq("grew", String(probeLive()), "true");
eq("pid-linked size follows", String(a.size), String(statSync(pa).size));
eq("unlinked left to scan", String(b.size), "8");
eq("settled again", String(probeLive()), "false");
rmSync(pa);
eq("deleted file: no change, no throw", String(probeLive()), "false");

rmSync(dir, { recursive: true, force: true });

// scan: new logs come, deleted ones go (counted, no set of paths per scan), a listed log whose file vanished goes
sessions.clear();
const pd = CLAUDE + "/projects/-tmp-scan"; mkdirSync(pd, { recursive: true });
const u = (n: number): string => pd + "/0000000" + String(n) + "-aaaa-bbbb-cccc-dddddddddddd.jsonl";
writeFileSync(u(1), "{}\n"); writeFileSync(u(2), "{}\n");
scan(); eq("two logs", String(sessions.size), "2");
writeFileSync(u(3), "{}\n"); scan(); eq("a new log", String(sessions.size), "3");
scan(); eq("steady", String(sessions.size), "3");
rmSync(u(2)); scan(); eq("a deleted log goes", String(sessions.size) + " " + String(sessions.has(u(2))), "2 false");
// --redact (H.meta): every scan applies it to every listed session, also unchanged ones and old ones not stat'ed this
// scan (a writer path that skips applyMeta must not leave a real value on screen)
let metas = 0; H.meta.push((x: Sess): void => { metas++; if (x.title && !x.title.startsWith("F-")) x.title = "F-" + x.title; });
scan(); const m1 = metas; scan();
eq("meta per listed session per scan", String(metas - m1), String(sessions.size));
const one = sessions.get(u(1)); if (one) { one.title = "real title"; one.mtime = 1; } // a writer that set a field without applyMeta, on an old log
scan(); eq("faked on the next scan", one ? one.title : "", "F-real title");
H.meta.pop();
rmSync(CLAUDE, { recursive: true, force: true }); scan(); eq("all gone", String(sessions.size), "0");
console.log(bad ? bad + " failed" : "sessions: all checks passed");
if (bad) process.exit(1);
