// agentglass — self-check for the exact fleet merge (fleet spec 13, 14): scriptc build src/features/fleet/merge.check.ts -o mc && ./mc
// SPDX-License-Identifier: Apache-2.0
// Hosts are built from fixture Claude logs the way `fleet snapshot` builds them (the real ledger, dayRows, msgrows);
// the ground truth is the real ledger reading every log of the fleet on one machine.
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { type Sess, newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { ledger, complete } from "../usage/ledger.ts";
import { forget } from "../usage/owners.ts";
import { loadUser } from "../usage/pricing.ts";
import type { Acc } from "../usage/record.ts";
import { rowsFor, ownKeys, msgHash } from "../usage/msgrows.ts";
import { type HostReport, type OwnRow, type SessRow, FORMAT, noOwned } from "./model.ts";
import { dayRows } from "./snap.ts";
import { type LocalLog, type FleetHost, type Exact, type Occ, type Shadow, exactFleet, ownerIndex, shiftDH, shadowOf } from "./merge.ts";
import "../../harness/index.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = join(HOME, "mg"); mkdirSync(dir, { recursive: true });
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "mg-cache");
const M = "claude-sonnet-4-5";
function asst(id: string, ts: string, inp: number, out: number, cr: number, cw: number): string {
  return "{\"type\":\"assistant\",\"timestamp\":\"" + ts + "\",\"requestId\":\"req_" + id + "\",\"message\":{\"id\":\"" + id + "\",\"model\":\"" + M + "\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"usage\":{\"input_tokens\":" + String(inp) + ",\"output_tokens\":" + String(out) + ",\"cache_read_input_tokens\":" + String(cr) + ",\"cache_creation_input_tokens\":" + String(cw) + "}}}";
}
const T = ["2026-09-01T10:00:00.000Z", "2026-09-01T10:05:00.000Z", "2026-09-01T11:00:00.000Z", "2026-09-02T09:00:00.000Z", "2026-09-03T09:00:00.000Z"];
// m1..m4 usage; a copy has the same usage under the same id
const U: number[][] = [[100, 10, 1000, 50], [200, 20, 2000, 60], [300, 30, 3000, 70], [400, 40, 4000, 80]];
function msg(i: number, ts: string): string { const u = U[i - 1] ?? [0, 0, 0, 0]; return asst("m" + String(i), ts, u[0] ?? 0, u[1] ?? 0, u[2] ?? 0, u[3] ?? 0); }
function put(name: string, lines: string[]): string { const p = join(dir, name + ".jsonl"); writeFileSync(p, lines.join("\n") + "\n"); return p; }
function sess(path: string): Sess {
  const s = newSess("claude", path.slice(path.lastIndexOf("/") + 1, -6), path, false); sessions.set(path, s);
  s.size = statSync(path).size; s.mtime = Date.now(); return s;
}
function reset(): void { sessions.clear(); ledger.clear(); forget(); }
function allDays(a: Acc): Set<string> { const o = new Set<string>(); for (const k of a.days.keys()) o.add(k); return o; }
// a host as its snapshot would carry it: one session per log, its days and owned rows
function hostOf(name: string, hostId: string, paths: string[]): FleetHost {
  reset(); for (const p of paths) complete(sess(p));
  const ss: SessRow[] = []; const owned = noOwned();
  for (const p of paths) {
    const a = ledger.get(p); if (!a) continue;
    const r = rowsFor(p, "claude", a); ok(name + ": rows ok", r.ok, p);
    const key = "claude:" + p.slice(p.lastIndexOf("/") + 1, -6);
    ss.push({ s: { harness: "claude", id: key.slice(7), billing: { mode: "api" } }, key, days: dayRows([a], allDays(a)), own: r.rows, prov: [] });
    owned.push({ key, rows: r.rows });
  }
  const rep: HostReport = { hello: { format: FORMAT, version: "x", hostId, hostName: name, os: "linux", tzOffsetMin: 0, redact: false, days: 7, now: 0, priceSig: "" }, sessions: ss, cost: null, allowance: null, live: null, exact: true, owned };
  return { name, hostId, r: rep, shiftMin: 0 };
}
interface Tot { tok: number[]; cost: number }
function totOf(accs: Acc[]): Tot { const t = [0, 0, 0, 0]; let c = 0; for (const a of accs) { t[0] = (t[0] ?? 0) + a.inTok; t[1] = (t[1] ?? 0) + a.outTok; t[2] = (t[2] ?? 0) + a.cr; t[3] = (t[3] ?? 0) + a.cw; c += a.cost; } return { tok: t, cost: c }; }
// the truth: every path on one machine
function truth(paths: string[]): Tot { reset(); for (const p of paths) complete(sess(p)); const as: Acc[] = []; for (const p of paths) { const a = ledger.get(p); if (a) as.push(a); } return totOf(as); }
// local logs indexed in the (reset) ledger
function localOf(paths: string[]): { logs: LocalLog[]; accs: Acc[] } {
  reset(); for (const p of paths) complete(sess(p));
  const logs: LocalLog[] = []; const accs: Acc[] = [];
  for (const p of paths) { const a = ledger.get(p); if (!a) continue; accs.push(a); logs.push({ path: p, skey: "claude:" + p.slice(p.lastIndexOf("/") + 1, -6), keys: ownKeys(p, a), bill: "api" }); }
  return { logs, accs };
}
function fleet(local: { logs: LocalLog[]; accs: Acc[] }, hosts: FleetHost[], rep: boolean): { t: Tot; x: Exact } {
  const x = exactFleet(local.logs, "ffffffffffffffff", hosts, rep, (p: string): OwnRow[] | null => { const a = ledger.get(p); return a ? rowsFor(p, "claude", a).rows : null; });
  const as: Acc[] = local.accs.slice(); for (const s of x.accs) as.push(s.a);
  return { t: totOf(as), x };
}
function of(x: Exact, host: string): Shadow | null { for (const s of x.accs) if (s.host === host) return s; return null; }
function same(a: Tot, b: Tot): boolean { return JSON.stringify(a.tok) === JSON.stringify(b.tok) && Math.abs(a.cost - b.cost) < 1e-9; }
function show(t: Tot): string { return JSON.stringify(t.tok) + " $" + String(t.cost); }
const none = { logs: [] as LocalLog[], accs: [] as Acc[] };

