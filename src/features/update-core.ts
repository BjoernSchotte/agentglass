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
