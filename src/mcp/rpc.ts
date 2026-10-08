// agentglass-mcp — the JSON-RPC 2.0 core of the MCP server: byte-level line framing, protocol versions, message
// parsing and the synchronous methods (initialize, ping, tools/list). Pure: main.ts owns stdin, stdout and children.
// SPDX-License-Identifier: Apache-2.0
// Imports only util/json.ts: the server's idle memory is its module init (src/mcp imports no feature module).
import { type Obj, obj, str } from "../util/json.ts";

// newest first; initialize answers the client's version when listed, else the newest (the client then decides)
export const VERSIONS: string[] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MAX_LINE = 4 * 1024 * 1024;
// the CLI contract this server speaks (src/features/version.ts CONTRACT; version.check.ts pins them equal)
export const CONTRACT = 1;
export function negotiate(requested: string): string { return VERSIONS.indexOf(requested) >= 0 ? requested : VERSIONS[0] ?? ""; }
// ISO dates compare as strings: outputSchema + structuredContent from 2025-06-18, tool title + annotations from 2025-03-26
export function structured(version: string): boolean { return version >= "2025-06-18"; }
export function annotated(version: string): boolean { return version >= "2025-03-26"; }

// ── framing: split on byte 0x0A and decode whole lines only (a UTF-8 character split across reads stays intact) ──
// parts: the pending line's chunks (no newline in them); plen their bytes; skipping: an oversize line is being dropped
export interface Framer { parts: Uint8Array[]; plen: number; skipping: boolean }
export function newFramer(): Framer { return { parts: [], plen: 0, skipping: false }; }
export interface Frame { line: string; oversize: boolean } // oversize: a dropped line (→ -32600, id null)
function joined(f: Framer, tail: Uint8Array): Uint8Array {
  if (!f.parts.length) return tail;
  const b = new Uint8Array(f.plen + tail.length); let at = 0;
  for (let i = 0; i < f.parts.length; i++) { const p = f.parts[i] as Uint8Array; b.set(p, at); at += p.length; }
  b.set(tail, at);
  return b;
}
// one complete line (without its "\n"): CRLF tolerated, blank lines skipped, over MAX_LINE dropped
function emit(out: Frame[], b: Uint8Array): void {
  let n = b.length; if (n > 0 && b[n - 1] === 13) n--;
  if (n > MAX_LINE) { out.push({ line: "", oversize: true }); return; }
  let blank = true; for (let i = 0; i < n && blank; i++) { const c = b[i] ?? 0; if (c !== 32 && c !== 9 && c !== 13) blank = false; }
  if (!blank) out.push({ line: new TextDecoder("utf-8").decode(b.subarray(0, n)), oversize: false });
}
export function push(f: Framer, d: Uint8Array): Frame[] {
  const out: Frame[] = [];
  let from = 0;
  while (from < d.length) {
    let nl = from; while (nl < d.length && d[nl] !== 10) nl++;
    if (nl === d.length) nl = -1;
    if (nl < 0) { // no line end in this chunk: keep it (+1: room for a final "\r"), or start/keep dropping it
      const rest = d.subarray(from);
      if (!f.skipping && f.plen + rest.length > MAX_LINE + 1) { f.skipping = true; f.parts = []; f.plen = 0; }
      if (!f.skipping) { f.parts.push(rest.slice()); f.plen += rest.length; } // slice: the caller may reuse its buffer
      break;
    }
    if (f.skipping) out.push({ line: "", oversize: true });
    else emit(out, joined(f, d.subarray(from, nl)));
    f.parts = []; f.plen = 0; f.skipping = false; from = nl + 1;
  }
  return out;
}

