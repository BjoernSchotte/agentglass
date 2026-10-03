// agentglass — golden OTLP output for all seven harnesses: scriptc build src/features/otlp/otlp.check.ts -o oc && ./oc
// Per harness it re-runs itself with HOME = a copy of testdata/otlp/fixtures/<harness> and compares `export --dry-run --since all`
// with testdata/otlp/golden-<harness>.json (AGENTGLASS_GOLDEN=update rewrites them; read every change by hand).
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { type Obj, obj, str, arr, parse as parseJson } from "../../util/json.ts";
import { harnessOf } from "../../harness/index.ts";
import { newAcc } from "../usage/record.ts";
import { sessions } from "../../model/sessions.ts";
import { sourceOf } from "../../harness/index.ts";
import { cfgFrom } from "./config.ts";
import { parseExport, dryRun } from "./export.ts";
import { discover } from "../cli.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
const HS = ["claude", "codex", "gemini", "opencode", "pi", "kiro", "fx"];
const child = process.env["AGENTGLASS_GOLDEN_CHILD"] ?? "";
// the scope version is the build's and os.type the runner's: normalized so a golden survives commits and macOS
function norm(l: string): string { return l.replace(/"scope":\{"name":"agentglass","version":"[^"]*"\}/g, "\"scope\":{\"name\":\"agentglass\",\"version\":\"(build)\"}").replace(/"key":"os.type","value":\{"stringValue":"darwin"\}/g, "\"key\":\"os.type\",\"value\":{\"stringValue\":\"linux\"}"); }

