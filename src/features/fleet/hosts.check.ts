// agentglass — self-check for the fleet merge: rows, freshness, duplicates, overlap, cost, budget, allowance, and that
// remote rows stay out of every local path: scriptc build src/features/fleet/hosts.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
import { newSess } from "../../model/types.ts";
import { sessions, buildView, loadHead, loadTail, isLive, FRESH } from "../../model/sessions.ts";
import { enrich, complete } from "../../hooks.ts";
import { S } from "../../state.ts";
import { str } from "../../util/json.ts";
import { identOf } from "../query/project.ts";
import { newSum } from "../usage/costs.ts";
import type { CostNow } from "../usage/summary.ts";
import { budget } from "../usage/summary.ts";
import { FORMAT, type HostReport, type HostFeed, newFeedState } from "./model.ts";
import { sessRowOf } from "./report.ts";
import type { FleetCfg } from "./config.ts";
import { FLEET, setFleet, rowsOf, applyReport, idMap, overlap, fleetCost, fleetBudget, fleetAllowance, freshOf, syncFresh, hostByName, merged, rowObj } from "./hosts.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const now = Date.now();
function rep(hostId: string, sess: { id: string; live: boolean }[], today: number, proj: boolean, al: { account: string; fetchedAt: number; pct: number } | null): HostReport {
  const ss = sess.map((x) => sessRowOf({ id: x.id, harness: "claude", title: "t " + x.id, cwd: "/w/x", updated: new Date(now - 1000).toISOString(), live: x.live, status: x.live ? "busy" : "", costUsd: x.id === "nul" ? null : 1.5,
    tokens: { in: 10, out: 2, cacheRead: 0, cacheWrite: 0 }, billing: { mode: "api", plan: "", source: "config" }, attention: x.live, stuck: null, repo: { key: "git:github.com/a/x", label: "x", kind: "git", worktree: "", top: "/w/x", remote: "" } }));
  return { hello: { format: FORMAT, version: "x", hostId, hostName: "h", os: "linux", tzOffsetMin: 0, redact: false, days: 7, now, priceSig: "" }, sessions: ss,
    cost: { today: { byMode: { api: today, plan: 0, metered: 0, gateway: 0, unknown: 0 }, estimatedUsd: 0, unpriced: { tokens: 5, byModel: { m: 5 }, credits: 0 } }, week: { byMode: { api: today * 2 } }, month: { byMode: { api: today * 3 }, projected: proj ? { byMode: { api: today * 10 }, total: today * 10 } : null } },
    allowance: al ? { claude: { account: al.account, fetchedAt: al.fetchedAt, h5: { pct: al.pct, reset: now + 3600000 }, d7: null }, codex: null } : null, live: null, exact: false };
}
const nofeed: HostFeed = { kind: "ssh", start: (t: number): boolean => false, poll: (t: number) => newFeedState(), stop: (): void => {} };
const cfg: FleetCfg = { hosts: [{ name: "ws", ssh: "ws", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "" }, { name: "vm1", ssh: "vm1", agentglass: "agentglass", redact: false, enabled: true, kind: "ssh", path: "" }],
  localName: "local", refreshS: 60, days: 7, timeoutS: 90, warns: [] };
