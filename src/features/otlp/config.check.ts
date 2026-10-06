// agentglass — self-check for the otlp config section: scriptc build src/features/otlp/config.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { cfgFrom, endpointOf, withPath, expandHeaders, plainOk, safeUrl, tlsOf, tlsAt, tlsUrlErr, logsUrlOf, logHeaders } from "./config.ts";

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

// ── client TLS, logs stream, titles, detail (otlp-complete 1, 2, 3) ──
eq("new defaults", [d.tls.join("|"), String(d.logs), d.logsEndpoint, String(d.titles), d.detail].join(" "), "|| true  false none");
eq("tls from config", cfgFrom({ tls: { ca: "~/ca.crt" } }).tls[0] ?? "", "~/ca.crt");
eq("tls wrong type", String(cfgFrom({ tls: 3 }).warns.some((x: string) => x.indexOf("otlp.tls") >= 0)), "true");
eq("tls field wrong type", String(cfgFrom({ tls: { cert: 7 } }).warns.some((x: string) => x.indexOf("otlp.tls.cert") >= 0)) + " " + (cfgFrom({ tls: { cert: 7 } }).tls[1] ?? "?"), "true ");
const dw = cfgFrom({ detail: "full", logs: "no", titles: 1, logsEndpoint: "https://l.example/v1/logs" });
eq("detail/logs/titles wrong", [dw.detail, String(dw.logs), String(dw.titles), dw.logsEndpoint, String(dw.warns.length)].join(" "), "none true false https://l.example/v1/logs 3");
eq("detail meta", cfgFrom({ detail: "meta" }).detail, "meta");
const td = join(HOME, "tls"); mkdirSync(td, { recursive: true });
for (const f of ["ca.crt", "ca2.crt", "cli.crt", "cli.key"]) writeFileSync(join(td, f), "x\n");
chmodSync(join(td, "cli.key"), 0o600);
const TE = env([["OTEL_EXPORTER_OTLP_CERTIFICATE", join(td, "ca2.crt")], ["OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE", join(td, "ca.crt")]]);
eq("tls env: signal-specific wins", tlsOf(d, TE, "TRACES").tls[0] ?? "", join(td, "ca.crt"));
eq("tls env: generic for the other signal", tlsOf(d, TE, "LOGS").tls[0] ?? "", join(td, "ca2.crt"));
eq("tls config beats env", tlsOf(cfgFrom({ tls: { ca: "~/tls/ca2.crt" } }), TE, "TRACES").tls[0] ?? "", join(td, "ca2.crt"));
const both = tlsOf(cfgFrom({ tls: { ca: "~/tls/ca.crt", cert: "~/tls/cli.crt", key: "~/tls/cli.key" } }), env([]), "TRACES");
eq("tls all three, ~ expanded", both.tls.join("|") + " " + both.err, join(td, "ca.crt") + "|" + join(td, "cli.crt") + "|" + join(td, "cli.key") + " ");
eq("tls client pair from env", tlsOf(d, env([["OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE", join(td, "cli.crt")], ["OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY", join(td, "cli.key")]]), "LOGS").tls.join("|"), "|" + join(td, "cli.crt") + "|" + join(td, "cli.key"));
eq("tls unset", tlsOf(d, env([]), "TRACES").tls.join("|") + tlsOf(d, env([]), "TRACES").err, "||");
eq("tls missing file", String(tlsOf(cfgFrom({ tls: { ca: "~/tls/nope.crt" } }), env([]), "TRACES").err.indexOf("otlp.tls.ca") >= 0), "true");
eq("tls env missing file names the variable", String(tlsOf(d, env([["OTEL_EXPORTER_OTLP_CERTIFICATE", join(td, "nope")]]), "TRACES").err.indexOf("OTEL_EXPORTER_OTLP_CERTIFICATE") >= 0), "true");
eq("tls a directory", String(tlsOf(cfgFrom({ tls: { ca: td } }), env([]), "TRACES").err !== ""), "true");
eq("tls cert without key", String(tlsOf(cfgFrom({ tls: { cert: "~/tls/cli.crt" } }), env([]), "TRACES").err.indexOf("otlp.tls.key") >= 0), "true");
eq("tls key without cert", String(tlsOf(cfgFrom({ tls: { key: "~/tls/cli.key" } }), env([]), "TRACES").err.indexOf("otlp.tls.cert") >= 0), "true");
chmodSync(join(td, "cli.key"), 0o640);
const gk = tlsOf(cfgFrom({ tls: { cert: "~/tls/cli.crt", key: "~/tls/cli.key" } }), env([]), "TRACES");
eq("tls group-readable key refused", String(gk.err.indexOf("chmod 600") >= 0 && gk.err.indexOf("otlp.tls.key") >= 0), "true");
chmodSync(join(td, "cli.key"), 0o600);
eq("tls with http refused", String(tlsUrlErr("http://h:4318/v1/traces", ["/a", "", ""]).indexOf("https") >= 0), "true");
eq("tls with https ok", tlsUrlErr("https://h:4318/v1/traces", ["/a", "", ""]) + tlsUrlErr("http://h:4318", ["", "", ""]), "");
// tlsAt: TLS for an endpoint. otlp.tls with http:// is refused; the OTEL_* variables (often set for other exporters) do
// not apply to http:// — ignored with a note, as the OTel SDKs do, never an exit 2 for an existing http export
const HE = env([["OTEL_EXPORTER_OTLP_CERTIFICATE", join(td, "nope.crt")], ["OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY", join(td, "cli.key")]]);
const ah = tlsAt(d, HE, "TRACES", "http://localhost:4318/v1/traces");
eq("tlsAt: env TLS ignored for http", ah.tls.join("|") + " " + ah.err + "|" + String(ah.note.indexOf("OTEL_EXPORTER_OTLP_CERTIFICATE") >= 0 && ah.note.indexOf("OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY") >= 0), "|| |true");
eq("tlsAt: no note without variables", tlsAt(d, env([]), "TRACES", "http://localhost:4318").note, "");
eq("tlsAt: config TLS with http refused", String(tlsAt(cfgFrom({ tls: { ca: "~/tls/ca.crt" } }), env([]), "TRACES", "http://h:4318/v1/traces").err.indexOf("https") >= 0), "true");
eq("tlsAt: https validates the variables", String(tlsAt(d, HE, "TRACES", "https://h:4318/v1/traces").err.indexOf("does not exist") >= 0), "true");
const as = tlsAt(cfgFrom({ tls: { ca: "~/tls/ca.crt" } }), env([]), "TRACES", "https://h:4318/v1/traces");
eq("tlsAt: https", as.tls.join("|") + " " + as.err + as.note, join(td, "ca.crt") + "|| ");
// logs endpoint (spec 2.2)
eq("logs from /v1/traces", logsUrlOf("https://h:4318/v1/traces", true, d, env([])).url, "https://h:4318/v1/logs");
const cust = logsUrlOf("https://h/otlp/traces", true, d, env([]));
eq("logs off for a custom path", cust.url + " " + String(cust.why.indexOf("otlp.logsEndpoint") >= 0), " true");
eq("logs endpoint config as is", logsUrlOf("https://h/otlp/traces", true, cfgFrom({ logsEndpoint: "https://l.example/x" }), env([])).url, "https://l.example/x");
const LE = env([["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", "https://l.example/logs"]]);
eq("logs env when traces came from env", logsUrlOf("https://t.example/x", false, d, LE).url, "https://l.example/logs");
eq("logs env ignored when traces from flag", logsUrlOf("https://t.example/v1/traces", true, d, LE).url, "https://t.example/v1/logs");
const off = logsUrlOf("https://h:4318/v1/traces", true, cfgFrom({ logs: false }), env([]));
eq("logs false", off.url + "|" + off.why, "|");
eq("logs keep query", logsUrlOf("https://h:4318/v1/traces?x=1", true, d, env([])).url, "https://h:4318/v1/logs?x=1");
// logs headers: the LOGS variable before the generic one, config headers first
eq("logs headers env", H(logHeaders(d, env([["OTEL_EXPORTER_OTLP_HEADERS", "a=1"], ["OTEL_EXPORTER_OTLP_LOGS_HEADERS", "l=2"], ["OTEL_EXPORTER_OTLP_TRACES_HEADERS", "t=3"]])).headers), "l=2");
eq("logs headers generic", H(logHeaders(d, env([["OTEL_EXPORTER_OTLP_HEADERS", "a=1"], ["OTEL_EXPORTER_OTLP_TRACES_HEADERS", "t=3"]])).headers), "a=1");
eq("logs headers config", H(logHeaders(ch, env([["OTEL_TOKEN", "k"], ["OTEL_EXPORTER_OTLP_LOGS_HEADERS", "l=2"]])).headers), "Authorization=Bearer k,X-Scope-OrgID=me");
rmSync(td, { recursive: true, force: true });

if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp config: all checks passed");
