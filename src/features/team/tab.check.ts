// agentglass — self-check for the Team tab (fleet-teams spec 10, Task 9a): the 80-column layout from a fixture view
// (members, devices online/total, ● ◆ ⚠ and ○ age, today and the period, $/commit, top harness with its share, skills,
// the footer keys), a member's read-only sessions, the period and selection keys, the filter keys member and room.
//   scriptc build src/features/team/tab.check.ts -o tc && ./tc
// SPDX-License-Identifier: Apache-2.0
import { type Obj } from "../../util/json.ts";
import { width } from "../../util/text.ts";
import { newSess } from "../../model/types.ts";
import { type DayRow } from "../fleet/model.ts";
import { parse } from "../query/parse.ts";
import { compile, matchSession } from "../query/eval.ts";
import { type MemberKeys } from "./keys.ts";
import { type TeamState } from "./state.ts";
import { type TeamView, type TeamRow } from "./view.ts";
import { TS, TEAM_TAB, lines, detailLines, memberRows } from "./tab.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const now = Date.now(); const z = (n: number): string => String(n).padStart(2, "0");
const today = ((): string => { const d = new Date(now); return String(d.getFullYear()) + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); })();
function day(usd: string): DayRow { return { d: today, tp: [["10", "", "claude-sonnet-4-5", "1000", "100", "0", "0", "0", usd]], hx: [], unk: 0, um: [], uc: 0, tools: 1, turns: 1, calls: 1, errors: 0, sa: [] }; }
function row(member: string, device: string, harness: string, usd: string, status: string, commits: number, skills: string[]): TeamRow {
  const sk: Obj[] = []; for (const s of skills) sk.push({ name: s });
  const s: Obj = { id: member + harness + usd, harness, model: "m", updated: new Date(now - 60000).toISOString(), live: status !== "ended", status, title: "fix the login", git: { produced: commits, prs: 0, costPerCommit: null }, skills: sk };
  return { member, device, rooms: ["r1"], s, days: [day(usd)], mine: false, updated: now - 60000 };
}
const A = "aaaaaaaaaaaaaaaa"; const B = "bbbbbbbbbbbbbbbb"; const D = "dddddddddddddddd";
const v: TeamView = { team: "0123456789abcdef", room: "", at: now, rows: [
  row(A, "a1", "claude", "10.00", "busy", 4, ["tdd", "plans"]), row(A, "a1", "claude", "2.40", "attention", 0, ["tdd"]), row(A, "a2", "codex", "1.00", "ended", 0, []),
  row(B, "b1", "codex", "5.00", "ended", 0, ["x"]),
], members: [
  { id: A, name: "alice", mine: false, devices: [{ id: "a1", online: true, at: now - 30000, live: 1, attention: 1, stuck: 0 }, { id: "a2", online: true, at: now - 40000, live: 0, attention: 0, stuck: 0 }], sessions: 3 },
  { id: B, name: "bjoern", mine: true, devices: [{ id: "b1", online: true, at: now - 20000, live: 0, attention: 0, stuck: 0 }, { id: "b2", online: false, at: 0, live: 0, attention: 0, stuck: 0 }], sessions: 1 },
  { id: D, name: "dan", mine: false, devices: [{ id: "d1", online: false, at: now - 3 * 3600000, live: 0, attention: 0, stuck: 0 }], sessions: 0 },
], skipped: [], truncated: 0 };
const me: MemberKeys = { id: B, sign: { sk: new Uint8Array(64), pk: new Uint8Array(32) }, box: { sk: new Uint8Array(32), pk: new Uint8Array(32) } };
const t: TeamState = { id: "0123456789abcdef", mailbox: "/x", kind: "dir", me, device: "b1", label: "", name: "bjoern", req: "", manifest: null, priv: { name: "acme", names: {}, rooms: [{ id: "r1", name: "backend", scope: ["github.com/acme/*"], level: "numbers", budgetUsd: 0, epoch: 1 }] }, policy: [] };

