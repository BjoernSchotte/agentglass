// agentglass — self-check for the MCP tools: goldens, argv mapping, validation, cursors, shaping, content stripping, size
// caps and schema drift against the CLI's field lists. Run from the repo root (it reads testdata/mcp/):
//   scriptc build src/mcp/tools.check.ts -o tc && ./tc        (MCP_GOLDEN_WRITE=1 ./tc rewrites the goldens)
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from "node:fs";
import { type Obj, obj, arr, str } from "../util/json.ts";
import { TOOLS, defaultOpts, parseOpts, toolsList, plan, encodeCursor, decodeCursor, instructionsFor, type Opts, type Call, type ToolDef } from "./tools.ts";
import { shapeOk, shapeExit, errorShaped, stripContent, capList, capObject, type Shaped } from "./shape.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got.slice(0, 400)); } }
const J = (v: unknown): string => JSON.stringify(v);
const d = defaultOpts();
function o(over: (x: Opts) => void): Opts { const x = defaultOpts(); over(x); return x; }

// ── options ──
ok("defaults", J(d) === J({ allProjects: false, content: false, redact: false, maxBytes: 24000, timeoutMs: 50000, log: false }), J(d));
const po = parseOpts(["--all-projects", "--content", "--redact", "--max-bytes", "8000", "--timeout=20", "--log"]);
ok("parseOpts", po.err === "" && po.o.allProjects && po.o.content && po.o.redact && po.o.maxBytes === 8000 && po.o.timeoutMs === 20000 && po.o.log, J(po));
ok("parseOpts version/help", parseOpts(["--version"]).version && parseOpts(["--help"]).help && parseOpts(["-h"]).help, "");
for (const b of [["--nope"], ["--max-bytes", "100"], ["--max-bytes", "300000"], ["--timeout", "4"], ["--timeout", "601"], ["--timeout"], ["--max-bytes", "x"], ["stray"]]) ok("parseOpts refuses " + b.join(" "), parseOpts(b).err !== "", J(parseOpts(b)));

// ── goldens ──
const g1 = J(toolsList("2025-11-25")); const g0 = J(toolsList("2024-11-05"));
const G1 = "testdata/mcp/tools-2025-11-25.json"; const G0 = "testdata/mcp/tools-2024-11-05.json";
if (process.env.MCP_GOLDEN_WRITE === "1") { writeFileSync(G1, g1 + "\n"); writeFileSync(G0, g0 + "\n"); console.log("goldens written: review them"); process.exit(1); }
function file(p: string): string { try { return readFileSync(p, "utf8"); } catch (e) { return ""; } }
ok("golden 2025-11-25", g1 === file(G1).trimEnd(), "differs from " + G1 + " (MCP_GOLDEN_WRITE=1 rewrites it; a change is a contract change)");
ok("golden 2024-11-05", g0 === file(G0).trimEnd(), "differs from " + G0);
ok("2024-11-05: no outputSchema/title/annotations", g0.indexOf("\"outputSchema\"") < 0 && g0.indexOf("\"title\":") < 0 && g0.indexOf("\"annotations\"") < 0, "");
const t0326 = obj(arr(toolsList("2025-03-26")["tools"])[0]) ?? {};
ok("2025-03-26: title in the annotations (its Tool has none)", t0326["title"] === undefined && (obj(t0326["annotations"]) ?? {})["title"] === "Session" && (obj(t0326["annotations"]) ?? {})["readOnlyHint"] === true, J(t0326).slice(0, 200));
ok("2025-03-26: annotations, no outputSchema", J(toolsList("2025-03-26")).indexOf("\"annotations\"") > 0 && J(toolsList("2025-03-26")).indexOf("\"outputSchema\"") < 0, "");
ok("2025-11-25: outputSchema", g1.indexOf("\"outputSchema\"") > 0 && g1.indexOf("\"readOnlyHint\":true") > 0, "");
// 9 KB for the 11 tools of mcp-server; 10 KB with skill-usage's events tool; 10.5 KB with its skills tool (13 tools, its
// schema 629 bytes at its leanest: ≈ 2.6k tokens in all, +160 bytes over 10 KB)
ok("tools/list ≤ 10.5 KB", new TextEncoder().encode(g1).length <= 10752, String(new TextEncoder().encode(g1).length));
ok("13 tools in order", TOOLS.map((t: ToolDef) => t.name).join(" ") === "session sessions errors cost triage compare related events skills contention waits fleet prices", TOOLS.map((t: ToolDef) => t.name).join(" "));
for (const t of TOOLS) ok("description ≤ 200: " + t.name, t.description.length <= 200 && t.description.length > 40, String(t.description.length));
const ins = instructionsFor("project"); const insAll = instructionsFor("all projects");
ok("instructions ≤ 600", ins.length <= 600 && insAll.length <= 600 && ins.indexOf("(project)") > 0 && insAll.indexOf("(all projects)") > 0, ins);

