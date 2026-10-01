// agentglass — self-check for the curl JSON GET: scriptc build src/util/http.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { curlBin, getJson } from "./http.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-http-check"; mkdirSync(dir, { recursive: true });
// a fake curl: -V answers the probe; otherwise argv and stdin are recorded, the body is printed
const fake = dir + "/curl";
writeFileSync(fake, "#!/bin/sh\n[ \"$1\" = -V ] && { echo curl 8; exit 0; }\necho \"$@\" > " + dir + "/argv\ncat > " + dir + "/stdin\necho '{\"ok\":1}'\n");
chmodSync(fake, 0o755);
process.env["AGENTGLASS_CURL"] = fake;
ok("probe", curlBin() === fake, curlBin());
const r = getJson("http://127.0.0.1:1/api/info", "opencode", "s3cr\"et\\x");
ok("body", !!r && r["ok"] === 1, JSON.stringify(r));
const argv = readFileSync(dir + "/argv", "utf8"); const stdin = readFileSync(dir + "/stdin", "utf8");
ok("password not in argv", argv.indexOf("s3cr") < 0 && argv.indexOf("-K -") >= 0, argv);
ok("no ~/.curlrc, no proxy", argv.startsWith("-q ") && argv.indexOf("--noproxy *") >= 0, argv);
ok("config on stdin, escaped", stdin === "url = \"http://127.0.0.1:1/api/info\"\nuser = \"opencode:s3cr\\\"et\\\\x\"\n", stdin);
// --fail: an HTTP error exits 22 → null
const fail = dir + "/curl-fail";
writeFileSync(fail, "#!/bin/sh\n[ \"$1\" = -V ] && exit 0\ncat > /dev/null\nexit 22\n"); chmodSync(fail, 0o755);
process.env["AGENTGLASS_CURL"] = fail;
ok("http error → null", getJson("http://x/", "u", "p") === null, "");
// not an object → null
const arrF = dir + "/curl-arr";
writeFileSync(arrF, "#!/bin/sh\n[ \"$1\" = -V ] && exit 0\ncat > /dev/null\necho '[1]'\n"); chmodSync(arrF, 0o755);
process.env["AGENTGLASS_CURL"] = arrF;
ok("non-object → null", getJson("http://x/", "u", "p") === null, "");
process.env["AGENTGLASS_CURL"] = "/nonexistent";
ok("no curl", curlBin() === "" && getJson("http://x/", "u", "p") === null, curlBin());
console.log(bad ? bad + " failed" : "http: all checks passed");
if (bad) process.exit(1);