// 1. ws holds m1..m3; vm1 holds later copies of m2, m3 under another session id, plus m4
const A = put("s1", [msg(1, T[0] ?? ""), msg(2, T[1] ?? ""), msg(3, T[2] ?? "")]);
const B = put("s9", [msg(2, T[3] ?? ""), msg(3, T[3] ?? ""), msg(4, T[4] ?? "")]);
const want = truth([A, B]);
let ws = hostOf("ws", "1111111111111111", [A]); let vm = hostOf("vm1", "2222222222222222", [B]);
let r = fleet(none, [ws, vm], false);
ok("copies later: totals equal one machine reading both", same(r.t, want), show(r.t) + " want " + show(want));
ok("copies later: removed 2", r.x.removed === 2, String(r.x.removed));
const naive = totOf([shadowOf(ws.r.sessions[0] ?? { s: {}, key: "", days: null, own: null, prov: [] }, 0), shadowOf(vm.r.sessions[0] ?? { s: {}, key: "", days: null, own: null, prov: [] }, 0)]);
ok("without the merge the copies count twice", naive.tok[0] === (want.tok[0] ?? 0) + 500, show(naive));
const vmShadow = of(r.x, "vm1");
ok("vm1's shadow keeps only m4", !!vmShadow && vmShadow.a.inTok === 400, vmShadow ? String(vmShadow.a.inTok) : "-");

