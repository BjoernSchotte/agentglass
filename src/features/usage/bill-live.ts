// agentglass — billing mode per session at runtime: stamped evidence (transcript, live process environment), else the
// current config (assumed). Sums resolve per provider (pi/OpenCode) at display time through modeOf.
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import type { Sess } from "../../model/types.ts";
import { H } from "../../hooks.ts";
import { join } from "node:path";
import { HOME, readText } from "../../util/fs.ts";
import type { Obj } from "../../util/json.ts";
import { OS } from "../../platform/index.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger } from "./ledger.ts";
import { type Acc, stamp, startOfDay } from "./record.ts";
import { type Bill, type Det, type Evid, asBill, newEvid, rule, provRule, configEv, configFiles, envSummary, type Allow, allowanceOf, cutObject } from "./billing.ts";

const RECHECK_MS = 60000;
const NONE: Det = { bill: "unknown", plan: "", why: "", src: "" };
function mtimes(fs: string[]): string { let t = ""; for (const f of fs) { let m = 0; try { m = statSync(f).mtimeMs; } catch (e) { m = 0; } t += String(m) + ","; } return t; }

// current config evidence per harness + project dir: re-checked at most every 60 s, re-read only when a file's mtime moved
interface CfgHit { at: number; sig: string; ev: Evid; det: Det }
const cfg = new Map<string, CfgHit>();
function cfgOf(h: string, cwd: string): CfgHit {
  const k = h + "\0" + (h === "claude" ? cwd : ""); // only Claude has project-level settings
  const hit = cfg.get(k); const now = Date.now();
  if (hit && now - hit.at < RECHECK_MS) return hit;
  const fs = configFiles(h, HOME, h === "claude" ? cwd : "");
  const sig = mtimes(fs);
  if (hit && hit.sig === sig) { hit.at = now; return hit; }
  const ev = configEv(h, HOME, h === "claude" ? cwd : "");
  const n: CfgHit = { at: now, sig, ev, det: rule(h, ev, "config") };
  cfg.set(k, n);
  return n;
}
// live environment names per pid (pi/OpenCode resolve each provider against them); names only, never values
const envs = new Map<number, { at: number; ev: Evid }>();

function stamped(a: Acc | undefined): Det | null { return a && a.billSrc ? { bill: asBill(a.bill), plan: a.plan, why: "", src: a.billSrc } : null; }
// the session's own mode: stamped evidence, else the current config's (src "config" = assumed)
export function billOf(s: Sess): Det { return stamped(ledger.get(s.path)) ?? cfgOf(s.h, s.cwd).det; }
function multi(h: string): boolean { return h === "pi" || h === "opencode"; }
function provDet(s: Sess, prov: string): Det {
  if (!multi(s.h) || !prov) return billOf(s);
  const e = s.pid ? envs.get(s.pid) : undefined;
  if (e) { const d = provRule(s.h, prov, e.ev, "process"); if (d.bill !== "unknown") return d; }
  const c = provRule(s.h, prov, cfgOf(s.h, s.cwd).ev, "config");
  return c.bill !== "unknown" ? c : billOf(s);
}
// the mode a cost booked under provider prov counts as
export function modeOf(s: Sess, prov: string): Bill { return provDet(s, prov).bill; }
// one label per session: multi-provider harnesses take the provider with the largest cost (its id as plan)
export function sessionBill(s: Sess): Det {
  if (!multi(s.h)) return billOf(s);
  const a = ledger.get(s.path); if (!a) return billOf(s);
  const by = new Map<string, number>();
  for (const d of a.days.values()) for (const [p, c] of d.cp) by.set(p, (by.get(p) ?? 0) + c);
  let top = ""; let max = 0;
  for (const [p, c] of by) if (c > max) { max = c; top = p; }
  if (!top) return billOf(s);
  const d = provDet(s, top);
  return { bill: d.bill, plan: d.bill === "plan" ? top : d.plan, why: d.why, src: d.src };
}
// Claude plan allowance gauge: only the cachedUsageUtilization block of ~/.claude.json, re-read at most once a minute
// and only when its mtime moved; shown only while a live or today's Claude session is on a plan
const CJ = join(HOME, ".claude.json");
let alAt = 0; let alSig = ""; let alObj: Obj | null = null;
export function allowance(): Allow | null {
  const sod = startOfDay(); let onPlan = false;
  for (const s of sessions.values()) if (s.h === "claude" && s.bill === "plan" && (s.pid > 0 || s.mtime >= sod)) { onPlan = true; break; }
  if (!onPlan) return null;
  const now = Date.now();
  if (now - alAt >= RECHECK_MS) {
    alAt = now; const sig = mtimes([CJ]);
    if (sig !== alSig) { alSig = sig; const c = cutObject(readText(CJ, 0, 8388608), "cachedUsageUtilization"); alObj = null; if (c) { const o: Obj = {}; o["cachedUsageUtilization"] = c; alObj = o; } }
  }
  return alObj ? allowanceOf(alObj, now) : null; // a rejected shape just hides the gauge (no debug log exists to note it in)
}
function label(s: Sess): void { const b = sessionBill(s); s.bill = b.bill; s.plan = b.plan; s.billSrc = b.src; }

// the live process's environment, at most once a minute per pid (Linux /proc only; empty elsewhere)
function probe(): void {
  const now = Date.now(); const live = new Set<number>();
  for (const s of sessions.values()) {
    if (s.pid <= 0) continue;
    live.add(s.pid);
    const a = ledger.get(s.path);
    if (a && a.billSrc === "session") continue;
    const e = envs.get(s.pid);
    if (e && now - e.at < RECHECK_MS) continue;
    const sm = envSummary(OS.envOf(s.pid));
    const ev = newEvid(); ev.names = sm.names; ev.on = sm.on;
    envs.set(s.pid, { at: now, ev });
    if (!a || !sm.names.length) continue;
    const d = rule(s.h, ev, "process");
    if (d.bill !== "unknown") stamp(a, d.bill, d.plan, "process");
  }
  for (const p of [...envs.keys()]) if (!live.has(p)) envs.delete(p);
}
let lastProbe = 0;
H.onTick.push(() => {
  const now = Date.now();
  if (now - lastProbe >= 2000) { lastProbe = now; probe(); }
  for (const s of sessions.values()) label(s);
});
H.complete.push(label); // after the ledger's own complete (registered first): --json carries billing
