// agentglass — gateway prices: per-model costs the user wrote into pi's models.json and OpenCode's config, per provider key
// SPDX-License-Identifier: Apache-2.0
// Only provider ids, model ids and their cost numbers are copied; apiKey, headers, options and base URLs never leave the
// parsed object, which is dropped right after. pricing.ts applies the rows to bookings of that provider only.
import { statSync } from "node:fs";
import { join } from "node:path";
import { type Obj, obj, str, arr } from "../../util/json.ts";
import { readText } from "../../util/fs.ts";
import { type Price, normModel } from "./pricing.ts";

// JSON with comments (OpenCode's .jsonc): drops // and /* */ outside strings and trailing commas before } or ]
export function stripJsonc(t: string): string {
  const out: string[] = []; let i = 0; let s = 0; const n = t.length;
  while (i < n) {
    const c = t.charCodeAt(i);
    if (c === 34) { // a string: copy through its closing quote, escapes included
      let j = i + 1;
      while (j < n) { const d = t.charCodeAt(j); if (d === 92) { j += 2; continue; } if (d === 34) break; j++; }
      i = j + 1; continue;
    }
    if (c === 47 && i + 1 < n && (t.charCodeAt(i + 1) === 47 || t.charCodeAt(i + 1) === 42)) {
      out.push(t.slice(s, i));
      if (t.charCodeAt(i + 1) === 47) { const e = t.indexOf("\n", i); i = e < 0 ? n : e; } else { const e = t.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; }
      s = i; continue;
    }
    if (c === 44) { // a comma whose next non-space character closes an object or array
      let j = i + 1; let gone = false;
      while (j < n) {
        const d = t.charCodeAt(j);
        if (d === 32 || d === 9 || d === 10 || d === 13) { j++; continue; }
        if (d === 47 && j + 1 < n && t.charCodeAt(j + 1) === 47) { const e = t.indexOf("\n", j); j = e < 0 ? n : e; continue; }
        if (d === 47 && j + 1 < n && t.charCodeAt(j + 1) === 42) { const e = t.indexOf("*/", j + 2); j = e < 0 ? n : e + 2; continue; }
        gone = d === 125 || d === 93; break;
      }
      if (gone) { out.push(t.slice(s, i)); s = i + 1; }
    }
    i++;
  }
  out.push(t.slice(s));
  return out.join("");
}

function rate(v: unknown): number { return typeof v === "number" && isFinite(v as number) && (v as number) >= 0 && (v as number) < 10000 ? (v as number) : -1; }
// one cost object → a row ($/Mtok as stored); input and output are required (0/0 = a free route), cache fields default -1
function row(id: string, c: Obj | null, cr: string, cw: string): Price | null {
  if (!c || !id) return null;
  const i = rate(c["input"]); const o = rate(c["output"]);
  if (i < 0 || o < 0) return null;
  return { p: normModel(id), i, o, cr: rate(c[cr]), cw: rate(c[cw]), cw1: -1 };
}
function put(m: Map<string, Price[]>, prov: string, r: Price): void {
  const rs = m.get(prov);
  if (!rs) { m.set(prov, [r]); return; }
  for (const x of rs) if (x.p === r.p) { x.i = r.i; x.o = r.o; x.cr = r.cr; x.cw = r.cw; x.cw1 = r.cw1; return; } // a later file/entry wins
  rs.push(r);
}
// pi: providers.<prov>.models[] {id, cost{input, output, cacheRead, cacheWrite}}
export function piRows(o: Obj | null): Map<string, Price[]> {
  const out = new Map<string, Price[]>(); const ps = o ? obj(o["providers"]) : null; if (!ps) return out;
  for (const prov of Object.keys(ps)) {
    const pv = obj(ps[prov]); if (!pv) continue;
    for (const m of arr(pv["models"])) { const mo = obj(m); if (!mo) continue; const r = row(str(mo["id"]), obj(mo["cost"]), "cacheRead", "cacheWrite"); if (r) put(out, prov, r); }
  }
  return out;
}
// OpenCode: provider.<prov>.models.<id>.cost {input, output, cache_read, cache_write, context_over_200k {…}}
export function opencodeRows(o: Obj | null): Map<string, Price[]> {
  const out = new Map<string, Price[]>(); const ps = o ? obj(o["provider"]) : null; if (!ps) return out;
  for (const prov of Object.keys(ps)) {
    const pv = obj(ps[prov]); const ms = pv ? obj(pv["models"]) : null; if (!ms) continue;
    for (const id of Object.keys(ms)) {
      const mo = obj(ms[id]); const c = mo ? obj(mo["cost"]) : null;
      const r = row(id, c, "cache_read", "cache_write"); if (!r) continue;
      put(out, prov, r);
      const big = row(id, c ? obj(c["context_over_200k"]) : null, "cache_read", "cache_write");
      if (big) { big.p = r.p + ">200k"; put(out, prov, big); }
    }
  }
  return out;
}
// pi's models.json, then OpenCode's global configs in the order OpenCode merges them (later wins)
const OC_NAMES = ["config.json", "opencode.json", "opencode.jsonc"];
export function gatewayFiles(home: string, env: Map<string, string>): string[] {
  const p0 = env.get("PI_CODING_AGENT_DIR") ?? "";
  const pi = p0 === "~" ? home : p0.startsWith("~/") ? join(home, p0.slice(2)) : p0; // pi expands ~ itself
  const xdg = env.get("XDG_CONFIG_HOME") ?? "";
  const oc = join(xdg ? xdg : join(home, ".config"), "opencode");
  return [join(pi ? pi : join(home, ".pi", "agent"), "models.json")].concat(OC_NAMES.map((f: string) => join(oc, f)));
}
function readObj(f: string): Obj | null {
  const t = readText(f, 0, 2097152).trim();
  if (!t) return null;
  try { return obj(JSON.parse(f.endsWith(".jsonc") ? stripJsonc(t) : t)); } catch (e) { return null; }
}
// stat-cheap: files are parsed again only when a mtime or size changed; sig = "" when no file has a row
let memoKey = "\u0000"; let memoRows = new Map<string, Price[]>(); let memoSig = "";
export function loadGateway(home: string, env: Map<string, string>): { rows: Map<string, Price[]>; sig: string } {
  const fs = gatewayFiles(home, env);
  let key = "";
  for (const f of fs) { try { const s = statSync(f); key += f + ":" + s.mtimeMs + ":" + s.size + "|"; } catch (e) { key += f + ":-|"; } }
  if (key === memoKey) return { rows: memoRows, sig: memoSig };
  const rows = new Map<string, Price[]>();
  // OpenCode first, pi last: pi rows win a clash of provider + id (they are what pi sessions book; OpenCode providers rarely share pi's names)
  for (let i = 1; i < fs.length; i++) for (const [p, rs] of opencodeRows(readObj(fs[i] ?? ""))) for (const r of rs) put(rows, p, r);
  for (const [p, rs] of piRows(readObj(fs[0] ?? ""))) for (const r of rs) put(rows, p, r);
  let t = "";
  for (const p of [...rows.keys()].sort()) for (const r of rows.get(p) ?? []) t += p + "/" + r.p + ":" + r.i + "," + r.o + "," + r.cr + "," + r.cw + "|";
  memoKey = key; memoRows = rows; memoSig = t;
  return { rows, sig: t };
}
// the process environment's gateway dirs (PI_CODING_AGENT_DIR, XDG_CONFIG_HOME), for loadGateway(HOME, …)
export function gatewayEnv(): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of ["PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME"]) { const v = process.env[k]; if (v) m.set(k, v); }
  return m;
}
