// agentglass — `agentglass update`: stable/dev channels from GitHub Releases, SHA256SUMS + self-check, atomic swap, rollback
// SPDX-License-Identifier: Apache-2.0
// Only this command talks to GitHub, and only when run. Downloads use curl (scriptc's fetch has no binary bodies).
import { existsSync, mkdirSync, copyFileSync, renameSync, chmodSync, readSync, writeSync, openSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { str, parse } from "../util/json.ts";
import { HOME, readText } from "../util/fs.ts";
import { section, setConfig } from "../util/config.ts";
import { OS } from "../platform/index.ts";
import { H } from "../hooks.ts";
import { BUILD } from "../build-info.ts";
import { installMethod, samePath, versionOfTag, versionInfo } from "./version.ts";
import { type Rel, relsFromJson, pickTarget, isDowngrade, sumFor } from "./update-core.ts";

const REPO = "BjoernSchotte/agentglass";
const INSTALL_JSON = join(HOME, ".agentglass", "install.json");

interface Opts { status: boolean; channel: string; tag: string; dry: boolean; json: boolean; yes: boolean; force: boolean; rollback: boolean }
function opts(args: string[]): Opts | string {
  const o: Opts = { status: false, channel: "", tag: "", dry: false, json: false, yes: false, force: false, rollback: false };
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "status") o.status = true;
    else if (a === "--channel") { o.channel = args[++i] ?? ""; if (o.channel !== "stable" && o.channel !== "dev") return "--channel must be stable or dev"; }
    else if (a === "--tag") { o.tag = args[++i] ?? ""; if (!o.tag) return "--tag needs a version or tag"; }
    else if (a === "--dry-run") o.dry = true;
    else if (a === "--json") o.json = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--force") o.force = true;
    else if (a === "--rollback") o.rollback = true;
    else return "unknown option " + a;
  }
  return o;
}
function say(o: Opts, text: string, data: Record<string, unknown>): void { console.log(o.json ? JSON.stringify(data) : text); }
function fail(msg: string, code: number): number { console.error("agentglass update: " + msg); return code; }
function rmrf(p: string): void { try { execFileSync("rm", ["-rf", p]); } catch (e) { /* best effort */ } }
function tagOf(t: string): string { return t.startsWith("dev-") || t.startsWith("v") ? t : "v" + t; }

