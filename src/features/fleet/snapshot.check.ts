// agentglass — self-check for fleet snapshot (spec 12): generations, acknowledgements, deltas, gone, the peer cap
// scriptc build src/features/fleet/snapshot.check.ts -o snc && ./snc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, appendFileSync, unlinkSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { HOME, readText } from "../../util/fs.ts";
import { type OwnRow, type Owned, type SessRow, ownSess } from "./model.ts";
import { type Snap, type OwnLine, newSnapParse, feedSnap, snapLines, applySnap, dayOut } from "./snap.ts";
import { type PeerState, type SnapScope, buildSnap, baseFor, savePeer, loadPeer, peersDir, newGen, MAX_PEERS } from "./snapshot.ts";
import type { Sess } from "../../model/types.ts";
import { identSync } from "../query/project.ts";
import { type Obj, obj } from "../../util/json.ts";
import { msgHash } from "../usage/msgrows.ts";
import { startOfDay } from "../usage/record.ts";
import { rowsOfChunk, rowsOfChunks } from "./ownc.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
process.env["AGENTGLASS_CACHE_DIR"] = join(HOME, "cache");
process.env["AGENTGLASS_FLEET_DIR"] = join(HOME, "fl", "fleet");
const p = join(HOME, ".claude", "projects", "-w-app"); mkdirSync(p, { recursive: true });
const now = Date.now(); const iso = (m: number): string => new Date(now - m * 60000).toISOString();
function user(id: string, ts: string): string { return '{"type":"user","sessionId":"' + id + '","cwd":"/w/app","timestamp":"' + ts + '","message":{"role":"user","content":"fix the keepme bug"}}\n'; }
function asst(id: string, mid: string, ts: string, inp: number): string {
  return '{"type":"assistant","sessionId":"' + id + '","timestamp":"' + ts + '","message":{"id":"' + mid + '","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":' + String(inp) + ',"output_tokens":10}}}\n';
}
// fixed local times early today (one hour of one day, whatever the clock: the no-scope golden below stays byte-equal)
const day0 = startOfDay();
const at = (m: number): string => new Date(day0 + m * 60000).toISOString();
// mtimes s seconds ago, whole seconds apart (the list order; recent enough to be stat'ed on every scan). scriptc has no
// utimesSync: touch -t [[CC]YY]MMDDhhmm.ss, local time
function touch(f: string, sec: number): void {
  const d = new Date(Math.floor(now / 1000) * 1000 - sec * 1000); const z = (n: number): string => String(n).padStart(2, "0");
  execFileSync("touch", ["-t", String(d.getFullYear()) + z(d.getMonth() + 1) + z(d.getDate()) + z(d.getHours()) + z(d.getMinutes()) + "." + z(d.getSeconds()), f]);
}
writeFileSync(join(p, "s1.jsonl"), user("s1", at(1)) + asst("s1", "m1", at(1), 100) + asst("s1", "m2", at(2), 200)); touch(join(p, "s1.jsonl"), 30);
writeFileSync(join(p, "s2.jsonl"), user("s2", at(3)) + asst("s2", "m3", at(3), 300)); touch(join(p, "s2.jsonl"), 20);
writeFileSync(join(p, "s3.jsonl"), user("s3", at(4)) + asst("s3", "m4", at(4), 400)); touch(join(p, "s3.jsonl"), 10);
function round(x: Snap): Snap { const q = newSnapParse(); feedSnap(q, snapLines(x)); return q; }
const keys = (x: Snap): string => x.sess.map((r: SessRow) => r.key).sort().join(",");
const P = "00112233445566ff";
function ownOf(x: Snap, key: string): OwnLine | null { for (const o of x.own) if (ownSess(o.key) === key) return o; return null; }
function req(ack: string, full: boolean): Snap {
  const st = loadPeer(P); const base = baseFor(st, ack, full);
  const b = buildSnap(7, base, Date.now()); const q = round(b.snap);
  ok("parses: " + (q.err || "ok"), q.done && !q.err, q.err);
  savePeer(P, st, b.next);
  return q;
}

