// agentglass — billing modes: what a cost figure is (API spend, plan list-equivalent, cloud-metered, gateway, unknown)
// SPDX-License-Identifier: Apache-2.0
// Pure rules over an evidence record, plus the readers that build it. Privacy: environment VALUES are decoded only for the
// boolean SWITCHES (reduced to on/off at once); auth files are read for type fields only; ~/.claude.json only for the
// oauthAccount plan fields (cut out of the text, never parsed whole). Nothing here keeps a secret or a personal value.
import { join } from "node:path";
import { readText } from "../../util/fs.ts";
import { type Obj, obj, str } from "../../util/json.ts";

export type Bill = "api" | "plan" | "metered" | "gateway" | "unknown";
export const MODES: Bill[] = ["api", "plan", "metered", "gateway", "unknown"];
const TAGS = ["spend", "plan", "cloud", "gw", "?"];
export function tag(b: Bill): string { return TAGS[MODES.indexOf(b)] ?? "?"; }
export function asBill(s: string): Bill { const i = MODES.indexOf(s as Bill); return i >= 0 ? (MODES[i] ?? "unknown") : "unknown"; }

// src: "session" (transcript), "process" (live environment), "config" (current files, assumed for history), "" = nothing conclusive
export interface Det { bill: Bill; plan: string; why: string; src: string }
// names = environment variable names present, on = SWITCHES set to a true value, kv = config facts (type fields only)
export interface Evid { names: string[]; on: string[]; kv: Map<string, string> }
export const SWITCHES = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "GOOGLE_GENAI_USE_VERTEXAI"];
const OFF = ["", "0", "false", "no", "off"];
const CAP = 2097152; // config reads are size-capped

function det(bill: Bill, plan: string, why: string, src: string): Det { return { bill, plan, why, src: bill === "unknown" ? "" : src }; }
const NONE: Det = { bill: "unknown", plan: "", why: "", src: "" };
export function newEvid(): Evid { return { names: [], on: [], kv: new Map<string, string>() }; }
function switchOn(v: string): boolean { return OFF.indexOf(v.trim().toLowerCase()) < 0; }

// /proc/<pid>/environ → names; a value is decoded only for a switch, and only its on/off survives
export function envSummary(raw: Uint8Array): { names: string[]; on: string[] } {
  const names: string[] = []; const on: string[] = [];
  const dec = new TextDecoder("utf-8");
  let i = 0;
  while (i < raw.length) {
    let z = i; while (z < raw.length && raw[z] !== 0) z++;
    let eq = i; while (eq < z && raw[eq] !== 61) eq++;
    if (eq > i && eq < z) {
      const name = dec.decode(raw.subarray(i, eq));
      names.push(name);
      if (SWITCHES.indexOf(name) >= 0 && switchOn(dec.decode(raw.subarray(eq + 1, z)))) on.push(name);
    }
    i = z + 1;
  }
  return { names, on };
}

