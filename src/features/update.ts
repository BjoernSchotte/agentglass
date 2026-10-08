// agentglass — `agentglass update`: stable/dev channels from GitHub Releases, SHA256SUMS + self-check, atomic swap, rollback
// SPDX-License-Identifier: Apache-2.0
// Only this command talks to GitHub, and only when run. Downloads use curl (scriptc's fetch has no binary bodies).
import { existsSync, mkdirSync, copyFileSync, renameSync, chmodSync, readSync, writeSync, openSync, closeSync, lstatSync, unlinkSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { str, parse } from "../util/json.ts";
import { HOME, readText } from "../util/fs.ts";
import { section, setConfig } from "../util/config.ts";
import { OS } from "../platform/index.ts";
import { H } from "../hooks.ts";
import { BUILD } from "../build-info.ts";
import { installMethod, samePath, versionOfTag, versionInfo } from "./version.ts";
import { errLine, interactive } from "./agentenv.ts";
import { opt, setOptions } from "./clihelp.ts";
import { type Rel, relsFromJson, pickTarget, isDowngrade, sumFor, caMissing, fetchErr, curlErr } from "./update-core.ts";
import { argVal } from "../util/argv.ts";

const REPO = "BjoernSchotte/agentglass";
const INSTALL_JSON = join(HOME, ".agentglass", "install.json");

// update's options (`update status` is in the record's summary): the JSON help lists them, `update --help` prints them
// (cli.ts, from the record)
setOptions("update", [
  opt("--channel", "stable|dev", "the release channel (remembered after a successful update)", "the saved one, else stable", ["stable", "dev"]),
  opt("--tag", "T", "one specific release (2026.10.1, v2026.10.1 or a dev-… tag); the saved channel stays", "", []),
  opt("--dry-run", "", "show what would happen, change nothing", "", []),
  opt("--json", "", "one JSON object on stdout", "", []),
  opt("--yes", "", "allow a downgrade without asking (-y)", "", []),
  opt("--force", "", "replace a binary built from source with a release", "", []),
  opt("--rollback", "", "back to the binary before the last update", "", []),
]);
interface Opts { status: boolean; channel: string; tag: string; dry: boolean; json: boolean; yes: boolean; force: boolean; rollback: boolean }
function opts(args: string[]): Opts | string {
  const o: Opts = { status: false, channel: "", tag: "", dry: false, json: false, yes: false, force: false, rollback: false };
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "status") o.status = true;
    else if (a === "--channel") { o.channel = argVal(args, i++) ?? ""; if (o.channel !== "stable" && o.channel !== "dev") return "--channel must be stable or dev"; }
    else if (a === "--tag") { o.tag = argVal(args, i++) ?? ""; if (!o.tag) return "--tag needs a version or tag"; }
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
function fail(msg: string, code: number): number { errLine("agentglass update", code === 2 ? "usage" : "update_failed", msg, ""); return code; }
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
  } catch (e) { return fetchErr(String(e), noCa()); }
}
function noCa(): boolean { return caMissing((p: string): boolean => existsSync(p), process.env.NODE_EXTRA_CA_CERTS ?? "", BUILD.platform); }
// curl's exit code (0 ok, -1 it did not run or timed out): curlErr turns it into the message
function download(url: string, to: string): number {
  const r = spawnSync("curl", ["-fsSL", "--retry", "2", "-o", to, url], { stdio: ["ignore", "ignore", "ignore"], timeout: 300000 });
  return typeof r.status === "number" ? r.status : -1;
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
  if (typeof o0 === "string") return fail(o0, 2); // a usage error (exit-code table)
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
      { installed: versionInfo(), channel, latest: latest ? latest.tag : null, error: typeof rs === "string" ? rs : null });
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
      const dc = download(base + "build-metadata.json", join(work, "meta.json"));
      if (dc !== 0) return fail(curlErr("cannot download build-metadata.json for " + target.tag, dc, noCa()), 1);
      const m = parse(readText(join(work, "meta.json"), 0, 65536).trim()); tv = m ? str(m["version"]) : "";
      if (!tv) return fail("build-metadata.json of " + target.tag + " names no version", 1);
    }
    const tch = target.prerelease ? "dev" : "stable";
    if (tv === BUILD.version && tch === BUILD.channel && !o.tag) { say(o, "already on " + tv + " (" + tch + ")", { upToDate: true, version: tv }); return 0; }
    const down = isDowngrade(BUILD.version, tv);
    const plan = { channel: tch, installed: BUILD.version, target: tv, tag: target.tag, downgrade: down, method, path: exe };
    if (o.dry) { say(o, "would update " + BUILD.version + " → " + tv + " (" + target.tag + ")" + (down ? " — a downgrade" : ""), plan); return 0; }
    if (down && !o.yes) {
      if (!interactive() || !ask("downgrade " + BUILD.version + " → " + tv + "? [y/N] "))
        return fail("refusing to downgrade " + BUILD.version + " → " + tv + " without confirmation (use --yes)", 2);
    }
    const asset = "agentglass-" + BUILD.platform + ".tar.gz";
    const arc = join(work, asset); const sums = join(work, "SHA256SUMS");
    let dc = download(base + asset, arc); if (dc === 0) dc = download(base + "SHA256SUMS", sums);
    if (dc !== 0) return fail(curlErr("cannot download " + target.tag + " for " + BUILD.platform, dc, noCa()), 1);
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
    updateSibling(arc, x, exe, "agentglass-mcp", true, "");
    updateSibling(arc, x, exe, "agentglass-receive-tls", false, "built-in HTTPS off; use tailscale serve or a TLS proxy");
    if (!o.tag) try { setConfig("update", "channel", tch); } catch (e) { errLine("agentglass update", "config", "channel not saved: " + (e instanceof Error ? e.message : String(e)), ""); } // --tag is one-off: the saved channel stays
    rewriteInstallJson(exe, tch, tv);
    say(o, "updated " + BUILD.version + " → " + tv + " (" + tch + ")", { updated: true, from: BUILD.version, to: tv, channel: tch, tag: target.tag });
    return 0;
  } finally { rmrf(work); }
}