// fleet's own snapshot without a scope is a contract (fleet-teams Task 3): its lines, with what depends on the machine,
// the clock and the build normalised, equal testdata/snap-noscope.golden byte for byte (written from the code before
// the scope existed; AGENTGLASS_GOLDEN_WRITE=<path> writes it again, deliberately)
function normLine(l: string): string {
  let t = l.split(HOME).join("~").replace(/"path":"[^"]*"/g, "\"path\":\"P\"").replace(/"activity":"[^"]*"/g, "\"activity\":\"A\""); // --redact's fake text varies with the clock
  for (const k of ["gen", "base"]) t = t.replace(new RegExp("\"" + k + "\":\"[0-9a-f]{16}\"", "g"), "\"" + k + "\":\"G\"");
  for (const k of ["version", "hostId", "hostName", "os"]) t = t.replace(new RegExp("\"" + k + "\":\"[^\"]*\"", "g"), "\"" + k + "\":\"X\"");
  for (const k of ["now", "tzOffsetMin"]) t = t.replace(new RegExp("\"" + k + "\":-?[0-9]+", "g"), "\"" + k + "\":0");
  t = t.replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, "T").replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}/g, "D");
  return t.replace(/",[0-9]+,"D",/g, "\",0,\"D\","); // an own row's time key
}
{
  const lines = snapLines(buildSnap(7, null, now).snap).map((l: string) => normLine(l)).join("\n") + "\n";
  const gw = process.env["AGENTGLASS_GOLDEN_WRITE"] ?? "";
  if (gw) writeFileSync(gw, lines);
  const gp = "src/features/fleet/testdata/snap-noscope.golden";
  const want = existsSync(gp) ? readText(gp, 0, 1048576) : "";
  ok("no-scope lines equal the golden", want !== "" && lines === want, "\n got:\n" + lines + "\n want:\n" + want);
}

const s1 = req("", false);
ok("first: full, 3 sessions", s1.full && s1.base === "" && keys(s1) === "claude:s1,claude:s2,claude:s3", keys(s1));
const own1 = ownOf(s1, "claude:s1");
ok("first: own rows of s1 (2 messages, hashed)", !!own1 && own1.reset && own1.rows.n === 2 && rowsOfChunk(own1.rows).some((r: OwnRow) => r.h === msgHash("m1")), JSON.stringify(own1 ? rowsOfChunk(own1.rows) : []));
ok("first: day rows", (s1.sess[0]?.days?.length ?? 0) >= 1, JSON.stringify(s1.sess[0]?.days ?? []));
ok("no raw message id on the wire", snapLines(s1).join("\n").indexOf("\"m1\"") < 0, "leak");
let rep = applySnap(null, s1);
const s2 = req(s1.gen, false);
ok("second: delta on the first, nothing changed", !s2.full && s2.base === s1.gen && s2.sess.length === 0 && s2.own.length === 0 && s2.gone.length === 0, JSON.stringify({ sess: keys(s2), own: s2.own.length, gone: s2.gone }));
rep = applySnap(rep, s2);
appendFileSync(join(p, "s2.jsonl"), asst("s2", "m5", iso(1), 500));
const s3 = req(s2.gen, false);
const o3 = ownOf(s3, "claude:s2");
ok("third: one session, its new own row only", keys(s3) === "claude:s2" && !!o3 && !o3.reset && o3.rows.n === 1 && (rowsOfChunk(o3.rows)[0]?.h ?? "") === msgHash("m5"), keys(s3));
let st: PeerState = loadPeer(P);
ok("state: acked = second, pending = third", (st.acked?.gen ?? "") === s2.gen && (st.pending?.gen ?? "") === s3.gen, JSON.stringify({ a: st.acked?.gen, p: st.pending?.gen }));
// the third was lost: the next request acknowledges the second again → the same changes relative to it
const s4 = req(s2.gen, false);
const o4 = ownOf(s4, "claude:s2");
ok("lost: delta again from the second", s4.base === s2.gen && keys(s4) === "claude:s2" && !!o4 && !o4.reset && o4.rows.n === 1, s4.base + " " + keys(s4));
rep = applySnap(rep, s4);
// applying s4 (not the lost s3) gives the same report as a fresh full one
const f = req("", true);
const fr = applySnap(null, f);
function norm(r: SessRow[]): string { const o: string[] = []; for (const x of r) { const ow: string[] = []; for (const y of rowsOfChunks(x.own ?? [])) ow.push(y.h + y.n.join(",")); o.push(x.key + JSON.stringify(x.days ?? []) + ow.join(";")); } return o.sort().join("\n"); }
ok("deltas applied = a full snapshot", norm(rep.sessions) === norm(fr.sessions), norm(rep.sessions) + "\n vs " + norm(fr.sessions));
const unk = req("ffffffffffffffff", false);
ok("unknown ack → full", unk.full && unk.base === "" && unk.sess.length === 3, String(unk.full));
// a deleted log → gone (and its rows reset empty)
unlinkSync(join(p, "s3.jsonl"));
const g = req(unk.gen, false);
ok("deleted → gone", g.gone.indexOf("claude:s3") >= 0 && !!ownOf(g, "claude:s3") && (ownOf(g, "claude:s3")?.reset ?? false) && (ownOf(g, "claude:s3")?.rows.n ?? 1) === 0, JSON.stringify(g.gone));
const gr = applySnap(applySnap(null, unk), g);
ok("gone applied", !gr.sessions.some((s: SessRow) => s.key === "claude:s3") && !gr.owned.some((o: Owned) => ownSess(o.key) === "claude:s3"), JSON.stringify(gr.sessions.map((s: SessRow) => s.key)));
// peer files: 0600, at most MAX_PEERS
st = { acked: null, pending: null };
for (let i = 0; i < MAX_PEERS + 1; i++) savePeer("aa" + String(i).padStart(14, "0"), st, { gen: newGen(), sig: new Map<string, string>() });
const files = readdirSync(peersDir()).filter((n: string) => n.endsWith(".json"));
ok("at most 16 peer files", files.length === MAX_PEERS, String(files.length));
ok("generation ids differ", newGen() !== newGen() && /^[0-9a-f]{16}$/.test(newGen()), newGen());
ok("peer state holds no message id", readFileSync(join(peersDir(), files[0] ?? ""), "utf8").indexOf("m1") < 0, "");