function has(ev: Evid, n: string): boolean { return ev.names.indexOf(n) >= 0; }
function kv(ev: Evid, k: string): string { return ev.kv.get(k) ?? ""; }
function claudeRule(ev: Evid, src: string): Det {
  for (const sw of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) if (ev.on.indexOf(sw) >= 0) return det("metered", "", sw, src);
  if (has(ev, "ANTHROPIC_AUTH_TOKEN")) return det("gateway", "", "ANTHROPIC_AUTH_TOKEN", src);
  if (has(ev, "ANTHROPIC_API_KEY")) return det("api", "", "ANTHROPIC_API_KEY", src);
  if (kv(ev, "claude.helper")) return det("api", "", "apiKeyHelper", src);
  if (kv(ev, "claude.billingType")) return det("plan", kv(ev, "claude.plan"), "oauthAccount.billingType", src);
  return NONE;
}
function codexRule(ev: Evid, src: string): Det {
  // a non-OpenAI model_provider routes the traffic elsewhere, whatever login auth.json still holds
  const pv = kv(ev, "codex.provider");
  if (pv && pv !== "openai") return det(pv === "azure" ? "metered" : "gateway", "", "model_provider", src);
  const am = kv(ev, "codex.auth_mode").toLowerCase();
  if (am === "chatgpt") return det("plan", "", "auth_mode", src);
  if (am.indexOf("api") >= 0) return det("api", "", "auth_mode", src);
  if (has(ev, "OPENAI_API_KEY") || has(ev, "CODEX_API_KEY")) return det("api", "", has(ev, "CODEX_API_KEY") ? "CODEX_API_KEY" : "OPENAI_API_KEY", src);
  return NONE;
}
function geminiRule(ev: Evid, src: string): Det {
  if (ev.on.indexOf("GOOGLE_GENAI_USE_VERTEXAI") >= 0) return det("metered", "", "GOOGLE_GENAI_USE_VERTEXAI", src);
  const t = kv(ev, "gemini.selectedType");
  if (t === "gemini-api-key") return det("api", "", "selectedType", src);
  if (t === "vertex-ai" || t === "compute-default-credentials" || t === "cloud-shell") return det("metered", "", "selectedType", src);
  if (t === "oauth-personal") return det("plan", "", "selectedType", src);
  if (has(ev, "GEMINI_API_KEY") || has(ev, "GOOGLE_API_KEY")) return det("api", "", has(ev, "GEMINI_API_KEY") ? "GEMINI_API_KEY" : "GOOGLE_API_KEY", src);
  return NONE;
}
// pi / OpenCode: per provider — the auth file's type literal, else <PROVIDER>_API_KEY in the environment
export function provRule(h: string, prov: string, ev: Evid, src: string): Det {
  if (!prov) return NONE;
  const t = kv(ev, "auth." + prov).toLowerCase();
  if (t === "oauth") return det("plan", prov, "auth.json", src);
  if (h === "opencode" && t === "wellknown") return det("gateway", "", "auth.json", src);
  if (t && (h === "pi" || t === "api")) return det("api", "", "auth.json", src);
  const env = prov.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY";
  if (has(ev, env)) return det("api", "", env, src);
  return NONE;
}
// the harness's rule table, first match wins; multi-provider harnesses resolve here only when exactly one provider is known
export function rule(h: string, ev: Evid, src: string): Det {
  if (h === "claude") return claudeRule(ev, src);
  if (h === "codex") return codexRule(ev, src);
  if (h === "gemini") return geminiRule(ev, src);
  if (h === "kiro") return det("plan", "", "kiro bills plan credits", src);
  if (h === "pi" || h === "opencode") {
    const ps: string[] = []; for (const k of ev.kv.keys()) if (k.startsWith("auth.")) ps.push(k.slice(5));
    return ps.length === 1 ? provRule(h, ps[0] ?? "", ev, src) : NONE;
  }
  return NONE; // fx: no documented auth storage
}
// transcript evidence: a Bedrock or Vertex model id means the cloud bills it
export function modelBill(model: string): Bill | "" {
  const m = model.toLowerCase();
  if (m.indexOf("anthropic.claude-") >= 0 || /^(us|eu|apac)\.anthropic\./.test(m) || m.startsWith("arn:aws:bedrock")) return "metered";
  if (/^claude-.*@\d{8}$/.test(m)) return "metered";
  return "";
}

