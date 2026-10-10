// agentglass — self-check for the snapshot codec (fleet spec 12): scriptc build src/features/fleet/snap.check.ts -o sc && ./sc
// SPDX-License-Identifier: Apache-2.0
import { type Snap, SNAP, newSnap, newSnapParse, snapLines, feedSnap, applySnap, fullOf, dayRows } from "./snap.ts";
import type { DayRow, OwnRow, Owned, SessRow, HostReport } from "./model.ts";
import { str } from "../../util/json.ts";
import { chunkOf, lenOf, rowsOfChunks, NO_ROWS } from "./ownc.ts";
import { newAcc, bucket, tokens, usageExact, tool, credits } from "../usage/record.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const HEAD = { version: "2026.10.6", hostId: "0123456789abcdef", hostName: "ws", os: "linux", tzOffsetMin: 120, redact: false, days: 7, now: 1791000000000, priceSig: "x" };
function sr(key: string, updated: string, cost: number): SessRow {
  return { s: { harness: key.split(":")[0] ?? "", id: key.split(":")[1] ?? "", updated, costUsd: cost }, key, days: [{ d: "2026-10-01", tp: [["9", "", "claude-sonnet-4-5", "1", "2", "3", "4", "5", "0.5"]], hx: [["10", "anthropic", "0.25"]], unk: 0, um: [] as string[][], uc: 0, tools: 1, turns: 1, calls: 1, errors: 0, sa: [["alpha", "", "claude-sonnet-4-5", "1", "0", "0", "0", "0", "0", "100", "0", "0", "0", "300", "0", "0", "0", "200", "0", "0", "0"]] }], own: null, prov: [], dd: false };
}
function row(h: string, key: number): OwnRow { return { h, key, d: "2026-10-01", hr: 9, m: "claude-sonnet-4-5", prov: "", n: [1, 2, 3, 4, 5, 0.5, 1] }; }
const H1 = "00000000000000a1"; const H2 = "00000000000000a2"; const H3 = "00000000000000a3"; const H9 = "00000000000000f9";
const full: Snap = { head: HEAD, gen: "1111111111111111", base: "", full: true, sess: [sr("claude:a", "2026-10-01T10:00:00.000Z", 1), sr("claude:b", "2026-10-01T09:00:00.000Z", 2)],
  own: [{ key: "claude:a", reset: true, rows: chunkOf([row(H1, 10), row(H2, 12)]) }, { key: "claude:b", reset: true, rows: chunkOf([row(H3, 14)]) }, { key: "claude:old", reset: true, rows: chunkOf([{ h: H9, key: 2, d: "", hr: 0, m: "", prov: "", n: [] }]) }],
  gone: [], cost: { today: { byMode: { api: 3 } } }, allowance: { claude: null, codex: null }, done: true, err: "" };
const ls = snapLines(full);
ok("first line is the snap head", ls[0]?.startsWith("{\"snap\":{") === true && (ls[0] ?? "").indexOf(SNAP) > 0, ls[0] ?? "");
ok("last line is end", ls[ls.length - 1]?.startsWith("{\"end\":") === true, ls[ls.length - 1] ?? "");
// chunked feeding: one line at a time
const p = newSnapParse(); for (const l of ls) feedSnap(p, [l]);
ok("parsed done", p.done && !p.err, p.err);
ok("round trip", JSON.stringify(snapLines(p)) === JSON.stringify(ls), snapLines(p).join("\n"));
ok("skill day rows travel (skill-usage 6.15)", JSON.stringify(p.sess[0]?.days?.[0]?.sa ?? []) === JSON.stringify(full.sess[0]?.days?.[0]?.sa ?? [["x"]]), JSON.stringify(p.sess[0]?.days?.[0]?.sa ?? []));
{ const old = newSnapParse(); feedSnap(old, ls.map((l: string) => l.replace(/,"sa":\[\[[^\]]*\]\]/g, ""))); ok("a host without skill rows: sa []", (old.sess[0]?.days?.[0]?.sa.length ?? -1) === 0, old.err); }
const cut = newSnapParse(); feedSnap(cut, ls.slice(0, ls.length - 1));
ok("no end → not done", !cut.done && !cut.err, String(cut.done));
const wrong = newSnapParse(); feedSnap(wrong, ls.slice(0, 2).concat([ls[ls.length - 1] ?? ""]));
ok("end counts mismatch → error", !wrong.done && wrong.err === "incomplete snapshot", wrong.err);
const v2 = newSnapParse(); feedSnap(v2, ["{\"snap\":{\"format\":\"agentglass-snapshot/v2\",\"gen\":\"1111111111111111\",\"base\":\"\"}}"]);
ok("newer major → error", v2.err.indexOf("newer format") === 0, v2.err);
const pull = newSnapParse(); feedSnap(pull, ["{\"hello\":{\"format\":\"agentglass-fleet/v1\"}}"]);
ok("a pull report is not a snapshot", pull.err === "not a fleet snapshot", pull.err);
const badRow = newSnapParse(); feedSnap(badRow, [ls[0] ?? "", "{\"own\":{\"key\":\"claude:a\",\"reset\":false,\"rows\":[[\"msg_raw_id\",1]]}}"]);
ok("an own row with a raw id is refused", badRow.err === "bad own row", badRow.err);