// ── a scope (fleet-teams Task 3: team room streams): selection, projection, ownership limit, cost of the selection,
// changed-day deltas ──
function repo(name: string): string {
  const d = join(HOME, "acme", name); mkdirSync(join(d, ".git"), { recursive: true });
  writeFileSync(join(d, ".git", "config"), "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://github.com/acme/" + name + ".git\n");
  return d;
}
const apiDir = repo("api"); const webDir = repo("web");
const pp = join(HOME, ".claude", "projects", "-acme"); mkdirSync(pp, { recursive: true });
function line(id: string, cwd: string, ts: string, mid: string, inp: number): string {
  return '{"type":"user","sessionId":"' + id + '","cwd":"' + cwd + '","timestamp":"' + ts + '","message":{"role":"user","content":"go"}}\n' +
    '{"type":"assistant","sessionId":"' + id + '","cwd":"' + cwd + '","timestamp":"' + ts + '","message":{"id":"' + mid + '","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":' + String(inp) + ',"output_tokens":10}}}\n';
}
// api: yesterday and today; web: today
writeFileSync(join(pp, "a1.jsonl"), line("a1", apiDir, at(-600), "ma1", 1000) + line("a1", apiDir, at(5), "ma2", 2000)); touch(join(pp, "a1.jsonl"), 8);
writeFileSync(join(pp, "w1.jsonl"), line("w1", webDir, at(6), "mw1", 3000)); touch(join(pp, "w1.jsonl"), 7);
const keyOf = (s: Sess): string => { const id = identSync(s); return id ? id.key : ""; };
function scope(dayDelta: boolean): SnapScope {
  return { pass: (s: Sess): boolean => keyOf(s) === "git:github.com/acme/api", row: (o: Obj): Obj => { const r: Obj = {}; for (const k of Object.keys(o)) if (k !== "title" && k !== "cwd") r[k] = o[k]; return r; },
    head: (h: Obj): Obj => { const r: Obj = {}; for (const k of Object.keys(h)) if (k !== "hostName") r[k] = h[k]; r["room"] = "r1"; return r; }, ownAll: false, dayDelta, cost: true, allowance: false, noOwn: false };
}
function dayList(r: SessRow | undefined): string { const o: string[] = []; if (r) for (const d of r.days ?? []) o.push(d.d); return o.join(","); }
const sb = buildSnap(7, null, Date.now(), scope(true)); const sl = snapLines(sb.snap); const sq = round(sb.snap);
ok("scope: only the selected repo's session", keys(sq) === "claude:a1", keys(sq));
ok("scope: own lines only for it, no rest (|*) lines", sq.own.length > 0 && sq.own.every((o: OwnLine) => ownSess(o.key) === "claude:a1") && sl.every((l: string) => l.indexOf("|*") < 0), JSON.stringify(sq.own.map((o: OwnLine) => o.key)));
ok("scope: row projected (title, cwd gone from every line)", sl.every((l: string) => l.indexOf("\"title\"") < 0 && l.indexOf("\"cwd\"") < 0), "");
ok("scope: head rewritten", sl[0]?.indexOf("\"room\":\"r1\"") !== undefined && (sl[0] ?? "").indexOf("\"room\":\"r1\"") > 0 && (sl[0] ?? "").indexOf("hostName") < 0, sl[0] ?? "");
ok("scope: no allowance", JSON.stringify(sq.allowance) === "{\"claude\":null,\"codex\":null}", JSON.stringify(sq.allowance));
function modeSum(o: unknown): number { const oo = obj(o); const b = (oo ? obj(oo["byMode"]) : null) ?? {}; let t = 0; for (const k of Object.keys(b)) t += typeof b[k] === "number" ? (b[k] as number) : 0; return t; }
const sr0 = sq.sess[0]; const cv: unknown = sr0 ? sr0.s["costUsd"] : null; const selCost = typeof cv === "number" ? cv : -1;
const sc = obj(sq.cost); const monthCost = modeSum(sc ? sc["week"] : null); // the week: yesterday may be last month
ok("scope: cost line = the selected sessions only", selCost > 0 && Math.abs(monthCost - selCost) < 1e-9, String(monthCost) + " vs " + String(selCost));
ok("scope: no budget in a scoped cost line", sc !== null && sc["budget"] === null, "");
ok("scope: a day row per day", (sq.sess[0]?.days?.length ?? 0) === 2, dayList(sq.sess[0]));
ok("scope: a base row carries no dd", sl.every((l: string) => l.indexOf("\"dd\"") < 0), "");
// a message today on the selected session: the delta carries only today's day row, marked dd
appendFileSync(join(pp, "a1.jsonl"), line("a1", apiDir, iso(1), "ma3", 4000));
const d1 = buildSnap(7, sb.next, Date.now(), scope(true)); const dq = round(d1.snap);
const today = new Date(day0 + 43200000).toISOString().slice(0, 10);
const r1 = dq.sess[0];
ok("dd delta: one row, today's day only, dd", dq.sess.length === 1 && r1 !== undefined && r1.dd && (r1.days?.length ?? 0) === 1 && snapLines(d1.snap).some((l: string) => l.indexOf("\"dd\":true") > 0),
  dq.sess.map((r: SessRow) => r.key + " dd=" + String(r.dd) + " " + dayList(r)).join("; ") + " today " + today);