// 2. swapped: vm1's copies are earlier → ws's shadow loses m2, m3; totals unchanged
const B2 = put("s9e", [msg(2, "2026-08-30T09:00:00.000Z"), msg(3, "2026-08-30T09:00:00.000Z"), msg(4, T[4] ?? "")]);
const want2 = truth([A, B2]);
vm = hostOf("vm1", "2222222222222222", [B2]); ws = hostOf("ws", "1111111111111111", [A]);
r = fleet(none, [ws, vm], false);
ok("copies earlier: totals equal the truth", same(r.t, want2), show(r.t) + " want " + show(want2));
const wsShadow = of(r.x, "ws");
ok("copies earlier: ws keeps only m1", !!wsShadow && wsShadow.a.inTok === 100, wsShadow ? String(wsShadow.a.inTok) : "-");
ok("token totals equal on a different day split too", same(r.t, want2), "");

// 3. a tie (same key): the smaller host id owns
const B3 = put("s9t", [msg(2, T[1] ?? "")]);
ws = hostOf("ws", "bbbbbbbbbbbbbbbb", [A]); vm = hostOf("vm1", "aaaaaaaaaaaaaaaa", [B3]);
r = fleet(none, [ws, vm], false);
const t3 = of(r.x, "vm1"); const w3 = of(r.x, "ws");
ok("tie: the smaller host id keeps the message", !!t3 && t3.a.inTok === 200 && !!w3 && w3.a.inTok === 400, (t3 ? String(t3.a.inTok) : "-") + " / " + (w3 ? String(w3.a.inTok) : "-"));
const occ: Occ[] = [{ host: "ws", hostId: "bbbbbbbbbbbbbbbb", key: "claude:s1", row: { h: msgHash("m2"), key: 5, d: "", hr: 0, m: "", prov: "", n: [] } }, { host: "vm1", hostId: "aaaaaaaaaaaaaaaa", key: "claude:s9t", row: { h: msgHash("m2"), key: 5, d: "", hr: 0, m: "", prov: "", n: [] } }, { host: "x", hostId: "0000000000000000", key: "z", row: { h: msgHash("m2"), key: 6, d: "", hr: 0, m: "", prov: "", n: [] } }];
ok("ownerIndex: key, then host id", (ownerIndex(occ).get(msgHash("m2"))?.host ?? "") === "vm1", ownerIndex(occ).get(msgHash("m2"))?.host ?? "-");

// 4. this machine holds a copy of m1: earlier → it keeps it, ws's shadow loses it; later → a local correction
const Lp = put("loc", [msg(1, "2026-08-29T09:00:00.000Z")]);
const want4 = truth([A, Lp]);
ws = hostOf("ws", "1111111111111111", [A]);
r = fleet(localOf([Lp]), [ws], false);
ok("local earlier copy: totals equal the truth", same(r.t, want4), show(r.t) + " want " + show(want4));
const Lq = put("loc2", [msg(1, "2026-09-05T09:00:00.000Z")]);
const want5 = truth([A, Lq]);
ws = hostOf("ws", "1111111111111111", [A]);
r = fleet(localOf([Lq]), [ws], false);
ok("local later copy: corrected, totals equal the truth", same(r.t, want5) && r.x.corrected === 1, show(r.t) + " want " + show(want5) + " corrected " + String(r.x.corrected));

// 5. re-pricing: a price set on this machine prices every host's table-priced usage
ws = hostOf("ws", "1111111111111111", [A]); vm = hostOf("vm1", "2222222222222222", [B]);
const before = fleet(none, [ws, vm], true).t;
loadUser(JSON.parse("{\"" + M + "\":{\"input\":1000000,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"cacheWrite1h\":0}}"));
const after = fleet(none, [ws, vm], true).t;
const tokIn = (want.tok[0] ?? 0);
ok("reprice: cost = input tokens × $1/token", Math.abs(after.cost - tokIn) < 1e-6, String(after.cost) + " vs " + String(tokIn) + " (before " + String(before.cost) + ")");
const kept = fleet(none, [ws, vm], false).t;
ok("reprice off: the hosts' own figures", Math.abs(kept.cost - before.cost) < 1e-9, String(kept.cost));
loadUser(null);

