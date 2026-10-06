// agentglass — OTLP protobuf decoder (otlp-hub spec 8, Decision 3): ExportTraceServiceRequest and ExportLogsServiceRequest
// → the protobuf JSON mapping as the exporter writes it (src/features/otlp/encode.ts: hex ids, decimal-string nanos and
// intValue, doubleValue numbers, base64 bytesValue, key order of the exporter). Hostile input is expected: every read
// is bounds-checked, nesting is capped, unknown fields and wire-type mismatches are skipped, and the first problem
// ends the decode with err (never a throw). Links and metrics are not decoded.
// SPDX-License-Identifier: Apache-2.0
//   field numbers: opentelemetry-proto v1 (common, resource, trace, logs; collector/{trace,logs}/v1)

interface Rd { b: Uint8Array; p: number; err: string; lo: number; hi: number; depth: number; n: number; cap: number }
export const PB_MAX_DEPTH = 16; // AnyValue nesting (arrays in kvlists in arrays …)
export const PB_MAX_STR = 16 * 1024 * 1024;
const W32 = 4294967296;
const MUL = [1, 128, 16384, 2097152, 268435456];
const HEX = "0123456789abcdef";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function fail(r: Rd, m: string): void { if (!r.err) r.err = m + " at byte " + String(r.p); r.p = r.b.length; }
// one varint into r.lo / r.hi (two 32-bit words, as unsigned numbers)
function vint(r: Rd): void {
  let lo = 0; let hi = 0;
  for (let i = 0; i < 10; i++) {
    if (r.p >= r.b.length) { fail(r, "truncated varint"); r.lo = 0; r.hi = 0; return; }
    const c = r.b[r.p] ?? 0; r.p += 1; const v = c & 0x7f;
    if (i < 4) lo += v * (MUL[i] ?? 0);
    else if (i === 4) { lo += (v & 0x0f) * 268435456; hi += v >>> 4; }
    else hi += v * (MUL[i - 5] ?? 0) * 8;
    if (c < 0x80) { r.lo = lo; r.hi = hi % W32; return; }
  }
  fail(r, "varint longer than 10 bytes"); r.lo = 0; r.hi = 0;
}
function fixed64(r: Rd, at: number): void {
  const b = r.b;
  r.lo = (b[at] ?? 0) + (b[at + 1] ?? 0) * 256 + (b[at + 2] ?? 0) * 65536 + (b[at + 3] ?? 0) * 16777216;
  r.hi = (b[at + 4] ?? 0) + (b[at + 5] ?? 0) * 256 + (b[at + 6] ?? 0) * 65536 + (b[at + 7] ?? 0) * 16777216;
}
// unsigned 64-bit (two words) as a decimal string, exact (16-bit limbs keep every step inside a double's 53 bits)
export function u64dec(lo: number, hi: number): string {
  let a3 = Math.floor(hi / 65536); let a2 = hi % 65536; let a1 = Math.floor(lo / 65536); let a0 = lo % 65536;
  let s = "";
  while (a3 || a2 || a1 || a0) {
    let t = a3; a3 = Math.floor(t / 10); let rm = t % 10;
    t = rm * 65536 + a2; a2 = Math.floor(t / 10); rm = t % 10;
    t = rm * 65536 + a1; a1 = Math.floor(t / 10); rm = t % 10;
    t = rm * 65536 + a0; a0 = Math.floor(t / 10); rm = t % 10;
    s = HEX[rm] + s;
  }
  return s || "0";
}
// two's-complement signed 64-bit
export function i64dec(lo: number, hi: number): string {
  if (hi < 2147483648) return u64dec(lo, hi);
  const nlo = (W32 - lo) % W32; const nhi = (W32 - 1 - hi + (lo === 0 ? 1 : 0)) % W32;
  return "-" + u64dec(nlo, nhi);
}
function hexOf(b: Uint8Array, s: number, e: number): string { let o = ""; for (let i = s; i < e; i++) { const v = b[i] ?? 0; o += HEX[v >>> 4] + HEX[v & 15]; } return o; }
function b64(b: Uint8Array, s: number, e: number): string {
  let o = ""; let i = s;
  for (; i + 2 < e; i += 3) { const v = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0); o += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63] + B64[v & 63]; }
  const r = e - i;
  if (r === 1) { const v = (b[i] ?? 0) << 16; o += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63] + "=="; }
  else if (r === 2) { const v = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8); o += B64[(v >>> 18) & 63] + B64[(v >>> 12) & 63] + B64[(v >>> 6) & 63] + "="; }
  return o;
}
// a length-delimited field's end, or -1 after fail
function lenEnd(r: Rd, end: number): number {
  vint(r); if (r.err) return -1;
  if (r.hi !== 0 || r.lo > end - r.p) { fail(r, "length past the end"); return -1; }
  return r.p + r.lo;
}
function strAt(r: Rd, end: number): string {
  const e = lenEnd(r, end); if (e < 0) return "";
  if (e - r.p > PB_MAX_STR) { fail(r, "string over 16 MB"); return ""; }
  const s = new TextDecoder("utf-8").decode(r.b.subarray(r.p, e)); r.p = e; return s;
}
function bytesHex(r: Rd, end: number): string { const e = lenEnd(r, end); if (e < 0) return ""; const s = hexOf(r.b, r.p, e); r.p = e; return s; }
function skip(r: Rd, wt: number, end: number): void {
  if (wt === 0) { vint(r); return; }
  if (wt === 1) { if (end - r.p < 8) fail(r, "truncated fixed64"); else r.p += 8; return; }
  if (wt === 2) { const e = lenEnd(r, end); if (e >= 0) r.p = e; return; }
  if (wt === 5) { if (end - r.p < 4) fail(r, "truncated fixed32"); else r.p += 4; return; }
  fail(r, "unsupported wire type " + String(wt));
}
// the next field's tag: [field, wire type]; field 0 = stop (fail set)
function tag(r: Rd): number { vint(r); if (r.err) return 0; if (r.hi !== 0 || r.lo < 8) { fail(r, "bad field tag"); return 0; } return r.lo; }
function f64(r: Rd, end: number): number {
  if (end - r.p < 8) { fail(r, "truncated fixed64"); return 0; }
  const v = new DataView(r.b.buffer, r.b.byteOffset + r.p, 8).getFloat64(0, true); r.p += 8; return v;
}
function u64At(r: Rd, end: number): string { if (end - r.p < 8) { fail(r, "truncated fixed64"); return "0"; } fixed64(r, r.p); r.p += 8; return u64dec(r.lo, r.hi); }
function u32At(r: Rd, end: number): number { if (end - r.p < 4) { fail(r, "truncated fixed32"); return 0; } const b = r.b; const p = r.p; r.p += 4; return (b[p] ?? 0) + (b[p + 1] ?? 0) * 256 + (b[p + 2] ?? 0) * 65536 + (b[p + 3] ?? 0) * 16777216; }
function dbl(v: number): string { return v !== v ? "\"NaN\"" : v === Infinity ? "\"Infinity\"" : v === -Infinity ? "\"-Infinity\"" : JSON.stringify(v); }