async function releases(): Promise<Rel[] | string> {
  const api = process.env.AGENTGLASS_RELEASES_API ?? ("https://api.github.com/repos/" + REPO + "/releases?per_page=100");
  if (api.startsWith("file://")) return relsFromJson(readText(api.slice(7), 0, 16777216));
  try {
    const r = await fetch(api, { headers: { "user-agent": "agentglass", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
    const body = await r.text();
    if (r.status !== 200) return "GitHub answered " + r.status + (r.headers.get("x-ratelimit-remaining") === "0" ? " (rate limit — try again later)" : "");
    return relsFromJson(body);
  } catch (e) { return "cannot reach GitHub: " + String(e); }
}
function download(url: string, to: string): boolean {
  try { execFileSync("curl", ["-fsSL", "--retry", "2", "-o", to, url], { stdio: ["ignore", "ignore", "ignore"], timeout: 300000 }); return true; } catch (e) { return false; }
}
function ask(q: string): boolean {
  writeSync(1, q);
  const b = new Uint8Array(64); let n = 0;
  try { n = readSync(0, b, 0, 64, null); } catch (e) { return false; }
  return new TextDecoder().decode(b.subarray(0, n)).trim().toLowerCase().startsWith("y");
}
function rewriteInstallJson(path: string, channel: string, version: string): void {
  const o = parse(readText(INSTALL_JSON, 0, 65536).trim());
  if (!o || !samePath(path, o["path"])) return;
  o["channel"] = channel; o["version"] = version;
  try { const fd = openSync(INSTALL_JSON, "w"); writeSync(fd, JSON.stringify(o) + "\n"); closeSync(fd); } catch (e) { /* marker only */ }
}

async function update(args: string[]): Promise<number> {
  const o0 = opts(args);
  if (typeof o0 === "string") return fail(o0, 1);
  const o = o0;
  const exe = process.execPath;
  const method = installMethod(exe, BUILD.channel, readText(INSTALL_JSON, 0, 65536));
  const saved = str(section("update")["channel"]);
  const channel = o.channel || saved || (BUILD.channel === "dev" ? "dev" : "stable");

  if (o.rollback) {
    const prev = exe + ".prev";
    if (!existsSync(prev)) return fail("nothing to roll back to (" + prev + " is missing)", 1);
    try { renameSync(exe, exe + ".rollback-tmp"); renameSync(prev, exe); renameSync(exe + ".rollback-tmp", prev); }
    catch (e) { return fail("rollback failed: " + String(e), 1); }
    say(o, "rolled back to " + execFileSync(exe, ["--version"], { encoding: "utf8" }).trim(), { rolledBack: true });
    return 0;
  }
  if (o.status) {
    const rs = await releases();
    const latest = typeof rs === "string" ? null : pickTarget(rs, channel, "", BUILD.platform);
    say(o, "agentglass " + BUILD.version + " (" + BUILD.channel + ", " + method + ") · channel " + channel + " · latest " + (latest ? latest.tag : typeof rs === "string" ? "unknown (" + rs + ")" : "none"),
      { installed: versionInfo(), channel, latest: latest ? latest.tag : null });
    return 0;
  }
  if (method === "homebrew") {
    const f = channel === "dev" ? "agentglass-dev" : "agentglass";
    return fail("installed with Homebrew — run: brew upgrade " + f + (o.channel && o.channel !== BUILD.channel ? " (switch: brew uninstall agentglass agentglass-dev; brew install bjoernschotte/tap/" + f + ")" : ""), 2);
  }
  if (method === "source" && !o.force) return fail("built from source — run: git pull && ./build.sh (or --force to replace it with a release)", 2);

  const rels = await releases();
  if (typeof rels === "string") return fail(rels, 1);
  const target = pickTarget(rels, channel, o.tag ? tagOf(o.tag) : "", BUILD.platform);
  if (!target) return fail("no complete " + (o.tag ? "release " + tagOf(o.tag) : channel + " release") + " for " + BUILD.platform, 1);

  const base = (process.env.AGENTGLASS_DOWNLOAD_BASE ?? ("https://github.com/" + REPO + "/releases/download")) + "/" + target.tag + "/";
  const work = join(dirname(exe), ".agentglass-update-" + String(process.pid));
  try { mkdirSync(work, { recursive: true }); }
  catch (e) { return fail("cannot write to " + dirname(exe) + " — reinstall with install.sh --prefix <a writable directory>", 1); }
  try {
    // target version: stable from the tag; dev from its build metadata
    let tv = versionOfTag(target.tag);
    if (!tv) {
      if (!download(base + "build-metadata.json", join(work, "meta.json"))) return fail("cannot download build-metadata.json for " + target.tag, 1);
      const m = parse(readText(join(work, "meta.json"), 0, 65536).trim()); tv = m ? str(m["version"]) : "";
      if (!tv) return fail("build-metadata.json of " + target.tag + " names no version", 1);
    }
    const tch = target.prerelease ? "dev" : "stable";
    if (tv === BUILD.version && tch === BUILD.channel && !o.tag) { say(o, "already on " + tv + " (" + tch + ")", { upToDate: true, version: tv }); return 0; }
    const down = isDowngrade(BUILD.version, tv);
    const plan = { channel: tch, installed: BUILD.version, target: tv, tag: target.tag, downgrade: down, method, path: exe };
    if (o.dry) { say(o, "would update " + BUILD.version + " → " + tv + " (" + target.tag + ")" + (down ? " — a downgrade" : ""), plan); return 0; }
    if (down && !o.yes) {
      if (!process.stdin.isTTY || !ask("downgrade " + BUILD.version + " → " + tv + "? [y/N] "))
        return fail("refusing to downgrade " + BUILD.version + " → " + tv + " without confirmation (use --yes)", 2);
    }
    const asset = "agentglass-" + BUILD.platform + ".tar.gz";
    const arc = join(work, asset); const sums = join(work, "SHA256SUMS");
    if (!download(base + asset, arc) || !download(base + "SHA256SUMS", sums)) return fail("cannot download " + target.tag + " for " + BUILD.platform, 1);
    const want = sumFor(readText(sums, 0, 65536), asset);
    if (!want || OS.sha256File(arc) !== want) return fail("checksum mismatch for " + asset + " — nothing changed", 1);
    const x = join(work, "x"); mkdirSync(x, { recursive: true });
    try { execFileSync("tar", ["-xzf", arc, "-C", x, "agentglass"], { stdio: "ignore" }); } catch (e) { return fail("archive has no agentglass binary", 1); }
    const cand = join(x, "agentglass"); chmodSync(cand, 0o755);
    let info: Record<string, unknown> | null = null;
    try { info = parse(execFileSync(cand, ["--version", "--json"], { encoding: "utf8", timeout: 10000 }).trim()); } catch (e) { info = null; }
    if (!info || str(info["version"]) !== tv || str(info["channel"]) !== tch)
      return fail("downloaded binary failed its self-check (expected " + tv + " " + tch + ") — nothing changed", 1);
    try { copyFileSync(exe, exe + ".prev"); renameSync(cand, exe); }
    catch (e) { return fail("cannot replace " + exe + ": " + String(e), 1); }
    if (!o.tag) setConfig("update", "channel", tch); // --tag is one-off: the saved channel stays
    rewriteInstallJson(exe, tch, tv);
    say(o, "updated " + BUILD.version + " → " + tv + " (" + tch + ")", { updated: true, from: BUILD.version, to: tv, channel: tch, tag: target.tag });
    return 0;
  } finally { rmrf(work); }
}

// first in line: the generic CLI handler would take `update --json` for a --json snapshot
H.cli.unshift((args: string[]): boolean => {
  if (args[0] !== "update") return false;
  update(args).then((code: number) => process.exit(code));
  return true;
});
