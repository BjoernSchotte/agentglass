// agentglass — self-check for process → harness detection: scriptc build src/model/procs.check.ts -o prc && ./prc
// SPDX-License-Identifier: Apache-2.0
import { harnessOfArgs, linkOne } from "./procs.ts";
import { newSess, type Sess } from "./types.ts";
import { H } from "../hooks.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const cases: string[][] = [
  ["node /u/.nvm/versions/node/v24/bin/gemini -p hi", "gemini"], // launcher
  ["node --max-old-space-size=8192 /u/lib/node_modules/@google/gemini-cli/bundle/gemini.js -p hi", "gemini"], // relaunched child
  ["node --no-warnings=DEP0040 --max-old-space-size=8192 /x/bundle/gemini.js", "gemini"],
  ["/usr/local/bin/gemini", "gemini"], // SEA binary
  ["node /x/pi.js", "pi"],
  ["node /x/dist/cli.js", ""],
  ["node --inspect", ""], // only flags: nothing to name
  ["node -r ./hook.js /u/bin/gemini -p hi", "gemini"], // a flag with a separate value is no script
  ["node --require /x/pi.js --import /y/loader.mjs /u/bin/gemini", "gemini"],
  ["node --inspect-port 9229 /x/pi.js", "pi"],
  ["node -e 1", ""], // inline code: no script
  ["/usr/bin/aider --model x", "aider"],
  ["claude --resume abc", "claude"],
];
for (const c of cases) { const got = harnessOfArgs(c[0]); ok(c[0], got === c[1], JSON.stringify(got) + " ≠ " + c[1]); }
// linking a session to its process: H.meta (redact fakes the name) runs only when the linked name changed or s.name was
// rewritten since; the real name never stays in s.name
let metas = 0;
H.meta.push((s: Sess): void => { metas++; if (s.name && !s.name.startsWith("F-")) s.name = "F-" + s.name; });
const ls = newSess("codex", "l1", "/l/1", false);
ok("first link runs meta", linkOne(ls, 42, "busy", "real") && ls.name === "F-real" && ls.pid === 42, ls.name);
const m0 = metas;
ok("same link: no meta, fake kept", !linkOne(ls, 42, "idle", "real") && ls.name === "F-real" && ls.status === "idle" && metas === m0, ls.name);
ok("other name: meta again", linkOne(ls, 42, "idle", "other") && ls.name === "F-other", ls.name);
ls.name = "nick"; // a re-parse set it (codex nickname): the link wins again, as before
ok("name rewritten elsewhere: relinked", linkOne(ls, 42, "idle", "other") && ls.name === "F-other", ls.name);
ok("unlinked: name cleared", linkOne(ls, 0, "", "") && ls.name === "" && ls.pid === 0, ls.name);
console.log(bad ? bad + " failed" : "procs: all checks passed (" + String(cases.length + 5) + " cases)"); process.exit(bad ? 1 : 0);