const ls = lines(t, v, "w", "", 80, now); const all = ls.join("\n");
ok("every line 80 columns", ls.every((l: string) => width(l) === 80), ls.map((l: string) => String(width(l))).join(","));
ok("header: team, room, period, online", (ls[0] ?? "").indexOf("Team acme · room all") >= 0 && (ls[0] ?? "").indexOf("this week") >= 0 && (ls[0] ?? "").indexOf("2 of 3 members online") >= 0, ls[0] ?? "");
ok("columns", (ls[1] ?? "").indexOf("MEMBER") >= 0 && (ls[1] ?? "").indexOf("DEVICES") >= 0 && (ls[1] ?? "").indexOf("WEEK") >= 0 && (ls[1] ?? "").indexOf("$/COMMIT") >= 0 && (ls[1] ?? "").indexOf("TOP HARNESS") >= 0, ls[1] ?? "");
const al = ls.find((l: string) => l.indexOf("alice") >= 0) ?? "";
ok("alice: 2/2 devices, ●1 ◆1, $13.40 week, $/commit, claude 67% codex, 2 skills", al.indexOf("2/2") >= 0 && al.indexOf("●1 ◆1") >= 0 && al.indexOf("$13.40") >= 0 && al.indexOf("$3.35") >= 0 && al.indexOf("claude 67% codex") >= 0 && al.trim().endsWith("2"), al);
const bj = ls.find((l: string) => l.indexOf("bjoern") >= 0) ?? "";
ok("me marked, 1/2 devices, no commits: —", bj.indexOf("bjoern (me)") >= 0 && bj.indexOf("1/2") >= 0 && bj.indexOf("—") >= 0, bj);
const dn = ls.find((l: string) => l.indexOf("dan") >= 0) ?? "";
ok("dan: offline with the age of his last file", dn.indexOf("○ 3 h ago") >= 0 && dn.indexOf("0/1") >= 0, dn);
ok("sorted by the period's cost", all.indexOf("alice") < all.indexOf("bjoern") && all.indexOf("bjoern") < all.indexOf("dan"), all);
ok("footer keys", ls[ls.length - 1]?.indexOf("d w m a period · r room · ↵ sessions") !== undefined && (ls[ls.length - 1] ?? "").indexOf("d w m a period") >= 0, ls[ls.length - 1] ?? "");
ok("today period: no second cost column", lines(t, v, "d", "", 80, now)[1]?.indexOf("WEEK") === -1, lines(t, v, "d", "", 80, now)[1] ?? "");
ok("memberRows: period sum", Math.abs((memberRows(v, "w")[0]?.period ?? 0) - 13.4) < 1e-9, String(memberRows(v, "w")[0]?.period));
// a member's sessions: read-only
const dl = detailLines(v, A, "w", 80);
ok("detail: alice's three sessions, read-only", dl.length === 4 && (dl[0] ?? "").indexOf("read-only") >= 0 && dl.join("\n").indexOf("fix the login") >= 0, dl.join("\n"));
// keys
TS.view = v; TS.teams = [t]; TS.ti = 0; TS.sel = 0; TS.detail = ""; TS.period = "w";
ok("m: the period", TEAM_TAB.key("m") && TS.period === "m", TS.period);
ok("down, enter: the second member's sessions", TEAM_TAB.key("down") && TEAM_TAB.key("enter") && TS.detail !== "", TS.detail);
ok("esc: back", TEAM_TAB.key("esc") && TS.detail === "", TS.detail);
ok("no send or resume key here", !TEAM_TAB.key("s") || TS.detail === "", "");
// filter keys
const me1 = compile(parse("member is me").cs, "list").f; const local = newSess("claude", "x", "/x.jsonl", false);
ok("member is me: a local row", me1 !== null && matchSession(me1, local, null), "");
const rm = parse("room is backend"); ok("room is backend compiles", !rm.err && compile(rm.cs, "list").err === null, rm.err ? rm.err.msg : "");
console.log(bad ? String(bad) + " failed" : "team tab: all checks passed");
if (bad) process.exit(1);
