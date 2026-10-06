#!/bin/sh
# the main binary stays on the LLVM tier: no file in src/main.ts's import graph imports node:https (it would move the
# whole program to the C backend — otlp-hub Decision 8); src/receive-tls.ts is the only importer and nothing imports it
set -e
cd "$(dirname "$0")/.."
command -v node > /dev/null || { echo "skipped: no node"; exit 0; }
node - <<'JS'
const { readFileSync } = require("node:fs"); const { dirname, resolve, relative } = require("node:path");
function closure(entry) { // entry + its transitive relative imports (scripts/check-plan.mjs's walk)
  const seen = new Set(); const stack = [resolve(entry)];
  while (stack.length) {
    const f = stack.pop(); if (seen.has(f)) continue; seen.add(f);
    let src; try { src = readFileSync(f, "utf8"); } catch { continue; }
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) stack.push(resolve(dirname(f), m[1]));
  }
  return seen;
}
const https = /(?:from|import)\s*\(?\s*["'](?:node:)?https["']/;
let bad = 0;
for (const f of closure("src/main.ts")) {
  let src = ""; try { src = readFileSync(f, "utf8"); } catch { continue; }
  if (https.test(src)) { console.log("FAIL " + relative(process.cwd(), f) + " imports node:https and is reached from src/main.ts"); bad++; }
  if (/receive-tls\.ts["']/.test(src)) { console.log("FAIL " + relative(process.cwd(), f) + " imports src/receive-tls.ts"); bad++; }
}
const tls = closure("src/receive-tls.ts");
if (!https.test(readFileSync("src/receive-tls.ts", "utf8"))) { console.log("FAIL src/receive-tls.ts no longer serves https"); bad++; }
if (!tls.has(resolve("src/features/hub/server.ts"))) { console.log("FAIL src/receive-tls.ts does not use the shared handler"); bad++; }
if (!bad) console.log("no https in main: ok (" + String(closure("src/main.ts").size) + " files checked)");
process.exit(bad ? 1 : 0);
JS
