// agentglass — self-check for the OTLP batch sender (retries, Retry-After, partial success, gzip fallback): scriptc build src/features/otlp/send.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { type SendCfg, sendBatch, tlsFail, decide, resetLike } from "./send.ts";

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
  "[ \"$st\" = 000 ] && { printf '\\n000'; exit 7; }\n" +
  "[ \"$st\" = R55 ] && { echo 'curl: (55) Send failure: Connection reset by peer' >&2; printf '\\n000'; exit 55; }\n" +
  "[ \"$st\" = T56 ] && { echo 'curl: (56) OpenSSL SSL_read: error:0A00045C:SSL routines::tlsv13 alert certificate required, errno 0' >&2; printf '\\n000'; exit 56; }\nprintf '%s\\n%s' \"$body\" \"$st\"\n");
chmodSync(fake, 0o755);
process.env["AGENTGLASS_CURL"] = fake; process.env["AGENTGLASS_OTLP_DIR"] = dir + "/otlp";
const C: SendCfg = { url: "http://localhost:4318/v1/traces", headers: [], timeoutS: 5, gzip: true, live: false, tls: ["", "", ""] };
function run(script: string[], json: string, c: SendCfg): string {
  writeFileSync(dir + "/script", script.join("\n") + "\n"); writeFileSync(dir + "/n", "0"); writeFileSync(dir + "/log", "");
  const sl: number[] = [];
  const r = sendBatch(c, json, (ms: number) => { sl.push(ms); });
  return [String(r.ok), String(r.final), String(r.status), String(r.rejected), String(r.gzipRefused), String(r.retries), "sleeps " + sl.join("/"), readFileSync(dir + "/log", "utf8").trim().split("\n").join("+")].join(" ");
}
const big = "{\"resourceSpans\":[" + "{\"x\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"},".repeat(60) + "{}]}";
eq("503 then 200", run(["503 - x", "200 - {}"], big, C), "true false 200 0 false 1 sleeps 1000 gz+gz");
eq("connection refused retried", run(["000 - x", "000 - x", "200 - {}"], big, C), "true false 200 0 false 2 sleeps 1000/2000 gz+gz+gz");
eq("gives up after 3 retries", run(["503 - x", "503 - x", "503 - x", "503 - x", "200 - {}"], big, C), "false false 503 0 false 3 sleeps 1000/2000/4000 gz+gz+gz+gz");
eq("400 fails, no retry", run(["400 - bad", "400 - bad"], "{}", C), "false false 400 0 false 0 sleeps  plain");
eq("429 + Retry-After capped at 60 s", run(["429 120 x", "200 - {}"], big, C), "true false 200 0 false 1 sleeps 60000 gz+gz");
eq("Retry-After honored", run(["503 3 x", "200 - {}"], big, C), "true false 200 0 false 1 sleeps 3000 gz+gz");
eq("partial success", run(["200 - {\"partialSuccess\":{\"rejectedSpans\":\"2\",\"errorMessage\":\"bad\"}}"], big, C), "true false 200 2 false 0 sleeps  gz");
eq("415 on gzip → plain resend", run(["415 - no", "200 - {}"], big, C), "true false 200 0 true 0 sleeps  gz+plain");
eq("400 on gzip, 400 plain → failure, gzip not blamed", run(["400 - no", "400 - no"], big, C), "false false 400 0 false 0 sleeps  gz+plain");
eq("small body plain", run(["200 - {}"], "{}", C), "true false 200 0 false 0 sleeps  plain");
eq("compression none", run(["200 - {}"], big, { url: C.url, headers: [], timeoutS: 5, gzip: false, live: false, tls: ["", "", ""] }), "true false 200 0 false 0 sleeps  plain");
eq("live: one attempt, the queue retries", run(["503 - x", "200 - {}"], big, { url: C.url, headers: [], timeoutS: 5, gzip: true, live: true, tls: ["", "", ""] }), "false false 503 0 false 0 sleeps  gz");