// ── messages ──
// kind: request | notification | response | invalid; id: the id as JSON text ("" = none); why: the reason when invalid
export interface Msg { kind: string; id: string; method: string; params: Obj; why: string }
function bad(id: string, why: string): Msg { return { kind: "invalid", id, method: "", params: {}, why }; }
function one(v: unknown): Msg {
  const o = obj(v);
  if (!o) return bad("", "not a JSON-RPC object");
  const idv = o["id"]; const hasId = idv !== undefined;
  let id = "";
  // MCP: an id is a string or a number, never null (base JSON-RPC allows null); 1e999 parses to Infinity, no id either
  if (hasId) { if (typeof idv === "string" || (typeof idv === "number" && Number.isFinite(idv))) id = JSON.stringify(idv); else return bad("", "id must be a string or a number"); }
  if (o["jsonrpc"] !== "2.0") return bad(id, "jsonrpc must be \"2.0\"");
  const method = o["method"];
  if (method === undefined) return hasId && (o["result"] !== undefined || o["error"] !== undefined) ? { kind: "response", id, method: "", params: {}, why: "" } : bad(id, "no method");
  if (typeof method !== "string") return bad(id, "method must be a string");
  const pv = o["params"]; let params: Obj = {};
  if (pv !== undefined && pv !== null) { const p = obj(pv); if (!p) return bad(id, "params must be an object"); params = p; }
  return { kind: hasId ? "request" : "notification", id, method, params, why: "" };
}
// a JSON array is a batch: its items under 2025-03-26 only (the one version that had batches), else one invalid
export function parse(line: string, version: string): Msg[] {
  let v: unknown = null;
  try { v = JSON.parse(line); } catch (e) { return [bad("", "parse error")]; }
  if (!Array.isArray(v)) return [one(v)];
  const items = v as unknown[];
  if (version !== "2025-03-26") return [bad("", "batch not supported")];
  if (!items.length) return [bad("", "empty batch")];
  const out: Msg[] = [];
  for (const it of items) out.push(one(it));
  return out;
}

// ── lines (no "\n"; main.ts's send adds it) ──
export function ok(id: string, result: Obj): string { return "{\"jsonrpc\":\"2.0\",\"id\":" + (id || "null") + ",\"result\":" + JSON.stringify(result) + "}"; }
export function fail(id: string, code: number, message: string): string { return "{\"jsonrpc\":\"2.0\",\"id\":" + (id || "null") + ",\"error\":" + JSON.stringify({ code, message }) + "}"; }
export function note(method: string, params: Obj): string { return "{\"jsonrpc\":\"2.0\",\"method\":" + JSON.stringify(method) + ",\"params\":" + JSON.stringify(params) + "}"; }

// ── the connection and its synchronous methods ──
// version: negotiated ("" before initialize); client: clientInfo.name; scopeName: "project" | "all projects"
export interface Conn { version: string; init: boolean; client: string; redact: boolean; scopeName: string; contract: number }
export function newConn(): Conn { return { version: "", init: false, client: "", redact: false, scopeName: "project", contract: CONTRACT }; }
// handled false: tools/call and notifications/cancelled, which main.ts answers (children, queue)
export interface Reply { handled: boolean; lines: string[] }
const done = (lines: string[]): Reply => ({ handled: true, lines });
export function answer(c: Conn, m: Msg, toolsList: (version: string) => Obj, instructions: (c: Conn) => string, serverVersion: string): Reply {
  if (m.kind === "invalid") return done([m.why === "parse error" ? fail("", -32700, "Parse error") : fail(m.id, -32600, "Invalid Request: " + m.why)]);
  if (m.kind === "response") return done([]); // the server sends no requests: a stray response is dropped
  if (m.kind === "notification") return m.method === "notifications/cancelled" ? { handled: false, lines: [] } : done([]); // initialized and unknown ones: nothing to answer
  if (m.method === "ping") return done([ok(m.id, {})]);
  if (m.method === "initialize") {
    c.version = negotiate(str(m.params["protocolVersion"])); c.init = true;
    const ci = obj(m.params["clientInfo"]); c.client = ci ? str(ci["name"]) : "";
    const meta: Obj = {}; meta["agentglass/contract"] = c.contract;
    // serverInfo.title: 2025-06-18 on (the test is structured(), which scriptc 0.1.7 cannot call here: SC1043)
    const info: Obj = { name: "agentglass" }; if (c.version !== "2025-03-26" && c.version !== "2024-11-05") info["title"] = "agentglass"; info["version"] = serverVersion;
    return done([ok(m.id, {
      protocolVersion: c.version, capabilities: { tools: { listChanged: false } },
      serverInfo: info,
      instructions: instructions(c), _meta: meta,
    })]);
  }
  if (!c.init) return done([fail(m.id, -32600, "Invalid Request: initialize first")]);
  if (m.method === "tools/list") return done([ok(m.id, toolsList(c.version))]);
  if (m.method === "tools/call") return { handled: false, lines: [] };
  return done([fail(m.id, -32601, "Method not found: " + m.method)]);
}
