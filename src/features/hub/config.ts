// agentglass — the "receive" section of ~/.agentglass/config.json (otlp-hub spec 6, 7, 10, 12), the listen policy, and
// the hub-source fields of a fleet.hosts entry with "otlp" (spec 2)
// SPDX-License-Identifier: Apache-2.0
//   {"receive": {"listen", "dir", "tls": {"cert", "key"}, "listenPublic", "maxBodyMB", "maxDecodedMB", "maxRecords",
//                "ratePerMin", "mbPerMin", "maxDiskMB", "retentionDays", "keepContent", "drop": [keys]}}
import { join } from "node:path";
import { type Obj, obj, str, arr } from "../../util/json.ts";
import { HOME } from "../../util/fs.ts";
import { rawSection } from "../../util/config.ts";

export interface RecvCfg {
  listen: string; dir: string; tls: string[]; // [cert, key], "" = unset
  maxBodyMB: number; maxDecodedMB: number; maxRecords: number; ratePerMin: number; mbPerMin: number;
  maxDiskMB: number; retentionDays: number; keepContent: boolean; drop: string[]; listenPublic: boolean;
  warns: string[];
}
export const DEFAULT_LISTEN = "127.0.0.1:4318";
// AGENTGLASS_HUB_DIR: another hub directory (tests and branch builds keep off the real one); read per call
export function hubDir(): string { const e = process.env["AGENTGLASS_HUB_DIR"]; return e !== undefined && e ? e : join(HOME, ".agentglass", "hub"); }
export function expandHome(p: string): string { return p === "~" ? HOME : p.startsWith("~/") ? join(HOME, p.slice(2)) : p; }

function int(o: Obj, k: string, lo: number, hi: number, d: number, w: string[]): number {
  const v = o[k]; if (v === undefined) return d;
  if (typeof v === "number" && Number.isInteger(v as number) && (v as number) >= lo && (v as number) <= hi) return v as number;
  w.push("receive." + k + " must be an integer " + String(lo) + "–" + String(hi) + " — using " + String(d)); return d;
}
function bool(o: Obj, k: string, d: boolean, w: string[]): boolean { const v = o[k]; if (v === undefined) return d; if (typeof v === "boolean") return v as boolean; w.push("receive." + k + " must be true or false — using " + String(d)); return d; }
// the section as given (any shape): defaults of spec 10 for what is missing or wrong, one warning each
export function recvFrom(raw: unknown): RecvCfg {
  const w: string[] = [];
  let o = obj(raw);
  if (raw !== undefined && !o) { w.push("receive in ~/.agentglass/config.json must be an object — using defaults"); o = null; }
  const s: Obj = o ?? {};
  const tls = ["", ""]; const to = obj(s["tls"]);
  if (to) { const c = to["cert"]; const k = to["key"]; if (typeof c === "string") tls[0] = c as string; else if (c !== undefined) w.push("receive.tls.cert must be a file path"); if (typeof k === "string") tls[1] = k as string; else if (k !== undefined) w.push("receive.tls.key must be a file path"); }
  else if (s["tls"] !== undefined) w.push("receive.tls must be an object: {\"cert\", \"key\"}");
  const drop: string[] = []; for (const v of arr(s["drop"])) { const k = str(v); if (k) drop.push(k); else w.push("receive.drop entries must be attribute keys"); }
  if (s["drop"] !== undefined && !Array.isArray(s["drop"])) w.push("receive.drop must be a list of attribute keys");
  const l = s["listen"]; if (l !== undefined && typeof l !== "string") w.push("receive.listen must be \"host:port\"");
  const d = s["dir"]; if (d !== undefined && typeof d !== "string") w.push("receive.dir must be a directory path");
  return {
    listen: str(l) || DEFAULT_LISTEN, dir: str(d) ? expandHome(str(d)) : hubDir(), tls,
    maxBodyMB: int(s, "maxBodyMB", 1, 64, 8, w), maxDecodedMB: int(s, "maxDecodedMB", 1, 512, 64, w), maxRecords: int(s, "maxRecords", 1, 1000000, 20000, w),
    ratePerMin: int(s, "ratePerMin", 1, 100000, 120, w), mbPerMin: int(s, "mbPerMin", 1, 100000, 128, w),
    maxDiskMB: int(s, "maxDiskMB", 1, 10485760, 2048, w), retentionDays: int(s, "retentionDays", 1, 3650, 30, w),
    keepContent: bool(s, "keepContent", false, w), drop, listenPublic: bool(s, "listenPublic", false, w), warns: w,
  };
}
export function loadRecv(): RecvCfg { return recvFrom(rawSection("receive")); }

