// agentglass — self-check for the MCP JSON-RPC core (framing, versions, parse, sync methods, fuzz):
//   scriptc build src/mcp/rpc.check.ts -o rc && ./rc
// SPDX-License-Identifier: Apache-2.0
import { type Obj } from "../util/json.ts";
import { VERSIONS, MAX_LINE, CONTRACT, negotiate, structured, annotated, newFramer, push, parse, ok as okLine, fail, note, newConn, answer, type Msg, type Conn, type Reply, type Frame } from "./rpc.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got.slice(0, 300)); } }
const B = (s: string): Uint8Array => new TextEncoder().encode(s);
function filled(n: number, c: number): Uint8Array { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = c; return b; }
function lines(fs: Frame[]): string { return JSON.stringify(fs.map((f) => (f.oversize ? "<oversize>" : f.line))); }

// ── framing ──
{
  const f = newFramer();
  const a = push(f, B("{\"a\":1}\n{\"b\""));
  const b = push(f, B(":2}\n"));
  ok("split line", lines(a.concat(b)) === "[\"{\\\"a\\\":1}\",\"{\\\"b\\\":2}\"]", lines(a.concat(b)));
}
{
  const f = newFramer();
  const a = push(f, new Uint8Array([0x61, 0xc3]));
  const b = push(f, new Uint8Array([0xbc, 0x62, 0x0a]));
  ok("split utf-8", a.length === 0 && b.length === 1 && (b[0]?.line ?? "") === "aüb", lines(a.concat(b)));
}
{
  const f = newFramer();
  const r = push(f, B("x\r\n\n\n  \ny\n"));
  ok("crlf and empty lines", lines(r) === "[\"x\",\"y\"]", lines(r));
  const p = push(f, B("pending"));
  ok("no final newline stays pending", p.length === 0, lines(p));
  const q = push(f, B("\n"));
  ok("pending completes", lines(q) === "[\"pending\"]", lines(q));
}
{
  const f = newFramer();
  const big = filled(MAX_LINE + 1, 0x61);
  let r = push(f, big.subarray(0, 1 << 20));
  for (let i = 1 << 20; i < big.length; i += 1 << 20) r = r.concat(push(f, big.subarray(i, Math.min(big.length, i + (1 << 20)))));
  r = r.concat(push(f, B("\n{\"ok\":1}\n")));
  ok("oversize line dropped", lines(r) === "[\"<oversize>\",\"{\\\"ok\\\":1}\"]", lines(r));
  const f2 = newFramer(); const one = filled(MAX_LINE + 2, 0x62); one[MAX_LINE + 1] = 10;
  const r2 = push(f2, one).concat(push(f2, B("z\n")));
  ok("oversize line in one chunk", lines(r2) === "[\"<oversize>\",\"z\"]", lines(r2));
  const f3 = newFramer(); const fit = filled(MAX_LINE + 1, 0x63); fit[MAX_LINE] = 10;
  const r3 = push(f3, fit);
  ok("a line of exactly MAX_LINE fits", r3.length === 1 && !(r3[0]?.oversize ?? true) && (r3[0] ? (r3[0] as Frame).line.length : 0) === MAX_LINE, String(r3.length));
}

// ── versions ──
for (const v of VERSIONS) ok("negotiate " + v, negotiate(v) === v, negotiate(v));
ok("negotiate unknown", negotiate("2023-01-01") === "2025-11-25", negotiate("2023-01-01"));
ok("negotiate empty", negotiate("") === "2025-11-25", negotiate(""));
ok("structured 2025-06-18", structured("2025-06-18"), "");
ok("structured 2025-11-25", structured("2025-11-25"), "");
ok("not structured 2025-03-26", !structured("2025-03-26"), "");
ok("annotated 2025-03-26", annotated("2025-03-26"), "");
ok("not annotated 2024-11-05", !annotated("2024-11-05"), "");