const d2 = buildSnap(7, sb.next, Date.now(), scope(false)); const dq2 = round(d2.snap);
ok("no dayDelta: the full row", dq2.sess.length === 1 && !(dq2.sess[0]?.dd ?? true) && (dq2.sess[0]?.days?.length ?? 0) === 2, JSON.stringify(dq2.sess.map((r: SessRow) => (r.days ?? []).length)));
function daysOf(r: SessRow[]): string { const o: string[] = []; for (const x of r) { const ds: string[] = []; for (const d of x.days ?? []) ds.push(JSON.stringify(dayOut(d))); ds.sort(); o.push(x.key + ":" + ds.join("|")); } return o.sort().join("\n"); }
const baseRep = applySnap(null, sq);
const m1 = applySnap(baseRep, dq); const m2 = applySnap(applySnap(null, sq), dq2);
ok("dd delta applied = full row applied", daysOf(m1.sessions) === daysOf(m2.sessions) && daysOf(m1.sessions).indexOf(today) > 0, daysOf(m1.sessions) + "\n vs \n" + daysOf(m2.sessions));
ok("applied rows have no dd", m1.sessions.every((r: SessRow) => !r.dd), "");
// a scope with ownAll: true keeps the other Claude sessions' ownership rows (a personal team's room "all")
{
  const all = buildSnap(7, null, Date.now(), { pass: (s: Sess): boolean => true, row: (o: Obj): Obj => o, head: (h: Obj): Obj => h, ownAll: true, dayDelta: false, cost: false, allowance: true, noOwn: false });
  ok("scope ownAll + pass all: same sessions as no scope", keys(round(all.snap)) === keys(round(buildSnap(7, null, Date.now()).snap)), keys(round(all.snap)));
}

if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("fleet snapshot: all checks passed");
