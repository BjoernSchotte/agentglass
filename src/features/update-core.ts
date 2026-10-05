// agentglass — agentglass update, the pure part: which release to install, is it a downgrade, which checksum is ours
// SPDX-License-Identifier: Apache-2.0
import { obj, str, arr } from "../util/json.ts";
import { parseVersion, compareVersions, parseDevTag, versionOfTag } from "./version.ts";

export interface Rel { tag: string; prerelease: boolean; draft: boolean; assets: string[] }

// GitHub /releases JSON → Rel[] (anything that is not an array of releases → [])
export function relsFromJson(text: string): Rel[] {
  const out: Rel[] = [];
  let v: unknown = null;
  try { v = JSON.parse(text); } catch (e) { return out; }
  for (const r of arr(v)) {
    const o = obj(r); if (!o) continue;
    const assets: string[] = [];
    for (const a of arr(o["assets"])) { const ao = obj(a); const n = ao ? str(ao["name"]) : ""; if (n) assets.push(n); }
    out.push({ tag: str(o["tag_name"]), prerelease: o["prerelease"] === true, draft: o["draft"] === true, assets });
  }
  return out;
}
function complete(r: Rel, platform: string): boolean {
  return !r.draft && r.assets.indexOf("agentglass-" + platform + ".tar.gz") >= 0 && r.assets.indexOf("SHA256SUMS") >= 0;
}
function newerDev(a: string, b: string): boolean {
  const x = parseDevTag(a); const y = parseDevTag(b);
  if (!x || !y) return !!x;
  return x.date !== y.date ? x.date > y.date : x.run !== y.run ? x.run > y.run : x.attempt > y.attempt;
}
// tag "" = newest complete release of the channel for this platform; otherwise exactly that tag (if complete)
export function pickTarget(rels: Rel[], channel: string, tag: string, platform: string): Rel | null {
  let best: Rel | null = null;
  for (const r of rels) {
    if (!complete(r, platform)) continue;
    if (tag) { if (r.tag === tag) return r; continue; }
    if (channel === "stable") {
      if (r.prerelease || !versionOfTag(r.tag)) continue;
      const v = parseVersion(versionOfTag(r.tag)); const b = best ? parseVersion(versionOfTag(best.tag)) : null;
      if (v && (!b || compareVersions(v, b) > 0)) best = r;
    } else if (channel === "dev") {
      if (!r.prerelease || !parseDevTag(r.tag)) continue;
      if (!best || newerDev(r.tag, best.tag)) best = r;
    }
  }
  return best;
}
// installed → target goes backwards? a local build is never "downgraded" (it has no place in the release order)
export function isDowngrade(installed: string, target: string): boolean {
  const a = parseVersion(installed); const b = parseVersion(target);
  if (!a || !b || a.rank === 2) return false;
  return compareVersions(b, a) < 0;
}
// "<hash>  <file>" / "<hash> *<file>" lines → the hash for asset, "" if absent
export function sumFor(sums: string, asset: string): string {
  for (const l of sums.split("\n")) {
    const p = l.trim().split(/\s+/);
    const f = (p[1] ?? "").replace(/^\*/, "");
    if (p.length >= 2 && f === asset) return p[0] ?? "";
  }
  return "";
}

// the CA bundles the TLS runtime reads (scriptc's scr_tls_ca.c; curl looks in the same places): none = no HTTPS verifies
export const CA_BUNDLES = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem"];
// no CA certificate on this host (a slim container): has = file exists, extra = $NODE_EXTRA_CA_CERTS (the runtime reads it too)
export function caMissing(has: (p: string) => boolean, extra: string, platform: string): boolean {
  if (platform.startsWith("win")) return false;
  if (extra && has(extra)) return false;
  for (const p of CA_BUNDLES) if (has(p)) return false;
  return true;
}
const CA_FIX = "no CA certificates on this host (" + CA_BUNDLES[1] + " and the like are missing) — install ca-certificates (e.g. apt install ca-certificates, apk add ca-certificates)";
// a failed fetch for a person: it says only "fetch failed", so a missing CA bundle is named as the likely cause
export function fetchErr(err: string, noCa: boolean): string {
  return noCa ? "cannot reach GitHub: TLS certificate check failed — " + CA_FIX : "cannot reach GitHub: " + err + " (network, DNS or proxy)";
}
// a failed curl download: exit 60/77 are certificate errors (-1 = curl did not run or was stopped by the timeout)
export function curlErr(what: string, code: number, noCa: boolean): string {
  if (code === 60 || code === 77) return what + ": TLS certificate check failed (curl exit " + String(code) + ") — " + (noCa ? CA_FIX : "install or update ca-certificates (e.g. apt install ca-certificates)");
  return code < 0 ? what + " (curl did not finish: not installed, or timed out)" : what + " (curl exit " + String(code) + ")";
}