if (!child) {
  for (const h of HS) {
    const t = "/tmp/agentglass-golden-" + String(process.pid) + "-" + h;
    mkdirSync(t + "/home", { recursive: true });
    execFileSync("cp", ["-R", "testdata/otlp/fixtures/" + h + "/.", t + "/home/"]);
    const env: Record<string, string> = { HOME: t + "/home", PATH: process.env["PATH"] ?? "", AGENTGLASS_GOLDEN_CHILD: h, TZ: "UTC", AGENTGLASS_NOTIFY: "0", AGENTGLASS_OFFLINE: "1", AGENTGLASS_CACHE_DIR: t + "/cache", AGENTGLASS_OTLP_DIR: t + "/otlp", AGENTGLASS_GOLDEN: process.env["AGENTGLASS_GOLDEN"] ?? "", XDG_STATE_HOME: t + "/state" };
    if (h === "opencode") { const db = t + "/opencode.db"; execFileSync("sqlite3", [db], { input: readFileSync("testdata/otlp/fixtures/opencode/opencode.sql", "utf8") }); env["OPENCODE_DB"] = db; }
    execFileSync("sh", ["-c", "find \"$1\" -type f -exec touch -t 202609011100 {} +", "sh", t + "/home"]);
    let o = ""; // the child's exit code rides on its output (execFileSync keeps no output when it throws)
    try { o = execFileSync("sh", ["-c", "\"$0\" 2>&1; echo \"exit=$?\"", process.execPath], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { o = "FAIL " + h + " child did not run\n"; }
    process.stdout.write(o.split("\n").filter((l: string) => l.startsWith("FAIL") || l.startsWith("wrote")).map((l: string) => l + "\n").join(""));
    if (o.indexOf("\nexit=0") < 0) bad++;
    rmSync(t, { recursive: true, force: true });
  }
  if (bad) { console.log(String(bad) + " harnesses failed"); process.exit(1); }
  console.log("otlp golden: all seven harnesses match");
  process.exit(0);
}

// ── child: one harness ──
const h = child;
discover();
const p = parseExport(["export", "--dry-run", "--since", "all"], cfgFrom({}), Date.now(), new Map<string, string>());
const lines = dryRun(p.o, cfgFrom({}), Date.now()).map(norm);
const golden = "testdata/otlp/golden-" + h + ".json";
const got = lines.join("\n") + "\n";
if (process.env["AGENTGLASS_GOLDEN"] === "update") { writeFileSync(golden, got); console.log("wrote " + golden); }
else if (!existsSync(golden)) eq(h + " golden", "missing", golden);
else eq(h + " golden matches", String(readFileSync(golden, "utf8") === got), "true");

// structure, independent of the golden
interface S0 { trace: string; id: string; parent: string; name: string; attrs: Map<string, string> }
const all: S0[] = [];
for (const l of lines) {
  const o = parseJson(l) ?? {};
  for (const rs of arr(o["resourceSpans"])) for (const ss of arr((obj(rs) ?? {})["scopeSpans"])) for (const x of arr((obj(ss) ?? {})["spans"])) {
    const so = obj(x); if (!so) continue;
    const m = new Map<string, string>();
    for (const a of arr(so["attributes"])) { const ao = obj(a); if (!ao) continue; const v = obj(ao["value"]) ?? {}; const k = Object.keys(v)[0] ?? ""; const vv = v[k]; m.set(str(ao["key"]), typeof vv === "string" ? (vv as string) : JSON.stringify(vv)); }
    all.push({ trace: str(so["traceId"]), id: str(so["spanId"]), parent: str(so["parentSpanId"]), name: str(so["name"]), attrs: m });
  }
}
eq(h + " has spans", String(all.length > 0), "true");
const byId = new Map<string, S0>(); for (const s of all) byId.set(s.id, s);
const traces = new Set<string>(); for (const s of all) traces.add(s.trace);
for (const t of traces) {
  const roots = all.filter((s: S0) => s.trace === t && !s.parent);
  eq(h + " one root per trace", String(roots.length) + " " + (roots[0]?.name.startsWith("invoke_agent ") ? "ok" : "?"), "1 ok");
}
let usageOnAgent = 0; let chatNoBill = 0; let billElsewhere = 0; let badParent = 0;
for (const s of all) {
  const op = s.attrs.get("gen_ai.operation.name") ?? "";
  if (op === "invoke_agent" && s.attrs.get("agentglass.usage.session_total") !== "true" && [...s.attrs.keys()].some((k: string) => k.startsWith("gen_ai.usage.") || k === "agentglass.usage.cost")) usageOnAgent++;
  if (op === "chat" && !s.attrs.has("agentglass.billing.mode")) chatNoBill++;
  if (op !== "chat" && s.attrs.has("agentglass.billing.mode")) billElsewhere++;
  if (op === "chat" || op === "execute_tool") { const par = byId.get(s.parent); if (!par || (par.attrs.get("gen_ai.operation.name") !== "invoke_agent" && op === "chat")) badParent++; }
}
eq(h + " no usage on invoke_agent", String(usageOnAgent), "0");
eq(h + " billing mode on every chat, nowhere else", String(chatNoBill) + "/" + String(billElsewhere), "0/0");
eq(h + " chat parents are invoke_agent", String(badParent), "0");
// Σ chat usage = the ledger's totals for the same files (fx/kiro: sidecar totals, checked in build.check)
if (h !== "fx" && h !== "kiro") {
  let out = 0; for (const s of all) if (s.attrs.get("gen_ai.operation.name") === "chat") out += Number(s.attrs.get("gen_ai.usage.output_tokens") ?? "0");
  let want = 0;
  for (const s of sessions.values()) { const a = newAcc(); a.sub = !!s.parent; const st = sourceOf(s.h).stat(s); if (st) for (const l of sourceOf(s.h).lines(s, 0, st.size).lines) harnessOf(s.h).usage(a, l); want += a.outTok; }
  eq(h + " Σ chat output tokens = ledger", String(out), String(want));
}
// spec cases per harness
const names = all.map((s: S0) => s.name);
const has = (k: string, v: string): boolean => all.some((s: S0) => s.attrs.get(k) === v);
if (h === "claude") {
  eq("claude mcp", String(has("gen_ai.tool.type", "extension") && has("mcp.method.name", "tools/call")), "true");
  eq("claude superseded fallback", String(has("agentglass.chat.superseded", "true")), "true");
  eq("claude subagent", String(names.indexOf("invoke_agent Explore") >= 0), "true");
  eq("claude plan billing", String(has("agentglass.billing.mode", "plan")), "true");
}
if (h === "codex") {
  eq("codex aborted turn", String(has("error.type", "cancelled")), "true");
  eq("codex pieces", String(names.filter((n: string) => n === "invoke_agent worker").length), "2");
  eq("codex api billing", String(has("agentglass.billing.mode", "api")), "true");
}
if (h === "gemini") eq("gemini models", String(all.some((s: S0) => (s.attrs.get("agentglass.models") ?? "").indexOf("gemini-2.5-pro") >= 0 && (s.attrs.get("agentglass.models") ?? "").indexOf("gemini-2.5-flash") >= 0 && s.attrs.get("gen_ai.request.model") === "gemini-2.5-flash")), "true");
if (h === "opencode") eq("opencode chats", String(names.filter((n: string) => n.startsWith("chat ")).length), "2");
if (h === "pi") eq("pi response model", String(all.some((s: S0) => s.attrs.has("gen_ai.response.model") && s.attrs.get("gen_ai.response.model") !== s.attrs.get("gen_ai.request.model"))), "true");
if (h === "kiro" || h === "fx") {
  eq(h + " one chat per turn, estimated", String(names.filter((n: string) => n.startsWith("chat")).length) + " " + String(all.filter((s: S0) => s.name.startsWith("chat")).every((s: S0) => s.attrs.get("agentglass.timing.estimated") === "true")), "2 true");
  eq(h + " billing", String(has("agentglass.billing.mode", h === "kiro" ? "plan" : "unknown")), "true");
}
if (bad) process.exit(1);
console.log(h + " ok");