// ── argv mapping ──
const A = (c: Call): string => J(c.argv);
const SF = "id,harness,title,project,updated,live,status,costUsd,attention,stuck";
const s5 = plan("sessions", { since: "7d", live: true, limit: 5, cursor: encodeCursor(10) }, d);
ok("sessions argv", A(s5) === J(["sessions", "--since", "7d", "--live", "--limit", "16", "--format", "json", "--fields", SF]) && s5.offset === 10 && s5.limit === 5 && s5.err === "", J(s5));
const sd = plan("sessions", {}, d);
ok("sessions defaults", A(sd) === J(["sessions", "--since", "24h", "--limit", "21", "--format", "json", "--fields", SF]) && sd.limit === 20, A(sd));
ok("sessions harness filter", A(plan("sessions", { harness: "pi", filter: "cost > 2" }, d)) === J(["sessions", "--since", "24h", "--harness", "pi", "--filter=cost > 2", "--limit", "21", "--format", "json", "--fields", SF]), A(plan("sessions", { harness: "pi", filter: "cost > 2" }, d)));
ok("sessions fields", A(plan("sessions", { fields: ["id", "model"] }, d)).indexOf("\"--fields\",\"id,model\"") > 0, A(plan("sessions", { fields: ["id", "model"] }, d)));
const SESSF = "id,harness,title,cwd,live,status,updated,costUsd,costBasis,tokens,turns,wallMs,activeMs,models,tools,errors,files,repeats,attention,stuck,alerts,via";
ok("session current", A(plan("session", {}, d)) === J(["session", "current", "--format", "json", "--fields", SESSF]), A(plan("session", {}, d)));
ok("session ref root", A(plan("session", { ref: "claude:abc123", root: true }, d)) === J(["session", "claude:abc123", "--root", "--format", "json", "--fields", SESSF]), A(plan("session", { ref: "claude:abc123", root: true }, d)));
ok("errors", A(plan("errors", {}, d)) === J(["errors", "--since", "24h", "--limit", "21", "--format", "json", "--fields", "ts,harness,session,tool,arg,durationMs"]), A(plan("errors", {}, d)));
ok("errors ref: all its history", A(plan("errors", { ref: "last", limit: 3 }, d)) === J(["errors", "last", "--limit", "4", "--format", "json", "--fields", "ts,harness,session,tool,arg,durationMs"]), A(plan("errors", { ref: "last", limit: 3 }, d)));
ok("errors --content: text", A(plan("errors", {}, o((x) => { x.content = true; }))).indexOf("arg,text,durationMs") > 0, A(plan("errors", {}, o((x) => { x.content = true; }))));
ok("cost bare", A(plan("cost", {}, d)) === J(["cost", "--format", "json"]), A(plan("cost", {}, d)));
ok("cost by", A(plan("cost", { since: "7d", by: "model" }, d)) === J(["cost", "--since", "7d", "--by", "model", "--format", "json"]), A(plan("cost", { since: "7d", by: "model" }, d)));
ok("cost by only", A(plan("cost", { by: "harness" }, d)) === J(["cost", "--since", "today", "--by", "harness", "--format", "json"]), A(plan("cost", { by: "harness" }, d)));
ok("skills: period table, no advice", A(plan("skills", {}, d)) === J(["skills", "--json", "--period", "30d", "--advice", "0"]), A(plan("skills", {}, d)));
ok("skills: repo, name, advise", A(plan("skills", { period: "7d", repo: "agentglass", name: "brainstorming", advise: true }, d)) === J(["skills", "--json", "--period", "7d", "--repo", "agentglass", "--name", "brainstorming", "--advice", "10"]), A(plan("skills", { period: "7d", repo: "agentglass", name: "brainstorming", advise: true }, d)));
ok("skills: ref = that session's loads", A(plan("skills", { ref: "current" }, d)) === J(["skills", "--session", "current", "--json"]), A(plan("skills", { ref: "current" }, d)));
ok("skills: bad period", plan("skills", { period: "1y" }, d).err.indexOf("period must be one of") === 0, plan("skills", { period: "1y" }, d).err);
ok("skills: a name is no flag", plan("skills", { name: "-x" }, d).err !== "", plan("skills", { name: "-x" }, d).err);
ok("triage", A(plan("triage", { preset: "errors" }, d)) === J(["triage", "--json", "--preset", "errors", "--limit", "10"]), A(plan("triage", { preset: "errors" }, d)));
ok("triage full", A(plan("triage", { select: "tool is Bash", baseline: "previous", entity: "call", days: 30, limit: 5 }, d)) === J(["triage", "--json", "--select=tool is Bash", "--baseline", "previous", "--entity", "call", "--days", "30", "--limit", "5"]), A(plan("triage", { select: "tool is Bash", baseline: "previous", entity: "call", days: 30, limit: 5 }, d)));
ok("compare sessions", A(plan("compare", { sessions: ["last", "current"] }, d)) === J(["compare", "last", "current", "--json"]), A(plan("compare", { sessions: ["last", "current"] }, d)));
ok("compare groups", A(plan("compare", { a: "model ~ opus", b: "model ~ sonnet" }, d)) === J(["compare", "--a=model ~ opus", "--b=model ~ sonnet", "--json"]), A(plan("compare", { a: "model ~ opus", b: "model ~ sonnet" }, d)));
ok("compare no subagents", A(plan("compare", { a: "x", b: "y", subagents: false, filter: "repo is r" }, d)) === J(["compare", "--a=x", "--b=y", "--json", "--filter=repo is r", "--no-subagents"]), A(plan("compare", { a: "x", b: "y", subagents: false, filter: "repo is r" }, d)));
ok("related", A(plan("related", {}, d)) === J(["--json", "--related", "current", "--minutes", "10"]), A(plan("related", {}, d)));
const rl = plan("related", { ref: "last", event: "toolu_01", at: "2026-10-01T10:00:00Z", minutes: 5, limit: 7 }, d);
ok("related full", A(rl) === J(["--json", "--related", "last", "--event", "toolu_01", "--at", "2026-10-01T10:00:00Z", "--minutes", "5"]) && rl.limit === 7, A(rl));
ok("contention kind", A(plan("contention", { kind: "test" }, d)) === J(["wait", "--check", "--json", "--kind", "test"]), A(plan("contention", { kind: "test" }, d)));
ok("contention family max", A(plan("contention", { family: "pnpm test", max: 2 }, d)) === J(["wait", "--check", "--json", "--family", "pnpm test", "--max", "2"]), A(plan("contention", { family: "pnpm test", max: 2 }, d)));
ok("waits", A(plan("waits", {}, d)) === J(["wait", "--json", "--since", "7d", "--by", "family", "--limit", "15"]), A(plan("waits", {}, d)));
ok("waits by tool", A(plan("waits", { since: "30d", by: "tool", filter: "harness is pi", limit: 3 }, d)) === J(["wait", "--json", "--since", "30d", "--by", "tool", "--filter=harness is pi", "--limit", "3"]), "");
ok("fleet", A(plan("fleet", {}, d)) === J(["fleet", "status", "--json"]), A(plan("fleet", {}, d)));
ok("prices", A(plan("prices", {}, d)) === J(["prices", "--json", "--unpriced"]), A(plan("prices", {}, d)));
ok("prices all", A(plan("prices", { unpriced: false, model: "gpt-6-sol" }, d)) === J(["prices", "--json"]), A(plan("prices", { unpriced: false, model: "gpt-6-sol" }, d)));
const all = o((x) => { x.allProjects = true; x.redact = true; });
for (const t of ["session", "sessions", "errors", "cost", "triage", "related", "waits"]) {
  const a = plan(t, {}, all).argv;
  ok("--all-projects for " + t, a.indexOf("--all-projects") >= 0 && a.indexOf("--redact") >= 0, J(a));
}
ok("--all-projects for compare", plan("compare", { a: "x", b: "y" }, all).argv.indexOf("--all-projects") >= 0, "");
for (const t of ["contention", "fleet", "prices"]) { const a = plan(t, {}, all).argv; ok("host-wide " + t + ": no --all-projects", a.indexOf("--all-projects") < 0 && a.indexOf("--redact") >= 0, J(a)); }
ok("heartbeat label", plan("contention", {}, d).heartbeat === "agentglass wait --check" && plan("session", {}, d).heartbeat === "agentglass session", plan("contention", {}, d).heartbeat);
ok("unknown tool", plan("nope", {}, d).err === "unknown tool" && plan("nope", {}, d).argv.length === 0, J(plan("nope", {}, d)));