// 6. time zones: a 23:30 row on a host two hours behind lands on the next day here
const sh = shiftDH("2026-09-01", 23, 120);
ok("shift 23h +2h → next day 1h", sh.d === "2026-09-02" && sh.h === 1, JSON.stringify(sh));
ok("shift back", shiftDH("2026-09-02", 1, -120).d === "2026-09-01", "");
const tz: SessRow = { s: { billing: { mode: "api" } }, key: "claude:z", days: [{ d: "2026-09-01", tp: [["23", "", M, "1", "0", "0", "0", "0", "0.5"]], hx: [] as string[][], unk: 0, um: [] as string[][], uc: 0, tools: 0, turns: 0, calls: 0, errors: 0 }], own: null, prov: [] };
const za = shadowOf(tz, 120);
ok("shadow re-bucketed", za.days.has("2026-09-02") && !za.days.has("2026-09-01") && Math.abs((za.days.get("2026-09-02")?.hc[1] ?? 0) - 0.5) < 1e-12, JSON.stringify([...za.days.keys()]));
ok("half-hour zone rounds", shiftDH("2026-09-01", 10, 330).h === 16 || shiftDH("2026-09-01", 10, 330).h === 15, String(shiftDH("2026-09-01", 10, 330).h));

// 7. three hosts and this machine, 60 messages, each copied 1–4 times across them at random times (copies are common:
// 235 k distinct ids in 423 k occurrences on one real machine): the merged totals equal one machine reading every log
let seed = 42; function rnd(n: number): number { seed = (seed * 48271) % 2147483647; return Math.floor(seed / 7) % n; } // Park–Miller: exact in doubles
for (const sd of [42, 7, 1234]) {
  seed = sd;
  const owners = ["l", "a", "b", "c"]; const logs = new Map<string, string[]>();
  for (const o of owners) for (let j = 0; j < 2; j++) logs.set(o + String(j), []);
  const base = Date.parse("2026-09-10T08:00:00.000Z");
  for (let i = 0; i < 60; i++) {
    const n = 1 + rnd(4); const used = new Set<string>();
    for (let c = 0; c < n; c++) {
      const lg = owners[rnd(4)] + String(rnd(2)); if (used.has(lg)) continue; used.add(lg);
      const ts = new Date(base + (i * 37 + rnd(5) * 3600) * 60000).toISOString(); // copies on other hours and days
      (logs.get(lg) ?? []).push(asst("r" + String(i), ts, 10 + i, 1 + rnd(50), 100 * rnd(30), rnd(3) * 50));
    }
  }
  const paths = new Map<string, string>(); for (const [k, ls] of logs) if (ls.length) paths.set(k, put("rand-" + k, ls));
  const of2 = (o: string): string[] => { const r: string[] = []; for (const [k, p] of paths) if (k.charAt(0) === o) r.push(p); return r; };
  const wantR = truth([...paths.values()]);
  const hA = hostOf("a", "aaaaaaaaaaaaaaaa", of2("a")); const hB = hostOf("b", "bbbbbbbbbbbbbbbb", of2("b")); const hC = hostOf("c", "cccccccccccccccc", of2("c"));
  r = fleet(localOf(of2("l")), [hA, hB, hC], false);
  ok("seed " + String(sd) + ": random copies on 3 hosts + here: totals equal the truth", same(r.t, wantR), show(r.t) + " want " + show(wantR));
  let nOcc = 0; for (const ls of logs.values()) nOcc += ls.length;
  ok("random copies: something was removed", r.x.removed + r.x.corrected > 0, String(r.x.removed) + "/" + String(r.x.corrected) + " occurrences " + String(nOcc) + " logs " + String(paths.size));
  // the hosts in another order: the same totals
  r = fleet(localOf(of2("l")), [hC, hA, hB], false);
  ok("host order does not matter", same(r.t, wantR), show(r.t));
}

if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("fleet merge: all checks passed");
