// agentglass — self-check for the OpenCode adapter against the real fixture DB: scriptc build src/harness/opencode.check.ts -o oc && ./oc
// SPDX-License-Identifier: Apache-2.0
// Run from the repo root (reads specs/pi-opencode-harnesses/fixtures/opencode.sql); needs the real sqlite3 CLI.
import { execFileSync } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { newSess, type Ev, type Sess } from "../model/types.ts";
import { newAcc, type Acc } from "../features/usage/record.ts";
import { S } from "../state.ts";
import { parseEvents, sourceOf, busy } from "./index.ts";
import { opencode } from "./opencode.ts";
import type { Live } from "./types.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-oc-check"; mkdirSync(dir, { recursive: true });
const db = dir + "/opencode.db";
for (const f of [db, db + "-wal", db + "-shm", db + "-journal"]) { try { unlinkSync(f); } catch (e) { /* none */ } }
execFileSync("sqlite3", [db], { input: readFileSync("specs/pi-opencode-harnesses/fixtures/opencode.sql", "utf8"), stdio: ["pipe", "ignore", "inherit"] });
function sql(s: string): string { return execFileSync("sqlite3", [db, s], { encoding: "utf8" }).trim(); }
process.env["OPENCODE_DB"] = db;
process.env["XDG_STATE_HOME"] = dir + "/state";
delete process.env["AGENTGLASS_SQLITE3"];

const P2 = "ses_f12acb259ffeoToIvxeAjWIeys"; const C2 = "ses_f12ac8b5bffe043s7U74AHb6nX"; // 2.0.19: todo app + README subagent
const P1 = "ses_f12aab5d0ffeu2RLy9BOMcKvLL"; const C1 = "ses_f12a9729fffesb0u1Wl7KocrAC"; // 1.18.33: write + task subagent
const byId = new Map<string, Sess>();
let added = 0;
function scan(): void {
  added = 0;
  opencode.scan((path: string, id: string, parent: string, archived: boolean) => {
    added++;
    if (byId.has(id)) return;
    const s = newSess("opencode", id, path, archived); s.parent = parent;
    const m = opencode.meta; if (m) m(s);
    byId.set(id, s);
  });
}
function sess(id: string): Sess { const s = byId.get(id); if (!s) throw new Error("no session " + id); return s; }
const src = sourceOf("opencode");
function end(s: Sess): number { const st = src.stat(s); return st ? st.size : -1; }
function events(s: Sess, from: number, to: number): Ev[] { const evs: Ev[] = []; for (const l of src.lines(s, from, to).lines) parseEvents("opencode", l, evs, s); return evs; }
function kinds(evs: Ev[]): string { return evs.map((e: Ev) => e.kind).join(" "); }
function distinct(evs: Ev[]): string { const k: string[] = []; for (const e of evs) if (k.indexOf(e.kind) < 0) k.push(e.kind); return k.join(" "); }

// ── discovery: both schemas, parents linked, one row per id ──
scan();
ok("four sessions (2.x + 1.x)", added === 4, String(added));
ok("2.x subagent linked to its parent", byId.has(C2) && sess(C2).parent === P2 && sess(C2).kind === "general", byId.has(C2) ? sess(C2).parent + "/" + sess(C2).kind : "missing");
ok("1.x subagent linked to its parent", byId.has(C1) && sess(C1).parent === P1, byId.has(C1) ? sess(C1).parent : "missing");
ok("cwd known at scan time", sess(P2).cwd === "/tmp/agtest-oc" && sess(P1).cwd === "/tmp/agtest-oc1", sess(P2).cwd + " " + sess(P1).cwd);
const title = opencode.title; const tt = (s: Sess): string => title ? title(s) : "";
ok("title from the session row", tt(sess(P2)) === "Minimal todo web app with localStorage", tt(sess(P2)));
const spawn = opencode.spawnOf; const sp = (s: Sess): string => spawn ? spawn(s) : "";
ok("2.x spawnOf = the parent's subagent call", sp(sess(C2)) === "toolu_01NUutkj1dxD1m55v5WZnjfU", sp(sess(C2)));
ok("1.x spawnOf = the parent's task call", sp(sess(C1)) === "toolu_019x755kL1treKSxzyo6T2Kh", sp(sess(C1)));
ok("idle", !busy(sess(P2)) && !busy(sess(P1)), "busy");

