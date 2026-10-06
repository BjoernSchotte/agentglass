// agentglass — self-check for fleet snapshot (spec 12): generations, acknowledgements, deltas, gone, the peer cap
// scriptc build src/features/fleet/snapshot.check.ts -o snc && ./snc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, appendFileSync, unlinkSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "../../util/fs.ts";
import { type OwnRow, type Owned, type SessRow, ownSess } from "./model.ts";
import { type Snap, type OwnLine, newSnapParse, feedSnap, snapLines, applySnap } from "./snap.ts";
import { type PeerState, buildSnap, baseFor, savePeer, loadPeer, peersDir, newGen, MAX_PEERS } from "./snapshot.ts";
import { msgHash } from "../usage/msgrows.ts";
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
writeFileSync(join(p, "s1.jsonl"), user("s1", iso(50)) + asst("s1", "m1", iso(50), 100) + asst("s1", "m2", iso(49), 200));
writeFileSync(join(p, "s2.jsonl"), user("s2", iso(40)) + asst("s2", "m3", iso(40), 300));
writeFileSync(join(p, "s3.jsonl"), user("s3", iso(30)) + asst("s3", "m4", iso(30), 400));
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

if (bad) { console.log(String(bad) + " failure(s)"); process.exit(1); }
console.log("fleet snapshot: all checks passed");
