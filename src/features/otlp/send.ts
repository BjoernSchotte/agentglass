// agentglass — OTLP export: one batch to the endpoint with retries (spec 6.2) and the gzip fallback (6.5)
// SPDX-License-Identifier: Apache-2.0
import { obj, str, parse as parseJson } from "../../util/json.ts";
import { postJson } from "../../util/http.ts";
import { gzip } from "../../util/gzip.ts";

export interface SendCfg { url: string; headers: string[][]; timeoutS: number; gzip: boolean; live: boolean; tls: string[] } // tls = [ca, cert, key] ("" = unset)
// rejected = spans the backend refused in a partial success; gzipRefused = the endpoint took the batch only uncompressed;
// final = a TLS failure: retrying within this run cannot help (msg says what to fix)
export interface SendOut { ok: boolean; status: number; rejected: number; msg: string; gzipRefused: boolean; retries: number; final: boolean }
const RETRY_EXIT = [6, 7, 28, 35, 52, 56]; // resolve, connect, timeout, TLS, empty reply, receive error
const RETRY_HTTP = [429, 502, 503, 504];
const BACKOFF = [1000, 2000, 4000];
const SLOW_MS = 1000; // one compression slower than this: the rest of the run goes uncompressed
export const GZ = { off: false, note: "" }; // per run: compression switched off (slow, or unusable runtime) and why

