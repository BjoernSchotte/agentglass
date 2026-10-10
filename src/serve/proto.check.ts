// agentglass serve --stdio — the agentglass-serve/1 dispatcher in process with a fake clock (local-web-api W2): hello and
// version negotiation, sessions.list = the read model, sub → snapshot, an appended log → one patch, resume inside the
// ring, snapshot for another epoch, heartbeat, ring cap, unknown method, oversize line, read-only commands, unsub.
// scriptc build src/serve/proto.check.ts -o spc && HOME=$(mktemp -d) AGENTGLASS_REDACT=0 ./spc
// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { type Obj, obj, str } from "../util/json.ts";
import { CLAUDE } from "../util/fs.ts";
import { newFramer, push } from "../util/jsonl.ts";
import { discover, readSessions } from "../read/index.ts";
import { type Srv, newSrv, onLine } from "./proto.ts";
import { RING_MAX, HB_MS, step, beat, emit, openTopic } from "./subs.ts";
import "../features/redact.ts";
import "../features/skills/marks.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const day = new Date().toISOString().slice(0, 10);
const dir = CLAUDE + "/projects/-w-spc";
const IDS = ["bbbbbbb1-0000-4000-8000-000000000001", "bbbbbbb2-0000-4000-8000-000000000002"];
function file(i: number): string { return dir + "/" + (IDS[i] ?? "") + ".jsonl"; }
function turn(id: string, k: number, text: string): string {
  return "{\"type\":\"user\",\"sessionId\":\"" + id + "\",\"cwd\":\"/w/spc\",\"timestamp\":\"" + day + "T00:00:0" + String(k) + ".000Z\",\"message\":{\"role\":\"user\",\"content\":\"" + text + "\"}}\n";
}
mkdirSync(dir, { recursive: true });
writeFileSync(file(0), turn(IDS[0] ?? "", 1, "first topic"));
const w0 = Date.now(); while (Date.now() < w0 + 20) { /* newest first must not depend on two writes in one ms */ }
writeFileSync(file(1), turn(IDS[1] ?? "", 1, "second topic"));
discover();

const clock = { t: 1700000000000 };
const out: string[] = [];
const sv: Srv = newSrv(true, "e3a9", (): number => clock.t, (l: string): void => { out.push(l); }, (): void => {});
function send(l: string): Obj[] { out.length = 0; onLine(sv, l, false); const r: Obj[] = []; for (const x of out) r.push(obj(JSON.parse(x)) ?? {}); return r; }
function one(l: string): Obj { return send(l)[0] ?? {}; }
function errCode(o: Obj): string { const e = obj(o["err"]); return e ? str(e["code"]) : ""; }
function ok(o: Obj): Obj { return obj(o["ok"]) ?? {}; }

eq("before hello", errCode(one("{\"id\":1,\"m\":\"meta\"}")), "proto");
eq("want 2", errCode(one("{\"id\":1,\"m\":\"hello\",\"p\":{\"client\":\"t\",\"want\":2}}")), "proto");
const h = one("{\"id\":2,\"m\":\"hello\",\"p\":{\"client\":\"t\",\"want\":1}}");
eq("hello", JSON.stringify([h["id"], ok(h)["proto"], ok(h)["contract"], ok(h)["readOnly"]]), JSON.stringify([2, 1, 1, true]));
eq("meta", String(ok(one("{\"id\":3,\"m\":\"meta\"}"))["proto"]), "1");
// sessions.list = readSessions
const l = ok(one("{\"id\":4,\"m\":\"sessions.list\",\"p\":{\"limit\":200}}"));
const want = readSessions({ filter: "", limit: 200, cursor: "", subagents: false, team: "", room: "" }).page;
eq("list = read model", JSON.stringify(l["data"]), JSON.stringify(want ? want.data : []));
eq("list limit", errCode(one("{\"id\":5,\"m\":\"sessions.list\",\"p\":{\"limit\":5000}}")), "bad_param");
eq("list bad filter", errCode(one("{\"id\":5,\"m\":\"sessions.list\",\"p\":{\"filter\":\"cost >\"}}")), "bad_filter");
eq("get", str(ok(one("{\"id\":6,\"m\":\"sessions.get\",\"p\":{\"ref\":\"bbbbbbb2\"}}"))["id"]), IDS[1] ?? "");
eq("get missing", errCode(one("{\"id\":6,\"m\":\"sessions.get\",\"p\":{\"ref\":\"zzzzzzzz\"}}")), "not_found");