// ── validation: an error and no argv ──
const BAD: [string, Obj][] = [
  ["session", { ref: "--all-projects" }], ["session", { ref: "a b" }], ["session", { ref: "x".repeat(129) }], ["session", { ref: "-x" }], ["session", { ref: 5 }],
  ["sessions", { filter: "x".repeat(513) }], ["sessions", { filter: "--x" }], ["sessions", { filter: "--all-projects" }],
  ["sessions", { limit: 0 }], ["sessions", { limit: 101 }], ["sessions", { limit: "5" }], ["sessions", { limit: 2.5 }], ["sessions", { live: "yes" }],
  ["sessions", { harness: "cursor" }], ["sessions", { fields: ["nope"] }], ["sessions", { fields: ["--all-projects"] }], ["sessions", { fields: "id" }], ["sessions", { fields: [] }],
  ["sessions", { since: "--all-projects" }], ["sessions", { since: "yesterday" }],
  ["compare", { sessions: ["last", "current"], a: "x", b: "y" }], ["compare", { a: "x" }], ["compare", { sessions: ["last"] }], ["compare", {}], ["compare", { sessions: ["last", "--all-projects"] }],
  ["related", { minutes: 61 }], ["related", { minutes: 0 }], ["related", { at: "yesterday" }], ["related", { event: "a;b" }],
  ["sessions", { cursor: "zz" }], ["sessions", { cursor: "o:1" }], ["sessions", { x: 1 }], ["fleet", { refresh: true }],
  ["contention", { kind: "vcs" }], ["contention", { kind: "test", family: "tsc" }], ["contention", { max: 33 }], ["contention", { family: "-x" }],
  ["triage", { days: 91 }], ["triage", { preset: "nope" }], ["triage", { limit: 51 }], ["waits", { by: "day" }], ["cost", { by: "week" }],
  ["prices", { model: "a b" }], ["prices", { unpriced: 1 }],
];
for (const [t, a] of BAD) { const c = plan(t, a, d); ok("refused " + t + " " + J(a).slice(0, 60), c.err !== "" && c.argv.length === 0, J(c)); }

