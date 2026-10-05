// agentglass — the harnesses' own OTLP export (spec 3b): detected so the same turn does not reach a backend twice under
// two names. Reads switch names and on/off values only — never an endpoint, header or token.
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { existsSync } from "node:fs";
import { type Obj, obj, parse as parseJson } from "../../util/json.ts";
import { HOME, readText } from "../../util/fs.ts";
import { OS } from "../../platform/index.ts";
import { envSummary } from "../usage/billing.ts";
import { type ExpState } from "./state.ts";

// on: "on" | "off" | "unknown" (a config that does not parse); src: "config <path>" | "env of pid <n>" | ""
export interface Native { h: string; on: string; src: string }
export interface NativeDecision { skipFrom: Map<string, number>; notes: string[] }
export const accessed: string[] = []; // config keys the readers looked at (the check asserts no endpoint/header key is among them)
const ORDER = ["claude", "codex", "gemini", "opencode", "pi", "kiro", "fx"];
const OFF = ["", "0", "false", "no", "off"];
function onVal(v: unknown): boolean { return v === true || (typeof v === "string" && OFF.indexOf((v as string).trim().toLowerCase()) < 0) || (typeof v === "number" && (v as number) !== 0); }
function tilde(p: string): string { return p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p; }

// a live process's environment: Claude's switch (its value: on/off), OpenCode's endpoint variable (its name only)
export function envNative(h: string, raw: Uint8Array): string {
  const sm = envSummary(raw);
  if (h === "claude") return sm.on.indexOf("CLAUDE_CODE_ENABLE_TELEMETRY") >= 0 ? "on" : "off";
  if (h === "opencode") return sm.names.indexOf("OTEL_EXPORTER_OTLP_ENDPOINT") >= 0 || sm.names.indexOf("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") >= 0 ? "on" : "off";
  return "off";
}
// Claude: settings.json {"env": {"CLAUDE_CODE_ENABLE_TELEMETRY": "1"}}
function claudeCfg(p: string): string {
  if (!existsSync(p)) return "off";
  let o: Obj | null = null; try { o = obj(JSON.parse(readText(p, 0, 2097152))); } catch (e) { return "unknown"; }
  if (!o) return "unknown";
  const env = obj(o["env"]); accessed.push("env.CLAUDE_CODE_ENABLE_TELEMETRY");
  return env && onVal(env["CLAUDE_CODE_ENABLE_TELEMETRY"]) ? "on" : "off";
}
// Codex: config.toml [otel] exporter / trace_exporter = "otlp-http" | "otlp-grpc" (section headers and key = "value" lines only)
function codexCfg(p: string): string {
  if (!existsSync(p)) return "off";
  let sec = ""; let on = false;
  for (const l of readText(p, 0, 2097152).split("\n")) {
    const t = l.trim(); if (!t || t.startsWith("#")) continue;
    if (t.startsWith("[")) { const m = /^\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(t); if (!m) return "unknown"; sec = m[1] ?? ""; continue; }
    if (sec !== "otel") continue;
    const m = /^(exporter|trace_exporter)\s*=\s*(.*)$/.exec(t); if (!m) continue;
    accessed.push("otel." + (m[1] ?? ""));
    const v = (m[2] ?? "").replace(/#.*$/, "").trim();
    const q = /^"([^"]*)"$/.exec(v); if (!q) { if (v.startsWith("{")) { if (/otlp-(http|grpc)/.test(v)) on = true; continue; } return "unknown"; }
    if (/^otlp-(http|grpc)$/.test(q[1] ?? "")) on = true;
  }
  return on ? "on" : "off";
}
// Gemini CLI: settings.json {"telemetry": {"enabled": true}} (user, then project)
function geminiCfg(p: string): string {
  if (!existsSync(p)) return "off";
  const o = parseJson(readText(p, 0, 2097152).trim()); if (!o) return "unknown";
  const t = obj(o["telemetry"]); accessed.push("telemetry.enabled");
  return t && t["enabled"] === true ? "on" : "off";
}
// the project dirs whose .gemini/settings.json can switch Gemini's export on: its sessions' cwds, newest first, each once,
// at most 64 (a long --since must not crowd out the session that is running now)
export function projectDirs(roots: { h: string; cwd: string; mtime: number }[]): string[] {
  const gs = roots.filter((s: { h: string; cwd: string; mtime: number }) => s.h === "gemini" && !!s.cwd).sort((a, b) => b.mtime - a.mtime);
  const out: string[] = []; for (const s of gs) { if (out.length >= 64) break; if (out.indexOf(s.cwd) < 0) out.push(s.cwd); }
  return out;
}
// per harness (all of them, in a fixed order): live processes' environment first, then the config files
export function detectNative(pids: Map<string, number[]>, home: string, cwds: string[]): Native[] {
  const out: Native[] = [];
  for (const h of ORDER) {
    let on = "off"; let src = "";
    for (const pid of pids.get(h) ?? []) if (envNative(h, OS.envOf(pid)) === "on") { on = "on"; src = "env of pid " + String(pid); break; }
    const files: string[] = [];
    if (h === "claude") files.push(join(home, ".claude", "settings.json"));
    else if (h === "codex") files.push(join(home, ".codex", "config.toml"));
    else if (h === "gemini") { files.push(join(home, ".gemini", "settings.json")); for (const c of cwds) if (c) files.push(join(c, ".gemini", "settings.json")); }
    if (on !== "on") for (const f of files) {
      const v = h === "claude" ? claudeCfg(f) : h === "codex" ? codexCfg(f) : geminiCfg(f);
      if (v === "on") { on = "on"; src = "config " + tilde(f); break; }
      if (v === "unknown") on = "unknown"; // a parse failure is never "on"
    }
    out.push({ h, on, src });
  }
  return out;
}
const warned = new Set<string>();
// warn | skip | include (spec 3b.2); skip keeps a harness's turns that started before agentglass first saw its export on
export function applyPolicy(ns: Native[], pol: string, st: ExpState, now: number): NativeDecision {
  const d: NativeDecision = { skipFrom: new Map<string, number>(), notes: [] };
  for (const n of ns) {
    const has = st.nativeSince.has(n.h); const since = st.nativeSince.get(n.h) ?? now;
    if (n.on !== "on") {
      if (has && n.on === "off") { st.nativeSince.delete(n.h); d.notes.push(n.h + ": its own OTLP export is off again — all its new turns are exported; turns since " + new Date(since).toISOString() + " are not back-filled (--native include --since <time>)"); }
      continue;
    }
    if (pol === "skip") { if (!has) st.nativeSince.set(n.h, since); d.skipFrom.set(n.h, since); }
    else if (pol === "warn" && !warned.has(n.h)) {
      warned.add(n.h);
      d.notes.push(n.h + ": its own OTLP export is on (" + n.src.replace(/^config /, "") + ") — turns may appear twice in the backend; --native skip exports only what it does not send");
    }
  }
  return d;
}
