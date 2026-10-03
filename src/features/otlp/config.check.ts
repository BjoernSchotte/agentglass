// agentglass — self-check for the otlp config section: scriptc build src/features/otlp/config.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { cfgFrom, endpointOf, withPath, expandHeaders, plainOk, safeUrl } from "./config.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
const env = (kv: string[][]): Map<string, string> => { const m = new Map<string, string>(); for (const p of kv) m.set(p[0] ?? "", p[1] ?? ""); return m; };
const H = (hs: string[][]): string => hs.map((h: string[]) => (h[0] ?? "") + "=" + (h[1] ?? "")).join(",");

eq("withPath empty", withPath("http://h:4318"), "http://h:4318/v1/traces");
eq("withPath /", withPath("http://h:4318/"), "http://h:4318/v1/traces");
eq("withPath custom", withPath("http://h/custom"), "http://h/custom");
const d = cfgFrom(undefined);
eq("defaults", [d.endpoint, String(d.content), String(d.contentMax), d.inputTokens, String(d.hostName), String(d.batch), String(d.timeoutS), String(d.insecure), d.compression, d.native, String(d.warns.length)].join(" "), " false 16384 inclusive false 512 10 false gzip warn 0");
eq("malformed section", String(cfgFrom("oops").warns.length) + " " + cfgFrom("oops").compression, "1 gzip");
const w = cfgFrom({ content: "yes", batch: 100, compression: "zstd", inputTokens: "provider", native: "skip", attributes: { extra: { "deployment.environment.name": "laptop", n: 3 }, rename: { "agentglass.usage.cost": "my.cost" }, drop: ["process.working_directory"] } });
eq("wrong-typed keys ignored", String(w.content) + " " + String(w.batch) + " " + w.compression + " " + w.inputTokens + " " + w.native, "false 100 gzip provider skip");
eq("attribute tables", w.extra.map((a) => a.k + "=" + a.s + String(a.n)).join(",") + " " + (w.rename.get("agentglass.usage.cost") ?? "") + " " + String(w.drop.has("process.working_directory")), "deployment.environment.name=laptop0,n=3 my.cost true");
// endpoint precedence: --otlp > otlp.endpoint > TRACES_ENDPOINT (as is) > OTLP_ENDPOINT (+ /v1/traces)
const c1 = cfgFrom({ endpoint: "https://cfg.example" });
const E = env([["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "https://t.example/x"], ["OTEL_EXPORTER_OTLP_ENDPOINT", "https://b.example/"]]);
eq("flag wins", endpointOf("http://localhost:4318", c1, E), "http://localhost:4318/v1/traces");
eq("config next", endpointOf("", c1, E), "https://cfg.example/v1/traces");
eq("traces env as is", endpointOf("", d, E), "https://t.example/x");
eq("base env + path", endpointOf("", d, env([["OTEL_EXPORTER_OTLP_ENDPOINT", "https://b.example/otel"]])), "https://b.example/otel/v1/traces");
eq("none", endpointOf("", d, env([])), "");
// headers: ${env:…} expanded at send time; unset → error; OTEL_* headers only when the config has none
const ch = cfgFrom({ headers: { Authorization: "Bearer ${env:OTEL_TOKEN}", "X-Scope-OrgID": "me" } });
eq("env expanded", H(expandHeaders(ch, env([["OTEL_TOKEN", "s3cret"]])).headers), "Authorization=Bearer s3cret,X-Scope-OrgID=me");
const miss = expandHeaders(ch, env([]));
eq("env unset", String(miss.err.indexOf("OTEL_TOKEN") >= 0) + " " + String(miss.err.indexOf("s3cret") < 0), "true true");
eq("OTEL headers", H(expandHeaders(d, env([["OTEL_EXPORTER_OTLP_HEADERS", "a=b%20c,x=y"]])).headers), "a=b c,x=y");
eq("OTEL traces headers win", H(expandHeaders(d, env([["OTEL_EXPORTER_OTLP_HEADERS", "a=1"], ["OTEL_EXPORTER_OTLP_TRACES_HEADERS", "t=2"]])).headers), "t=2");
eq("config beats OTEL headers", H(expandHeaders(ch, env([["OTEL_TOKEN", "k"], ["OTEL_EXPORTER_OTLP_HEADERS", "a=b"]])).headers), "Authorization=Bearer k,X-Scope-OrgID=me");
// headersFile: private (0600, owned by the user) or refused
const dir = "/tmp/agentglass-otlp-cfg-" + String(process.pid); mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/h", "Authorization: Bearer f1le\n# comment\nX-A: b\n");
chmodSync(dir + "/h", 0o644);
const open = expandHeaders(cfgFrom({ headersFile: dir + "/h" }), env([]));
eq("headersFile 0644 refused", String(open.err.indexOf("chmod 600") >= 0) + " " + String(open.headers.length), "true 0");
chmodSync(dir + "/h", 0o600);
eq("headersFile 0600 read", H(expandHeaders(cfgFrom({ headersFile: dir + "/h" }), env([])).headers), "Authorization=Bearer f1le,X-A=b");
rmSync(dir, { recursive: true, force: true });
// plain http: headers only to loopback unless insecure
eq("plain remote refused", String(plainOk("http://10.0.0.5:4318/v1/traces", d, true).indexOf("10.0.0.5") >= 0), "true");
eq("plain loopback ok", plainOk("http://localhost:4318/v1/traces", d, true) + plainOk("http://127.0.0.1:4318/", d, true), "");
eq("plain without headers ok", plainOk("http://10.0.0.5:4318/v1/traces", d, false), "");
eq("insecure ok", plainOk("http://10.0.0.5:4318/v1/traces", cfgFrom({ insecure: true }), true), "");
eq("plain userinfo refused", String(plainOk("http://u:tok@10.0.0.5:4318/v1/traces", d, false).indexOf("10.0.0.5") >= 0), "true");
eq("plain query refused", String(plainOk("http://10.0.0.5:4318/v1/traces?key=x", d, false).indexOf("?key") < 0 && plainOk("http://10.0.0.5:4318/v1/traces?key=x", d, false) !== ""), "true");
eq("header CR/LF refused", String(expandHeaders(cfgFrom({ headers: { "X-A": "a\nurl = http://evil" } }), env([])).err.indexOf("line break") >= 0), "true");
eq("header env CR/LF refused", String(expandHeaders(ch, env([["OTEL_TOKEN", "a\r\noutput = /tmp/x"]])).err.indexOf("line break") >= 0), "true");
eq("OTEL header CR/LF refused", String(expandHeaders(d, env([["OTEL_EXPORTER_OTLP_HEADERS", "a=b%0Aoutput%3D%2Ftmp%2Fx"]])).err.indexOf("line break") >= 0), "true");
eq("safeUrl", safeUrl("https://u:tok@h.example:4318/v1/traces?key=x#f"), "https://h.example:4318/v1/traces");

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp config: all checks passed");