// ── cursor ──
ok("cursor round trip", decodeCursor(encodeCursor(40)) === 40 && decodeCursor(encodeCursor(0)) === 0, encodeCursor(40));
ok("cursor base64url", /^[A-Za-z0-9_-]+$/.test(encodeCursor(123456)), encodeCursor(123456));
ok("cursor malformed", decodeCursor("o:1") === -1 && decodeCursor("") === -1 && decodeCursor("!!") === -1 && decodeCursor(encodeCursor(-1)) === -1, "");

// ── shaping ──
function rows(n: number, f: (i: number) => Obj): Obj[] { const r: Obj[] = []; for (let i = 0; i < n; i++) r.push(f(i)); return r; }
const p20 = plan("sessions", {}, d);
const sh = shapeOk(p20, J(rows(21, (i: number): Obj => ({ id: "s" + String(i) }))), "project", d);
const so = sh.obj; const sr = arr(so["rows"]);
ok("sessions page", sr.length === 20 && so["next"] === encodeCursor(20) && so["truncated"] === false && so["scope"] === "project" && !sh.isError, J(so).slice(0, 200));
ok("text = structured", sh.text === J(so), sh.text.slice(0, 100));
const p2 = plan("sessions", { limit: 5, cursor: encodeCursor(20) }, d);
const sh2 = shapeOk(p2, J(rows(23, (i: number): Obj => ({ id: "s" + String(i) }))), "all", d);
ok("sessions second page", J(arr(sh2.obj["rows"]).map((r: unknown) => str((obj(r) ?? {})["id"]))) === J(["s20", "s21", "s22"]) && sh2.obj["next"] === null && sh2.obj["scope"] === "all", J(sh2.obj));
const er = shapeOk(plan("errors", {}, d), J({ rows: rows(3, (i: number): Obj => ({ ts: "t", tool: "Bash", text: "CANARY" })), source: "calls", scope: "project" }), "project", d);
ok("errors envelope", arr(er.obj["rows"]).length === 3 && er.text.indexOf("CANARY") < 0 && er.obj["next"] === null, er.text);
const erc = shapeOk(plan("errors", {}, o((x) => { x.content = true; })), J({ rows: [{ ts: "t", text: "CANARY" }], source: "calls", scope: "project" }), "project", o((x) => { x.content = true; }));
ok("errors --content keeps text", erc.text.indexOf("CANARY") > 0, erc.text);
const cnow = { at: "x", host: "local", load1: 3.5, cpus: 32, memAvailPct: 40, heavyRunning: 3, running: [
  { session: "a", harness: "claude", family: "pnpm test", kind: "test", heavy: true, ageSec: 10, rssMb: 900, bg: false },
  { session: "b", harness: "pi", family: "pnpm test", kind: "test", heavy: true, ageSec: 50, rssMb: 800, bg: false },
  { session: "c", harness: "codex", family: "tsc", kind: "typecheck", heavy: true, ageSec: 5, rssMb: 600, bg: false },
  { session: "d", harness: "codex", family: "git status", kind: "vcs", heavy: false, ageSec: 99, rssMb: 6, bg: false }] };