setFleet(cfg, "ffffffffffffffff", [nofeed, nofeed]);
const r1 = rep("1111111111111111", [{ id: "a", live: true }, { id: "nul", live: false }], 2, true, { account: "acc", fetchedAt: 10, pct: 40 });
const rows = rowsOf("ws", r1, now);
const a0 = rows[0]; const a1 = rows[1];
ok("two rows", rows.length === 2, String(rows.length));
ok("row fields", !!a0 && a0.path === "@ws/claude:a" && a0.pid === 0 && a0.host === "ws" && a0.rlive && a0.headDone && a0.cost === 1.5 && a0.inTok === 10 && a0.bill === "api", JSON.stringify(a0));
ok("null cost → -1", !!a1 && a1.cost === -1, a1 ? String(a1.cost) : "none");
ok("row object kept", !!a0 && rowObj(a0) !== null && str((rowObj(a0) ?? {})["title"]) === "t a", "missing");
const ws = hostByName("ws"); const vm = hostByName("vm1");
if (!ws || !vm) throw new Error("hosts");
const ids = idMap();
applyReport(ws, r1, now, ids);
ok("applied, fresh", ws.rows.length === 2 && ws.fresh && ws.dupOf === "", JSON.stringify({ n: ws.rows.length, f: ws.fresh }));
const live = ws.rows[0];
ok("isLive while fresh", !!live && isLive(live), "not live");
ok("attention while fresh", !!live && live.attention, "no attention");
FRESH.ok = (h: string): boolean => false;
ok("not live when FRESH says stale", !!live && !isLive(live), "live");
FRESH.ok = (h: string): boolean => { const rh = hostByName(h); return rh !== null && rh.fresh; };
// staleness: 2 × 60 s + 90 s
ok("fresh at 209 s", freshOf(ws, now + 209000, cfg, 60000), "stale");
ok("stale at 211 s", !freshOf(ws, now + 211000, cfg, 60000), "fresh");
ws.okAt = now - 300000; syncFresh(now);
ok("stale: no live, no attention", !!live && !isLive(live) && !live.attention && !ws.fresh, JSON.stringify({ f: ws.fresh, a: live ? live.attention : null }));
ws.okAt = now; syncFresh(now);
ok("fresh again: attention back", !!live && live.attention && isLive(live), "no");
// duplicates: this machine's id, an earlier host's id
const self = rep("ffffffffffffffff", [{ id: "s", live: false }], 1, true, null);
applyReport(vm, self, now, ids);
ok("this machine → dupOf local", vm.dupOf === "local" && vm.rows.length === 0, vm.dupOf);
applyReport(vm, rep("1111111111111111", [{ id: "z", live: false }], 1, true, null), now, ids);
ok("an earlier host's id → dupOf ws", vm.dupOf === "ws" && vm.rows.length === 0, vm.dupOf);
ok("merged skips duplicates", merged().length === 1, String(merged().length));
const r2 = rep("2222222222222222", [{ id: "x", live: false }], 3, false, { account: "acc", fetchedAt: 20, pct: 55 });
applyReport(vm, r2, now, ids);
ok("own id merges", vm.dupOf === "" && vm.rows.length === 1, vm.dupOf);
// overlap: local x and vm1 x
const loc = newSess("claude", "x", "/tmp/keepme-x.jsonl", false); loc.mtime = now; sessions.set(loc.path, loc);
ok("overlap", overlap([loc], merged()).size === 1 && overlap([loc], merged()).has("claude:x"), JSON.stringify([...overlap([loc], merged())]));
// cost: local today api 1 + ws 2 + vm1 3
const lt = newSum(); lt.by[0] = 1;
const ln: CostNow = { today: lt, week: newSum(), month: newSum(), projByMode: [{ today: 0, month: 4 }, { today: 0, month: 0 }, { today: 0, month: 0 }, { today: 0, month: 0 }, { today: 0, month: 0 }],
  proj: { today: 0, month: 4 }, projCounted: { today: 0, month: 4 }, budget, bs: { state: "", used: 0, projected: 0, approx: false } };
const fc = fleetCost(ln, merged(), now, cfg, 0);
ok("today sum", fc.today.by[0] === 6 && fc.today.unk === 10 && (fc.today.um.get("m") ?? 0) === 10, JSON.stringify(fc.today.by) + " " + String(fc.today.unk));
ok("month sum", fc.month.by[0] === 15, JSON.stringify(fc.month.by));
ok("approx: vm1 has no projection", fc.approx, "exact");
ok("projection: local 4 + ws 20 + vm1 month 9", fc.projByMode[0] === 33, JSON.stringify(fc.projByMode));
ok("per host", fc.perHost.length === 3 && (fc.perHost[0]?.name ?? "") === "local" && (fc.perHost[2]?.today ?? 0) === 3, JSON.stringify(fc.perHost));
applyReport(vm, rep("2222222222222222", [{ id: "x", live: false }], 3, true, { account: "acc", fetchedAt: 20, pct: 55 }), now, ids);
ok("exact without overlap or stale", !fleetCost(ln, merged(), now, cfg, 0).approx, "approx");
ok("overlap makes it approx", fleetCost(ln, merged(), now, cfg, 1).approx, "exact");
ws.okAt = now - 600000;
ok("a stale host makes it approx", fleetCost(ln, merged(), now, cfg, 0).approx, "exact");
ws.okAt = now;
budget.usd = 10; budget.counts = ["api"];
const bs = fleetBudget(fleetCost(ln, merged(), now, cfg, 0));
ok("fleet budget over", bs.state === "over" && bs.used === 15, JSON.stringify(bs));
budget.usd = 0;
// allowance: newest fetchedAt per account, never a sum
const al = fleetAllowance(null, merged());
const cl = al ? al["claude"] : null;
ok("allowance newest", Array.isArray(cl) && JSON.stringify(cl).indexOf("\"pct\":55") >= 0 && JSON.stringify(cl).indexOf("\"pct\":40") < 0 && JSON.stringify(cl).indexOf("95") < 0, JSON.stringify(al));
// remote rows stay out of local paths
const row = ws.rows[0];
if (row) {
  const before = JSON.stringify(row);
  enrich(row); complete(row); loadHead(row); loadTail(row);
  ok("enrich/complete/loadHead/loadTail do nothing", JSON.stringify(row) === before, JSON.stringify(row));
  const id = identOf(row);
  ok("project from the report", id !== null && id.key === "git:github.com/a/x" && id.via === "remote", JSON.stringify(id));
}
buildView();
ok("view has remote rows", S.view.some((s) => s.host === "ws") && S.view.some((s) => s.host === "vm1"), String(S.view.length));
ok("live remote row sorts first", (S.view[0]?.path ?? "") === "@ws/claude:a", S.view.map((s) => s.path).join(","));
let leaked = false; for (const k of sessions.keys()) if (k.startsWith("@")) leaked = true;
ok("sessions never holds a remote path", !leaked, "leaked");
console.log(bad ? String(bad) + " failed" : "fleet hosts: all checks passed");
if (bad) process.exit(1);
