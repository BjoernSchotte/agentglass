// agentglass — self-check for the OTLP protobuf decoder: scriptc build src/features/hub/otlppb.check.ts -o pc && ./pc
// HUB_PB_WRITE=<dir> also writes the fixtures the receive test posts (traces.bin, traces.json, logs.bin, logs.json)
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeTraces, decodeLogs, u64dec, i64dec, partialPb } from "./otlppb.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }

// ── a minimal encoder (the check's own; the decoder never sees how bytes were made) ──
function vb(o: number[], v: number): void { let x = v; while (x >= 128) { o.push((x % 128) + 128); x = Math.floor(x / 128); } o.push(x); }
function v64(o: number[], lo: number, hi: number): void {
  let l = lo; let h = hi;
  while (h > 0 || l >= 128) { o.push((l & 0x7f) | 0x80); l = ((l >>> 7) | ((h & 0x7f) << 25)) >>> 0; h = h >>> 7; }
  o.push(l);
}
function tg(o: number[], f: number, wt: number): void { vb(o, f * 8 + wt); }
function ld(o: number[], f: number, b: number[]): void { tg(o, f, 2); vb(o, b.length); for (const x of b) o.push(x); }
function sb(s: string): number[] { const e = new TextEncoder().encode(s); const o: number[] = []; for (let i = 0; i < e.length; i++) o.push(e[i] ?? 0); return o; }
function st(o: number[], f: number, s: string): void { ld(o, f, sb(s)); }
function fx(o: number[], f: number, lo: number, hi: number): void { tg(o, f, 1); for (let i = 0; i < 4; i++) o.push(Math.floor(lo / 2 ** (8 * i)) & 255); for (let i = 0; i < 4; i++) o.push(Math.floor(hi / 2 ** (8 * i)) & 255); }
function db(o: number[], f: number, v: number): void { const b = new Uint8Array(8); new DataView(b.buffer, b.byteOffset, 8).setFloat64(0, v, true); tg(o, f, 1); for (let i = 0; i < 8; i++) o.push(b[i] ?? 0); }
function vi(o: number[], f: number, v: number): void { tg(o, f, 0); vb(o, v); }
function seq(n: number, from: number): number[] { const o: number[] = []; for (let i = 0; i < n; i++) o.push((from + i) & 255); return o; }
function anyS(s: string): number[] { const o: number[] = []; st(o, 1, s); return o; }
function kv(k: string, any: number[]): number[] { const o: number[] = []; st(o, 1, k); ld(o, 2, any); return o; }
function attrsOf(f: number, list: number[][]): number[] { const o: number[] = []; for (const a of list) ld(o, f, a); return o; }