const ct = shapeExit(plan("contention", {}, d), 3, J({ now: cnow, check: { family: null, kind: null, max: 3, running: 3, over: true } }), "", "project", d);
ok("contention exit 3 is data", !ct.isError && ct.obj["go"] === false && str(ct.obj["advice"]).startsWith("3 heavy commands running (pnpm test ×2, tsc)"), J(ct.obj));
ok("contention shape", J(Object.keys(ct.obj)) === J(["go", "heavyRunning", "max", "running", "load1", "cpus", "memAvailPct", "advice", "scope"]) && ct.obj["scope"] === "host", J(Object.keys(ct.obj)));
const cr = arr(ct.obj["running"]).map((r: unknown) => str((obj(r) ?? {})["session"])).join();
ok("contention running: heavy oldest first, then others", cr === "b,a,c,d", cr);
ok("contention running: no bg field", J(ct.obj).indexOf("\"bg\"") < 0, J(ct.obj));
const cg = shapeOk(plan("contention", {}, d), J({ now: { load1: 1, cpus: 8, memAvailPct: 50, heavyRunning: 0, running: [] }, check: { max: 3, running: 0, over: false } }), "project", d);
ok("contention go", cg.obj["go"] === true && cg.obj["advice"] === "0 heavy commands running: go", J(cg.obj));
const c1 = shapeOk(plan("contention", {}, d), J({ now: { load1: 1, cpus: 8, memAvailPct: 50, heavyRunning: 1, running: [cnow.running[2]] }, check: { max: 3, running: 1, over: false } }), "project", d);
ok("contention singular", c1.obj["advice"] === "1 heavy command running (tsc): go", J(c1.obj["advice"]));
const fl = shapeExit(plan("fleet", {}, d), 2, "", "{\"error\":{\"code\":\"usage\",\"message\":\"no hosts configured\",\"hint\":\"add …\"}}\n", "project", d);
ok("fleet without hosts", !fl.isError && J(fl.obj) === J({ hosts: [], configured: false }), J(fl.obj));
const fo = shapeOk(plan("fleet", {}, d), J({ localName: "ws", hostId: "h", hosts: [{ name: "lab" }] }), "project", d);
ok("fleet hosts", fo.obj["configured"] === true && arr(fo.obj["hosts"]).length === 1, J(fo.obj));
const ns = shapeExit(plan("session", {}, d), 3, "", "{\"error\":{\"code\":\"no_current_session\",\"message\":\"no current session\",\"hint\":\"session not written yet\"}}\n", "project", d);
ok("session exit 3: isError", ns.isError && J(ns.obj) === J({ error: { code: "no_current_session", message: "no current session", hint: "session not written yet" } }) && ns.text === J(ns.obj), J(ns.obj));
const junk = shapeExit(plan("session", {}, d), 1, "", "Segmentation fault\n", "project", d);
ok("exit 1 without JSON: cli error", junk.isError && str((obj(junk.obj["error"]) ?? {})["code"]) === "cli" && str((obj(junk.obj["error"]) ?? {})["message"]).indexOf("Segmentation fault") >= 0, J(junk.obj));
const pr = shapeExit(plan("prices", { model: "gpt-6-sol" }, d), 4, J({ file: "/h/.agentglass/prices.json", community: null, models: [{ model: "gpt-6-sol", source: "unpriced", via: "", estimated: false, price: null, tokens: { in: 1 }, unpricedTokens: 5, costUsd: 0 }, { model: "other", source: "unpriced", price: null, unpricedTokens: 1, estimated: false }] }), "", "project", d);
ok("prices exit 4 is data, projected, model filter", !pr.isError && J(pr.obj) === J({ models: [{ model: "gpt-6-sol", source: "unpriced", price: null, unpricedTokens: 5, estimated: false }] }), J(pr.obj));
const wt = shapeOk(plan("waits", {}, d), J({ period: { days: 7 }, previous: {}, scope: { project: "git:x", now: "host" }, retention: {}, agentTime: { activeMs: 1 }, rows: [{ key: "pnpm test", kind: "test", heavy: true, calls: 3, timedCalls: 3, totalMs: 9, share: 0.1, p50Ms: 1, p95Ms: 2, maxMs: 3, errors: 0, errorRate: 0, prevTotalMs: 1, trend: 1, agents: 1, peak: 2, peakAt: null, atLeast2Ms: 0, atLeast3Ms: 0, slowdown: null, hist: [1, 2] }], heavy: {}, now: { running: [] }, guard: "empty", warnings: [] }), "project", d);
ok("waits shape", J(wt.obj) === J({ period: { days: 7 }, agentTime: { activeMs: 1 }, rows: [{ key: "pnpm test", kind: "test", heavy: true, calls: 3, totalMs: 9, share: 0.1, p50Ms: 1, p95Ms: 2, errors: 0, trend: 1, peak: 2 }], guard: "empty", scope: "project" }), J(wt.obj));
const bo = shapeOk(plan("cost", {}, d), "not json", "project", d);
ok("unparseable stdout: isError", bo.isError && str((obj(bo.obj["error"]) ?? {})["code"]) === "bad_output", J(bo.obj));
const es = errorShaped("busy", "2 calls running and 8 waiting", "retry in a few seconds");
ok("errorShaped", es.isError && J(es.obj) === J({ error: { code: "busy", message: "2 calls running and 8 waiting", hint: "retry in a few seconds" } }), J(es.obj));

