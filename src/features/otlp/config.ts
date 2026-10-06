// agentglass — the "otlp" section of ~/.agentglass/config.json, endpoint and header resolution (spec 7)
// SPDX-License-Identifier: Apache-2.0
//   {"otlp": {"endpoint", "headers": {"K": "V ${env:NAME}"}, "headersFile", "content", "contentMax", "inputTokens",
//             "hostName", "attributes": {"extra", "rename", "drop"}, "batch", "timeoutSeconds", "insecure", "compression", "native",
//             "tls": {"ca", "cert", "key"}, "logs", "logsEndpoint", "titles", "detail"}}
import { execFileSync } from "node:child_process";
import { statSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr } from "../../util/json.ts";
import { HOME, readText } from "../../util/fs.ts";
import { rawSection } from "../../util/config.ts";
import { type Attr, attrS, attrD, attrI, attrB } from "./types.ts";

export interface OtlpCfg {
  endpoint: string; headers: string[][]; headersFile: string; content: boolean; contentMax: number; inputTokens: string; hostName: boolean;
  extra: Attr[]; rename: Map<string, string>; drop: Set<string>; batch: number; timeoutS: number; insecure: boolean; compression: string; native: string;
  tls: string[]; // [ca, cert, key] as configured ("" = unset; ~ not expanded yet: tlsOf)
  logs: boolean; logsEndpoint: string; titles: boolean; detail: string; // logs stream (live), its endpoint, session titles, call details none|meta
  warns: string[]; // one line per problem: a malformed section, a value of the wrong type
}
function bool(o: Obj, k: string, d: boolean, w: string[]): boolean { const v = o[k]; if (v === undefined) return d; if (typeof v === "boolean") return v as boolean; w.push("otlp." + k + " must be true or false"); return d; }
function int(o: Obj, k: string, lo: number, hi: number, d: number, w: string[]): number {
  const v = o[k]; if (v === undefined) return d;
  if (typeof v === "number" && Number.isInteger(v as number) && (v as number) >= lo && (v as number) <= hi) return v as number;
  w.push("otlp." + k + " must be an integer " + String(lo) + "–" + String(hi)); return d;
}
function oneOf(o: Obj, k: string, vals: string[], w: string[]): string {
  const v = o[k]; const d = vals[0] ?? "";
  if (v === undefined) return d;
  if (typeof v === "string" && vals.indexOf(v as string) >= 0) return v as string;
  w.push("otlp." + k + " must be one of " + vals.join(", ")); return d;
}
const TLS_KEYS = ["ca", "cert", "key"];
// the section as given (any shape): defaults for what is missing or wrong, one warning each
export function cfgFrom(raw: unknown): OtlpCfg {
  const w: string[] = [];
  let o = obj(raw);
  if (raw !== undefined && !o) { w.push("otlp in ~/.agentglass/config.json must be an object — using defaults"); o = null; }
  const s: Obj = o ?? {};
  const headers: string[][] = [];
  const ho = obj(s["headers"]);
  if (ho) for (const k of Object.keys(ho)) { const v = ho[k]; if (typeof v === "string") headers.push([k, v as string]); else w.push("otlp.headers." + k + " must be a string"); }
  else if (s["headers"] !== undefined) w.push("otlp.headers must be an object");
  const at = obj(s["attributes"]) ?? {};
  const extra: Attr[] = [];
  const ex = obj(at["extra"]);
  if (ex) for (const k of Object.keys(ex)) {
    const v = ex[k];
    if (typeof v === "string") extra.push(attrS(k, v as string));
    else if (typeof v === "number") extra.push(Number.isInteger(v as number) ? attrI(k, v as number) : attrD(k, v as number));
    else if (typeof v === "boolean") extra.push(attrB(k, v as boolean));
    else w.push("otlp.attributes.extra." + k + " must be a string, number or boolean");
  }
  const rename = new Map<string, string>(); const rn = obj(at["rename"]);
  if (rn) for (const k of Object.keys(rn)) { const v = str(rn[k]); if (v) rename.set(k, v); }
  const drop = new Set<string>(); for (const v of arr(at["drop"])) { const k = str(v); if (k) drop.add(k); }
  const tls = ["", "", ""]; const to = obj(s["tls"]);
  if (to) TLS_KEYS.forEach((k: string, i: number) => { const v = to[k]; if (typeof v === "string") tls[i] = v as string; else if (v !== undefined) w.push("otlp.tls." + k + " must be a file path"); });
  else if (s["tls"] !== undefined) w.push("otlp.tls must be an object: {\"ca\", \"cert\", \"key\"}");
  const le = s["logsEndpoint"]; if (le !== undefined && typeof le !== "string") w.push("otlp.logsEndpoint must be a URL");
  return {
    endpoint: str(s["endpoint"]), headers, headersFile: str(s["headersFile"]), content: bool(s, "content", false, w), contentMax: int(s, "contentMax", 256, 1048576, 16384, w),
    inputTokens: oneOf(s, "inputTokens", ["inclusive", "provider"], w), hostName: bool(s, "hostName", false, w),
    extra, rename, drop, batch: int(s, "batch", 1, 100000, 512, w), timeoutS: int(s, "timeoutSeconds", 1, 600, 10, w), insecure: bool(s, "insecure", false, w),
    compression: oneOf(s, "compression", ["gzip", "none"], w), native: oneOf(s, "native", ["warn", "skip", "include"], w),
    tls, logs: bool(s, "logs", true, w), logsEndpoint: str(le), titles: bool(s, "titles", false, w), detail: oneOf(s, "detail", ["none", "meta"], w), warns: w,
  };
}
export function loadCfg(): OtlpCfg { return cfgFrom(rawSection("otlp")); }
export function envMap(): Map<string, string> { const m = new Map<string, string>(); for (const k of Object.keys(process.env)) { const v = process.env[k]; if (v !== undefined) m.set(k, v); } return m; }