function spanBytes(i: number, rich: boolean): number[] {
  const o: number[] = [];
  ld(o, 1, seq(16, 1)); ld(o, 2, seq(8, 32 + (i & 127))); ld(o, 4, seq(8, 200));
  st(o, 5, "chat claude-opus-4-1"); vi(o, 6, 3);
  fx(o, 7, 603127808, 416766852); fx(o, 8, 1603127808, 416766852);
  const at: number[][] = [kv("gen_ai.operation.name", anyS("chat"))];
  if (rich) {
    const b: number[] = []; vi(b, 2, 1); at.push(kv("b", b));
    const n: number[] = []; vi(n, 3, 42); at.push(kv("i", n));
    const neg: number[] = []; tg(neg, 3, 0); v64(neg, 4294967291, 4294967295); at.push(kv("neg", neg));
    const d: number[] = []; db(d, 4, 3.5); at.push(kv("d", d));
    const arrv: number[] = []; ld(arrv, 1, anyS("a")); const one: number[] = []; vi(one, 3, 1); ld(arrv, 1, one); const ar: number[] = []; ld(ar, 5, arrv); at.push(kv("arr", ar));
    const kl: number[] = []; ld(kl, 1, kv("k", anyS("v"))); const kvl: number[] = []; ld(kvl, 6, kl); at.push(kv("kv", kvl));
    const by: number[] = []; ld(by, 7, [1, 2, 3]); at.push(kv("bytes", by));
    at.push(kv("empty", []));
  }
  for (const a of at) ld(o, 9, a);
  if (rich) {
    const ev: number[] = []; fx(ev, 1, 1603127808, 416766852); st(ev, 2, "exception"); ld(ev, 3, kv("exception.message", anyS("x")));
    ld(o, 11, ev);
    const link: number[] = []; ld(link, 1, seq(16, 9)); ld(o, 13, link); // links are skipped
    vi(o, 99, 7); // an unknown field: skipped
    const s: number[] = []; st(s, 2, "boom"); vi(s, 3, 2); ld(o, 15, s);
  }
  return o;
}
function traces(n: number, rich: boolean): Uint8Array {
  const sc: number[] = []; const scope: number[] = []; st(scope, 1, "agentglass"); st(scope, 2, "2026.10.6"); ld(sc, 1, scope);
  for (let i = 0; i < n; i++) ld(sc, 2, spanBytes(i, rich && i === 0));
  const res: number[] = attrsOf(1, [kv("service.name", anyS("claude-code")), kv("host.id", anyS("0011223344556677"))]);
  const rs: number[] = []; ld(rs, 1, res); ld(rs, 2, sc);
  const req: number[] = []; ld(req, 1, rs);
  return new Uint8Array(req);
}
const TJ = "{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"claude-code\"}},{\"key\":\"host.id\",\"value\":{\"stringValue\":\"0011223344556677\"}}]},\"scopeSpans\":[{\"scope\":{\"name\":\"agentglass\",\"version\":\"2026.10.6\"},\"spans\":[" +
  "{\"traceId\":\"0102030405060708090a0b0c0d0e0f10\",\"spanId\":\"2021222324252627\",\"parentSpanId\":\"c8c9cacbcccdcecf\",\"name\":\"chat claude-opus-4-1\",\"kind\":3,\"startTimeUnixNano\":\"1790000000000000000\",\"endTimeUnixNano\":\"1790000001000000000\",\"attributes\":[" +
  "{\"key\":\"gen_ai.operation.name\",\"value\":{\"stringValue\":\"chat\"}},{\"key\":\"b\",\"value\":{\"boolValue\":true}},{\"key\":\"i\",\"value\":{\"intValue\":\"42\"}},{\"key\":\"neg\",\"value\":{\"intValue\":\"-5\"}},{\"key\":\"d\",\"value\":{\"doubleValue\":3.5}}," +
  "{\"key\":\"arr\",\"value\":{\"arrayValue\":{\"values\":[{\"stringValue\":\"a\"},{\"intValue\":\"1\"}]}}},{\"key\":\"kv\",\"value\":{\"kvlistValue\":{\"values\":[{\"key\":\"k\",\"value\":{\"stringValue\":\"v\"}}]}}},{\"key\":\"bytes\",\"value\":{\"bytesValue\":\"AQID\"}},{\"key\":\"empty\",\"value\":{}}]," +
  "\"events\":[{\"timeUnixNano\":\"1790000001000000000\",\"name\":\"exception\",\"attributes\":[{\"key\":\"exception.message\",\"value\":{\"stringValue\":\"x\"}}]}],\"status\":{\"code\":2,\"message\":\"boom\"}}]}]}]}";

function logsBytes(): Uint8Array {
  const lr: number[] = [];
  fx(lr, 1, 603127808, 416766852); fx(lr, 11, 1603127808, 416766852); vi(lr, 2, 9); st(lr, 3, "INFO"); st(lr, 12, "agentglass.heartbeat");
  ld(lr, 5, anyS("agentglass.heartbeat")); ld(lr, 6, kv("event.name", anyS("agentglass.heartbeat"))); ld(lr, 9, seq(16, 1)); ld(lr, 10, seq(8, 1));
  const sc: number[] = []; const scope: number[] = []; st(scope, 1, "agentglass"); ld(sc, 1, scope); ld(sc, 2, lr);
  const rs: number[] = []; ld(rs, 1, attrsOf(1, [kv("service.name", anyS("agentglass"))])); ld(rs, 2, sc);
  const req: number[] = []; ld(req, 1, rs);
  return new Uint8Array(req);
}
const LJ = "{\"resourceLogs\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"agentglass\"}}]},\"scopeLogs\":[{\"scope\":{\"name\":\"agentglass\"},\"logRecords\":[{\"timeUnixNano\":\"1790000000000000000\",\"observedTimeUnixNano\":\"1790000001000000000\",\"severityNumber\":9,\"severityText\":\"INFO\",\"eventName\":\"agentglass.heartbeat\",\"body\":{\"stringValue\":\"agentglass.heartbeat\"},\"attributes\":[{\"key\":\"event.name\",\"value\":{\"stringValue\":\"agentglass.heartbeat\"}}],\"traceId\":\"0102030405060708090a0b0c0d0e0f10\",\"spanId\":\"0102030405060708\"}]}]}]}";

// 64-bit decimals
ok("u64 small", u64dec(42, 0) === "42" && u64dec(0, 0) === "0", u64dec(42, 0));
ok("u64 nanos", u64dec(603127808, 416766852) === "1790000000000000000", u64dec(603127808, 416766852));
ok("u64 max", u64dec(4294967295, 4294967295) === "18446744073709551615", u64dec(4294967295, 4294967295));
ok("i64", i64dec(4294967291, 4294967295) === "-5" && i64dec(0, 2147483648) === "-9223372036854775808" && i64dec(4294967295, 2147483647) === "9223372036854775807", i64dec(0, 2147483648));

