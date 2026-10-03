// agentglass — OTLP export: one batch to the endpoint with retries (spec 6.2) and the gzip fallback (6.5)
// SPDX-License-Identifier: Apache-2.0
import { obj, str, parse as parseJson } from "../../util/json.ts";
import { postJson } from "../../util/http.ts";
import { gzip } from "../../util/gzip.ts";

export interface SendCfg { url: string; headers: string[][]; timeoutS: number; gzip: boolean; live: boolean }
// rejected = spans the backend refused in a partial success; gzipRefused = the endpoint took the batch only uncompressed
export interface SendOut { ok: boolean; status: number; rejected: number; msg: string; gzipRefused: boolean; retries: number }
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
  const out: SendOut = { ok: false, status: 0, rejected: 0, msg: "", gzipRefused: false, retries: 0 };
  for (let k = 0; ; k++) {
    const r = postJson(c.url, c.headers, data, c.timeoutS, gz);
    out.status = r.status;
    if (r.status >= 200 && r.status < 300) {
      const rj = rejectedOf(r.body); out.ok = true; out.rejected = rj.n;
      if (rj.n > 0) out.msg = String(rj.n) + " spans rejected" + (rj.msg ? ": " + rj.msg : "");
      return out;
    }
    if (gz && (r.status === 415 || r.status === 400)) { // the endpoint may not take gzip: once more, plain
      const p = postJson(c.url, c.headers, plain, c.timeoutS, false);
      out.status = p.status;
      if (p.status >= 200 && p.status < 300) { const rj = rejectedOf(p.body); out.ok = true; out.rejected = rj.n; out.gzipRefused = true; return out; }
      out.msg = why(p.status, p.exit, p.err, p.body);
      return out;
    }
    out.msg = why(r.status, r.exit, r.err, r.body);
    if (c.live || !retryable(r.status, r.exit) || k >= BACKOFF.length) return out;
    sleep(r.retryAfter > 0 ? Math.min(60, r.retryAfter) * 1000 : BACKOFF[k] ?? 4000);
    out.retries++;
  }
}
