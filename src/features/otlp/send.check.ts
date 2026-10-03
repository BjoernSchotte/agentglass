// agentglass — self-check for the OTLP batch sender (retries, Retry-After, partial success, gzip fallback): scriptc build src/features/otlp/send.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { type SendCfg, sendBatch } from "./send.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
const dir = "/tmp/agentglass-send-check-" + String(process.pid); mkdirSync(dir, { recursive: true });
// a fake curl answering from a script: one line per call, "<status> <retry-after> <body>"; logs gz/plain per call
const fake = dir + "/curl";
writeFileSync(fake, "#!/bin/sh\n[ \"$1\" = -V ] && { echo curl 8; exit 0; }\ncat > " + dir + "/cfg\n" +
  "n=$(cat " + dir + "/n 2>/dev/null || echo 0); n=$((n+1)); echo $n > " + dir + "/n\n" +
  "l=$(sed -n \"${n}p\" " + dir + "/script); st=${l%% *}; rest=${l#* }; ra=${rest%% *}; body=${rest#* }\n" +
  "grep -q 'Content-Encoding: gzip' " + dir + "/cfg && echo gz >> " + dir + "/log || echo plain >> " + dir + "/log\n" +
  "h=$(sed -n 's/^dump-header = \"\\(.*\\)\"$/\\1/p' " + dir + "/cfg); printf 'HTTP/1.1 %s x\\r\\n' \"$st\" > \"$h\"; [ \"$ra\" != - ] && printf 'Retry-After: %s\\r\\n' \"$ra\" >> \"$h\"\n" +
  "[ \"$st\" = 000 ] && { printf '\\n000'; exit 7; }\nprintf '%s\\n%s' \"$body\" \"$st\"\n");
chmodSync(fake, 0o755);
process.env["AGENTGLASS_CURL"] = fake; process.env["AGENTGLASS_OTLP_DIR"] = dir + "/otlp";
const C: SendCfg = { url: "http://localhost:4318/v1/traces", headers: [], timeoutS: 5, gzip: true, live: false };
function run(script: string[], json: string, c: SendCfg): string {
  writeFileSync(dir + "/script", script.join("\n") + "\n"); writeFileSync(dir + "/n", "0"); writeFileSync(dir + "/log", "");
  const sl: number[] = [];
  const r = sendBatch(c, json, (ms: number) => { sl.push(ms); });
  return [String(r.ok), String(r.status), String(r.rejected), String(r.gzipRefused), String(r.retries), "sleeps " + sl.join("/"), readFileSync(dir + "/log", "utf8").trim().split("\n").join("+")].join(" ");
}
const big = "{\"resourceSpans\":[" + "{\"x\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},".repeat(60) + "{}]}";
eq("503 then 200", run(["503 - x", "200 - {}"], big, C), "true 200 0 false 1 sleeps 1000 gz+gz");
eq("connection refused retried", run(["000 - x", "000 - x", "200 - {}"], big, C), "true 200 0 false 2 sleeps 1000/2000 gz+gz+gz");
eq("gives up after 3 retries", run(["503 - x", "503 - x", "503 - x", "503 - x", "200 - {}"], big, C), "false 503 0 false 3 sleeps 1000/2000/4000 gz+gz+gz+gz");
eq("400 fails, no retry", run(["400 - bad", "400 - bad"], "{}", C), "false 400 0 false 0 sleeps  plain");
eq("429 + Retry-After capped at 60 s", run(["429 120 x", "200 - {}"], big, C), "true 200 0 false 1 sleeps 60000 gz+gz");
eq("Retry-After honored", run(["503 3 x", "200 - {}"], big, C), "true 200 0 false 1 sleeps 3000 gz+gz");
eq("partial success", run(["200 - {\"partialSuccess\":{\"rejectedSpans\":\"2\",\"errorMessage\":\"bad\"}}"], big, C), "true 200 2 false 0 sleeps  gz");
eq("415 on gzip → plain resend", run(["415 - no", "200 - {}"], big, C), "true 200 0 true 0 sleeps  gz+plain");
eq("400 on gzip, 400 plain → failure, gzip not blamed", run(["400 - no", "400 - no"], big, C), "false 400 0 false 0 sleeps  gz+plain");
eq("small body plain", run(["200 - {}"], "{}", C), "true 200 0 false 0 sleeps  plain");
eq("compression none", run(["200 - {}"], big, { url: C.url, headers: [], timeoutS: 5, gzip: false, live: false }), "true 200 0 false 0 sleeps  plain");
eq("live: one attempt, the queue retries", run(["503 - x", "200 - {}"], big, { url: C.url, headers: [], timeoutS: 5, gzip: true, live: true }), "false 503 0 false 0 sleeps  gz");
rmSync(dir, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp send: all checks passed");
