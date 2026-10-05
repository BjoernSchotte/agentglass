// agentglass — the current rule set: loaded on first use, hot-reloaded (mtime stat every 2 s), CPU history cap, warnings
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { userInfo } from "node:os";
import { OS } from "../../platform/index.ts";
import { readWhole } from "../../util/fs.ts";
import { home } from "../../util/text.ts";
import { S, say } from "../../state.ts";
import { HIST } from "../../model/procs.ts";
import { type RuleSet, loadRules, errCount } from "./config.ts";
import { RULES_FILE } from "./file.ts";
import { retain } from "./engine.ts";

// set: the rules in force; mtime -1 = no file; safe: the file may name a notify command (owned by the user, not group/world-writable)
export const R = { set: loadRules("", false), mtime: -2, checkedAt: 0, safe: false, ver: 0 };
// the fix first: an 80-column toast cuts the tail
const CMD_UNSAFE = "notify.command ignored — chmod 600 " + home(RULES_FILE) + " (the file must be yours, not group- or world-writable)";

function warn(msg: string): void { if (S.cli) process.stderr.write("agentglass: " + msg + "\n"); else say("warn", msg); }
// the file's change stamp (ctime: content writes and chmod/chown alike, so fixing the mode re-runs the permission check), -1 = missing
export function fileMtime(p: string): number { try { const st = statSync(p); return Math.max(st.mtimeMs, st.ctimeMs); } catch (e) { return -1; } }
// the file's text, or why it cannot be read (no permission, a directory, over 1 MiB): never an empty file in its place
export function fileRead(p: string): { text: string; err: string } { const f = readWhole(p, 1048576); return { text: f.text, err: f.err }; }
// owned by this user and (mode & 0o022) === 0 — the check ssh does for its config
export function fileSafe(p: string): boolean { const om = OS.ownerMode(p); return om.length === 2 && om[0] === userInfo().uid && ((om[1] ?? 0) & 0o022) === 0; }
function capOf(rs: RuleSet): number { let n = 120; for (const r of rs.rules) { const v = r.params.get("samples"); if (r.enabled && v !== undefined && v > n) n = v; } return n; }
// a rule set for this file state; an unsafe command is dropped with a diagnostic
export function withSafety(rs: RuleSet, safe: boolean): RuleSet {
  if (!safe && rs.notify.command.length) { rs.notify.command = []; rs.diags.push({ line: rs.cmdAt[0] ?? 1, col: rs.cmdAt[1] ?? 1, rule: "", msg: CMD_UNSAFE, err: true }); }
  return rs;
}
function install(rs: RuleSet): void {
  R.set = rs; R.ver++;
  const ids = new Set<string>(); for (const r of rs.rules) if (r.enabled) ids.add(r.id);
  retain(ids); // removed or disabled rules end silently
  HIST.cap = capOf(rs);
}
// every 2 s: an unchanged mtime is a no-op; a broken edit keeps the previous rules (one warning per mtime); true = replaced
export function reload(now: number, read: (p: string) => { text: string; err: string }, mtimeOf: (p: string) => number, safeOf: (p: string) => boolean): boolean {
  if (R.mtime !== -2 && now - R.checkedAt < 2000) return false;
  R.checkedAt = now;
  const mt = mtimeOf(RULES_FILE);
  if (mt === R.mtime) return false;
  const first = R.mtime === -2;
  R.mtime = mt;
  if (mt < 0) { if (!first) install(loadRules("", false)); return !first; } // deleted: back to the built-ins
  const f = read(RULES_FILE);
  if (f.err) { // unreadable is not a syntax error: say which, as `rules check` does
    if (first) { install(loadRules("", false)); warn("rules.json: cannot read the file (" + f.err + ") — using built-in rules"); return true; }
    warn("rules.json: cannot read the file (" + f.err + ") — keeping the previous rules");
    return false;
  }
  R.safe = safeOf(RULES_FILE);
  const rs = withSafety(loadRules(f.text, true), R.safe);
  if (rs.syntax) {
    if (first) { install(rs); warn("rules.json: " + rs.syntax + " — using built-in rules"); return true; }
    warn("rules.json: " + rs.syntax + " — keeping the previous rules");
    return false;
  }
  install(rs);
  const n = errCount(rs);
  const e1 = rs.diags.find((d) => d.err);
  if (n === 1 && e1) warn("rules.json:" + String(e1.line) + ":" + String(e1.col) + ": " + (e1.rule ? e1.rule + ": " : "") + e1.msg);
  else if (n) warn("rules.json: " + String(n) + " errors (broken rules are disabled, overridden built-ins unchanged) — agentglass rules check");
  return true;
}
// the rules in force (loads the file on first use, then hot-reloads)
export function rules(): RuleSet { reload(Date.now(), fileRead, fileMtime, fileSafe); return R.set; }
