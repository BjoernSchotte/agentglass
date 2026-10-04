// agentglass — ~/.ssh/config Host → HostName/Port, read only: an ssh alias in a git remote (github-work:me/x) names
// its real host the way ssh resolves it
// SPDX-License-Identifier: Apache-2.0
// Host patterns (* ? !negation, case-insensitive), first value per keyword wins, a section before the first Host applies
// to every host, Include one level deep (relative to ~/.ssh, ~, globs in the last path part; inside a Host block it
// applies to that block's hosts only), Match blocks never apply (their criteria need ssh itself). Parsed once per
// (file, included files and glob dirs) mtime.
import { statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME, readText } from "./fs.ts";

// file/home: checks point them at a fixture home
export const SSH = { file: join(HOME, ".ssh", "config"), home: HOME };
export interface SshTarget { host: string; port: string } // host "" = no HostName for this alias
interface Block { conds: string[][]; never: boolean; hostname: string; port: string }
interface Parsed { deps: string[]; stamp: string; blocks: Block[] }
const MAX_FILE = 262144; const MAX_INCLUDES = 64;
const cache = new Map<string, Parsed>();

// mtime, ctime (chmod) and size; "-" = missing
function stampOf(p: string): string { try { const s = statSync(p); return String(s.mtimeMs) + ":" + String(s.ctimeMs) + ":" + String(s.size); } catch (e) { return "-"; } }
function fileText(p: string): string {
  try { const s = statSync(p); if (!s.isFile() || s.size > MAX_FILE) return ""; return readText(p, 0, s.size); } catch (e) { return ""; }
}
// whitespace-separated words, "double quotes" group; HostName/Port take exactly one (ssh rejects trailing garbage)
function words(s: string): string[] {
  const out: string[] = []; let cur = ""; let q = false; let has = false;
  for (const ch of s) {
    if (ch === '"') { q = !q; has = true; continue; }
    if (!q && (ch === " " || ch === "\t")) { if (has) out.push(cur); cur = ""; has = false; continue; }
    cur += ch; has = true;
  }
  if (has) out.push(cur);
  return out;
}
function globRe(p: string): RegExp { return new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"); }
function wild(p: string): boolean { return p.indexOf("*") >= 0 || p.indexOf("?") >= 0; }
// an Include argument → existing paths in glob order; deps gets every file and glob dir whose change must re-parse
function includePaths(arg: string, base: string, deps: string[]): string[] {
  const p = arg.startsWith("~/") ? SSH.home + arg.slice(1) : arg.startsWith("/") ? arg : join(base, arg);
  const d = dirname(p); const b = p.slice(d.length + 1);
  if (wild(d)) return []; // wildcards in directory parts: not followed
  if (!wild(b)) { deps.push(p); return [p]; }
  deps.push(d);
  let names: string[] = []; try { names = readdirSync(d); } catch (e) { return []; }
  const re = globRe(b); const out: string[] = [];
  for (const n of names) if ((b.startsWith(".") || !n.startsWith(".")) && re.test(n)) out.push(join(d, n));
  out.sort();
  for (const f of out) deps.push(f);
  return out;
}
// blocks are pushed when complete: scriptc may copy a record on push, so a pushed block is never mutated
function parseInto(text: string, base: string, outer: string[][], never: boolean, depth: number, blocks: Block[], deps: string[]): void {
  let cur: Block = { conds: outer, never, hostname: "", port: "" };
  for (const raw of text.split("\n")) {
    const l = raw.trim(); if (!l || l.startsWith("#")) continue;
    const m = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(l); if (!m) continue;
    const k = (m[1] ?? "").toLowerCase(); const args = words(m[2] ?? "");
    if (k === "host") { blocks.push(cur); cur = { conds: outer.concat([args.map((a) => a.toLowerCase())]), never, hostname: "", port: "" }; }
    else if (k === "match") { blocks.push(cur); cur = { conds: outer, never: true, hostname: "", port: "" }; }
    else if (k === "hostname") { if (!cur.hostname && args.length === 1) cur.hostname = args[0] ?? ""; }
    else if (k === "port") { if (!cur.port && args.length === 1) cur.port = args[0] ?? ""; }
    else if (k === "include" && depth === 0) {
      blocks.push(cur); // later lines of this block come after the included ones
      for (const a of args) for (const f of includePaths(a, base, deps)) if (deps.length <= MAX_INCLUDES) parseInto(fileText(f), base, cur.conds, cur.never, 1, blocks, deps);
      cur = { conds: cur.conds, never: cur.never, hostname: "", port: "" };
    }
  }
  blocks.push(cur);
}
function parsed(file: string): Parsed {
  const c = cache.get(file);
  if (c && c.deps.map(stampOf).join("|") === c.stamp) return c;
  const deps: string[] = [file]; const blocks: Block[] = [];
  parseInto(fileText(file), dirname(file), [], false, 0, blocks, deps);
  const p: Parsed = { deps, stamp: deps.map(stampOf).join("|"), blocks };
  cache.set(file, p);
  return p;
}
// changes whenever the config or anything it includes changes (identity caches re-resolve on it)
export function sshStamp(file: string): string { return parsed(file).stamp; }

function matches(host: string, pats: string[]): boolean {
  let hit = false;
  for (const p of pats) {
    if (p.startsWith("!")) { if (globRe(p.slice(1)).test(host)) return false; }
    else if (globRe(p).test(host)) hit = true;
  }
  return hit;
}
// %h = the alias, %% = %; any other token (user, port, …) cannot be expanded here: no mapping
function expand(v: string, host: string): string {
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v.charAt(i); if (ch !== "%") { out += ch; continue; }
    const t = v.charAt(i + 1); i++;
    if (t === "h") out += host; else if (t === "%") out += "%"; else return "";
  }
  return out;
}
// the host and port ssh connects to for alias; {"", ""} when the config names no valid HostName for it
export function sshTarget(alias: string, file: string): SshTarget {
  const host = alias.toLowerCase(); let hn = ""; let port = "";
  for (const b of parsed(file).blocks) {
    if (b.never || (hn && port) || !b.conds.every((c) => matches(host, c))) continue;
    if (!hn && b.hostname) hn = b.hostname;
    if (!port && b.port) port = b.port;
  }
  let h = expand(hn, host).toLowerCase();
  if (h.indexOf(":") >= 0 && !h.startsWith("[")) h = "[" + h + "]";
  if (!/^[a-z0-9._-]+$/.test(h) && !/^\[[0-9a-f:.]+\]$/.test(h)) return { host: "", port: "" };
  return { host: h, port: /^\d{1,5}$/.test(port) ? port : "" };
}
