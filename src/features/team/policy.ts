// agentglass — rooms, share policy and the sender's projection (fleet-teams spec 1, 6). Pure: the publisher selects
// sessions with inScope() and projects each jsonSess/shortSess object with teamRow(); a viewer never filters fields it
// should not have. teamRow() is an allowlist: a field jsonSess gains later is dropped until it is added to LEVEL_FIELDS
// (and the goldens in testdata/ change with it).
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, arr } from "../../util/json.ts";
import { CI_HOSTS } from "../../model/project.ts";
import { scrubSecrets } from "../../util/secrets.ts";
import { teamSessId } from "./code.ts";

export interface Room { id: string; name: string; scope: string[]; level: "numbers" | "titles"; budgetUsd: number; epoch: number }
// the member's choice for one room (member-local; never leaves the machine except as its effect). repos: keys without
// "git:" (github.com/acme/api); since: history start, epoch ms
export interface RoomShare { room: string; on: boolean; repos: string[]; level: "numbers" | "titles"; since: number; paused: boolean }

// one path segment against a pattern segment: * any run within the segment
function segMatch(p: string, s: string): boolean {
  let pi = 0; let si = 0; let star = -1; let mark = 0;
  while (si < s.length) {
    const c = pi < p.length ? p.charAt(pi) : "";
    if (c !== "*" && c !== "" && c === s.charAt(si)) { pi++; si++; }
    else if (c === "*") { star = pi; mark = si; pi++; }
    else if (star >= 0) { pi = star + 1; mark++; si = mark; }
    else return false;
  }
  while (pi < p.length && p.charAt(pi) === "*") pi++;
  return pi === p.length;
}
// pattern segments ps[i..] against key segments ks[j..]; ** = any number of segments (also none)
function segsMatch(ps: string[], i: number, ks: string[], j: number): boolean {
  if (i === ps.length) return j === ks.length;
  const p = ps[i] ?? "";
  if (p === "**") { for (let k = j; k <= ks.length; k++) if (segsMatch(ps, i + 1, ks, k)) return true; return false; }
  return j < ks.length && segMatch(p, ks[j] ?? "") && segsMatch(ps, i + 1, ks, j + 1);
}
// a room pattern against a repo key without "git:" (github.com/acme/api): * within a segment, ** across segments; a
// bare * or ** is every repo (a team of one's room "all"). Hosts compare case-insensitively; the path too on CI_HOSTS
// (their keys are lowercased already, project.ts normRemote)
export function scopeMatch(pattern: string, repoKey: string): boolean {
  const pt = pattern.trim();
  if (!pt || !repoKey) return false;
  if (pt === "*" || pt === "**") return true;
  const ks = repoKey.split("/"); const ps = pt.split("/");
  const host = (ks[0] ?? "").toLowerCase(); ks[0] = host; ps[0] = (ps[0] ?? "").toLowerCase();
  if (CI_HOSTS.indexOf(host) >= 0) for (let i = 1; i < ps.length; i++) ps[i] = (ps[i] ?? "").toLowerCase();
  return segsMatch(ps, 0, ks, 0);
}
// the repo key a session's identity shares under: "git:<x>" with a network remote; "" for path identities and local
// file remotes (never shared: paths differ per machine and carry user names)
export function shareKey(identKey: string): string {
  if (!identKey.startsWith("git:") || identKey.startsWith("git:file/")) return "";
  return identKey.slice(4);
}
function anyScope(r: Room, key: string): boolean { for (const p of r.scope) if (scopeMatch(p, key)) return true; return false; }
// a session leaves into this room only when its repo is one the member chose AND the room allows, the share is on and
// not paused, and it started at or after the share's history start
export function inScope(r: Room, sh: RoomShare, identKey: string, startedMs: number): boolean {
  if (sh.room !== r.id || !sh.on || sh.paused || startedMs < sh.since) return false;
  const k = shareKey(identKey);
  return k !== "" && (sh.repos.indexOf(k) >= 0 || sh.repos.indexOf("*") >= 0) && anyScope(r, k); // "*": all my repos (a personal team)
}
// the level a share publishes at: the member's, capped by the room's (titles only when both say titles)
export function levelOf(r: Room, sh: RoomShare): "numbers" | "titles" { return r.level === "titles" && sh.level === "titles" ? "titles" : "numbers"; }
// repos of these identities the room allows but the member has not chosen (the "new matching repo" toast), sorted
export function suggest(r: Room, sh: RoomShare, identKeys: string[]): string[] {
  const out: string[] = [];
  for (const id of identKeys) { const k = shareKey(id); if (k && out.indexOf(k) < 0 && sh.repos.indexOf(k) < 0 && anyScope(r, k)) out.push(k); }
  out.sort();
  return out;
}