// ── parse ──
const P = (l: string, v: string): string => JSON.stringify(parse(l, v).map((m: Msg) => [m.kind, m.id, m.method, m.why]));
ok("request", P("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}", "") === "[[\"request\",\"1\",\"ping\",\"\"]]", P("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}", ""));
ok("string id", P("{\"jsonrpc\":\"2.0\",\"id\":\"a\\\"b\",\"method\":\"ping\"}", "") === JSON.stringify([["request", "\"a\\\"b\"", "ping", ""]]), P("{\"jsonrpc\":\"2.0\",\"id\":\"a\\\"b\",\"method\":\"ping\"}", ""));
ok("null id", P("{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}", "") === "[[\"request\",\"null\",\"ping\",\"\"]]", P("{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"ping\"}", ""));
ok("notification", P("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}", "") === "[[\"notification\",\"\",\"notifications/initialized\",\"\"]]", P("{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}", ""));
ok("response", P("{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}", "") === "[[\"response\",\"3\",\"\",\"\"]]", P("{\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}", ""));
ok("parse error", P("{nope", "") === "[[\"invalid\",\"\",\"\",\"parse error\"]]", P("{nope", ""));
ok("not an object", (parse("42", "")[0]?.kind ?? "") === "invalid", P("42", ""));
ok("jsonrpc 1.0", (parse("{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"ping\"}", "")[0]?.kind ?? "") === "invalid", P("{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"ping\"}", ""));
ok("invalid keeps id", (parse("{\"jsonrpc\":\"1.0\",\"id\":7,\"method\":\"ping\"}", "")[0]?.id ?? "") === "7", P("{\"jsonrpc\":\"1.0\",\"id\":7,\"method\":\"ping\"}", ""));
ok("params not an object", (parse("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":[1]}", "")[0]?.kind ?? "") === "invalid", "");
ok("id an object", (parse("{\"jsonrpc\":\"2.0\",\"id\":{},\"method\":\"ping\"}", "")[0]?.kind ?? "") === "invalid", "");
const batch = "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"},{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}]";
ok("batch refused 2025-06-18", P(batch, "2025-06-18") === "[[\"invalid\",\"\",\"\",\"batch not supported\"]]", P(batch, "2025-06-18"));
ok("batch 2025-03-26", parse(batch, "2025-03-26").length === 2 && (parse(batch, "2025-03-26")[0]?.kind ?? "") === "request", P(batch, "2025-03-26"));
ok("empty batch", (parse("[]", "2025-03-26")[0]?.kind ?? "") === "invalid", P("[]", "2025-03-26"));
const pm = parse("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"x\"}}", "")[0];
ok("params", pm !== undefined && pm.params["name"] === "x", JSON.stringify(pm ? pm.params : null));

// ── lines ──
ok("ok line", okLine("1", { a: 1 }) === "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"a\":1}}", okLine("1", { a: 1 }));
ok("fail null id", fail("", -32700, "Parse error") === "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"Parse error\"}}", fail("", -32700, "Parse error"));
ok("note", note("notifications/progress", { progress: 2 }) === "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{\"progress\":2}}", note("notifications/progress", { progress: 2 }));