// rows the first session owns (its chunks summed)
function ownN(r: HostReport): number { return lenOf(r.sessions[0]?.own ?? []); }
// sessions without their chunks, and every part's rows: comparable as text
function text(r: HostReport): string { const ss: string[] = []; for (const x of r.sessions) ss.push(JSON.stringify({ s: x.s, key: x.key, days: x.days ?? [], prov: x.prov }) + ":" + JSON.stringify(rowsOfChunks(x.own ?? []))); const os: string[] = []; for (const o of r.owned) os.push(o.key + ":" + JSON.stringify(rowsOfChunks(o.rows))); return ss.join("\n") + "\n" + os.join("\n"); }
// apply: full, then a delta (one session replaced, one own append, one gone)
const r1 = applySnap(null, p);
ok("full: 2 sessions, own attached", r1.sessions.length === 2 && ownN(r1) === 2 && r1.exact && r1.owned.length === 3, JSON.stringify(r1.sessions.map((s: SessRow) => s.key)));
const delta: Snap = { head: HEAD, gen: "2222222222222222", base: "1111111111111111", full: false, sess: [sr("claude:a", "2026-10-01T11:00:00.000Z", 5)],
  own: [{ key: "claude:a", reset: false, rows: chunkOf([row("00000000000000a4", 20)]) }, { key: "claude:b", reset: true, rows: NO_ROWS }], gone: ["claude:b"], cost: { today: { byMode: { api: 5 } } }, allowance: null, done: true, err: "" };
const dp = newSnapParse(); feedSnap(dp, snapLines(delta));
const r2 = applySnap(r1, dp);
ok("delta: b gone", r2.sessions.length === 1 && (r2.sessions[0]?.key ?? "") === "claude:a", JSON.stringify(r2.sessions.map((s: SessRow) => s.key)));
const a2 = r2.sessions[0]; const a2s = a2 ? a2.s : {};
ok("delta: a replaced", a2s["costUsd"] === 5, JSON.stringify(a2s));
ok("delta: own appended", ownN(r2) === 3 && !r2.owned.some((o: Owned) => o.key === "claude:b") && r2.owned.some((o: Owned) => o.key === "claude:old"), String(ownN(r2)));
ok("delta: the old report is untouched", r1.sessions.length === 2 && ownN(r1) === 2, String(r1.sessions.length));
const reset: Snap = { head: HEAD, gen: "3333333333333333", base: "2222222222222222", full: false, sess: [], own: [{ key: "claude:a", reset: true, rows: chunkOf([row(H1, 10)]) }], gone: [], cost: null, allowance: null, done: true, err: "" };
const r3 = applySnap(r2, reset);
ok("own reset replaces", ownN(r3) === 1, String(ownN(r3)));
// fullOf: the state as one full snapshot applies to the same report
const back = applySnap(null, fullOf(r2, "4444444444444444"));
ok("fullOf round trip", text(back) === text(r2) && back.owned.length === r2.owned.length, text(back));
ok("delta: the appended part is two chunks, the first the full snapshot's own", (r2.owned.find((o: Owned) => o.key === "claude:a")?.rows.length ?? 0) === 2 && (r2.owned.find((o: Owned) => o.key === "claude:a")?.rows[0] ?? null) === (r1.owned.find((o: Owned) => o.key === "claude:a")?.rows[0] ?? null), "");
ok("fullOf: one chunk a part", (fullOf(r2, "4444444444444444").own.find((o) => o.key === "claude:a")?.rows.n ?? 0) === 3, "");

