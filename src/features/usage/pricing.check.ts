// agentglass — self-check for model id normalisation (Bedrock/Vertex → list rows): scriptc build src/features/usage/pricing.check.ts -o pc && ./pc
// SPDX-License-Identifier: Apache-2.0
import { price, normModel } from "./pricing.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const base = price("claude-sonnet-4-5");
ok("base priced", !!base, "null");
for (const id of ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "anthropic.claude-sonnet-4-5-20250929-v1:0", "apac.anthropic.claude-sonnet-4-5-v2",
  "claude-sonnet-4-5@20250929", "arn:aws:bedrock:us-east-1:123:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0"]) {
  const p = price(id); ok("same row " + id, !!p && !!base && p.p === base.p, normModel(id));
}
ok("plain ids unchanged", normModel("gpt-5.1-codex") === "gpt-5.1-codex", normModel("gpt-5.1-codex"));
ok("non-bedrock -vN kept", normModel("deepseek-v3") === "deepseek-v3", normModel("deepseek-v3"));
ok("unknown stays unknown", price("us.anthropic.nope-v1:0") === null, "priced");
console.log(bad ? bad + " failed" : "pricing: all checks passed");
if (bad) process.exit(1);
