// agentglass — hub-side scrubbing at ingest (otlp-hub spec 12): defense in depth behind redaction at the source.
// user.email always goes; content attributes and status messages unless keepContent; configured keys; e-mails and
// key-like tokens masked in free-text attributes and log bodies. Applied to every attribute list, nested kvlists too.
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, arr, str } from "../../util/json.ts";
import { scrubSecrets } from "../../util/secrets.ts";

export const CONTENT_KEYS = ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result"];
const ALWAYS = ["user.email"];
const FREE = ["agentglass.session.title", "agentglass.tool.command", "agentglass.tool.target", "exception.message"];
export interface ScrubCfg { keepContent: boolean; drop: string[] }
interface Cnt { n: number } // content attributes, status messages and user.email removed (the "check its export settings" counter)

function gone(k: string, c: ScrubCfg, cnt: Cnt): boolean {
  if (ALWAYS.indexOf(k) >= 0 || (!c.keepContent && CONTENT_KEYS.indexOf(k) >= 0)) { cnt.n++; return true; }
  return c.drop.indexOf(k) >= 0;
}
// an AnyValue: strings masked when free (a free-text key or a log body), kvlists filtered, arrays walked
function value(v: unknown, free: boolean, c: ScrubCfg, cnt: Cnt): unknown {
  const o = obj(v); if (!o) return v;
  const s = o["stringValue"];
  if (typeof s === "string") { if (free) o["stringValue"] = scrubSecrets(s as string); return o; }
  const kl = obj(o["kvlistValue"]); if (kl) { kl["values"] = attrs(kl["values"], c, cnt); o["kvlistValue"] = kl; return o; }
  const al = obj(o["arrayValue"]); if (al) { const out: unknown[] = []; for (const x of arr(al["values"])) out.push(value(x, free, c, cnt)); al["values"] = out; o["arrayValue"] = al; }
  return o;
}
function attrs(list: unknown, c: ScrubCfg, cnt: Cnt): unknown[] {
  const out: unknown[] = [];
  for (const a of arr(list)) {
    const o = obj(a); if (!o) continue;
    const k = str(o["key"]);
    if (gone(k, c, cnt)) continue;
    o["value"] = value(o["value"], FREE.indexOf(k) >= 0, c, cnt);
    out.push(o);
  }
  return out;
}
// false when the request text names no key the scrub acts on: it is stored as it came (rebuilding a large request
// costs more than everything else at ingest). One pass over the "key" members (whitespace around ":" allowed); a \u
// escape anywhere, or a backslash in a key, could spell a key another way: then always scrub
const WS = " \t\r\n";
export function scrubNeeded(text: string, c: ScrubCfg): boolean {
  if (text.indexOf("\\u") >= 0) return true;
  if (!c.keepContent && text.indexOf("\"message\"") >= 0) return true; // a span status message (or a value spelled so: the slow path)
  const keys = new Set<string>(ALWAYS.concat(FREE, c.drop, c.keepContent ? [] : CONTENT_KEYS));
  let i = text.indexOf("\"key\"");
  while (i >= 0) {
    let j = i + 5;
    while (j < text.length && WS.indexOf(text[j] ?? "") >= 0) j++;
    if (text[j] === ":") {
      j++; while (j < text.length && WS.indexOf(text[j] ?? "") >= 0) j++;
      if (text[j] === "\"") { const e = text.indexOf("\"", j + 1); if (e < 0) return true; const name = text.slice(j + 1, e); if (keys.has(name) || name.indexOf("\\") >= 0) return true; j = e + 1; }
    }
    i = text.indexOf("\"key\"", j);
  }
  return false;
}
// parsed JSON has value semantics in scriptc: a changed child is assigned back into its parent at every level
function own(o: Obj, c: ScrubCfg, cnt: Cnt): Obj { if (o["attributes"] !== undefined) o["attributes"] = attrs(o["attributes"], c, cnt); return o; }
// one ResourceSpans / ResourceLogs, scrubbed (a new value); n = content items removed
export function scrubResource(rs: Obj, logs: boolean, c: ScrubCfg): { rs: Obj; n: number } {
  const cnt: Cnt = { n: 0 };
  const res = obj(rs["resource"]); if (res) rs["resource"] = own(res, c, cnt);
  const sk = logs ? "scopeLogs" : "scopeSpans"; const ik = logs ? "logRecords" : "spans";
  const scopes: unknown[] = [];
  for (const sx of arr(rs[sk])) {
    const so = obj(sx); if (!so) continue;
    const sc = obj(so["scope"]); if (sc) so["scope"] = own(sc, c, cnt);
    const items: unknown[] = [];
    for (const it of arr(so[ik])) {
      const r0 = obj(it); if (!r0) continue;
      const r = own(r0, c, cnt);
      if (logs) { if (r["body"] !== undefined) r["body"] = value(r["body"], true, c, cnt); items.push(r); continue; }
      if (r["events"] !== undefined) { const ev: unknown[] = []; for (const e of arr(r["events"])) { const eo = obj(e); if (eo) ev.push(own(eo, c, cnt)); } r["events"] = ev; }
      const st = obj(r["status"]);
      if (st && st["message"] !== undefined && !c.keepContent) { const ns: Obj = {}; for (const k of Object.keys(st)) if (k !== "message") ns[k] = st[k]; r["status"] = ns; cnt.n++; }
      items.push(r);
    }
    so[ik] = items; scopes.push(so);
  }
  rs[sk] = scopes;
  return { rs, n: cnt.n };
}
// a whole request line (the check's and the tests' entry point; the server scrubs resources it already parsed)
export function scrubRequest(json: string, keepContent: boolean, drop: string[]): { json: string; dropped: number; err: string } {
  let root: Obj | null = null;
  try { root = obj(JSON.parse(json)); } catch (e) { root = null; }
  if (!root) return { json: "", dropped: 0, err: "not a JSON object" };
  const logs = root["resourceLogs"] !== undefined;
  const c: ScrubCfg = { keepContent, drop };
  let n = 0;
  const out: unknown[] = [];
  for (const r of arr(root[logs ? "resourceLogs" : "resourceSpans"])) { const o = obj(r); if (!o) continue; const x = scrubResource(o, logs, c); out.push(x.rs); n += x.n; }
  root[logs ? "resourceLogs" : "resourceSpans"] = out;
  return { json: JSON.stringify(root), dropped: n, err: "" };
}
