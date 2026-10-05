// agentglass — self-check for price-list normalization and cost math: scriptc build src/features/usage/remote.check.ts -o rmc && ./rmc
// SPDX-License-Identifier: Apache-2.0
import { fromLitellm, fromModelsDev, pricesFile } from "./remote.ts";
import { cost } from "./pricing.ts";

let bad = 0;
function eq(what: string, got: number, want: number): void { if (Math.abs(got - want) > 1e-9) { bad++; console.log("FAIL " + what + ": got " + got + " want " + want); } }
function ok(what: string, c: boolean): void { if (!c) { bad++; console.log("FAIL " + what); } }

const ll = fromLitellm({
  "claude-opus-4-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5, cache_read_input_token_cost: 5e-7, cache_creation_input_token_cost: 6.25e-6, cache_creation_input_token_cost_above_1hr: 1e-5 },
  "gpt-5-codex": { litellm_provider: "openai", mode: "responses", input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1.25e-7 },
  "gemini/gemini-2.5-pro": { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 1.25e-6, output_cost_per_token: 1e-5 },
  "bedrock/anthropic.claude-x-v1:0": { litellm_provider: "bedrock", mode: "chat", input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
  "text-embedding-3": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 1e-7, output_cost_per_token: 0 },
  "broken": { litellm_provider: "openai", mode: "chat", input_cost_per_token: "x" },
  "sample_spec": "not an object",
});
ok("litellm keeps first-party chat models", ll.size === 3 && ll.has("claude-opus-4-5") && ll.has("gpt-5-codex") && ll.has("gemini-2.5-pro"));
const o = ll.get("claude-opus-4-5");
if (o) { eq("opus in", o.i, 5); eq("opus out", o.o, 25); eq("opus cr", o.cr, 0.5); eq("opus cw", o.cw, 6.25); eq("opus cw1", o.cw1, 10); }
const g = ll.get("gpt-5-codex"); if (g) eq("codex: no cache write → -1", g.cw, -1);

const md = fromModelsDev({ anthropic: { models: { "claude-sonnet-4-5": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
  openrouter: { models: { "x": { cost: { input: 1, output: 1 } } } }, openai: { models: { "free": { cost: { input: 0, output: 0 } } } } });
ok("models.dev keeps first-party priced models only", md.size === 1 && md.has("claude-sonnet-4-5"));

// the cached list lives in the ledger's cache dir: AGENTGLASS_CACHE_DIR moves it with the ledger (tests, isolated runs)
process.env["AGENTGLASS_CACHE_DIR"] = "/tmp/agc-x";
ok("cache dir honoured", pricesFile("litellm") === "/tmp/agc-x/prices-litellm.json");
process.env["AGENTGLASS_CACHE_DIR"] = "";
ok("default cache dir", pricesFile("litellm").endsWith("/.agentglass/cache/prices-litellm.json"));

// 1h cache writes: own rate if listed, else 2× input — never the 5-minute rate
eq("cw1 listed", cost({ p: "m", i: 5, o: 25, cr: -1, cw: 6.25, cw1: 10 }, 0, 0, 0, 0, 1e6), 10);
eq("cw1 derived", cost({ p: "m", i: 5, o: 25, cr: -1, cw: 6.25, cw1: -1 }, 0, 0, 0, 0, 1e6), 10);
eq("5m write", cost({ p: "m", i: 5, o: 25, cr: -1, cw: 6.25, cw1: -1 }, 0, 0, 0, 1e6, 0), 6.25);

console.log(bad ? bad + " failed" : "prices: all checks passed");
process.exit(bad ? 1 : 0);
