// agentglass — synchronous JSON GET through the curl CLI (the SessionSource port is synchronous; fetch is not)
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj } from "./json.ts";
import { HOME, readText } from "./fs.ts";
import { writeBin } from "./gzip.ts";

// the probe result is cached per configured command, so a changed $AGENTGLASS_CURL is probed again
let binFor = "\u0000"; let bin = "";
export function curlBin(): string {
  const env = process.env["AGENTGLASS_CURL"];
  const want = env !== undefined && env.trim() ? env.trim() : "curl";
  if (want === binFor) return bin;
  binFor = want;
  try { execFileSync(want, ["-V"], { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }); bin = want; } catch (e) { bin = ""; }
  return bin;
}
// curl config-file string: quotes and backslashes escaped
function cq(s: string): string { return "\"" + s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\""; }
// HTTP Basic GET → JSON object; null = no curl, connection/HTTP error, timeout (3 s), not a JSON object.
// URL and credentials go through stdin (-K -): never argv (ps) or the child's environment; -q (first) skips ~/.curlrc
// (a --trace there would write the Authorization header), --noproxy keeps the request on loopback
export function getJson(url: string, user: string, pass: string): Obj | null {
  const b = curlBin();
  if (!b) return null;
  let out = "";
  try {
    out = execFileSync(b, ["-q", "--noproxy", "*", "-sS", "--fail", "--max-time", "3", "-K", "-"], { input: "url = " + cq(url) + "\nuser = " + cq(user + ":" + pass) + "\n", encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 4000, maxBuffer: 67108864 });
  } catch (e) { return null; }
  try { return obj(JSON.parse(out)); } catch (e) { return null; }
}

// ── POST for the OTLP exporter ──
// where the exporter keeps its state, lock and request bodies (AGENTGLASS_OTLP_DIR moves it, e.g. for tests)
export function otlpDir(): string { const e = process.env["AGENTGLASS_OTLP_DIR"]; return e !== undefined && e ? e : join(HOME, ".agentglass", "otlp"); }
export interface PostRes { status: number; body: string; err: string; exit: number; retryAfter: number } // status 0 = no HTTP response; exit = curl's exit code
function loopback(url: string): boolean { const m = /^[a-z]+:\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url); const h = m ? (m[1] ?? "").toLowerCase() : ""; return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.startsWith("127."); }
let seq = 0;
// POST body (JSON, gzip-compressed when gz) with the given headers. URL and headers go to curl on stdin (-K -), the body
// through a 0600 file named in that config: argv and the environment never hold a token. No --fail: the status is read
// from --write-out, Retry-After from the dumped headers. Proxies apply, except to loopback.
export function postJson(url: string, headers: string[][], body: Uint8Array, timeoutS: number, gz: boolean): PostRes {
  const res: PostRes = { status: 0, body: "", err: "", exit: -1, retryAfter: 0 };
  const b = curlBin();
  if (!b) { res.err = "no curl"; return res; }
  const dir = join(otlpDir(), "tmp");
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { /* exists */ }
  seq++;
  const base = join(dir, "otlp-" + String(process.pid) + "-" + String(seq));
  const bf = base + ".bin"; const hf = base + ".hdr"; const ef = base + ".err";
  try {
    if (!writeBin(bf, body)) { res.err = "cannot write " + bf; return res; }
    const cfg: string[] = ["url = " + cq(url)];
    for (const h of headers) cfg.push("header = " + cq((h[0] ?? "") + ": " + (h[1] ?? "")));
    cfg.push("header = " + cq("Content-Type: application/json"));
    if (gz) cfg.push("header = " + cq("Content-Encoding: gzip"));
    cfg.push("request = \"POST\"", "data-binary = " + cq("@" + bf), "dump-header = " + cq(hf), "write-out = \"\\n%{http_code}\"", "max-time = " + cq(String(timeoutS)));
    if (loopback(url)) cfg.push("noproxy = \"localhost,127.0.0.1,::1\"");
    // sh runs curl so its exit code comes back on stdout (execFileSync throws on a non-zero exit and keeps no output)
    const out = execFileSync("sh", ["-c", "c=$1; e=$2; shift 2; \"$c\" \"$@\" 2>\"$e\"; printf '\\n%s' \"$?\"", "sh", b, ef, "-q", "-sS", "-K", "-"],
      { input: cfg.join("\n") + "\n", encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: (timeoutS + 5) * 1000, maxBuffer: 4194304 });
    const ls = out.split("\n");
    res.exit = Number(ls[ls.length - 1] ?? "-1");
    res.status = Number(ls[ls.length - 2] ?? "0") || 0;
    res.body = ls.slice(0, Math.max(0, ls.length - 2)).join("\n").slice(0, 65536);
    res.err = readText(ef, 0, 4096).trim();
    const ra = /^retry-after:\s*(\d+)/im.exec(readText(hf, 0, 65536));
    if (ra) res.retryAfter = Number(ra[1] ?? "0");
  } catch (e) { res.err = res.err || "curl did not finish"; }
  finally { for (const f of [bf, hf, ef]) { try { unlinkSync(f); } catch (e) { /* not written */ } } }
  return res;
}