// ── answer ──
const tl = (v: string): Obj => ({ tools: [], v });
const ins = (c: Conn): string => "instructions for " + c.scopeName;
function one(c: Conn, l: string): Reply { const m = parse(l, c.version)[0]; return m ? answer(c, m, tl, ins, "9.9.9") : { handled: true, lines: [] }; }
{
  const c = newConn(); c.scopeName = "project";
  const p0 = one(c, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}");
  ok("ping before initialize", p0.handled && p0.lines.join() === "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}", p0.lines.join());
  const t0 = one(c, "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}");
  ok("tools/list before initialize", (t0.lines[0] ?? "").indexOf("-32600") > 0, t0.lines.join());
  const call0 = one(c, "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"session\"}}");
  ok("tools/call before initialize", call0.handled && (call0.lines[0] ?? "").indexOf("-32600") > 0, call0.lines.join());
  const i = one(c, "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"gemini-cli\",\"version\":\"1\"}}}");
  const r = JSON.parse(i.lines[0] ?? "{}") as Obj; const res = (r["result"] ?? {}) as Obj;
  const caps = (res["capabilities"] ?? {}) as Obj; const tools = (caps["tools"] ?? {}) as Obj; const si = (res["serverInfo"] ?? {}) as Obj; const meta = (res["_meta"] ?? {}) as Obj;
  ok("initialize version", res["protocolVersion"] === "2025-06-18" && c.version === "2025-06-18" && c.init, i.lines.join());
  ok("initialize caps", tools["listChanged"] === false, JSON.stringify(caps));
  ok("initialize serverInfo", si["name"] === "agentglass" && si["version"] === "9.9.9", JSON.stringify(si));
  ok("initialize contract", meta["agentglass/contract"] === CONTRACT && CONTRACT === 1, JSON.stringify(meta));
  ok("initialize instructions", res["instructions"] === "instructions for project" && String(res["instructions"]).length <= 600, String(res["instructions"]));
  ok("client name", c.client === "gemini-cli", c.client);
  const n = one(c, "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}");
  ok("initialized: no lines", n.handled && n.lines.length === 0, n.lines.join());
  const u = one(c, "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"resources/list\"}");
  ok("unknown method", (u.lines[0] ?? "").indexOf("-32601") > 0, u.lines.join());
  const un = one(c, "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/whatever\"}");
  ok("unknown notification: no lines", un.handled && un.lines.length === 0, un.lines.join());
  const tl2 = one(c, "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/list\"}");
  ok("tools/list", tl2.lines.join() === "{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{\"tools\":[],\"v\":\"2025-06-18\"}}", tl2.lines.join());
  const call = one(c, "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"session\"}}");
  ok("tools/call not handled", !call.handled && call.lines.length === 0, call.lines.join());
  const cn = one(c, "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":6}}");
  ok("cancelled not handled", !cn.handled, "");
  const resp = one(c, "{\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{}}");
  ok("response ignored", resp.handled && resp.lines.length === 0, resp.lines.join());
  const pe = one(c, "{garbage");
  ok("parse error answered", (pe.lines[0] ?? "") === "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32700,\"message\":\"Parse error\"}}", pe.lines.join());
  const iv = one(c, "{\"jsonrpc\":\"1.0\",\"id\":8,\"method\":\"ping\"}");
  ok("invalid request keeps its id", (iv.lines[0] ?? "").indexOf("\"id\":8") > 0 && (iv.lines[0] ?? "").indexOf("-32600") > 0, iv.lines.join());
  const c2 = newConn();
  const i2 = one(c2, "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"1999-01-01\"}}");
  ok("initialize unknown version", (i2.lines[0] ?? "").indexOf("\"protocolVersion\":\"2025-11-25\"") > 0, i2.lines.join());
}

// ── fuzz: random bytes never throw ──
const FZ = { c: newConn(), f: newFramer(), thrown: "" };
function fuzzStep(b: Uint8Array): number {
  let k = 0;
  try { for (const fr of push(FZ.f, b)) for (const m of parse(fr.line, FZ.c.version)) { answer(FZ.c, m, tl, ins, "1"); k++; } } catch (e) { FZ.thrown = String(e); }
  return k;
}
{
  let seed = 12345; const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed; };
  const pieces = ["{\"jsonrpc\":\"2.0\",", "\"id\":", "\"method\":\"", "initialize", "tools/call", "\"params\":{", "}", "]", "[", "\n", "null", "\"", "\\u00", "é"];
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    const len = rnd() % 301; const b = new Uint8Array(len);
    for (let j = 0; j < len; j++) b[j] = rnd() % 4 === 0 ? 10 : rnd() % 256;
    if (i % 3 === 0) { const e = B((pieces[rnd() % pieces.length] ?? "") + (pieces[rnd() % pieces.length] ?? "") + "\n"); const m = new Uint8Array(b.length + e.length); m.set(b, 0); m.set(e, b.length); n += fuzzStep(m); } else n += fuzzStep(b);
  }
  ok("fuzz never throws", FZ.thrown === "", FZ.thrown);
  ok("fuzz parsed something", n > 0, String(n));
}

console.log(bad ? String(bad) + " failed" : "rpc: all checks passed");
if (bad) process.exit(1);
