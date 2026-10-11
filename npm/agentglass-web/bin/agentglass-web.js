#!/usr/bin/env node
// agentglass-web from npm: runs the native binary of this platform's package (installed as an optional dependency,
// no install script); every argument and the exit status pass through. Without it, says which package is missing.
"use strict";
const { spawnSync } = require("node:child_process");
const PKG = { "linux-x64": "agentglass-web-linux-x64", "linux-arm64": "agentglass-web-linux-arm64", "darwin-arm64": "agentglass-web-darwin-arm64", "darwin-x64": "agentglass-web-darwin-x64-baseline" };
const key = process.platform + "-" + process.arch; const pkg = PKG[key];
if (!pkg) { console.error("agentglass-web: no build for " + key + " (linux-x64, linux-arm64, darwin-arm64, darwin-x64)"); process.exit(1); }
let bin;
try { bin = require.resolve(pkg + "/bin/agentglass-web"); }
catch (e) {
  console.error("agentglass-web: the package " + pkg + " is missing — it holds the binary for " + key + ".\n" +
    "  npm installs it as an optional dependency: reinstall without --omit=optional (or --no-optional), e.g.\n" +
    "  npm i -g agentglass-web");
  process.exit(1);
}
const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
if (r.error) { console.error("agentglass-web: " + r.error.message); process.exit(1); }
if (r.signal) process.kill(process.pid, r.signal);
process.exit(r.status ?? 1);