// the siblings that ship in the same archive, replaced next to agentglass so they never run an older version:
// agentglass-mcp (the MCP server; an archive without it — an older release — keeps the installed one, which agents
// have registered) and the optional HTTPS receiver (otlp-hub 11.4; an archive without it — its C build failed for this
// target — removes the old one: receive refuses a binary of another version anyway)
function updateSibling(arc: string, x: string, exe: string, name: string, keepOld: boolean, gone: string): void {
  const dst = join(dirname(exe), name);
  try { execFileSync("tar", ["-xzf", arc, "-C", x, name], { stdio: "ignore" }); }
  catch (e) {
    try { lstatSync(dst); } catch (e2) { return; } // none installed
    if (keepOld) { errLine("agentglass update", "partial", "this release has no " + name + ": the old one is kept", ""); return; }
    try { unlinkSync(dst); errLine("agentglass update", "partial", "this release has no " + name + " for this platform: the old one is removed (" + gone + ")", ""); }
    catch (e3) { errLine("agentglass update", "partial", name + " of the previous version left in place: " + (e3 instanceof Error ? e3.message : String(e3)), "remove it: rm " + dst); }
    return;
  }
  const c = join(x, name);
  try { chmodSync(c, 0o755); renameSync(c, dst); }
  catch (e) { errLine("agentglass update", "partial", name + " not updated: " + (e instanceof Error ? e.message : String(e)), ""); }
}
// first in line: the generic CLI handler would take `update --json` for a --json snapshot
H.cli.unshift((args: string[]): boolean => {
  if (args[0] !== "update" || args.indexOf("--help") >= 0 || args.indexOf("-h") >= 0) return false; // help: cli.ts prints the record
  update(args).then((code: number) => process.exit(code));
  return true;
});