sql("insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) values ('" + P2 + "','global','dup','/tmp/agtest-oc','v1 copy','1.18.33',1,2)");
scan();
ok("an id in both schemas is listed once", added === 4, String(added));
ok("… with the 2.x title", tt(sess(P2)) === "Minimal todo web app with localStorage", tt(sess(P2)));

// ── records: kinds, cursor over seq gaps ──
const e0 = end(sess(P2));
ok("2.x end = max(seq)+1", e0 === 76, String(e0));
const pe = events(sess(P2), 0, e0);
ok("2.x kinds", distinct(pe) === "user assistant tool result meta", distinct(pe));
ok("2.x subagent transcript", kinds(events(sess(C2), 0, end(sess(C2)))) === "user tool result assistant meta", kinds(events(sess(C2), 0, end(sess(C2)))));
const call = pe.find((e: Ev) => e.kind === "tool"); const res = pe.find((e: Ev) => e.kind === "result");
ok("call ↔ result paired by id", !!call && !!res && call.id !== "" && call.id === res.id, (call ? call.id : "-") + "/" + (res ? res.id : "-"));
ok("tool text is name\\0arg", !!call && call.text === "write\u0000/tmp/agtest-oc/index.html", call ? JSON.stringify(call.text) : "-");
ok("idle row = turn complete", pe.length > 0 && pe[pe.length - 1].text === "turn complete", pe.length ? pe[pe.length - 1].text : "-");
ok("model from the assistant row", sess(P2).model === "claude-sonnet-5-5", sess(P2).model);
const r2 = src.lines(sess(P2), 2, e0);
ok("lines from 2 start at seq 4", r2.lines.length === 10 && r2.lines[0].startsWith("{\"type\":\"user\",\"seq\":4,") && r2.next === e0, r2.lines.length + " " + (r2.lines.length ? r2.lines[0].slice(0, 40) : "") + " next " + r2.next);
ok("a gap never stalls the cursor", src.lines(sess(P2), 6, 12).lines.length === 0 && src.lines(sess(P2), 6, 12).next === 12, JSON.stringify(src.lines(sess(P2), 6, 12)));
ok("align is identity", src.align(sess(P2), 7) === 7, String(src.align(sess(P2), 7)));
sql("insert into session_message (id,session_id,type,seq,time_created,time_updated,data) values ('msg_new1','" + P2 + "','user',90,1790688200000,1790688200000,'{\"time\":{\"created\":1790688200000},\"text\":\"one more thing\",\"files\":[]}')");
scan();
const e1 = end(sess(P2));
const r3 = src.lines(sess(P2), e0, e1);
ok("new row after a gap: read from the old end", e1 === 91 && r3.lines.length === 1 && r3.lines[0].indexOf("\"seq\":90") > 0 && r3.next === 91, e1 + " " + JSON.stringify(r3));
ok("mtime follows the newest row", src.stat(sess(P2)) !== null && (src.stat(sess(P2)) ?? { size: 0, mtime: 0 }).mtime === 1790688200000, JSON.stringify(src.stat(sess(P2))));
const v1e = events(sess(P1), 0, end(sess(P1)));
ok("1.x end = part count", end(sess(P1)) === 14, String(end(sess(P1))));
ok("1.x kinds", kinds(v1e) === "user tool result assistant user tool result assistant", kinds(v1e));
const v1s = src.lines(sess(P1), 2, 4);
ok("1.x cursor = part ordinal", v1s.lines.length === 2 && v1s.next === 4 && v1s.lines[0].indexOf("\"callID\":\"toolu_0113XPoVHapUyKnfTLUv3pg1\"") > 0, JSON.stringify(v1s).slice(0, 200));