// "host:port" / "[v6]:port" → [host, port]; null when malformed. Hosts are IP literals only: a name could resolve to a
// public address behind the policy's back
export function splitListen(a: string): { host: string; port: number } | null {
  const m = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(a) ?? /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(a);
  if (!m) return null;
  const port = Number(m[2] ?? ""); if (port > 65535) return null;
  const host = m[1] ?? "";
  if (host.indexOf(":") < 0) { for (const p of host.split(".")) if (Number(p) > 255) return null; }
  else if (v6words(host).length !== 8) return null;
  return { host, port };
}
// an IPv6 literal → 8 words, [] when malformed (an embedded IPv4 tail counts as two words)
export function v6words(h: string): number[] {
  const parts = h.split("::"); if (parts.length > 2) return [];
  const side = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    const g = s.split(":");
    for (let i = 0; i < g.length; i++) {
      const x = g[i] ?? "";
      if (i === g.length - 1 && x.indexOf(".") >= 0) { const q = x.split("."); if (q.length !== 4) return null; const b = q.map((v: string) => /^\d{1,3}$/.test(v) ? Number(v) : 256); if (b.some((v: number) => v > 255)) return null; out.push(((b[0] ?? 0) << 8) | (b[1] ?? 0), ((b[2] ?? 0) << 8) | (b[3] ?? 0)); continue; }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(x)) return null;
      out.push(parseInt(x, 16));
    }
    return out;
  };
  const a = side(parts[0] ?? ""); const b = parts.length === 2 ? side(parts[1] ?? "") : [];
  if (!a || !b) return [];
  if (parts.length === 1) return a.length === 8 ? a : [];
  if (a.length + b.length > 7) return [];
  const z: number[] = []; for (let i = a.length + b.length; i < 8; i++) z.push(0);
  return a.concat(z, b);
}
// loopback or the tailnet ranges (spec 7): listening there needs no further flags
export function privateAddr(host: string): boolean {
  if (host.indexOf(":") < 0) { const p = host.split(".").map((v: string) => Number(v)); const a = p[0] ?? 0; const b = p[1] ?? 0; return a === 127 || (a === 100 && b >= 64 && b <= 127); }
  const w = v6words(host);
  if (w.length !== 8) return false;
  let lo = true; for (let i = 0; i < 7; i++) if (w[i] !== 0) lo = false;
  if (lo && w[7] === 1) return true; // ::1
  return w[0] === 0xfd7a && w[1] === 0x115c && w[2] === 0xa1e0; // fd7a:115c:a1e0::/48
}
// "" = this listen address is allowed, else the reason and the fix (spec 7)
export function listenOk(addr: string, pub: boolean, tls: boolean): string {
  const l = splitListen(addr);
  if (!l) return "listen must be an IP address and port, e.g. 127.0.0.1:4318 or [::1]:4318 (got " + JSON.stringify(addr) + ")";
  if (privateAddr(l.host)) return "";
  if (!pub) return addr + " is not loopback or a tailnet address: a public listener needs --listen-public and TLS (--tls-cert/--tls-key); or keep 127.0.0.1 and expose it with tailscale serve or a TLS proxy";
  if (!tls) return addr + " is public: plain HTTP is refused there — add --tls-cert and --tls-key (or put a TLS proxy in front of 127.0.0.1)";
  return "";
}

// a fleet.hosts entry with "otlp" (spec 2): the directory, display names for host ids, trust, age cut, native records
// per fleet source entry: its hub fields (fleet/config.ts fills it while it parses fleet.hosts)
export const HUBS = { cfg: new Map<string, HubSrcCfg>() };
export interface HubSrcCfg { dir: string; names: Map<string, string>; trust: string; maxAgeDays: number; includeNative: boolean } // trust "" = by directory
const HOSTID_RE = /^[0-9a-f]{16}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
export function hubSourceFrom(o: Obj, who: string, w: string[]): HubSrcCfg {
  const names = new Map<string, string>();
  const h = obj(o["hosts"]);
  if (h) for (const k of Object.keys(h)) {
    const id = str(h[k]);
    if (!NAME_RE.test(k)) { w.push(who + ": hosts." + k + ": name must be 1–16 of a-z 0-9 - — skipped"); continue; }
    if (!HOSTID_RE.test(id)) { w.push(who + ": hosts." + k + " must be a host id of 16 hex digits — skipped"); continue; }
    names.set(id, k);
  } else if (o["hosts"] !== undefined) w.push(who + ": hosts must be an object {name: host id}");
  let trust = ""; const t = o["trust"];
  if (t === "label" || t === "payload") trust = t as string; else if (t !== undefined) w.push(who + ": trust must be \"label\" or \"payload\" — deciding by the directory");
  let age = 30; const a = o["maxAgeDays"];
  if (typeof a === "number" && Number.isInteger(a as number) && (a as number) >= 1 && (a as number) <= 3650) age = a as number; else if (a !== undefined) w.push(who + ": maxAgeDays must be an integer 1–3650 — using 30");
  let nat = false; const n = o["includeNative"];
  if (typeof n === "boolean") nat = n as boolean; else if (n !== undefined) w.push(who + ": includeNative must be true or false — using false");
  // spec 5.5: Codex, Gemini CLI and OpenCode records would join agentglass's only approximately, on fields no fixture
  // verifies yet; until then the switch says so instead of doing nothing silently
  if (nat) w.push(who + ": includeNative is not supported yet — Codex, Gemini CLI and OpenCode native records are ignored (Claude Code's api_request records count without it)");
  return { dir: expandHome(str(o["otlp"])), names, trust, maxAgeDays: age, includeNative: nat };
}