// ── content ──
ok("strip skills: loads lose their text", J(stripContent("skills", { rows: [{ name: "alpha" }], loads: [{ name: "alpha", text: "LOREMSKILLTEXT", textHidden: null }] })) === J({ rows: [{ name: "alpha" }], loads: [{ name: "alpha" }] }), J(stripContent("skills", { rows: [], loads: [{ name: "alpha", text: "LOREMSKILLTEXT" }] })));
ok("strip session errors text", J(stripContent("session", { errors: [{ tool: "Bash", text: "CANARY" }] })) === J({ errors: [{ tool: "Bash" }] }), J(stripContent("session", { errors: [{ tool: "Bash", text: "CANARY" }] })));
const rel: Obj = { anchor: { kind: "assistant", text: "CANARY a" }, events: [{ kind: "prompt", text: "CANARY p" }, { kind: "agent", text: "CANARY g" }, { kind: "shell", text: "pnpm test" }, { kind: "thinking", text: "CANARY t" }] };
const rs = J(stripContent("related", rel));
ok("strip related", rs.indexOf("CANARY") < 0 && rs.indexOf("pnpm test") > 0, rs);
ok("strip related keeps a tool anchor", J(stripContent("related", { anchor: { kind: "shell", text: "ls" }, events: [] })).indexOf("\"ls\"") > 0, "");
ok("triage/compare untouched", J(stripContent("triage", { rows: [{ text: "x" }] })) === J({ rows: [{ text: "x" }] }), "");
const rc = shapeOk(plan("related", {}, o((x) => { x.content = true; })), J(rel), "project", o((x) => { x.content = true; }));
ok("related --content keeps", rc.text.indexOf("CANARY p") > 0, rc.text);
const rd = shapeOk(plan("related", {}, d), J(rel), "project", d);
ok("related strips by default", rd.text.indexOf("CANARY") < 0, rd.text);
// events: ref, filter, paged here; no text without the server's --content
ok("events", A(plan("events", {}, d)) === J(["events", "current", "--json"]), A(plan("events", {}, d)));
const ev = plan("events", { ref: "last", filter: "event.kind is_one_of skill, error", limit: 3 }, o((x) => { x.content = true; }));
ok("events full", A(ev) === J(["events", "last", "--json", "--filter=event.kind is_one_of skill, error", "--content"]) && ev.limit === 3, A(ev));
const evo = { matched: 4, total: 9, events: rows(4, (i: number): Obj => ({ i, kind: "user", kinds: ["prompt"], text: "CANARY " + String(i) })) };
const evs = shapeOk(plan("events", { limit: 2 }, d), J(evo), "project", d);
ok("events pages and strips", arr(evs.obj["events"]).length === 2 && evs.obj["next"] === encodeCursor(2) && evs.text.indexOf("CANARY") < 0, evs.text);
ok("events keeps text with --content", shapeOk(plan("events", {}, o((x) => { x.content = true; })), J(evo), "project", o((x) => { x.content = true; })).text.indexOf("CANARY 0") > 0, "");
const rp = shapeOk(plan("related", { limit: 2 }, d), J({ anchor: {}, events: rows(5, (i: number): Obj => ({ kind: "shell", text: String(i) })) }), "project", d);
ok("related pages events", arr(rp.obj["events"]).length === 2 && rp.obj["next"] === encodeCursor(2), J(rp.obj));