// ── usage: OpenCode's own cost where it has one, the price table where it wrote 0 ──
sql("update session_message set data=json_set(data,'$.cost',0.001*seq) where session_id='" + P2 + "' and type='assistant' and seq<60");
scan();
const a = newAcc();
for (const l of src.lines(sess(P2), 0, end(sess(P2))).lines) opencode.usage(a, l);
const want = Number(sql("select sum(json_extract(data,'$.cost')) from session_message where session_id='" + P2 + "' and type='assistant' and json_extract(data,'$.cost')>0"));
const nTools = Number(sql("select count(*) from session_message m, json_each(m.data,'$.content') c where m.session_id='" + P2 + "' and json_extract(c.value,'$.type')='tool'"));
const inTok = Number(sql("select sum(json_extract(data,'$.tokens.input')) from session_message where session_id='" + P2 + "' and type='assistant'"));
const zero = a.cost - want; // the seq-70 row (cost 0) is priced from the table
ok("usage books OpenCode's cost + table price for cost 0", want > 0 && zero > 0 && zero < 0.05 && a.unk === 0, a.cost + " vs " + want);
ok("usage tools", a.tools === nTools && a.pend.size === 0, a.tools + "/" + nTools + " pending " + a.pend.size);
ok("usage input tokens", a.inTok === inTok, a.inTok + "/" + inTok);
ok("usage lines from write/edit", a.add > 0, String(a.add));
const b = newAcc();
for (const l of src.lines(sess(P1), 0, end(sess(P1))).lines) opencode.usage(b, l);
const in1 = Number(sql("select sum(json_extract(data,'$.tokens.input')) from part where session_id='" + P1 + "' and json_extract(data,'$.type')='step-finish'"));
const in1m = Number(sql("select sum(json_extract(data,'$.tokens.input')) from message where session_id='" + P1 + "' and json_extract(data,'$.role')='assistant'"));
ok("1.x usage = step-finish parts, not also the messages", b.inTok === in1 && in1 === in1m && b.tools === 2 && b.pend.size === 0, b.inTok + "/" + in1 + " tools " + b.tools);

// ── forks: the rows a fork copied from its parent are the parent's usage, not the fork's ──
const F2 = "ses_fork2"; const F1 = "ses_fork1";
sql("insert into session_v2 (id,project_id,slug,directory,title,version,fork_session_id,time_created,time_updated) values ('" + F2 + "','global','fk2','/tmp/agtest-oc','fork (fork #1)','2.0.19','" + P2 + "',1790688250000,1790688260000)");
sql("insert into session_message (id,session_id,type,seq,time_created,time_updated,data) select 'f_'||id,'" + F2 + "',type,seq,time_created,time_updated,data from session_message where session_id='" + P2 + "'");
sql("insert into session_message (id,session_id,type,seq,time_created,time_updated,data) values ('f_new','" + F2 + "','assistant',91,1790688260000,1790688260000,'" +
  "{\"time\":{\"created\":1790688260000,\"completed\":1790688260500},\"agent\":\"build\",\"model\":{\"id\":\"claude-sonnet-5-5\"},\"content\":[{\"type\":\"tool\",\"id\":\"tf2\",\"name\":\"write\",\"state\":{\"status\":\"completed\",\"input\":{\"path\":\"/tmp/agtest-oc/n.txt\",\"content\":\"a\\nb\"},\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]},\"time\":{\"created\":1790688260000,\"ran\":1790688260000,\"completed\":1790688260100}}],\"cost\":0.5,\"tokens\":{\"input\":7,\"output\":3,\"reasoning\":0,\"cache\":{\"read\":0,\"write\":0}}}')");
sql("insert into session (id,project_id,slug,directory,title,version,time_created,time_updated) values ('" + F1 + "','global','fk1','/tmp/agtest-oc1','v1 fork (fork #1)','1.18.33',1790688280000,1790688290000)");
sql("insert into message (id,session_id,time_created,time_updated,data) select 'f_'||id,'" + F1 + "',time_created,time_updated,data from message where session_id='" + P1 + "'");
sql("insert into part (id,message_id,session_id,time_created,time_updated,data) select 'f_'||id,'f_'||message_id,'" + F1 + "',time_created,time_updated,data from part where session_id='" + P1 + "'");
sql("insert into message (id,session_id,time_created,time_updated,data) values ('msg_fnew','" + F1 + "',1790688290000,1790688290000,'{\"role\":\"assistant\",\"modelID\":\"claude-sonnet-5-5\",\"time\":{\"created\":1790688290000,\"completed\":1790688290500}}')");
sql("insert into part (id,message_id,session_id,time_created,time_updated,data) values ('prt_fnew','msg_fnew','" + F1 + "',1790688290000,1790688290000,'{\"type\":\"step-finish\",\"cost\":0.25,\"tokens\":{\"input\":7,\"output\":3,\"reasoning\":0,\"cache\":{\"read\":0,\"write\":0}}}')");
scan();
function useOf(s: Sess): Acc { const u = newAcc(); for (const l of src.lines(s, 0, end(s)).lines) opencode.usage(u, l); return u; }
const fa = useOf(sess(F2));
ok("2.x fork: copied rows add no cost/tokens/tools/lines", Math.abs(fa.cost - 0.5) < 1e-9 && fa.inTok === 7 && fa.tools === 1 && fa.add === 2 && fa.pend.size === 0, fa.cost + " in " + fa.inTok + " tools " + fa.tools + " add " + fa.add);
ok("2.x fork: the transcript still shows the copied rows", events(sess(F2), 0, end(sess(F2))).length > events(sess(F2), 91, end(sess(F2))).length, "");
const fb = useOf(sess(F1));
ok("1.x fork: copied parts add no cost/tokens/tools", Math.abs(fb.cost - 0.25) < 1e-9 && fb.inTok === 7 && fb.tools === 0, fb.cost + " in " + fb.inTok + " tools " + fb.tools);
const pa = useOf(sess(P2));
ok("the fork's parent keeps its own usage", pa.inTok === a.inTok && pa.tools === a.tools, pa.inTok + "/" + a.inTok);