const tb = traces(1, true);
const t = decodeTraces(tb);
ok("traces decode", t.err === "" && t.spans === 1, t.err);
ok("traces JSON exact", t.json === TJ, t.json);
let parsed = false; try { JSON.parse(t.json); parsed = true; } catch (e) { parsed = false; }
ok("traces JSON parses", parsed, t.json);
const lb = logsBytes();
const l = decodeLogs(lb);
ok("logs decode", l.err === "" && l.records === 1, l.err);
ok("logs JSON exact (eventName = field 12)", l.json === LJ, l.json);
ok("empty request", decodeTraces(new Uint8Array(0)).json === "{\"resourceSpans\":[]}", decodeTraces(new Uint8Array(0)).json);

// truncation, bad wire types, false lengths, deep nesting, the record cap
let truncErr = 0; for (let n = 1; n < tb.length; n++) { const r = decodeTraces(tb.subarray(0, n)); if (r.err) truncErr++; else { try { JSON.parse(r.json); } catch (e) { ok("truncated at " + String(n) + " gives valid JSON", false, r.json); } } }
ok("truncated input → err", truncErr > tb.length / 2, String(truncErr) + " of " + String(tb.length));
ok("group wire type → err", decodeTraces(new Uint8Array([11])).err !== "", "accepted");
ok("length past the end → err", decodeTraces(new Uint8Array([10, 0xff, 0xff, 0xff, 0xff, 0x07])).err.indexOf("length") >= 0, decodeTraces(new Uint8Array([10, 0xff, 0xff, 0xff, 0xff, 0x07])).err);
ok("11-byte varint → err", decodeTraces(new Uint8Array([8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1])).err.indexOf("varint") >= 0, "accepted");
let deep: number[] = anyS("x"); for (let i = 0; i < 40; i++) { const a: number[] = []; ld(a, 1, deep); const w: number[] = []; ld(w, 5, a); deep = w; }
const dsp: number[] = []; ld(dsp, 9, kv("deep", deep)); const dsc: number[] = []; ld(dsc, 2, dsp); const drs: number[] = []; ld(drs, 2, dsc); const dreq: number[] = []; ld(dreq, 1, drs);
ok("nesting cap → err", decodeTraces(new Uint8Array(dreq)).err.indexOf("nested") >= 0, decodeTraces(new Uint8Array(dreq)).err);
ok("record cap → err", decodeTraces(traces(3, false), 2).err.indexOf("more than 2 spans") >= 0 && decodeTraces(traces(2, false), 2).err === "", decodeTraces(traces(3, false), 2).err);
ok("partial success response", partialPb(3, "x").join(",") === "10,5,8,3,18,1,120", partialPb(3, "x").join(","));

// fuzz: random bytes and mutations of valid requests never throw; always err or valid JSON
let seed = 0x9e3779b9;
function rnd(): number { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed; }
let thrown = 0; let invalid = 0;
function probe(b: Uint8Array): void {
  for (const lg of [false, true]) {
    try {
      const r = lg ? decodeLogs(b) : decodeTraces(b);
      if (!r.err) { try { JSON.parse(r.json); } catch (e) { invalid++; } }
    } catch (e) { thrown++; }
  }
}
for (let i = 0; i < 1000; i++) { const n = rnd() % 600; const b = new Uint8Array(n); for (let j = 0; j < n; j++) b[j] = rnd() & 255; probe(b); }
for (let i = 0; i < 1000; i++) { const src = i % 2 ? tb : lb; const b = new Uint8Array(src.length); for (let j = 0; j < src.length; j++) b[j] = src[j] ?? 0; const k = 1 + (rnd() % 4); for (let j = 0; j < k; j++) b[rnd() % b.length] = rnd() & 255; probe(b.subarray(0, b.length - (rnd() % 8))); }
ok("fuzz: no throw", thrown === 0, String(thrown));
ok("fuzz: no invalid JSON", invalid === 0, String(invalid));

// 20,000 spans (the receive record cap): time it
const big = traces(20000, false);
const t0 = Date.now(); const bd = decodeTraces(big); const ms = Date.now() - t0;
ok("20,000 spans", bd.err === "" && bd.spans === 20000, bd.err);
console.log("hub pb: 20,000 spans (" + String(Math.round(big.length / 1024)) + " KB) decoded in " + String(ms) + " ms");

const out = process.env["HUB_PB_WRITE"] ?? "";
if (out) { writeFileSync(join(out, "traces.bin"), tb); writeFileSync(join(out, "traces.json"), TJ + "\n"); writeFileSync(join(out, "logs.bin"), lb); writeFileSync(join(out, "logs.json"), LJ + "\n"); }
if (bad) console.log(String(bad) + " failed"); else console.log("hub pb: all checks passed");
if (bad) process.exit(1);