function num(v: unknown): number { return typeof v === "number" ? (v as number) : typeof v === "string" ? Number(v) || 0 : 0; }
// partialSuccess.rejectedSpans (int64: a JSON string in the protobuf mapping)
function rejectedOf(body: string): { n: number; msg: string } {
  const o = parseJson(body.trim()); const ps = o ? obj(o["partialSuccess"]) : null;
  return ps ? { n: num(ps["rejectedSpans"]), msg: str(ps["errorMessage"]) } : { n: 0, msg: "" };
}
function retryable(status: number, exit: number): boolean { return status === 0 ? RETRY_EXIT.indexOf(exit) >= 0 : RETRY_HTTP.indexOf(status) >= 0; }
// ── TLS failures (otlp-complete 1.4): a certificate problem never fixes itself within a run ──
const TLS_EXIT = [58, 59, 60, 66, 77, 80, 83, 90, 91]; // always TLS: key/cert, cipher, verify, engine, CA file, shutdown, issuer, pinned key, status
// exits 35 (handshake) and 56 (receive: TLS 1.3 alerts arrive after the handshake) are TLS only with one of these (lowercase)
const TLS_PHRASES = ["certificate required", "unknown ca", "bad certificate", "certificate unknown", "certificate expired", "certificate revoked", "handshake failure", "access denied", "certificate verify failed"];
function curlLine(err: string): string { const l = (err.split("\n")[0] ?? "").trim(); return l ? " (" + l.replace(/^curl: /, "curl ") + ")" : ""; }
// "" = no TLS failure; else what the user reads
export function tlsFail(exit: number, err: string): string {
  const e = err.toLowerCase();
  const phrase = TLS_PHRASES.some((p: string) => e.indexOf(p) >= 0);
  if (TLS_EXIT.indexOf(exit) < 0 && !((exit === 35 || exit === 56) && phrase)) return "";
  if (e.indexOf("certificate required") >= 0) return "the receiver requires a client certificate: set otlp.tls.cert and otlp.tls.key";
  if (e.indexOf("unknown ca") >= 0 || e.indexOf("bad certificate") >= 0 || e.indexOf("certificate unknown") >= 0) return "the receiver rejected the client certificate (unknown CA or wrong certificate)" + curlLine(err);
  if (e.indexOf("expired") >= 0) return "a certificate expired (receiver or client)" + curlLine(err);
  if (e.indexOf("revoked") >= 0) return "a certificate was revoked (receiver or client)" + curlLine(err);
  if (e.indexOf("handshake failure") >= 0) return "the receiver ended the TLS handshake: it may require a client certificate (set otlp.tls.cert and otlp.tls.key) or a TLS version curl does not offer" + curlLine(err);
  if (exit === 58) return "the client key is encrypted or does not match the certificate: agentglass needs an unencrypted key file (chmod 600)" + curlLine(err);
  if (exit === 60 && (e.indexOf("subject name") >= 0 || e.indexOf("does not match") >= 0)) return "the receiver's certificate is not for this host name: use the name it was issued for" + curlLine(err);
  if (exit === 60) return "cannot verify the receiver's certificate: set otlp.tls.ca to its CA" + curlLine(err);
  if (exit === 77) return "the CA file cannot be used: check otlp.tls.ca" + curlLine(err);
  return "TLS failed" + curlLine(err);
}
// a TLS rejection can surface as a bare connection reset: the receiver closes before curl reads its alert (measured: exit
// 55 "Send failure: Connection reset by peer" in 2 of 12 runs without a client certificate, else exit 56 with the alert)
export function resetLike(url: string, status: number, exit: number, err: string): boolean {
  return status === 0 && /^https:/i.test(url) && (exit === 35 || exit === 55 || exit === 56) && !tlsFail(exit, err);
}
// up to three tiny requests (an empty OTLP request) with the same TLS settings: the TLS failure behind a reset, "" = none
function probeTls(c: SendCfg): string {
  const empty = new TextEncoder().encode("{}");
  for (let i = 0; i < 3; i++) {
    const p = postJson(c.url, c.headers, empty, c.timeoutS, false, c.tls);
    const f = p.status === 0 ? tlsFail(p.exit, p.err) : "";
    if (f || p.status > 0 || !resetLike(c.url, p.status, p.exit, p.err)) return f;
  }
  return "";
}
// one attempt's outcome: ok, retry (after a backoff), final (TLS: stop for the run) or fail (this request only)
export function decide(status: number, exit: number, err: string, attempt: number, live: boolean): string {
  if (status >= 200 && status < 300) return "ok";
  if (status === 0 && tlsFail(exit, err)) return "final";
  return !live && retryable(status, exit) && attempt < BACKOFF.length ? "retry" : "fail";
}
function why(status: number, exit: number, err: string, body: string): string {
  if (status === 0) return err ? err.split("\n")[0] ?? err : "curl exit " + String(exit);
  const b = body.replace(/\s+/g, " ").trim();
  return "HTTP " + String(status) + (b ? ": " + (b.length > 200 ? b.slice(0, 200) + "…" : b) : "");
}
// sends json; a one-shot export retries connection errors, 429 and 5xx gateway errors 3 times (1 s, 2 s, 4 s, or
// Retry-After up to 60 s); live mode tries once and leaves retrying to its queue. A gzip body answered 415/400 is resent
// once uncompressed.
export function sendBatch(c: SendCfg, json: string, sleep: (ms: number) => void): SendOut {
  const plain = new TextEncoder().encode(json);
  let data = plain; let gz = false;
  if (c.gzip && !GZ.off && plain.length >= 1024) {
    const t0 = Date.now(); const z = gzip(plain);
    if (Date.now() - t0 > SLOW_MS) { GZ.off = true; GZ.note = "compression took over 1 s: sending uncompressed for the rest of this run"; }
    if (z.length < plain.length) { data = z; gz = true; }
  }
  const out: SendOut = { ok: false, status: 0, rejected: 0, msg: "", gzipRefused: false, retries: 0, final: false };
  let probed = false; // a reset is probed once per batch: the retries after it are plain retries
  for (let k = 0; ; k++) {
    const r = postJson(c.url, c.headers, data, c.timeoutS, gz, c.tls);
    const d = decide(r.status, r.exit, r.err, k, c.live);
    out.status = r.status;
    if (d === "final") { out.final = true; out.msg = tlsFail(r.exit, r.err); return out; }
    if (!probed && resetLike(c.url, r.status, r.exit, r.err)) { probed = true; const f = probeTls(c); if (f) { out.final = true; out.msg = f; return out; } }
    if (d === "ok") {
      const rj = rejectedOf(r.body); out.ok = true; out.rejected = rj.n;
      if (rj.n > 0) out.msg = String(rj.n) + " spans rejected" + (rj.msg ? ": " + rj.msg : "");
      return out;
    }
    if (gz && (r.status === 415 || r.status === 400)) { // the endpoint may not take gzip: once more, plain
      const p = postJson(c.url, c.headers, plain, c.timeoutS, false, c.tls);
      out.status = p.status;
      if (p.status >= 200 && p.status < 300) { const rj = rejectedOf(p.body); out.ok = true; out.rejected = rj.n; out.gzipRefused = true; return out; }
      out.msg = why(p.status, p.exit, p.err, p.body);
      return out;
    }
    out.msg = why(r.status, r.exit, r.err, r.body);
    if (d !== "retry") return out;
    sleep(r.retryAfter > 0 ? Math.min(60, r.retryAfter) * 1000 : BACKOFF[k] ?? 4000);
    out.retries++;
  }
}
