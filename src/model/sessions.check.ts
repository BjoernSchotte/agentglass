// agentglass — self-check for the live probe: scriptc build src/model/sessions.check.ts -o ssc && ./ssc
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { newSess } from "./types.ts";
import { sessions, probeLive } from "./sessions.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const dir = "/tmp/agtest-probe";
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
console.log(bad ? bad + " failed" : "sessions: all checks passed");
if (bad) process.exit(1);