// sub → answer, then a snapshot event
const s1 = send("{\"id\":7,\"m\":\"sub\",\"p\":{\"topic\":\"sessions\"}}");
const a1 = s1[0] ?? {}; const snap = s1[1] ?? {};
eq("sub answer", JSON.stringify(a1["ok"]), JSON.stringify({ sub: "s1", resumed: false }));
eq("snapshot", str(snap["sub"]) + " " + str(snap["k"]), "s1 snapshot");
const sd = obj(snap["d"]) ?? {}; const rows = sd["data"];
eq("snapshot rows", Array.isArray(rows) ? String((rows as unknown[]).length) : "", "2");
eq("row key", Array.isArray(rows) ? str((obj((rows as unknown[])[0]) ?? {})["key"]) : "", "claude:" + (IDS[1] ?? ""));
const snapId = str(snap["ev"]);
eq("event id form", /^e3a9-\d+$/.test(snapId) ? "ok" : snapId, "ok");
// nothing moved: no patch
out.length = 0; clock.t += 1500; step(sv.hub, clock.t);
eq("quiet step", String(out.length), "0");
// a fixture append → one patch upserting that row
appendFileSync(file(0), turn(IDS[0] ?? "", 2, "more"));
discover(); out.length = 0; clock.t += 1500; step(sv.hub, clock.t);
eq("one patch", String(out.length), "1");
const pt = obj(JSON.parse(out[0] ?? "{}")) ?? {}; const pd = obj(pt["d"]) ?? {};
eq("patch kind", str(pt["k"]) + " " + str(pt["sub"]), "patch s1");
const ups = pd["upsert"];
eq("patch upsert", Array.isArray(ups) && (ups as unknown[]).length === 1 ? str((obj((ups as unknown[])[0]) ?? {})["id"]) : JSON.stringify(ups), IDS[0] ?? "");
eq("patch remove", JSON.stringify(pd["remove"]), "[]");
const patchId = str(pt["ev"]);
// resume from the snapshot's id: the missed patch is replayed
const s2 = send("{\"id\":8,\"m\":\"sub\",\"p\":{\"topic\":\"sessions\",\"from\":\"" + snapId + "\"}}");
eq("resume answer", JSON.stringify((s2[0] ?? {})["ok"]), JSON.stringify({ sub: "s2", resumed: true }));
eq("resume replay", String(s2.length) + " " + str((s2[1] ?? {})["ev"]) + " " + str((s2[1] ?? {})["k"]), "2 " + patchId + " patch");
// from the newest id: resumed, nothing to replay
const s3 = send("{\"id\":9,\"m\":\"sub\",\"p\":{\"topic\":\"sessions\",\"from\":\"" + patchId + "\"}}");
eq("resume at head", JSON.stringify((s3[0] ?? {})["ok"]) + " " + String(s3.length), JSON.stringify({ sub: "s3", resumed: true }) + " 1");
// another run's id → snapshot
const s4 = send("{\"id\":10,\"m\":\"sub\",\"p\":{\"topic\":\"sessions\",\"from\":\"ffff-2\"}}");
eq("other epoch", JSON.stringify((s4[0] ?? {})["ok"]) + " " + str((s4[1] ?? {})["k"]), JSON.stringify({ sub: "s4", resumed: false }) + " snapshot");
// heartbeat: quiet subs only, after 25 s
out.length = 0; clock.t += 1000; eq("no hb yet", String(beat(sv.hub, clock.t)), "0");
clock.t += HB_MS; const nb = beat(sv.hub, clock.t);
eq("hb", String(nb) + " " + str((obj(JSON.parse(out[0] ?? "{}")) ?? {})["k"]), "4 hb");
// unsub; the topic goes with its last sub
const u1: Obj = one("{\"id\":11,\"m\":\"unsub\",\"p\":{\"sub\":\"s2\"}}");
eq("unsub", JSON.stringify(u1["ok"]), "{}");
eq("unsub twice", errCode(one("{\"id\":12,\"m\":\"unsub\",\"p\":{\"sub\":\"s2\"}}")), "not_found");
for (const s of ["s1", "s3", "s4"]) one("{\"id\":13,\"m\":\"unsub\",\"p\":{\"sub\":\"" + s + "\"}}");
eq("topics gone", String(sv.hub.topics.size), "0");
// a filtered topic is its own; a bad filter is refused
eq("sub bad filter", errCode(one("{\"id\":14,\"m\":\"sub\",\"p\":{\"topic\":\"sessions\",\"filter\":\"cost >\"}}")), "bad_filter");
eq("sub unknown topic", errCode(one("{\"id\":14,\"m\":\"sub\",\"p\":{\"topic\":\"nope\"}}")), "bad_param");
// ring cap: the oldest events go; a resume from before them gets a snapshot
const ot = openTopic(sv.hub, { filter: "", limit: 5, cursor: "", subagents: false, team: "", room: "" }, clock.t);
const t = ot.t;
if (t) {
  const first = sv.hub.seq + 1;
  for (let i = 0; i <= RING_MAX; i++) emit(sv.hub, t, "patch", "{\"upsert\":[],\"remove\":[]}", clock.t);
  eq("ring cap", String(t.ring.length), String(RING_MAX));
  t.n = 1; // a sub holds it open
  const r = send("{\"id\":15,\"m\":\"sub\",\"p\":{\"topic\":\"sessions\",\"limit\":5,\"from\":\"e3a9-" + String(first - 1) + "\"}}");
  eq("from before the ring", String((obj((r[0] ?? {})["ok"]) ?? {})["resumed"]) + " " + str((r[1] ?? {})["k"]), "false snapshot");
  const r2 = send("{\"id\":16,\"m\":\"sub\",\"p\":{\"topic\":\"sessions\",\"limit\":5,\"from\":\"e3a9-" + String(first + 1) + "\"}}");
  eq("from inside the ring", String((obj((r2[0] ?? {})["ok"]) ?? {})["resumed"]) + " " + String(r2.length), "true " + String(RING_MAX));
} else { bad++; console.log("FAIL ring topic: " + ot.err); }
// errors keep the loop going
const um: Obj = one("{\"id\":\"x\",\"m\":\"nope\"}");
eq("unknown method", JSON.stringify([um["id"], errCode(um)]), JSON.stringify(["x", "unknown_method"]));
eq("not json", errCode(one("{nope")), "bad_request");
eq("no id", errCode(one("{\"m\":\"meta\"}")), "bad_request");
eq("read-only cmd", errCode(one("{\"id\":17,\"m\":\"cmd\",\"p\":{\"cmd\":\"session.sendPrompt\"}}")), "read_only");
const F = newFramer(); const big = new Uint8Array(5 * 1024 * 1024 + 2); for (let i = 0; i < big.length; i++) big[i] = 32; big[0] = 123; big[big.length - 1] = 10;
const tail = new TextEncoder().encode("{\"id\":18,\"m\":\"meta\"}\n");
out.length = 0;
for (const f of push(F, big)) onLine(sv, f.line, f.oversize);
for (const f of push(F, tail)) onLine(sv, f.line, f.oversize);
eq("oversize then on", String(out.length) + " " + errCode(obj(JSON.parse(out[0] ?? "{}")) ?? {}) + " " + String((obj(JSON.parse(out[1] ?? "{}")) ?? {})["id"]), "2 oversize 18");

// a bounded number of subscriptions per process (the BFF holds one per browser view): beyond it too_many, unsub frees one
let last: Obj = {}; for (let i = 0; i < 80; i++) { last = one("{\"id\":" + String(100 + i) + ",\"m\":\"sub\",\"p\":{\"topic\":\"sessions\",\"limit\":" + String(1 + i) + "}}"); }
eq("subs capped", String(sv.hub.subs.size) + " " + errCode(last), "64 too_many");
const anySub = [...sv.hub.subs.keys()][0] ?? "";
one("{\"id\":190,\"m\":\"unsub\",\"p\":{\"sub\":\"" + anySub + "\"}}");
eq("unsub frees one", str(ok(one("{\"id\":191,\"m\":\"sub\",\"p\":{\"topic\":\"sessions\"}}"))["sub"]) ? "ok" : "no", "ok");

console.log(bad ? bad + " failed" : "serve/proto: all checks passed");
if (bad) process.exit(1);
