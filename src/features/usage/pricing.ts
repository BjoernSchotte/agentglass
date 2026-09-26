// agentglass — API-equivalent token prices ($ per million tokens) by model-id prefix, overridable via ~/.agentglass/prices.json
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { obj } from "../../util/json.ts";
import { HOME, readText } from "../../util/fs.ts";

// cr/cw < 0 = derive from input (cache read 0.1×, cache write 5m 1.25× / 1h 2×)
export interface Price { p: string; i: number; o: number; cr: number; cw: number }
const P: Price[] = [];
function add(p: string, i: number, o: number, cr: number, cw: number): void {
  for (const x of P) if (x.p === p) { x.i = i; x.o = o; x.cr = cr; x.cw = cw; return; }
  P.push({ p, i, o, cr, cw });
}
add("claude-fable-5-1", 10, 50, 0.25, -1); add("claude-fable-5", 10, 50, -1, -1); add("claude-mythos-5-1", 10, 50, -1, -1);
add("claude-opus-5-5", 4, 20, 0.2, -1); add("claude-opus-5", 5, 25, -1, -1);
for (const v of ["4-8", "4-7", "4-6", "4-5"]) add("claude-opus-" + v, 5, 25, -1, -1);
add("claude-opus-4-1", 15, 75, -1, -1); add("claude-opus-4", 15, 75, -1, -1);
add("claude-sonnet-5", 2, 10, -1, -1);
for (const v of ["4-6", "4-5", "4"]) add("claude-sonnet-" + v, 3, 15, -1, -1);
add("claude-3-7-sonnet", 3, 15, -1, -1); add("claude-haiku-4-5", 1, 5, -1, -1); add("claude-3-5-haiku", 0.8, 4, -1, -1);

function num(v: unknown, d: number): number { return typeof v === "number" ? (v as number) : d; }
// user table: {"<model-prefix>": {"input": n, "output": n, "cacheRead": n, "cacheWrite": n}} — read once, ignored if missing/invalid
const user = obj((() => { try { return JSON.parse(readText(join(HOME, ".agentglass", "prices.json"), 0, 262144)); } catch (e) { return null; } })());
if (user) for (const k of Object.keys(user)) {
  const r = obj(user[k]);
  if (r && typeof r["input"] === "number") add(k.toLowerCase(), num(r["input"], 0), num(r["output"], 0), num(r["cacheRead"], -1), num(r["cacheWrite"], -1));
}
P.sort((a, b) => b.p.length - a.p.length); // longest prefix wins (opus-4-1 before opus-4)

const memo = new Map<string, Price | null>();
export function price(model: string): Price | null {
  const hit = memo.get(model);
  if (hit !== undefined) return hit;
  let m = model.toLowerCase();
  const sl = m.lastIndexOf("/"); if (sl >= 0) m = m.slice(sl + 1); // provider/model ids from proxies
  m = m.replace(/-\d{8}$/, "");
  let r: Price | null = null;
  for (const x of P) if (m.startsWith(x.p)) { r = x; break; }
  memo.set(model, r);
  return r;
}
// ≈USD for one usage record; w5/w1 = cache writes with 5-minute / 1-hour TTL
export function cost(p: Price, inp: number, out: number, cr: number, w5: number, w1: number): number {
  const rr = p.cr >= 0 ? p.cr : p.i * 0.1;
  const r5 = p.cw >= 0 ? p.cw : p.i * 1.25;
  const r1 = p.cw >= 0 ? p.cw : p.i * 2;
  return (inp * p.i + out * p.o + cr * rr + w5 * r5 + w1 * r1) / 1e6;
}