// the allowlist per level, in output order (spec 6). Never, at any level: cwd, path, remote, activity, stuck text,
// alert messages, mux, git commits/hashes/URLs, prompts, outputs, tool arguments, file paths, hostname, plan name
const NUMBERS = ["id", "harness", "model", "updated", "live", "status", "kind", "subagents", "tokens", "costUsd", "costEstimatedUsd", "billing",
  "unpricedTokens", "unpricedCredits", "tools", "linesAdded", "linesRemoved", "repo", "skills", "alerts", "git"];
const TITLES = ["id", "harness", "title", "branch"].concat(NUMBERS.slice(2));
export const LEVEL_FIELDS: Record<string, string[]> = { numbers: NUMBERS, titles: TITLES };
const STATES = ["busy", "idle", "attention", "stuck", "ended"];

function isNum(v: unknown): boolean { return typeof v === "number" && isFinite(v); }
function n0(v: unknown): number { return typeof v === "number" && isFinite(v) ? v : 0; }
function has(s: Obj, k: string): boolean { return s[k] !== undefined; }
// the state enum, never the free-text status or the stuck text: the row's own state (read/row.ts) when it has one
function stateOf(s: Obj): string {
  const st = s["state"]; if (typeof st === "string" && STATES.indexOf(st) >= 0) return st;
  if (s["live"] !== true) return "ended";
  if (s["stuck"] !== null && s["stuck"] !== undefined && s["stuck"] !== "") return "stuck";
  if (s["attention"] === true) return "attention";
  return s["status"] === "busy" ? "busy" : "idle";
}
function skillRow(v: unknown): Obj | null {
  const o = obj(v); if (!o || typeof o["name"] !== "string") return null;
  const t = obj(o["tokens"]);
  const out: Obj = { name: o["name"], n: n0(o["n"]), loads: n0(o["loads"]), tokens: { load: n0(t ? t["load"] : 0), carry: n0(t ? t["carry"] : 0), tail: n0(t ? t["tail"] : 0) },
    costUsd: n0(o["costUsd"]), carryUsd: n0(o["carryUsd"]), tailUsd: n0(o["tailUsd"]) };
  const tier = o["tier"]; out["tier"] = tier === "exact" || tier === "≈" || tier === "?" ? tier : null;
  return out;
}
// one field of the projection; undefined = left out
function field(s: Obj, f: string, team: string): unknown {
  switch (f) {
    case "id": return teamSessId(team, String(s["harness"] ?? "") + ":" + String(s["id"] ?? ""));
    case "harness": case "model": case "updated": case "kind": case "branch": return typeof s[f] === "string" ? s[f] : undefined;
    case "title": return typeof s["title"] === "string" ? scrubSecrets(String(s["title"])) : undefined;
    case "live": return typeof s["live"] === "boolean" ? s["live"] : undefined;
    case "status": { if (!has(s, "status")) return undefined; const st = stateOf(s); return STATES.indexOf(st) >= 0 ? st : "idle"; }
    case "subagents": case "unpricedTokens": case "unpricedCredits": case "tools": case "linesAdded": case "linesRemoved": case "costEstimatedUsd":
      return isNum(s[f]) ? s[f] : undefined;
    case "costUsd": return isNum(s["costUsd"]) || s["costUsd"] === null ? s["costUsd"] : undefined;
    case "tokens": { const t = obj(s["tokens"]); return t ? { in: n0(t["in"]), out: n0(t["out"]), cacheRead: n0(t["cacheRead"]), cacheWrite: n0(t["cacheWrite"]) } : undefined; }
    case "billing": { const b = obj(s["billing"]); return b && typeof b["mode"] === "string" ? { mode: b["mode"] } : undefined; }
    case "repo": {
      const r = obj(s["repo"]); if (!r || typeof r["key"] !== "string" || shareKey(String(r["key"])) === "") return undefined;
      return { key: r["key"], label: typeof r["label"] === "string" ? r["label"] : "" };
    }
    case "skills": { // names already through skills.hide (jsonSess: omitted ones folded into "(hidden)")
      if (!has(s, "skills")) return undefined;
      const out: Obj[] = []; for (const v of arr(s["skills"])) { const k = skillRow(v); if (k) out.push(k); }
      return out;
    }
    case "alerts": {
      if (!has(s, "alerts")) return undefined;
      const out: string[] = []; for (const v of arr(s["alerts"])) { const a = obj(v); if (a && typeof a["rule"] === "string") out.push(String(a["rule"])); }
      return out;
    }
    case "git": {
      if (!has(s, "git")) return undefined;
      const g = obj(s["git"]); if (!g) return null;
      const c = g["costPerCommit"];
      return { produced: n0(g["produced"]), prs: arr(g["prs"]).length, costPerCommit: isNum(c) ? c : null };
    }
  }
  return undefined;
}
// the room stream's row for one jsonSess (or shortSess) object at a level ("titles", else "numbers")
export function teamRow(s: Obj, level: string, team: string): Obj {
  const fs = level === "titles" ? TITLES : NUMBERS;
  const out: Obj = {};
  for (const f of fs) { const v = field(s, f, team); if (v !== undefined) out[f] = v; }
  return out;
}
