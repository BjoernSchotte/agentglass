// agentglass — self-check for billing-mode detection (rules, environ names, config readers): scriptc build src/features/usage/billing.check.ts -o bc && ./bc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { newAcc, stamp } from "./record.ts";
import { type Evid, type Bill, rule, provRule, modelBill, envSummary, configEv, planLabel, tag, MODES } from "./billing.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const ROOT = "/tmp/agentglass-billing-check"; const HOMED = ROOT + "/home";
function write(p: string, s: string): void { mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); const fd = openSync(p, "w"); writeSync(fd, s); closeSync(fd); }
rmSync(ROOT, { recursive: true, force: true });
function kvs(e: Evid): string { let t = ""; for (const [k, v] of e.kv) t += k + "=" + v + ";"; return t; }
const E = (names: string[], on: string[], kv: string[][]): Evid => { const m = new Map<string, string>(); for (const p of kv) m.set(p[0] ?? "", p[1] ?? ""); return { names, on, kv: m }; };

ok("tags", MODES.map((b: Bill) => tag(b)).join() === "spend,plan,cloud,gw,?", MODES.map((b: Bill) => tag(b)).join());
// claude precedence
ok("bedrock switch", rule("claude", E(["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_API_KEY"], ["CLAUDE_CODE_USE_BEDROCK"], []), "process").bill === "metered", "");
ok("switch off = absent", rule("claude", E(["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_API_KEY"], [], []), "process").bill === "api", "");
ok("auth token = gateway", rule("claude", E(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"], [], []), "process").bill === "gateway", "");
ok("helper = api", rule("claude", E([], [], [["claude.helper", "1"], ["claude.billingType", "stripe_subscription"]]), "config").bill === "api", "");
const pl = rule("claude", E([], [], [["claude.billingType", "stripe_subscription"], ["claude.plan", "team"]]), "config");
ok("subscription = plan team", pl.bill === "plan" && pl.plan === "team" && pl.src === "config", pl.bill + pl.plan);
const nothing = rule("claude", E([], [], []), "config");
ok("nothing = unknown", nothing.bill === "unknown" && nothing.src === "", nothing.src);
// codex, gemini, kiro, opencode, pi
ok("codex chatgpt", rule("codex", E([], [], [["codex.auth_mode", "chatgpt"]]), "config").bill === "plan", "");
ok("codex apikey", rule("codex", E([], [], [["codex.auth_mode", "apikey"]]), "config").bill === "api", "");
ok("codex azure", rule("codex", E([], [], [["codex.provider", "azure"]]), "config").bill === "metered", "");
ok("codex other provider", rule("codex", E([], [], [["codex.provider", "litellm"]]), "config").bill === "gateway", "");
ok("codex openai provider = no evidence", rule("codex", E([], [], [["codex.provider", "openai"]]), "config").bill === "unknown", "");
ok("codex env key", rule("codex", E(["CODEX_API_KEY"], [], []), "process").bill === "api", "");
ok("gemini vertex switch", rule("gemini", E(["GEMINI_API_KEY"], ["GOOGLE_GENAI_USE_VERTEXAI"], []), "process").bill === "metered", "");
ok("gemini oauth", rule("gemini", E([], [], [["gemini.selectedType", "oauth-personal"]]), "config").bill === "plan", "");
ok("gemini key", rule("gemini", E([], [], [["gemini.selectedType", "gemini-api-key"]]), "config").bill === "api", "");
ok("gemini vertex type", rule("gemini", E([], [], [["gemini.selectedType", "vertex-ai"]]), "config").bill === "metered", "");
ok("kiro always plan", rule("kiro", E(["AWS_ACCESS_KEY_ID"], [], []), "config").bill === "plan", "");
ok("fx unknown", rule("fx", E(["OPENAI_API_KEY"], [], []), "process").bill === "unknown", "");
ok("opencode wellknown", provRule("opencode", "corp", E([], [], [["auth.corp", "wellknown"]]), "config").bill === "gateway", "");
ok("opencode oauth", provRule("opencode", "anthropic", E([], [], [["auth.anthropic", "oauth"]]), "config").bill === "plan", "");
ok("opencode api", provRule("opencode", "openai", E([], [], [["auth.openai", "api"]]), "config").bill === "api", "");
ok("pi env key", provRule("pi", "open-router", E(["OPEN_ROUTER_API_KEY"], [], []), "process").bill === "api", "");
ok("pi api-key type", provRule("pi", "openai", E([], [], [["auth.openai", "api_key"]]), "config").bill === "api", "");
ok("pi unknown provider", provRule("pi", "x", E([], [], [["auth.openai", "oauth"]]), "config").bill === "unknown", "");
ok("bedrock id", modelBill("us.anthropic.claude-sonnet-4-5-20250929-v1:0") === "metered" && modelBill("claude-opus-4@20250514") === "metered" && modelBill("claude-opus-4") === "" && modelBill("arn:aws:bedrock:us-east-1:1:x/y") === "metered", "");
// environ: names only, secrets never kept
const raw = new TextEncoder().encode("ANTHROPIC_API_KEY=sk-ant-SECRET\0CLAUDE_CODE_USE_VERTEX=1\0CLAUDE_CODE_USE_BEDROCK=0\0GOOGLE_GENAI_USE_VERTEXAI=False\0PATH=/usr/bin\0");
const es = envSummary(raw); const js = JSON.stringify(es);
ok("names", es.names.indexOf("ANTHROPIC_API_KEY") >= 0 && es.names.indexOf("PATH") >= 0 && es.on.join() === "CLAUDE_CODE_USE_VERTEX", js);
ok("no values kept", js.indexOf("SECRET") < 0 && js.indexOf("/usr/bin") < 0, js);
ok("empty environ", envSummary(new Uint8Array(0)).names.length === 0, "");
// config files on a fake home: malformed JSON, missing files, personal data dropped
write(HOMED + "/.claude.json", "{\"numStartups\":3,\"oauthAccount\":{\"billingType\":\"stripe_subscription\",\"organizationType\":\"claude_team\",\"seatTier\":\"team_tier_1\",\"emailAddress\":\"a@b.c\",\"displayName\":\"A B\"},\"projects\":{\"/w\":{\"x\":1}}}");
write(HOMED + "/.codex/auth.json", "{\"auth_mode\":\"apikey\",\"OPENAI_API_KEY\":\"sk-SECRET\",\"tokens\":null}");
write(HOMED + "/.codex/config.toml", "model = \"gpt-5\"\nmodel_provider = \"azure\"\n[profiles.x]\nmodel_provider = \"litellm\"\n");
write(HOMED + "/.gemini/settings.json", "{not json");
write(HOMED + "/.pi/agent/auth.json", "{\"anthropic\":{\"type\":\"oauth\",\"refresh\":\"r-SECRET\"},\"openai\":{\"type\":\"api_key\",\"key\":\"sk-SECRET\"}}");
write(HOMED + "/.local/share/opencode/auth.json", "{\"anthropic\":{\"type\":\"oauth\",\"access\":\"SECRET\"}}");
write(ROOT + "/proj/.claude/settings.local.json", "{\"env\":{\"CLAUDE_CODE_USE_BEDROCK\":\"1\",\"AWS_PROFILE\":\"SECRET\"}}");
const ce = configEv("claude", HOMED, "/nonexistent");
const cr = rule("claude", ce, "config");
ok("claude plan from file", cr.bill === "plan" && cr.plan === "team", kvs(ce));
ok("no personal data", kvs(ce).indexOf("@") < 0 && JSON.stringify(cr).indexOf("@") < 0 && JSON.stringify(ce.names).indexOf("A B") < 0, kvs(ce));
const pe = configEv("claude", HOMED, ROOT + "/proj");
ok("project settings env switch", rule("claude", pe, "config").bill === "metered" && JSON.stringify(pe.names).indexOf("SECRET") < 0, JSON.stringify(pe.names));
const xe = configEv("codex", HOMED, "");
ok("codex key presence only", xe.names.indexOf("OPENAI_API_KEY") >= 0 && kvs(xe).indexOf("SECRET") < 0, kvs(xe));
ok("codex top-level provider only", xe.kv.get("codex.provider") === "azure", xe.kv.get("codex.provider") ?? "");
ok("codex provider wins over auth_mode", rule("codex", xe, "config").bill === "metered", rule("codex", xe, "config").bill);
ok("malformed gemini = unknown", rule("gemini", configEv("gemini", HOMED, ""), "config").bill === "unknown", "");
ok("missing files = unknown", rule("pi", configEv("pi", HOMED + "/none", ""), "config").bill === "unknown", "");
const pie = configEv("pi", HOMED, "");
ok("pi per provider", provRule("pi", "anthropic", pie, "config").bill === "plan" && provRule("pi", "openai", pie, "config").bill === "api" && kvs(pie).indexOf("SECRET") < 0, kvs(pie));
ok("opencode single provider", rule("opencode", configEv("opencode", HOMED, ""), "config").bill === "plan", "");
ok("redact plan", planLabel("team", true) === "team" && planLabel("Acme Corp", true) === "plan" && planLabel("Acme Corp", false) === "Acme Corp", "");
rmSync(ROOT, { recursive: true, force: true });
// stamp precedence: config never stamps; process fills an empty stamp; session evidence replaces process, never the reverse
const sa = newAcc();
stamp(sa, "plan", "team", "config"); ok("config never stamps", sa.billSrc === "" && sa.bill === "", sa.bill);
stamp(sa, "api", "", "process"); ok("process stamps", sa.bill === "api" && sa.billSrc === "process", sa.bill);
stamp(sa, "metered", "", "session"); ok("session beats process", sa.bill === "metered" && sa.billSrc === "session", sa.bill);
stamp(sa, "api", "", "process"); ok("process never beats session", sa.bill === "metered" && sa.billSrc === "session", sa.bill);
stamp(sa, "plan", "pro", "session"); ok("first session evidence stays", sa.bill === "metered", sa.bill);
console.log(bad ? bad + " failed" : "billing: all checks passed");
if (bad) process.exit(1);