// TLS failures (otlp-complete 1.4): final, never retried; a plain connection reset still is
const T: [number, string, boolean][] = [
  [56, "curl: (56) OpenSSL SSL_read: OpenSSL/3.5.3: error:0A00045C:SSL routines::tlsv13 alert certificate required, errno 0", true],
  [56, "curl: (56) OpenSSL SSL_read: OpenSSL/3.5.3: error:0A000415:SSL routines::ssl/tls alert certificate expired, errno 0", true],
  [56, "curl: (56) OpenSSL SSL_read: OpenSSL/3.5.3: error:0A000418:SSL routines::tlsv1 alert unknown ca, errno 0", true],
  [56, "curl: (56) Recv failure: Connection reset by peer", false],
  [35, "curl: (35) OpenSSL/3.5.3: error:0A000418:SSL routines::tlsv1 alert unknown ca", true],
  [35, "curl: (35) TLS connect error: error:0A000410:SSL routines::ssl/tls alert handshake failure", true],
  [35, "curl: (35) Recv failure: Connection reset by peer", false],
  [60, "curl: (60) SSL certificate problem: self-signed certificate in certificate chain", true],
  [58, "curl: (58) unable to set private key file: 'cli2.key' type PEM", true],
  [77, "curl: (77) error setting certificate file: /x/ca.crt", true],
  [7, "curl: (7) Failed to connect", false],
  [28, "curl: (28) Operation timed out", false],
];
for (const t of T) eq("tls " + String(t[0]) + " " + t[1].slice(0, 50), String(tlsFail(t[0], t[1]) !== ""), String(t[2]));
eq("cert required msg", String(tlsFail(56, "tlsv13 alert certificate required").indexOf("otlp.tls.cert") >= 0), "true");
eq("unknown ca msg", String(tlsFail(56, "tlsv1 alert unknown ca").indexOf("rejected the client certificate") >= 0), "true");
eq("verify msg", String(tlsFail(60, "x").indexOf("otlp.tls.ca") >= 0), "true");
eq("expired msg", String(tlsFail(56, "alert certificate expired").indexOf("expired") >= 0) + " " + String(tlsFail(60, "SSL certificate problem: certificate has expired").indexOf("expired") >= 0), "true true");
eq("handshake failure msg", String(tlsFail(35, "TLS connect error: error:0A000410:SSL routines::ssl/tls alert handshake failure").indexOf("otlp.tls.cert") >= 0), "true");
eq("key msg", String(tlsFail(58, "unable to set private key file").indexOf("unencrypted key") >= 0), "true");
eq("decide", [decide(0, 56, "…tlsv13 alert certificate required", 0, false), decide(0, 56, "Recv failure: Connection reset by peer", 0, false), decide(503, 0, "", 3, false), decide(503, 0, "", 0, false), decide(503, 0, "", 0, true), decide(200, 0, "", 0, false), decide(400, 0, "", 0, false), decide(0, 60, "x", 0, true)].join(" "),
  "final retry fail retry fail ok fail final");
run(["200 - {}"], "{}", { url: "https://h.example/v1/traces", headers: [], timeoutS: 5, gzip: false, live: false, tls: ["/c/ca.crt", "/c/cli.crt", "/c/cli \"k\".key"] });
const cfgText = readFileSync(dir + "/cfg", "utf8");
eq("tls lines in the stdin config", String(cfgText.indexOf("cacert = \"/c/ca.crt\"\n") >= 0 && cfgText.indexOf("cert = \"/c/cli.crt\"\n") >= 0 && cfgText.indexOf("key = \"/c/cli \\\"k\\\".key\"\n") >= 0), "true");
eq("no Expect: 100-continue", String(cfgText.indexOf("header = \"Expect:\"") >= 0), "true");
run(["200 - {}"], "{}", C);
eq("no tls lines unset", String(readFileSync(dir + "/cfg", "utf8").indexOf("cacert") < 0 && readFileSync(dir + "/cfg", "utf8").indexOf("\nkey") < 0), "true");
const HC: SendCfg = { url: "https://localhost:4318/v1/traces", headers: [], timeoutS: 5, gzip: true, live: true, tls: ["", "", ""] };
eq("a reset over https: a probe finds the TLS rejection", run(["R55 - x", "T56 - x", "200 - {}"], big, HC), "false true 0 0 false 0 sleeps  gz+plain");
eq("a reset over https: the probe connects, a plain failure", run(["R55 - x", "200 - {}"], big, HC), "false false 0 0 false 0 sleeps  gz+plain");
eq("a reset over https: three probes at most, then a plain failure", run(["R55 - x", "R55 - x", "R55 - x", "R55 - x", "200 - {}"], big, HC), "false false 0 0 false 0 sleeps  gz+plain+plain+plain");
eq("a reset over http: no probe", run(["R55 - x", "200 - {}"], big, { url: C.url, headers: [], timeoutS: 5, gzip: true, live: true, tls: ["", "", ""] }), "false false 0 0 false 0 sleeps  gz");
eq("resetLike", [resetLike("https://h", 0, 55, "Send failure: Connection reset by peer"), resetLike("https://h", 0, 56, "Recv failure: Connection reset by peer"), resetLike("http://h", 0, 55, "x"), resetLike("https://h", 0, 7, "x"), resetLike("https://h", 0, 56, "tlsv13 alert certificate required")].join(" "), "true true false false false");
eq("TLS failure: one attempt, final", run(["T56 - x", "200 - {}"], big, C), "false true 0 0 false 0 sleeps  gz");
rmSync(dir, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp send: all checks passed");
