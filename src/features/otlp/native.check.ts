// agentglass — self-check for detecting the harnesses' own OTLP export: scriptc build src/features/otlp/native.check.ts -o nc && ./nc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { type Native, detectNative, applyPolicy, accessed, envNative } from "./native.ts";
import { newState } from "./state.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
const one = (ns: Native[], h: string): string => show(ns.filter((n: Native) => n.h === h));
const show = (ns: Native[]): string => ns.map((n: Native) => n.h + "=" + n.on + (n.src ? "(" + n.src.replace(/\/tmp\/[^ )]*home\d*/, "~") + ")" : "")).join(" ");
const base = "/tmp/agentglass-native-" + String(process.pid);
function home(n: string, files: string[][]): string { const h = base + "/home" + n; for (const f of files) { const p = h + "/" + (f[0] ?? ""); mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, f[1] ?? ""); } return h; }
const none = new Map<string, number[]>();

const h0 = home("0", []);
eq("nothing", show(detectNative(none, h0, [])), "claude=off codex=off gemini=off opencode=off pi=off kiro=off fx=off");
const h1 = home("1", [
  [".codex/config.toml", "model = \"gpt-5\"\n[otel]\nexporter = \"none\"\ntrace_exporter = \"otlp-http\"\n[otel.exporter.\"otlp-http\"]\nendpoint = \"https://secret.example\"\nheaders = { \"x-key\" = \"s3cret\" }\n"],
  [".claude/settings.json", "{\"env\":{\"CLAUDE_CODE_ENABLE_TELEMETRY\":\"1\",\"OTEL_EXPORTER_OTLP_ENDPOINT\":\"https://secret.example\",\"OTEL_EXPORTER_OTLP_HEADERS\":\"k=s3cret\"}}"],
  [".gemini/settings.json", "{\"telemetry\":{\"enabled\":true,\"otlpEndpoint\":\"https://secret.example\"}}"],
]);
eq("config on", show(detectNative(none, h1, [])), "claude=on(config ~/.claude/settings.json) codex=on(config ~/.codex/config.toml) gemini=on(config ~/.gemini/settings.json) opencode=off pi=off kiro=off fx=off");
eq("no endpoint/header key read", accessed.filter((k: string) => /endpoint|header|key|token/i.test(k)).join(","), "");
const h2 = home("2", [[".codex/config.toml", "[otel\ntrace_exporter = otlp"], [".claude/settings.json", "{oops"], [".gemini/settings.json", "[1"]]);
eq("malformed → unknown", show(detectNative(none, h2, [])), "claude=unknown codex=unknown gemini=unknown opencode=off pi=off kiro=off fx=off");
eq("codex exporter off", one(detectNative(none, home("3", [[".codex/config.toml", "[otel]\nexporter = \"none\"\n"]]), []), "codex"), "codex=off");
const h4 = home("4", [["proj/.gemini/settings.json", "{\"telemetry\":{\"enabled\":true}}"]]);
eq("gemini project settings", one(detectNative(none, h4, [h4 + "/proj"]), "gemini"), "gemini=on(config ~/proj/.gemini/settings.json)");
// process environment: names and switch values only
const env = (s: string): Uint8Array => new TextEncoder().encode(s.split("|").join("\u0000") + "\u0000");
eq("env: claude switch", envNative("claude", env("PATH=/bin|CLAUDE_CODE_ENABLE_TELEMETRY=1")), "on");
eq("env: claude switch off", envNative("claude", env("CLAUDE_CODE_ENABLE_TELEMETRY=0")), "off");
eq("env: opencode endpoint name", envNative("opencode", env("OTEL_EXPORTER_OTLP_ENDPOINT=https://x")), "on");
eq("env: nothing", envNative("opencode", env("PATH=/bin")), "off");
// policy
const on: Native[] = [{ h: "codex", on: "on", src: "config " + h1 + "/.codex/config.toml" }, { h: "claude", on: "off", src: "" }];
const st = newState("http://localhost:4318/v1/traces");
const w1 = applyPolicy(on, "warn", st, 1000); const w2 = applyPolicy(on, "warn", st, 2000);
eq("warn once per run", String(w1.notes.length) + String(w2.notes.length), "10");
eq("warn wording", (w1.notes[0] ?? "").split(h1).join("~"), "codex: its own OTLP export is on (~/.codex/config.toml) — turns may appear twice in the backend; --native skip exports only what it does not send");
const s1 = applyPolicy(on, "skip", st, 5000);
eq("skip sets nativeSince", String(st.nativeSince.get("codex") ?? 0) + " " + String(s1.skipFrom.get("codex") ?? 0), "5000 5000");
applyPolicy(on, "skip", st, 9000);
eq("nativeSince kept", String(st.nativeSince.get("codex") ?? 0), "5000");
const off = applyPolicy([{ h: "codex", on: "off", src: "" }], "skip", st, 10000);
eq("off again clears with a notice", String(st.nativeSince.has("codex")) + " " + String(off.notes.length) + " " + String(off.skipFrom.size), "false 1 0");
const inc = applyPolicy(on, "include", st, 11000);
eq("include", String(inc.notes.length) + String(inc.skipFrom.size), "00");
rmSync(base, { recursive: true, force: true });
if (bad) { console.log(String(bad) + " failed"); process.exit(1); }
console.log("otlp native: all checks passed");