// AnyValue → its JSON object; oneof: the last field set wins
function anyValue(r: Rd, end: number): string {
  r.depth += 1;
  if (r.depth > PB_MAX_DEPTH) { fail(r, "values nested deeper than " + String(PB_MAX_DEPTH)); return "{}"; }
  let out = "{}";
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 2) out = "{\"stringValue\":" + JSON.stringify(strAt(r, end)) + "}";
    else if (f === 2 && wt === 0) { vint(r); out = "{\"boolValue\":" + (r.lo !== 0 || r.hi !== 0 ? "true" : "false") + "}"; }
    else if (f === 3 && wt === 0) { vint(r); out = "{\"intValue\":\"" + i64dec(r.lo, r.hi) + "\"}"; }
    else if (f === 4 && wt === 1) out = "{\"doubleValue\":" + dbl(f64(r, end)) + "}";
    else if (f === 5 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) out = "{\"arrayValue\":{\"values\":[" + values(r, e).join(",") + "]}}"; }
    else if (f === 6 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) out = "{\"kvlistValue\":{\"values\":[" + kvs(r, e, 1).join(",") + "]}}"; }
    else if (f === 7 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { out = "{\"bytesValue\":\"" + b64(r.b, r.p, e) + "\"}"; r.p = e; } }
    else skip(r, wt, end);
  }
  r.depth--;
  return out;
}
// ArrayValue.values (field 1)
function values(r: Rd, end: number): string[] {
  const out: string[] = [];
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { out.push(anyValue(r, e)); r.p = e; } }
    else skip(r, wt, end);
  }
  return out;
}
function keyValue(r: Rd, end: number): string {
  let k = ""; let v = "{}";
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 2) k = strAt(r, end);
    else if (f === 2 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { v = anyValue(r, e); r.p = e; } }
    else skip(r, wt, end);
  }
  return "{\"key\":" + JSON.stringify(k) + ",\"value\":" + v + "}";
}
// the repeated KeyValue at field number fld of the message in [r.p, end); other fields are skipped
function kvs(r: Rd, end: number, fld: number): string[] {
  const out: string[] = [];
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === fld && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { out.push(keyValue(r, e)); r.p = e; } }
    else skip(r, wt, end);
  }
  return out;
}
// Resource {1 attributes, 2 dropped_attributes_count}
function resource(r: Rd, end: number): string {
  const a: string[] = []; let dropped = 0;
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { a.push(keyValue(r, e)); r.p = e; } }
    else if (f === 2 && wt === 0) { vint(r); dropped = r.lo; }
    else skip(r, wt, end);
  }
  return "{\"attributes\":[" + a.join(",") + "]" + (dropped ? ",\"droppedAttributesCount\":" + String(dropped) : "") + "}";
}
// InstrumentationScope {1 name, 2 version, 3 attributes, 4 dropped_attributes_count}
function scope(r: Rd, end: number): string {
  let name = ""; let ver = ""; const a: string[] = []; let dropped = 0;
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 2) name = strAt(r, end);
    else if (f === 2 && wt === 2) ver = strAt(r, end);
    else if (f === 3 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { a.push(keyValue(r, e)); r.p = e; } }
    else if (f === 4 && wt === 0) { vint(r); dropped = r.lo; }
    else skip(r, wt, end);
  }
  let s = "{\"name\":" + JSON.stringify(name) + (ver ? ",\"version\":" + JSON.stringify(ver) : "");
  if (a.length) s += ",\"attributes\":[" + a.join(",") + "]";
  return s + (dropped ? ",\"droppedAttributesCount\":" + String(dropped) : "") + "}";
}
// Span.Event {1 time_unix_nano, 2 name, 3 attributes, 4 dropped_attributes_count}
function event(r: Rd, end: number): string {
  let ts = "0"; let name = ""; const a: string[] = []; let dropped = 0;
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 1) ts = u64At(r, end);
    else if (f === 2 && wt === 2) name = strAt(r, end);
    else if (f === 3 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { a.push(keyValue(r, e)); r.p = e; } }
    else if (f === 4 && wt === 0) { vint(r); dropped = r.lo; }
    else skip(r, wt, end);
  }
  return "{\"timeUnixNano\":\"" + ts + "\",\"name\":" + JSON.stringify(name) + ",\"attributes\":[" + a.join(",") + "]" + (dropped ? ",\"droppedAttributesCount\":" + String(dropped) : "") + "}";
}
// Status {2 message, 3 code}
function status(r: Rd, end: number): string {
  let msg = ""; let code = 0;
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 2 && wt === 2) msg = strAt(r, end);
    else if (f === 3 && wt === 0) { vint(r); code = r.lo; }
    else skip(r, wt, end);
  }
  return "{" + (code ? "\"code\":" + String(code) : "") + (msg ? (code ? "," : "") + "\"message\":" + JSON.stringify(msg) : "") + "}";
}
// Span {1 trace_id, 2 span_id, 3 trace_state, 4 parent_span_id, 16 flags, 5 name, 6 kind, 7 start, 8 end, 9 attributes,
// 10 dropped_attributes_count, 11 events, 12 dropped_events_count, 13 links (skipped), 14 dropped_links_count, 15 status}
function span(r: Rd, end: number): string {
  let tid = ""; let sid = ""; let tstate = ""; let pid = ""; let flags = 0; let name = ""; let kind = 0; let t0 = "0"; let t1 = "0";
  const a: string[] = []; let da = 0; const ev: string[] = []; let de = 0; let dl = 0; let st = "";
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 2) tid = bytesHex(r, end);
    else if (f === 2 && wt === 2) sid = bytesHex(r, end);
    else if (f === 3 && wt === 2) tstate = strAt(r, end);
    else if (f === 4 && wt === 2) pid = bytesHex(r, end);
    else if (f === 16 && wt === 5) flags = u32At(r, end);
    else if (f === 5 && wt === 2) name = strAt(r, end);
    else if (f === 6 && wt === 0) { vint(r); kind = r.lo; }
    else if (f === 7 && wt === 1) t0 = u64At(r, end);
    else if (f === 8 && wt === 1) t1 = u64At(r, end);
    else if (f === 9 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { a.push(keyValue(r, e)); r.p = e; } }
    else if (f === 10 && wt === 0) { vint(r); da = r.lo; }
    else if (f === 11 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { ev.push(event(r, e)); r.p = e; } }
    else if (f === 12 && wt === 0) { vint(r); de = r.lo; }
    else if (f === 14 && wt === 0) { vint(r); dl = r.lo; }
    else if (f === 15 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { st = status(r, e); r.p = e; } }
    else skip(r, wt, end);
  }
  let s = "{\"traceId\":\"" + tid + "\",\"spanId\":\"" + sid + "\"";
  if (tstate) s += ",\"traceState\":" + JSON.stringify(tstate);
  if (pid) s += ",\"parentSpanId\":\"" + pid + "\"";
  if (flags) s += ",\"flags\":" + String(flags);
  s += ",\"name\":" + JSON.stringify(name) + (kind ? ",\"kind\":" + String(kind) : "");
  s += ",\"startTimeUnixNano\":\"" + t0 + "\",\"endTimeUnixNano\":\"" + t1 + "\",\"attributes\":[" + a.join(",") + "]";
  if (da) s += ",\"droppedAttributesCount\":" + String(da);
  if (ev.length) s += ",\"events\":[" + ev.join(",") + "]";
  if (de) s += ",\"droppedEventsCount\":" + String(de);
  if (dl) s += ",\"droppedLinksCount\":" + String(dl);
  if (st && st !== "{}") s += ",\"status\":" + st;
  return s + "}";
}
// LogRecord {1 time, 11 observed, 2 severity_number, 3 severity_text, 12 event_name, 5 body, 6 attributes,
// 7 dropped_attributes_count, 8 flags, 9 trace_id, 10 span_id}
function logRecord(r: Rd, end: number): string {
  let ts = ""; let obs = ""; let sev = 0; let sevT = ""; let ev = ""; let body = ""; const a: string[] = []; let da = 0; let flags = 0; let tid = ""; let sid = "";
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 1) ts = u64At(r, end);
    else if (f === 11 && wt === 1) obs = u64At(r, end);
    else if (f === 2 && wt === 0) { vint(r); sev = r.lo; }
    else if (f === 3 && wt === 2) sevT = strAt(r, end);
    else if (f === 12 && wt === 2) ev = strAt(r, end);
    else if (f === 5 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { body = anyValue(r, e); r.p = e; } }
    else if (f === 6 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { a.push(keyValue(r, e)); r.p = e; } }
    else if (f === 7 && wt === 0) { vint(r); da = r.lo; }
    else if (f === 8 && wt === 5) flags = u32At(r, end);
    else if (f === 9 && wt === 2) tid = bytesHex(r, end);
    else if (f === 10 && wt === 2) sid = bytesHex(r, end);
    else skip(r, wt, end);
  }
  const p: string[] = [];
  if (ts) p.push("\"timeUnixNano\":\"" + ts + "\"");
  if (obs) p.push("\"observedTimeUnixNano\":\"" + obs + "\"");
  if (sev) p.push("\"severityNumber\":" + String(sev));
  if (sevT) p.push("\"severityText\":" + JSON.stringify(sevT));
  if (ev) p.push("\"eventName\":" + JSON.stringify(ev));
  if (body) p.push("\"body\":" + body);
  p.push("\"attributes\":[" + a.join(",") + "]");
  if (da) p.push("\"droppedAttributesCount\":" + String(da));
  if (flags) p.push("\"flags\":" + String(flags));
  if (tid) p.push("\"traceId\":\"" + tid + "\"");
  if (sid) p.push("\"spanId\":\"" + sid + "\"");
  return "{" + p.join(",") + "}";
}
// Scope{Spans|Logs} {1 scope, 2 spans | log_records, 3 schema_url}
function scoped(r: Rd, end: number, logs: boolean): string {
  let sc = ""; const items: string[] = []; let url = "";
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { sc = scope(r, e); r.p = e; } }
    else if (f === 2 && wt === 2) {
      const e = lenEnd(r, end); if (e < 0) break;
      r.n += 1;
      if (r.n > r.cap) { fail(r, "more than " + String(r.cap) + (logs ? " log records" : " spans")); break; }
      items.push(logs ? logRecord(r, e) : span(r, e)); r.p = e;
    }
    else if (f === 3 && wt === 2) url = strAt(r, end);
    else skip(r, wt, end);
  }
  return "{" + (sc ? "\"scope\":" + sc + "," : "") + "\"" + (logs ? "logRecords" : "spans") + "\":[" + items.join(",") + "]" + (url ? ",\"schemaUrl\":" + JSON.stringify(url) : "") + "}";
}
// Resource{Spans|Logs} {1 resource, 2 scope_spans | scope_logs, 3 schema_url}
function resourced(r: Rd, end: number, logs: boolean): string {
  let res = ""; const sc: string[] = []; let url = "";
  while (r.p < end && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { res = resource(r, e); r.p = e; } }
    else if (f === 2 && wt === 2) { const e = lenEnd(r, end); if (e >= 0) { sc.push(scoped(r, e, logs)); r.p = e; } }
    else if (f === 3 && wt === 2) url = strAt(r, end);
    else skip(r, wt, end);
  }
  return "{\"resource\":" + (res || "{\"attributes\":[]}") + ",\"" + (logs ? "scopeLogs" : "scopeSpans") + "\":[" + sc.join(",") + "]" + (url ? ",\"schemaUrl\":" + JSON.stringify(url) : "") + "}";
}
function request(b: Uint8Array, cap: number, logs: boolean): { json: string; n: number; err: string } {
  const r: Rd = { b, p: 0, err: "", lo: 0, hi: 0, depth: 0, n: 0, cap };
  const rs: string[] = [];
  while (r.p < b.length && !r.err) {
    const t = tag(r); const f = Math.floor(t / 8); const wt = t % 8;
    if (f === 1 && wt === 2) { const e = lenEnd(r, b.length); if (e >= 0) { rs.push(resourced(r, e, logs)); r.p = e; } }
    else skip(r, wt, b.length);
  }
  if (r.err) return { json: "", n: r.n, err: r.err };
  return { json: "{\"" + (logs ? "resourceLogs" : "resourceSpans") + "\":[" + rs.join(",") + "]}", n: r.n, err: "" };
}
export function decodeTraces(b: Uint8Array, cap: number = 20000): { json: string; spans: number; err: string } { const o = request(b, cap, false); return { json: o.json, spans: o.n, err: o.err }; }
export function decodeLogs(b: Uint8Array, cap: number = 20000): { json: string; records: number; err: string } { const o = request(b, cap, true); return { json: o.json, records: o.n, err: o.err }; }
// the empty Export…ServiceResponse in protobuf is zero bytes; a partial success is field 1 {1 rejected (int64), 2 message}
export function partialPb(rejected: number, msg: string): Uint8Array {
  const m = new TextEncoder().encode(msg);
  const inner: number[] = [];
  const varint = (o: number[], v: number): void => { let x = v; while (x >= 128) { o.push((x % 128) | 128); x = Math.floor(x / 128); } o.push(x); };
  inner.push(8); varint(inner, rejected);
  inner.push(18); varint(inner, m.length); for (let i = 0; i < m.length; i++) inner.push(m[i] ?? 0);
  const out: number[] = [10]; varint(out, inner.length);
  return new Uint8Array(out.concat(inner));
}