// the JSON object right after "key": in text (brace-matched, strings respected): reads one block of a large file
// without parsing — or keeping — the rest of it
export function cutObject(text: string, key: string): Obj | null {
  const i = text.indexOf("\"" + key + "\"");
  if (i < 0) return null;
  let j = text.indexOf("{", i + key.length + 2);
  if (j < 0 || text.slice(i + key.length + 2, j).trim() !== ":") return null;
  let depth = 0; let inStr = false;
  for (let k = j; k < text.length; k++) {
    const c = text.charCodeAt(k);
    if (inStr) { if (c === 92) k++; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 123) depth++;
    else if (c === 125) { depth--; if (depth === 0) { try { return obj(JSON.parse(text.slice(j, k + 1))); } catch (e) { return null; } } }
  }
  return null;
}
function readObj(p: string): Obj | null {
  const t = readText(p, 0, CAP).trim();
  if (!t.startsWith("{")) return null;
  try { return obj(JSON.parse(t)); } catch (e) { return null; }
}
// a settings file: apiKeyHelper presence, env block names and switch values
function claudeSettings(ev: Evid, p: string): void {
  const o = readObj(p); if (!o) return;
  if (str(o["apiKeyHelper"])) ev.kv.set("claude.helper", "1");
  const env = obj(o["env"]); if (!env) return;
  for (const k of Object.keys(env)) {
    if (ev.names.indexOf(k) < 0) ev.names.push(k);
    if (SWITCHES.indexOf(k) >= 0 && switchOn(String(env[k] ?? "")) && ev.on.indexOf(k) < 0) ev.on.push(k);
  }
}
function authTypes(ev: Evid, p: string): void {
  const o = readObj(p); if (!o) return;
  for (const k of Object.keys(o)) { const v = obj(o[k]); const t = v ? str(v["type"]) : ""; if (t) ev.kv.set("auth." + k, t); }
}
// the files configEv(h, home, cwd) reads (their mtimes tell a cache when to re-read)
export function configFiles(h: string, home: string, cwd: string): string[] {
  if (h === "claude") {
    const fs = [join(home, ".claude", "settings.json"), join(home, ".claude.json")];
    if (cwd) { fs.push(join(cwd, ".claude", "settings.json")); fs.push(join(cwd, ".claude", "settings.local.json")); }
    return fs;
  }
  if (h === "codex") return [join(home, ".codex", "auth.json"), join(home, ".codex", "config.toml")];
  if (h === "gemini") return [join(home, ".gemini", "settings.json")];
  if (h === "pi") return [join(home, ".pi", "agent", "auth.json")];
  if (h === "opencode") return [join(home, ".local", "share", "opencode", "auth.json")];
  return [];
}
// current config of harness h under home (cwd: the session's project, for project settings)
export function configEv(h: string, home: string, cwd: string): Evid {
  const ev = newEvid();
  if (h === "claude") {
    claudeSettings(ev, join(home, ".claude", "settings.json"));
    if (cwd) { claudeSettings(ev, join(cwd, ".claude", "settings.json")); claudeSettings(ev, join(cwd, ".claude", "settings.local.json")); }
    const oa = cutObject(readText(join(home, ".claude.json"), 0, 4 * CAP), "oauthAccount");
    if (oa) {
      const bt = str(oa["billingType"]); if (bt) ev.kv.set("claude.billingType", bt);
      const ot = str(oa["organizationType"]);
      const plan = str(oa["claudeMaxTier"]) || (ot.startsWith("claude_") ? ot.slice(7) : ot) || str(oa["seatTier"]);
      if (plan) ev.kv.set("claude.plan", plan);
    }
  } else if (h === "codex") {
    const a = readObj(join(home, ".codex", "auth.json"));
    if (a) {
      const am = str(a["auth_mode"]); if (am) ev.kv.set("codex.auth_mode", am);
      if (str(a["OPENAI_API_KEY"])) ev.names.push("OPENAI_API_KEY"); // presence only
    }
    for (const ln of readText(join(home, ".codex", "config.toml"), 0, CAP).split("\n")) {
      if (/^\s*\[/.test(ln)) break; // top-level keys only: profiles override per run, not by default
      const m = ln.match(/^\s*model_provider\s*=\s*"([^"]+)"/);
      if (m) ev.kv.set("codex.provider", (m[1] ?? "").toLowerCase());
    }
  } else if (h === "gemini") {
    const o = readObj(join(home, ".gemini", "settings.json"));
    const sec = o ? obj(o["security"]) : null; const au = sec ? obj(sec["auth"]) : null;
    const t = (au ? str(au["selectedType"]) : "") || (o ? str(o["selectedAuthType"]) : ""); // older gemini: top-level selectedAuthType
    if (t) ev.kv.set("gemini.selectedType", t);
  } else if (h === "pi") authTypes(ev, join(home, ".pi", "agent", "auth.json"));
  else if (h === "opencode") authTypes(ev, join(home, ".local", "share", "opencode", "auth.json"));
  return ev;
}
// --redact: plan names are type words (team, pro, max_5x); anything else could be an organisation's name
export function planLabel(plan: string, redact: boolean): string { return redact && !/^[a-z0-9_]+$/.test(plan) ? "plan" : plan; }

// ── Claude plan allowance (~/.claude.json cachedUsageUtilization): undocumented, so behind a staleness + shape guard ──
// Pinned shape: {fetchedAtMs, utilization: {five_hour|seven_day: {utilization 0–100, resets_at ISO}}}. If Claude Code
// changes it once, update this check; a second change removes the gauge instead of chasing it.
export interface Win { pct: number; reset: number }
export interface Allow { h5: Win | null; d7: Win | null; hi: string } // hi = the fuller window, "5h" | "7d"
function winOf(v: unknown, now: number): Win | null {
  const o = obj(v); if (!o) return null;
  const u = o["utilization"]; if (typeof u !== "number") return null;
  let pct = u as number;
  if (pct > 0 && pct < 1 && Math.floor(pct) !== pct) pct = pct * 100; // a 0–1 fraction
  if (!(pct >= 0 && pct <= 100)) return null;
  const r = str(o["resets_at"]); const t = r ? new Date(r).getTime() : 0;
  if (!(t > now)) return null;
  return { pct: Math.round(pct), reset: t };
}
export function allowanceOf(o: Obj | null, now: number): Allow | null {
  const c = o ? obj(o["cachedUsageUtilization"]) : null; if (!c) return null;
  const f = c["fetchedAtMs"]; if (typeof f !== "number" || now - (f as number) > 3600000) return null;
  const u = obj(c["utilization"]); if (!u) return null;
  const h5 = winOf(u["five_hour"], now); const d7 = winOf(u["seven_day"], now);
  if (!h5 && !d7) return null;
  return { h5, d7, hi: h5 && (!d7 || h5.pct > d7.pct) ? "5h" : "7d" };
}