// ── full text ──
const se = opencode.search; const found = se ? se("todo") : [];
ok("search finds the 2.x session", found.indexOf(sess(P2).path) >= 0, found.join(","));
const f1 = se ? se("hello.txt") : [];
ok("search finds the 1.x session", f1.indexOf(sess(P1).path) >= 0, f1.join(","));
ok("search: LIKE wildcards are literal", (se ? se("t_d%") : ["x"]).length === 0, "");

// ── busy + live: a suspended session with a message still streaming, run by a live daemon ──
const ME = process.pid; // stands in for the daemon: alive for the whole check
mkdirSync(dir + "/state/opencode", { recursive: true });
function daemon(pid: number): void { writeFileSync(dir + "/state/opencode/service.json", JSON.stringify({ id: "x", version: "2.0.19", url: "http://127.0.0.1:1", pid, password: "keepme" })); }
function row(id: string, type: string, seq: number, data: string): void {
  sql("insert into session_message (id,session_id,type,seq,time_created,time_updated,data) values ('" + id + "','" + P2 + "','" + type + "'," + String(seq) + ",1790688300000,1790688300000,'" + data + "')");
}
const ASST = "\"agent\":\"build\",\"model\":{\"id\":\"claude-sonnet-5-5\"},\"content\":[{\"type\":\"text\",\"text\":\"work\"}]";
daemon(ME);
row("msg_old", "assistant", 92, "{\"time\":{\"created\":1790688300000}," + ASST + "}"); // an earlier turn that never finished its step
row("msg_oldidle", "idle", 93, "{\"time\":{\"created\":1790688300000},\"outcome\":\"interrupted\"}");
sql("update session_v2 set time_suspended=1790688300000 where id='" + P2 + "'");
row("msg_done", "assistant", 94, "{\"time\":{\"created\":1790688300000,\"completed\":1790688300500}," + ASST + "}");
row("msg_run", "assistant", 95, "{\"time\":{\"created\":1790688300000}," + ASST + "}");
scan();
ok("suspended + live daemon = busy", busy(sess(P2)), "idle");
ok("the running turn's finished rows are readable, an old unfinished turn doesn't hold them", end(sess(P2)) === 95 && src.lines(sess(P2), 91, 95).lines.length === 3, String(end(sess(P2))));
const lr = opencode.liveRegistry;
function reg(alive: (pid: number) => boolean): Live[] { return lr ? lr(alive) : []; }
const live = reg((pid: number) => pid === ME);
ok("the daemon runs the suspended session", live.some((l: Live) => l.id === P2 && l.pid === ME && l.status === "busy") && live.some((l: Live) => l.id === "" && l.pid === ME) && live.length === 2, JSON.stringify(live));
ok("dead daemon: nothing live", reg((pid: number) => pid < 0).length === 0, "");
sql("update session_message set data=json_set(data,'$.time.completed',1790688301000) where id='msg_run'");
sql("update session_v2 set time_suspended=null where id='" + P2 + "'");
scan();
ok("settled: readable and idle", end(sess(P2)) === 96 && src.lines(sess(P2), 95, 96).lines.length === 1 && !busy(sess(P2)), String(end(sess(P2))));
// the daemon died mid-turn: time_suspended stays set, but nothing runs the session any more
sql("update session_v2 set time_suspended=1790688400000 where id='" + P2 + "'");
row("msg_dead", "assistant", 98, "{\"time\":{\"created\":1790688400000}," + ASST + "}");
daemon(999999999);
scan();
ok("stale time_suspended without a daemon: not busy", !busy(sess(P2)) && reg((pid: number) => pid === ME).length === 0, "busy");
ok("stale time_suspended without a daemon: all rows readable", end(sess(P2)) === 99 && src.lines(sess(P2), 96, 99).lines.length === 1, String(end(sess(P2))));
rmSync(dir + "/state/opencode/service.json");
scan();
ok("no service.json: not busy", !busy(sess(P2)), "busy");

