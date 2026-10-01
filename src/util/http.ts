// agentglass — synchronous JSON GET through the curl CLI (the SessionSource port is synchronous; fetch is not)
// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { type Obj, obj } from "./json.ts";

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
