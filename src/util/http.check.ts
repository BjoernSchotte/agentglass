// agentglass — self-check for the curl JSON GET: scriptc build src/util/http.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { curlBin, getJson, postJson } from "./http.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-http-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
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
// postJson: config (url, headers, body file, write-out, dump-header) on stdin, argv carries nothing secret; status from the last lines
const pf = dir + "/curl-post";
writeFileSync(pf, "#!/bin/sh\n[ \"$1\" = -V ] && { echo curl 8; exit 0; }\necho \"$@\" > " + dir + "/pargv\ncat > " + dir + "/pstdin\n" +
  "b=$(sed -n 's/^data-binary = \"@\\(.*\\)\"$/\\1/p' " + dir + "/pstdin); cp \"$b\" " + dir + "/pbody; stat -c %a \"$b\" > " + dir + "/pmode 2>/dev/null || stat -f %Lp \"$b\" > " + dir + "/pmode\n" +
  "h=$(sed -n 's/^dump-header = \"\\(.*\\)\"$/\\1/p' " + dir + "/pstdin); printf 'HTTP/1.1 503 x\\r\\nRetry-After: 3\\r\\n\\r\\n' > \"$h\"\n" +
  "printf '{\"partialSuccess\":{}}\\n503'\n");
chmodSync(pf, 0o755);
process.env["AGENTGLASS_CURL"] = pf; process.env["AGENTGLASS_OTLP_DIR"] = dir + "/otlp";
const pr = postJson("https://otel.example:4318/v1/traces", [["Authorization", "Bearer t0k\"3n"]], new TextEncoder().encode("{\"a\":1}"), 7, true);
const pargv = readFileSync(dir + "/pargv", "utf8").trim(); const pin = readFileSync(dir + "/pstdin", "utf8");
ok("post argv clean", pargv === "-q -sS -K -", pargv);
ok("post config", pin.indexOf("url = \"https://otel.example:4318/v1/traces\"\n") >= 0 && pin.indexOf("header = \"Authorization: Bearer t0k\\\"3n\"\n") >= 0 && pin.indexOf("header = \"Content-Type: application/json\"\n") >= 0 && pin.indexOf("header = \"Content-Encoding: gzip\"\n") >= 0 && pin.indexOf("request = \"POST\"\n") >= 0 && pin.indexOf("max-time = \"7\"\n") >= 0, pin);
ok("remote: no noproxy", pin.indexOf("noproxy") < 0, pin);
ok("body file copied, 0600, gone after", readFileSync(dir + "/pbody", "utf8") === "{\"a\":1}" && readFileSync(dir + "/pmode", "utf8").trim() === "600" && !existsSync(pin.split("data-binary = \"@")[1]?.split("\"")[0] ?? "x"), readFileSync(dir + "/pmode", "utf8"));
ok("status, body, retry-after", pr.status === 503 && pr.body === "{\"partialSuccess\":{}}" && pr.retryAfter === 3 && pr.exit === 0, JSON.stringify(pr));
postJson("http://localhost:4318/v1/traces", [], new TextEncoder().encode("{}"), 5, false);
const pin2 = readFileSync(dir + "/pstdin", "utf8");
ok("loopback: noproxy, no gzip header", pin2.indexOf("noproxy = \"localhost,127.0.0.1,::1\"\n") >= 0 && pin2.indexOf("Content-Encoding") < 0, pin2);
// connection refused: curl exits 7 without a status
const cf = dir + "/curl-refused";
writeFileSync(cf, "#!/bin/sh\n[ \"$1\" = -V ] && exit 0\ncat > /dev/null\necho 'curl: (7) Failed to connect' >&2\nprintf '\\n000'\nexit 7\n"); chmodSync(cf, 0o755);
process.env["AGENTGLASS_CURL"] = cf;
const rr = postJson("http://localhost:1/v1/traces", [], new TextEncoder().encode("{}"), 5, false);
ok("refused", rr.status === 0 && rr.exit === 7 && rr.err.indexOf("Failed to connect") >= 0, JSON.stringify(rr));
process.env["AGENTGLASS_CURL"] = "/nonexistent";
ok("no curl", curlBin() === "" && getJson("http://x/", "u", "p") === null, curlBin());
rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "http: all checks passed");
if (bad) process.exit(1);