// ── 2.x without the service daemon (`--standalone`, `--server`): a suspended turn written to recently still runs ──
const IN_FLIGHT = 1800000; const now0 = Date.now();
row("msg_sidle", "idle", 99, "{\"time\":{\"created\":1790688400000},\"outcome\":\"interrupted\"}");
sql("insert into session_message (id,session_id,type,seq,time_created,time_updated,data) values ('msg_su','" + P2 + "','user',101," + now0 + "," + now0 + ",'{\"time\":{\"created\":" + now0 + "},\"text\":\"go on\",\"files\":[]}')");
sql("insert into session_message (id,session_id,type,seq,time_created,time_updated,data) values ('msg_sa','" + P2 + "','assistant',102," + now0 + "," + now0 + ",'{\"time\":{\"created\":" + now0 + "}," + ASST + "}')");
scan();
ok("no daemon, suspended, written just now: busy", busy(sess(P2)), "idle");
ok("no daemon, suspended, written just now: the streaming row is held", end(sess(P2)) === 102 && src.lines(sess(P2), 99, 102).lines.length === 2, String(end(sess(P2))));
// running is decided when asked, not when the DB was last read: an unchanged DB goes idle once the turn is IN_FLIGHT old
const old = now0 - IN_FLIGHT + 1500;
sql("update session_message set time_updated=" + old + " where id in ('msg_su','msg_sa')");
sql("insert into message (id,session_id,time_created,time_updated,data) values ('msg_v1run','" + P1 + "'," + old + "," + old + ",'{\"role\":\"assistant\",\"modelID\":\"claude-sonnet-5-5\",\"time\":{\"created\":" + old + "}}')");
scan();
ok("aging: 2.x still busy", busy(sess(P2)), "idle");
ok("aging: 1.x in flight = busy", busy(sess(P1)), "idle");
execFileSync("sleep", ["2"]);
scan();
ok("aged without a DB change: 2.x idle, all rows readable", !busy(sess(P2)) && end(sess(P2)) === 103, (busy(sess(P2)) ? "busy " : "idle ") + String(end(sess(P2))));
ok("aged without a DB change: 1.x idle", !busy(sess(P1)), "busy");

// ── no sqlite3: nothing listed, one warning, fast ──
process.env["AGENTGLASS_SQLITE3"] = "/bin/false";
S.toast = "";
let t0 = Date.now();
scan(); scan();
ok("no sqlite3: no sessions", added === 0, String(added));
ok("no sqlite3: fast", Date.now() - t0 < 500, String(Date.now() - t0) + " ms");
ok("no sqlite3: one warning", S.toast.indexOf("sqlite3") >= 0, S.toast);
ok("no sqlite3: records empty", src.lines(sess(P2), 0, 99).lines.length === 0, "");
// a hanging sqlite3: one bounded stall, then back off instead of stalling every tick
const hang = dir + "/hang.sh"; writeFileSync(hang, "#!/bin/sh\n[ \"$1\" = -version ] && exit 0\nexec sleep 10\n"); chmodSync(hang, 493);
process.env["AGENTGLASS_SQLITE3"] = hang;
sql("insert into session_message (id,session_id,type,seq,time_created,time_updated,data) values ('msg_x','" + P2 + "','idle',100,1790688400000,1790688400000,'{}')");
t0 = Date.now(); scan(); const first = Date.now() - t0;
t0 = Date.now(); scan(); const second = Date.now() - t0;
ok("hung query: bounded by the 3 s limit", first >= 2500 && first < 4500, String(first) + " ms");
ok("hung query: next scan backs off", second < 500, String(second) + " ms");

console.log(bad ? bad + " failed" : "opencode: all checks passed");
process.exit(bad ? 1 : 0);
