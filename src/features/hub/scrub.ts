// agentglass — hub-side scrubbing at ingest (otlp-hub spec 12): defense in depth behind redaction at the source.
// user.email always goes; content attributes and status messages unless keepContent; configured keys; e-mails and
// key-like tokens masked in free-text attributes and log bodies. Applied to every attribute list wherever a sender puts
// it (resource, scope, spans, events, links, log records, kvlists, members OTLP does not define): nothing the scrub
// acts on reaches the disk because it sat somewhere the schema does not expect it.
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, arr } from "../../util/json.ts";
import { scrubSecrets } from "../../util/secrets.ts";

// "prompt": the prompt text of the harnesses' native user_prompt events (Claude Code, Codex, Gemini CLI)
export const CONTENT_KEYS = ["gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.system_instructions", "gen_ai.tool.call.arguments", "gen_ai.tool.call.result", "prompt"];
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
  const o = obj(v); if (!o) return walk(v, c, cnt);
  const s = o["stringValue"];
  if (typeof s === "string") { if (free) o["stringValue"] = scrubSecrets(s as string); return o; }
  const kl = obj(o["kvlistValue"]); if (kl) { kl["values"] = walk(kl["values"], c, cnt); o["kvlistValue"] = kl; return o; }
  const al = obj(o["arrayValue"]); if (al) { const out: unknown[] = []; for (const x of arr(al["values"])) out.push(value(x, free, c, cnt)); al["values"] = out; o["arrayValue"] = al; return o; }
  return walk(o, c, cnt);
}
// any JSON value: in every array, {"key": k, …} entries with a dropped key go and free-text ones are masked; a "body"
// (log record) is masked; a "status" loses its message unless keepContent. parsed JSON has value semantics in scriptc:
// every changed child is assigned back into its parent
function walk(v: unknown, c: ScrubCfg, cnt: Cnt): unknown {
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v as unknown[]) {
      const o = obj(x); const k = o ? o["key"] : undefined;
      if (o && typeof k === "string") {
        if (gone(k as string, c, cnt)) continue;
        o["value"] = value(o["value"], FREE.indexOf(k as string) >= 0, c, cnt); out.push(o); continue;
      }
      out.push(walk(x, c, cnt));
    }
    return out;
  }
  const o = obj(v); if (!o) return v;
  for (const k of Object.keys(o)) {
    if (k === "body") { o[k] = value(o[k], true, c, cnt); continue; }
    if (k === "status" && !c.keepContent) {
      const st = obj(o[k]);
      if (st && st["message"] !== undefined) { const ns: Obj = {}; for (const sk of Object.keys(st)) if (sk !== "message") ns[sk] = st[sk]; o[k] = ns; cnt.n++; continue; }
    }
    o[k] = walk(o[k], c, cnt);
  }
  return o;
}
// false when the request text names no key the scrub acts on and holds no status message or log body: it is stored as
// it came (rebuilding a large request costs more than everything else at ingest). One pass over the "key" members
// (whitespace around ":" allowed); a \u escape anywhere, or a backslash in a key, could spell a key another way: then
// always scrub. The caller also stores only requests whose root holds nothing but their signal as they came
const WS = " \t\r\n";
export function scrubNeeded(text: string, c: ScrubCfg): boolean {
  if (text.indexOf("\\u") >= 0) return true;
  if (!c.keepContent && text.indexOf("\"message\"") >= 0) return true; // a span status message (or a value spelled so: the slow path)
  if (text.indexOf("\"body\"") >= 0) return true; // a log body (masked), wherever it sits
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
// one ResourceSpans / ResourceLogs, scrubbed (a new value); n = content items removed
export function scrubResource(rs: Obj, logs: boolean, c: ScrubCfg): { rs: Obj; n: number } {
  const cnt: Cnt = { n: 0 };
  const out = obj(walk(rs, c, cnt)) ?? {};
  return { rs: out, n: cnt.n };
}
// a whole request line (the check's and the tests' entry point; the server scrubs resources it already parsed): only
// the request's own signal member is kept
export function scrubRequest(json: string, keepContent: boolean, drop: string[]): { json: string; dropped: number; err: string } {
  let root: Obj | null = null;
  try { root = obj(JSON.parse(json)); } catch (e) { root = null; }
  if (!root) return { json: "", dropped: 0, err: "not a JSON object" };
  const key = root["resourceSpans"] === undefined && root["resourceLogs"] !== undefined ? "resourceLogs" : "resourceSpans";
  const c: ScrubCfg = { keepContent, drop };
  let n = 0;
  const out: unknown[] = [];
  for (const r of arr(root[key])) { const o = obj(r); if (!o) continue; const x = scrubResource(o, key === "resourceLogs", c); out.push(x.rs); n += x.n; }
  const w: Obj = {}; w[key] = out;
  return { json: JSON.stringify(w), dropped: n, err: "" };
}