// ── caps ──
const big = rows(200, (i: number): Obj => ({ id: "r" + String(i), pad: "x".repeat(300) }));
const cl = capList(big, { next: null, truncated: false, scope: "project" }, 24000);
ok("capList fits", J({ rows: cl.rows, next: encodeCursor(cl.rows.length), truncated: true, scope: "project" }).length <= 24000 && cl.truncated && cl.rows.length > 10, String(cl.rows.length));
const capped = shapeOk(plan("sessions", { limit: 100 }, d), J(big.slice(0, 101)), "project", d);
ok("list cap through shapeOk", capped.text.length <= 24000 && capped.obj["truncated"] === true && capped.obj["next"] === encodeCursor(arr(capped.obj["rows"]).length), String(capped.text.length) + " " + J(capped.obj["next"]));
const fat: Obj = { id: "s1", files: rows(500, (i: number): Obj => ({ path: "/w/p/file" + String(i) + ".ts", n: i })), tools: [{ name: "Bash" }] };
const co = capObject(fat, 4000);
ok("capObject trims files", J(co).length <= 4000 && J(co["truncated"]).indexOf("\"files\"") >= 0 && arr(co["tools"]).length === 1, J(co).slice(0, 120));
// compare: the big arrays sit one level down (files.onlyA/onlyB); trimmed there instead of a stub for the whole result
const onlyB: string[] = []; for (let i = 0; i < 400; i++) onlyB.push("/w/p/src/file-" + String(i) + ".ts");
const cmpFat: Obj = { a: { n: 1 }, b: { n: 2 }, programs: [], files: { onlyA: [], onlyB }, both: 3 };
const cc = capObject(cmpFat, 4000);
ok("capObject trims nested arrays", J(cc).length <= 4000 && J(cc["truncated"]) === J(["files.onlyB"]) && arr((obj(cc["files"]) ?? {})["onlyB"]).length > 50 && (obj(cc["b"]) ?? {})["n"] === 2, J(cc).slice(0, 160));
ok("capObject small unchanged", J(capObject({ id: "x", files: [1] }, 4000)) === J({ id: "x", files: [1] }), "");
const one = capList([{ id: "huge", pad: "x".repeat(30000) }], { next: null, truncated: false, scope: "project" }, 24000);
ok("a single huge row", J(one.rows) === J([{ id: "huge", truncated: true }]) && one.truncated, J(one.rows).slice(0, 100));
const hugeObj = capObject({ id: "h", title: "x".repeat(30000) }, 24000);
ok("a huge object", J(hugeObj) === J({ id: "h", truncated: true }), J(hugeObj).slice(0, 100));
const nullsKept = shapeOk(plan("session", {}, d), J({ id: "s", costUsd: null, errors: [] }), "project", d);
ok("nulls pass through", nullsKept.obj["costUsd"] === null && nullsKept.obj["scope"] === "project", J(nullsKept.obj));

