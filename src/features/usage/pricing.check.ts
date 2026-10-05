// agentglass — self-check for model id normalisation (Bedrock/Vertex → list rows): scriptc build src/features/usage/pricing.check.ts -o pc && ./pc
// SPDX-License-Identifier: Apache-2.0
import { price, normModel, resolve, loadUser, setGateway, readUserFile, PRICES_FILE, type Price } from "./pricing.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const base = price("claude-sonnet-4-5");
ok("base priced", !!base, "null");
for (const id of ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic.claude-sonnet-4-5-20250929-v1:0", "apac.anthropic.claude-sonnet-4-5-v2",
  "claude-sonnet-4-5@20250929", "arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"]) {
  const p = price(id); ok("same row " + id, !!p && !!base && p.p === base.p, normModel(id));
}
ok("plain ids unchanged", normModel("gpt-5.1-codex") === "gpt-5.1-codex", normModel("gpt-5.1-codex"));
ok("non-bedrock -vN kept", normModel("deepseek-v3") === "deepseek-v3", normModel("deepseek-v3"));
ok("unknown stays unknown", price("us.anthropic.nope-v1:0") === null, "priced");
// ── the layered resolver: user price > user alias > gateway (its provider only) > community > built-in ──
const row = (p: string, i: number, o: number): Price => ({ p, i, o, cr: -1, cw: -1, cw1: -1 });
// before any user layer: today's results (parity)
const g31 = resolve("gemini-3.1-pro-preview", ""); ok("gemini preview → base", !!g31 && g31.key === "gemini-3.1-pro" && g31.src === "built-in", g31 ? g31.key : "null");
ok("gemini -image unpriced", resolve("gemini-3.1-pro-image", "") === null, "priced");
ok("gemini -lite is not its base", resolve("gemini-3.8-flash-lite", "") === null, "priced");
const fl = resolve("gemini-3.5-flash-lite", ""); ok("gemini lite row", !!fl && fl.key === "gemini-3.5-flash-lite", fl ? fl.key : "null");
const t = resolve("gemini-3.1-pro-preview>200k", ""); ok("tier row", !!t && t.key === "gemini-3.1-pro>200k", t ? t.key : "null");
const t2 = resolve("gemini-3.5-flash>200k", ""); ok("no tier row → base", !!t2 && t2.key === "gemini-3.5-flash", t2 ? t2.key : "null");
const t3 = resolve("gemini-3.8-flash@2027", ""); ok("2027 row", !!t3 && t3.key === "gemini-3.8-flash@2027", t3 ? t3.key : "null");
const t4 = resolve("?gemini-2.5-flash-image", ""); ok("old ? key stays unpriced", t4 === null, t4 ? t4.key : "null");
ok("codex unpriced", resolve("gpt-6.1-sol", "") === null, "priced");
// layers
setGateway(new Map<string, Price[]>([["cliproxy", [row("claude-sonnet-5-5", 7, 70), row("gpt-6-sol", 1, 8)]]]));
const gw = resolve("claude-sonnet-5-5", "cliproxy"); ok("gateway for its provider", !!gw && gw.src === "gateway" && gw.p.i === 7 && gw.via === "cliproxy", gw ? gw.src : "null");
const bi = resolve("claude-sonnet-5-5", ""); ok("gateway not elsewhere", !bi || bi.src !== "gateway", bi ? bi.src : "null");
ok("gateway exact id only", resolve("gpt-6-sol-mini", "cliproxy") === null, "priced");
const w = loadUser(JSON.parse('{"gpt-6.1-sol":{"input":1.25,"output":10},"codex-auto-review":{"alias":"gpt-6.1-sol"},"x":{"alias":"codex-auto-review"},"y":{"alias":"nope-model"},"kiroCreditUsd":0.04,"bad":{"foo":1}}'));
ok("one warning (bad)", w.length === 1 && w[0] === "bad: needs input+output or alias", w.join("|"));
const u = resolve("gpt-6.1-sol", ""); ok("user price", !!u && u.src === "user" && u.p.o === 10, u ? u.src : "null");
const a = resolve("codex-auto-review", ""); ok("alias", !!a && a.src === "alias" && a.via === "gpt-6.1-sol" && a.p.i === 1.25, a ? a.src : "null");
ok("alias does not chain", resolve("x", "") === null, "priced");
ok("alias to unpriced → unpriced", resolve("y", "") === null, "priced");
const ag = resolve("codex-auto-review", "cliproxy"); ok("user alias beats gateway", !!ag && ag.src === "alias", ag ? ag.src : "null");
const w2 = loadUser(JSON.parse('{"gpt-6.1-sol":{"input":1,"output":2,"alias":"claude-opus-4"},"gpt-z":{"alias":"gpt-6-sol"}}'));
ok("price+alias warns", w2.length === 1 && w2[0] === "gpt-6.1-sol: has input and alias — using the price", w2.join("|"));
const pa = resolve("gpt-6.1-sol", ""); ok("price wins over its own alias", !!pa && pa.src === "user" && pa.p.i === 1, pa ? pa.src : "null");
const ga = resolve("gpt-z", "cliproxy"); ok("alias target via the gateway of the booking's provider", !!ga && ga.src === "alias" && ga.p.i === 1, ga ? ga.src : "null");
ok("alias target gateway is scoped", resolve("gpt-z", "") === null, "priced");
loadUser(JSON.parse('{"gemini-3.1-pro":{"input":1,"output":2}}'));
const ut = resolve("gemini-3.1-pro-preview>200k", ""); ok("user price replaces tiers", !!ut && ut.src === "user" && ut.p.i === 1, ut ? ut.key : "null");
loadUser(JSON.parse('{"gemini-2.5-pro>200k":{"input":3,"output":30}}'));
const ut2 = resolve("gemini-2.5-pro>200k", ""); ok("user tier row alone applies", !!ut2 && ut2.p.i === 3, ut2 ? ut2.key : "null");
loadUser(null); setGateway(new Map<string, Price[]>());
ok("price() wrapper", price("claude-sonnet-4-5") !== null, "null");
ok("AGENTGLASS_PRICES honoured", PRICES_FILE === (process.env.AGENTGLASS_PRICES || PRICES_FILE) && PRICES_FILE.endsWith(".json"), PRICES_FILE);
const rf = readUserFile("/nonexistent/prices.json"); ok("missing file: no object, no error", rf.o === null && rf.bad === "", rf.bad);
console.log(bad ? bad + " failed" : "pricing: all checks passed");
if (bad) process.exit(1);