// an empty or "/" path gets /v1/traces (like OTEL_EXPORTER_OTLP_ENDPOINT); any other path is used as is
export function withPath(url: string): string {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(\/?)([?#].*)?$/i.exec(url.trim());
  return m ? (m[1] ?? "") + "/v1/traces" + (m[3] ?? "") : url.trim();
}
// --otlp > otlp.endpoint > OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (as is) > OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/traces); "" = none
export function endpointOf(flag: string, c: OtlpCfg, env: Map<string, string>): string {
  if (flag) return withPath(flag);
  if (c.endpoint) return withPath(c.endpoint);
  const t = (env.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") ?? "").trim(); if (t) return t;
  const b = (env.get("OTEL_EXPORTER_OTLP_ENDPOINT") ?? "").trim(); if (b) return b.replace(/\/+$/, "") + "/v1/traces";
  return "";
}
// the URL without userinfo, query and fragment: the only form ever printed or stored
export function safeUrl(url: string): string { return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, "$1").replace(/[?#].*$/, ""); }
export function hostOf(url: string): string { const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url); return m ? (m[1] ?? "").toLowerCase() : ""; }
function loop(h: string): boolean { return h === "localhost" || h === "[::1]" || h.startsWith("127."); }
// credentials (headers, URL userinfo or query) over plain http only to loopback, unless the user says otlp.insecure
export function plainOk(url: string, c: OtlpCfg, hasHeaders: boolean): string {
  const inUrl = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url) || /\?/.test(url);
  if (!(hasHeaders || inUrl) || c.insecure || !/^http:/i.test(url)) return "";
  const h = hostOf(url);
  return loop(h) ? "" : (hasHeaders ? "headers" : "the URL's credentials or query") + " would go over plain http to " + h + " — use https, or set \"otlp\": {\"insecure\": true}";
}
function tilde(p: string): string { return p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p; }
// owner uid and permission bits of a file ("" when it cannot be read)
function ownerMode(p: string): string {
  try { return execFileSync("stat", process.platform === "darwin" ? ["-f", "%u %Lp", p] : ["-c", "%u %a", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (e) { return ""; }
}
// permission digits for group and others (both must be 0)
function lastTwo(m: string): string { return m.length >= 2 ? m.slice(m.length - 2) : "0" + m; }
function myUid(): string { try { return execFileSync("id", ["-u"], { encoding: "utf8" }).trim(); } catch (e) { return ""; } }
function kvList(s: string): string[][] {
  const out: string[][] = [];
  for (const p of s.split(",")) { const i = p.indexOf("="); if (i <= 0) continue; let v = p.slice(i + 1).trim(); try { v = decodeURIComponent(v); } catch (e) { /* as is */ } out.push([p.slice(0, i).trim(), v]); }
  return out;
}
// a line break would end the header (and the curl config line that carries it)
function broken(hs: string[][]): string {
  for (const h of hs) if (/[\r\n]/.test((h[0] ?? "") + (h[1] ?? ""))) return "otlp header " + (h[0] ?? "").replace(/[\r\n].*$/s, "") + " contains a line break — remove it";
  return "";
}
// the headers to send: config headers (${env:NAME} expanded now), the private headers file, else the OTEL_* variables
export function expandHeaders(c: OtlpCfg, env: Map<string, string>, signal = "TRACES"): { headers: string[][]; err: string } {
  const r = expandRaw(c, env, signal);
  if (r.err) return r;
  const b = broken(r.headers);
  return b ? { headers: [], err: b } : r;
}
function expandRaw(c: OtlpCfg, env: Map<string, string>, signal: string): { headers: string[][]; err: string } {
  const out: string[][] = [];
  for (const h of c.headers) {
    let v = h[1] ?? "";
    for (const m of [...v.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)]) {
      const n = m[1] ?? ""; const x = env.get(n);
      if (x === undefined) return { headers: [], err: "otlp.headers." + (h[0] ?? "") + " uses ${env:" + n + "}, which is not set" };
      v = v.split(m[0] ?? "").join(x);
    }
    out.push([h[0] ?? "", v]);
  }
  if (c.headersFile) {
    const p = tilde(c.headersFile); const om = ownerMode(p);
    if (!om) return { headers: [], err: "otlp.headersFile " + p + " cannot be read" };
    const sp = om.indexOf(" "); const uid = om.slice(0, sp); const mode = om.slice(sp + 1);
    if (uid !== myUid() || lastTwo(mode) !== "00") return { headers: [], err: "otlp.headersFile " + p + " must be yours and private: chmod 600 " + p };
    for (const l of readText(p, 0, 65536).split("\n")) { const t = l.trim(); const i = t.indexOf(":"); if (!t || t.startsWith("#") || i <= 0) continue; out.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]); }
  }
  if (!out.length) { const e = env.get("OTEL_EXPORTER_OTLP_" + signal + "_HEADERS") ?? env.get("OTEL_EXPORTER_OTLP_HEADERS") ?? ""; if (e) return { headers: kvList(e), err: "" }; }
  return { headers: out, err: "" };
}

// ── client TLS (otlp-complete 1.1–1.2) ──
const TLS_VARS = ["CERTIFICATE", "CLIENT_CERTIFICATE", "CLIENT_KEY"];
// a readable regular file ("" = fine); opened, never read: curl reads the contents
function fileErr(p: string): string {
  try { if (!statSync(p).isFile()) return "is not a regular file"; } catch (e) { return "does not exist"; }
  try { closeSync(openSync(p, "r")); } catch (e) { return "cannot be read"; }
  return "";
}
// [ca, cert, key] for a signal ("TRACES" | "LOGS"): config, else OTEL_EXPORTER_OTLP_<SIGNAL>_<VAR>, else OTEL_EXPORTER_OTLP_<VAR>;
// ~ expanded; every set path a readable file, the key private (like headersFile), cert and key only together
export function tlsOf(c: OtlpCfg, env: Map<string, string>, signal: string): { tls: string[]; err: string } {
  const tls = ["", "", ""]; const from = ["", "", ""];
  for (let i = 0; i < 3; i++) {
    const v = c.tls[i] ?? ""; const k = TLS_KEYS[i] ?? ""; const x = TLS_VARS[i] ?? "";
    if (v) { tls[i] = tilde(v); from[i] = "otlp.tls." + k; continue; }
    const sv = "OTEL_EXPORTER_OTLP_" + signal + "_" + x; const gv = "OTEL_EXPORTER_OTLP_" + x;
    const se = (env.get(sv) ?? "").trim(); const ge = (env.get(gv) ?? "").trim();
    if (se) { tls[i] = tilde(se); from[i] = sv; } else if (ge) { tls[i] = tilde(ge); from[i] = gv; }
  }
  const none = { tls: ["", "", ""], err: "" };
  for (let i = 0; i < 3; i++) {
    const p = tls[i] ?? ""; if (!p) continue;
    if (/[\r\n]/.test(p)) return { tls: none.tls, err: (from[i] ?? "") + " contains a line break — remove it" };
    const fe = fileErr(p); if (fe) return { tls: none.tls, err: (from[i] ?? "") + " " + p + " " + fe };
  }
  const cert = tls[1] ?? ""; const key = tls[2] ?? "";
  if (cert && !key) return { tls: none.tls, err: (from[1] ?? "") + " is set without a key: set otlp.tls.key too (mutual TLS needs both)" };
  if (key && !cert) return { tls: none.tls, err: (from[2] ?? "") + " is set without a certificate: set otlp.tls.cert too (mutual TLS needs both)" };
  if (key) {
    const om = ownerMode(key); const sp = om.indexOf(" ");
    if (!om || om.slice(0, sp) !== myUid() || lastTwo(om.slice(sp + 1)) !== "00") return { tls: none.tls, err: (from[2] ?? "") + " " + key + " must be yours and private: chmod 600 " + key };
  }
  return { tls, err: "" };
}
// TLS for one endpoint: tlsOf over https; over http:// otlp.tls is refused (tlsUrlErr) while the OTEL_* variables do not
// apply (the OTel SDKs ignore them for insecure endpoints, and they are often set for other exporters): a note, no exit 2
export function tlsAt(c: OtlpCfg, env: Map<string, string>, signal: string, url: string): { tls: string[]; err: string; note: string } {
  if (!/^http:/i.test(url.trim())) { const r = tlsOf(c, env, signal); return { tls: r.tls, err: r.err, note: "" }; }
  const none = ["", "", ""];
  if (c.tls.some((p: string) => p !== "")) return { tls: none, err: tlsUrlErr(url, c.tls), note: "" };
  const set: string[] = [];
  for (const x of TLS_VARS) for (const v of ["OTEL_EXPORTER_OTLP_" + signal + "_" + x, "OTEL_EXPORTER_OTLP_" + x]) if ((env.get(v) ?? "").trim()) set.push(v);
  return { tls: none, err: "", note: set.length ? set.join(", ") + " ignored: " + safeUrl(url) + " is not https" : "" };
}
export function tlsUrlErr(url: string, tls: string[]): string { return tls.some((p: string) => p !== "") && /^http:/i.test(url) ? "otlp.tls needs an https endpoint (got " + safeUrl(url) + ")" : ""; }

// ── the logs endpoint (otlp-complete 2.2) ──
// fromFlagOrCfg = the traces URL came from --otlp or otlp.endpoint (else from the environment)
export function logsUrlOf(tracesUrl: string, fromFlagOrCfg: boolean, c: OtlpCfg, env: Map<string, string>): { url: string; why: string } {
  if (!c.logs) return { url: "", why: "" };
  if (c.logsEndpoint) return { url: c.logsEndpoint.trim(), why: "" };
  const le = (env.get("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT") ?? "").trim();
  if (!fromFlagOrCfg && le) return { url: le, why: "" };
  const m = /^([^?#]*)\/v1\/traces([?#].*)?$/.exec(tracesUrl.trim());
  if (m) return { url: (m[1] ?? "") + "/v1/logs" + (m[2] ?? ""), why: "" };
  return { url: "", why: "logs off: set otlp.logsEndpoint for " + safeUrl(tracesUrl) };
}
// the headers for the logs signal: as expandHeaders, with OTEL_EXPORTER_OTLP_LOGS_HEADERS instead of the traces variable
export function logHeaders(c: OtlpCfg, env: Map<string, string>): { headers: string[][]; err: string } { return expandHeaders(c, env, "LOGS"); }