// dayRows: table-priced rows, harness-reported cost per provider and hour, unpriced and credits, top + subagent folded
const top = newAcc(); const sub = newAcc();
const iso = "2026-10-01T09:15:00.000Z"; const hr = new Date(iso).getHours();
let d = bucket(top, 0, iso); tokens(top, d, "claude-sonnet-4-5", 100, 10, 1000, 50, 0);
tool(top, d, "Bash", "claude-sonnet-4-5", 0);
d = bucket(sub, 0, iso); tokens(sub, d, "claude-sonnet-4-5", 1, 1, 1, 1, 0); tokens(sub, d, "no-such-model-xyz", 7, 0, 0, 0, 0);
usageExact(sub, d, "gpt-x", 5, 5, 0, 0, 0, 0.75, "openai"); credits(sub, d, 3);
const day = bucket(top, 0, iso);
const dr = dayRows([top, sub], new Set<string>([[...top.days.keys()][0] ?? ""]));
const one = dr[0];
ok("one day", dr.length === 1, String(dr.length));
const priced = one ? one.tp.filter((r: string[]) => r[2] === "claude-sonnet-4-5") : [];
ok("tp folded: in 101", priced.length === 1 && (priced[0]?.[3] ?? "") === "101" && (priced[0]?.[0] ?? "") === String(hr), JSON.stringify(one ? one.tp : []));
const unp = one ? one.tp.filter((r: string[]) => r[2] === "no-such-model-xyz") : [];
ok("unpriced tp row usd -1", unp.length === 1 && (unp[0]?.[8] ?? "") === "-1", JSON.stringify(unp));
ok("hx: harness cost by provider and hour", !!one && one.hx.length === 1 && (one.hx[0]?.[1] ?? "") === "openai" && (one.hx[0]?.[0] ?? "") === String(hr) && Math.abs(Number(one.hx[0]?.[2] ?? "0") - 0.75) < 1e-9, JSON.stringify(one ? one.hx : []));
ok("no unpriced outside tp", !!one && one.unk === 0 && one.um.length === 0, JSON.stringify(one));
ok("credits, tools", !!one && one.uc === 3 && one.tools === 1 && one.calls === 1, JSON.stringify(one));
ok("day cost = tp + hx", !!one && Math.abs(one.tp.reduce((t: number, r: string[]) => t + Math.max(0, Number(r[8] ?? "0")), 0) + 0.75 - (day.cost + (sub.days.get(one.d)?.cost ?? 0))) < 1e-9, "cost");
void newSnap;
// changed-day rows (dd, fleet-teams Task 3): a day present replaces that day, absent days stay, in date order; a v1 row
// (no dd) replaces the row as before; dd travels only when true
{
  const day = (d: string, tools: number): DayRow => ({ d, tp: [] as string[][], hx: [] as string[][], unk: 0, um: [] as string[][], uc: 0, tools, turns: 0, calls: 0, errors: 0, sa: [] as string[][] });
  const b0: Snap = { head: HEAD, gen: "2222222222222222", base: "", full: true, sess: [{ s: { harness: "claude", id: "d", updated: "2026-10-02T10:00:00.000Z" }, key: "claude:d", days: [day("2026-10-01", 1), day("2026-10-02", 2)], own: null, prov: [], dd: false }],
    own: [], gone: [], cost: null, allowance: { claude: null, codex: null }, done: true, err: "" };
  const dl: Snap = { head: HEAD, gen: "3333333333333333", base: "2222222222222222", full: false, sess: [{ s: { harness: "claude", id: "d", updated: "2026-10-03T10:00:00.000Z" }, key: "claude:d", days: [day("2026-10-03", 5), day("2026-10-02", 4)], own: null, prov: [], dd: true }],
    own: [], gone: [], cost: null, allowance: { claude: null, codex: null }, done: true, err: "" };
  const wire = snapLines(dl); const back = newSnapParse(); feedSnap(back, wire);
  ok("dd on the wire and back", wire.some((l: string) => l.indexOf("\"dd\":true") > 0) && (back.sess[0]?.dd ?? false), wire.join("\n"));
  ok("no dd on a v1 row", snapLines(b0).every((l: string) => l.indexOf("\"dd\"") < 0), "");
  const m = applySnap(applySnap(null, b0), back); const r = m.sessions[0];
  const got: string[] = []; if (r) for (const d of r.days ?? []) got.push(d.d + "=" + String(d.tools));
  ok("dd merges days by date", got.join(",") === "2026-10-01=1,2026-10-02=4,2026-10-03=5" && r !== undefined && !r.dd && str(r.s["updated"]) === "2026-10-03T10:00:00.000Z", got.join(","));
  const v1: Snap = { head: HEAD, gen: "3333333333333333", base: "2222222222222222", full: false, sess: [{ s: { harness: "claude", id: "d", updated: "2026-10-03T10:00:00.000Z" }, key: "claude:d", days: [day("2026-10-03", 5)], own: null, prov: [], dd: false }],
    own: [], gone: [], cost: null, allowance: { claude: null, codex: null }, done: true, err: "" };
  const m1 = applySnap(applySnap(null, b0), v1); const g1: string[] = []; for (const d of m1.sessions[0]?.days ?? []) g1.push(d.d);
  ok("a v1 row replaces the days", g1.join(",") === "2026-10-03", g1.join(","));
  const m2 = applySnap(null, dl); const g2: string[] = []; for (const d of m2.sessions[0]?.days ?? []) g2.push(d.d);
  ok("a dd row without a row to update keeps what it has", g2.join(",") === "2026-10-03,2026-10-02" || g2.join(",") === "2026-10-02,2026-10-03", g2.join(","));
}

if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("fleet snap: all checks passed");
