// agentglass — self-check for process → harness detection: scriptc build src/model/procs.check.ts -o prc && ./prc
// SPDX-License-Identifier: Apache-2.0
import { harnessOfArgs } from "./procs.ts";
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
console.log(bad ? bad + " failed" : "procs: all checks passed (" + cases.length + " cases)"); process.exit(bad ? 1 : 0);
