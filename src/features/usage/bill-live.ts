// agentglass — billing mode per session at runtime: stamped evidence (transcript, live process environment), else the
// current config (assumed). Sums resolve per provider (pi/OpenCode) at display time through modeOf.
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import type { Sess } from "../../model/types.ts";
import { H, realCwd } from "../../hooks.ts";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import type { Obj } from "../../util/json.ts";
import { OS } from "../../platform/index.ts";
import { sessions, SG } from "../../model/sessions.ts";
import { ledger } from "./ledger.ts";
import { type Acc, stamp, startOfDay } from "./record.ts";
import { type Bill, type Det, type Evid, asBill, newEvid, rule, provMode, configEv, configFiles, envSummary, type Allow, allowanceOf, claudeJson } from "./billing.ts";

const RECHECK_MS = 60000;
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
  cfg.set(k, n); if (hit) BL.cfg++; // changed evidence (a new key's sessions are labelled as they ask for it)
  return n;
}
// live environment names per pid (pi/OpenCode resolve each provider against them); names only, never values. g: a
// generation that moves only when a pid's evidence changed (incremental sums re-sum that session: summary.ts)
const envs = new Map<number, { at: number; ev: Evid; g: number; k: string }>();
let envGen = 0;
export function envSig(s: Sess): number { const e = s.pid > 0 ? envs.get(s.pid) : undefined; return e ? e.g : 0; }
// generations of the config evidence and of the environments (label memo keys); labels: label() runs (checks)
export const BL = { cfg: 0, env: 0, labels: 0 };

function stamped(a: Acc | undefined): Det | null { return a && a.billSrc ? { bill: asBill(a.bill), plan: a.plan, why: "", src: a.billSrc } : null; }
// the session's own mode: stamped evidence, else the current config's (src "config" = assumed)
export function billOf(s: Sess): Det { return stamped(ledger.get(s.path)) ?? cfgOf(s.h, realCwd(s)).det; }
function multi(h: string): boolean { return h === "pi" || h === "opencode"; }
function provDet(s: Sess, prov: string): Det {
  if (!multi(s.h) || !prov) return billOf(s);
  const e = s.pid ? envs.get(s.pid) : undefined;
  return provMode(s.h, prov, e ? e.ev : null, cfgOf(s.h, realCwd(s)).ev);
}
// the mode a cost booked under provider prov counts as; a pi/OpenCode cost without a provider (usage lines, subagent
// results) counts as the session's label
export function modeOf(s: Sess, prov: string): Bill { return multi(s.h) && !prov ? asBill(s.bill) : provDet(s, prov).bill; }
// one label per session: multi-provider harnesses take the provider with the largest cost (its id as plan)
export function sessionBill(s: Sess): Det {
  if (!multi(s.h)) return billOf(s);
  const a = ledger.get(s.path); if (!a) return billOf(s);
  const by = new Map<string, number>();
  for (const d of a.days.values()) for (const [p, c] of d.cp) if (p) by.set(p, (by.get(p) ?? 0) + c);
  let top = ""; let max = 0;
  for (const [p, c] of by) if (c > max) { max = c; top = p; }
  if (!top) return billOf(s);
  const d = provDet(s, top);
  return { bill: d.bill, plan: d.bill === "plan" ? top : d.plan, why: d.why, src: d.src };
}
// Claude plan allowance gauge: only the cachedUsageUtilization block of ~/.claude.json, looked at most once a minute
// (the read itself is shared with the plan evidence, cached by mtime + size); shown only while a live or today's Claude
// session is on a plan
const CJ = join(HOME, ".claude.json");
let alAt = 0; let alObj: Obj | null = null;
export function allowance(): Allow | null {
  const sod = startOfDay(); let onPlan = false;
  for (const s of sessions.values()) if (s.h === "claude" && s.bill === "plan" && (s.pid > 0 || s.mtime >= sod)) { onPlan = true; break; }
  if (!onPlan) return null;
  const now = Date.now();
  if (now - alAt >= RECHECK_MS) { alAt = now; const c = claudeJson(CJ).usage; alObj = null; if (c) { const o: Obj = {}; o["cachedUsageUtilization"] = c; alObj = o; } }
  return alObj ? allowanceOf(alObj, now) : null; // a rejected shape just hides the gauge (no debug log exists to note it in)
}
function label(s: Sess): void { BL.labels++; const b = sessionBill(s); s.bill = b.bill; s.plan = b.plan; s.billSrc = b.src; }
// the tick's labels, per session only when an input of sessionBill moved: the session object, its pid, its ledger entry (another object
// after a re-index, its stamp, its cost: pi/OpenCode take the provider with the largest), its cwd (project settings), the
// config evidence (re-checked by the minute: the epoch) or the environments
interface LabelKey { s: Sess; pid: number; a: Acc | undefined; bill: string; plan: string; src: string; cost: number; cwd: string; cfg: number; env: number; ep: number }
const labelled = new Map<string, LabelKey>();
// every session when the minute, the config evidence, the environments or the session set moved; in between only the
// live ones, those written within the minute (the ledger stamps and costs only logs that grew) and those live last time
// (a pid that went): a key lookup per session and tick was most of the tick's billing cost
const LA = { ep: -1, cfg: -1, env: -1, n: -1, gen: -1, live: [] as Sess[] };
export function labelAll(now: number): void {
  const ep = Math.floor(now / RECHECK_MS);
  const all = ep !== LA.ep || BL.cfg !== LA.cfg || BL.env !== LA.env || sessions.size !== LA.n || SG.gen !== LA.gen;
  LA.ep = ep; LA.cfg = BL.cfg; LA.env = BL.env; LA.n = sessions.size; LA.gen = SG.gen;
  const was = LA.live; LA.live = [];
  for (const s of sessions.values()) {
    if (s.pid > 0) LA.live.push(s);
    if (all || s.pid > 0 || now - s.mtime < RECHECK_MS) labelOnChange(s, now);
  }
  if (!all) for (const s of was) if (s.pid <= 0) labelOnChange(s, now);
  if (labelled.size > sessions.size) for (const k of [...labelled.keys()]) if (!sessions.has(k)) labelled.delete(k);
}
function labelOnChange(s: Sess, now: number): void {
  const a = ledger.get(s.path); const k = labelled.get(s.path); const ep = Math.floor(now / RECHECK_MS);
  const cost = a && multi(s.h) ? a.cost : 0; const env = multi(s.h) ? BL.env : 0; const cwd = realCwd(s);
  if (k && k.s === s && k.pid === s.pid && k.a === a && k.cfg === BL.cfg && k.env === env && k.ep === ep && k.cwd === cwd &&
      (!a || (k.bill === a.bill && k.plan === a.plan && k.src === a.billSrc && k.cost === cost))) return;
  label(s);
  labelled.set(s.path, { s, pid: s.pid, a, bill: a ? a.bill : "", plan: a ? a.plan : "", src: a ? a.billSrc : "", cost, cwd, cfg: BL.cfg, env, ep });
}

