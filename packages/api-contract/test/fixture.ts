// a fixture HOME with two Claude sessions and the full agentglass isolation set (nothing of the developer's state is
// read or written); shared by the conformance test, the BFF and the e2e test
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Fixture { dir: string; env: Record<string, string>; log: string; grow: (text: string) => void; done: () => void }
export const SID = ["aaaa0001-0000-4000-8000-000000000001", "aaaa0002-0000-4000-8000-000000000002"] as const;
function turn(id: string, at: string, text: string, n: number): string {
  const u = { type: "user", sessionId: id, cwd: "/w/app", timestamp: at, message: { role: "user", content: text } };
  const a = { type: "assistant", sessionId: id, cwd: "/w/app", timestamp: at, message: { id: "m-" + id + "-" + n, role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 100 * n, output_tokens: 10 } } };
  return JSON.stringify(u) + "\n" + JSON.stringify(a) + "\n";
}
export function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "agw-fx-"));
  const proj = join(dir, "h", ".claude", "projects", "-w-app"); mkdirSync(proj, { recursive: true });
  mkdirSync(join(dir, "run"), { recursive: true }); chmodSync(join(dir, "run"), 0o700);
  const at = new Date().toISOString();
  for (const [i, id] of SID.entries()) writeFileSync(join(proj, id + ".jsonl"), turn(id, at, i ? "second fixture topic" : "first fixture topic", 1));
  const env: Record<string, string> = {
    HOME: join(dir, "h"), PATH: process.env.PATH ?? "/usr/bin:/bin", AGENTGLASS_AGENT: "0", AGENTGLASS_CACHE_DIR: join(dir, "cache"),
    AGENTGLASS_CONFIG: join(dir, "config.json"), AGENTGLASS_RULES: "/nonexistent", AGENTGLASS_RUN_DIR: join(dir, "run"),
    AGENTGLASS_PALETTE_FILE: join(dir, "palette.json"), AGENTGLASS_THEME_FILE: join(dir, "theme"), AGENTGLASS_PRICES: join(dir, "prices.json"),
    AGENTGLASS_OTLP_DIR: join(dir, "otlp"), AGENTGLASS_FLEET_DIR: join(dir, "fleet"), AGENTGLASS_HUB_DIR: join(dir, "hub"),
    AGENTGLASS_TEAM_DIR: join(dir, "team"), AGENTGLASS_NOTIFY: "0", AGENTGLASS_OFFLINE: "1", AGENTGLASS_HERDR: "off", AGENTGLASS_REDACT: "0",
  };
  const log = join(proj, SID[0] + ".jsonl"); let n = 1;
  return { dir, env, log, grow: (text: string) => { n++; appendFileSync(log, turn(SID[0], new Date().toISOString(), text, n)); }, done: () => rmSync(dir, { recursive: true, force: true }) };
}