// ── schema drift: every outputSchema property is a CLI field (or a documented shaped one); fields enums = CLI lists ──
const cf = obj(JSON.parse(file("testdata/mcp/cli-fields.json") || "{}")) ?? {};
const SHAPED = ["scope", "next", "truncated", "rows", "via"];
function props(t: string, rowsOf: boolean): string[] {
  const tl = obj(JSON.parse(g1)) ?? {}; let r: string[] = [];
  for (const x of arr(tl["tools"])) {
    const tx = obj(x) ?? {}; if (tx["name"] !== t) continue;
    let p = obj((obj(tx["outputSchema"]) ?? {})["properties"]) ?? {};
    if (rowsOf) p = obj((obj((obj(p["rows"]) ?? {})["items"]) ?? {})["properties"]) ?? {};
    r = Object.keys(p);
  }
  return r;
}
for (const [t, cmd, rowsOf] of [["session", "session", false], ["sessions", "sessions", true], ["errors", "errors", true]] as [string, string, boolean][]) {
  const known = arr(cf[cmd]).map((x: unknown) => str(x));
  const ps = props(t, rowsOf);
  const stray = ps.filter((p: string) => known.indexOf(p) < 0 && SHAPED.indexOf(p) < 0);
  ok("outputSchema of " + t + " ⊂ CLI fields", ps.length > 3 && stray.length === 0, stray.join(","));
}
function enumOf(t: string): string[] {
  for (const x of TOOLS) if (x.name === t) return arr((obj((obj((obj(x.input["properties"]) ?? {})["fields"]) ?? {})["items"]) ?? {})["enum"]).map((v: unknown) => str(v));
  return [];
}
ok("session fields enum = CLI", J(enumOf("session")) === J(cf["session"]), J(enumOf("session")));
ok("sessions fields enum = CLI", J(enumOf("sessions")) === J(cf["sessions"]), J(enumOf("sessions")));

console.log(bad ? String(bad) + " failed" : "tools: all checks passed");
if (bad) process.exit(1);