// the live process's environment, at most once a minute per pid (Linux /proc only; empty elsewhere)
function probeOne(s: Sess, now: number): void {
  if (s.pid <= 0) return;
  const a = ledger.get(s.path);
  if (a && a.billSrc === "session") return;
  const e = envs.get(s.pid);
  if (e && now - e.at < RECHECK_MS) return;
  const sm = envSummary(OS.envOf(s.pid));
  const ev = newEvid(); ev.names = sm.names; ev.on = sm.on;
  const k = sm.names.join(",") + "|" + sm.on.join(",");
  envs.set(s.pid, { at: now, ev, g: e && e.k === k ? e.g : ++envGen, k });
  if (!e || e.k !== k) BL.env++; // the labels look again only when the evidence changed
  if (!a || !sm.names.length) return;
  const d = rule(s.h, ev, "process");
  if (d.bill !== "unknown") stamp(a, d.bill, d.plan, "process");
}
function probe(): void {
  const now = Date.now(); const live = new Set<number>();
  for (const s of sessions.values()) { if (s.pid > 0) live.add(s.pid); probeOne(s, now); }
  for (const p of [...envs.keys()]) if (!live.has(p)) envs.delete(p);
}
let lastProbe = 0;
H.onTick.push(() => {
  const now = Date.now();
  if (now - lastProbe >= 2000) { lastProbe = now; probe(); }
  labelAll(now);
});
// after the ledger's own complete (registered first): --json and `cost` carry billing, incl. the live process's evidence
H.complete.push((s: Sess): void => { probeOne(s, Date.now()); label(s); });
