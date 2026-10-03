// agentglass — where rules.json lives (AGENTGLASS_RULES overrides it: checks and tests stay hermetic), and whether a
// one-shot run needs the ledger's call rows for it. A leaf module: cache.ts asks before anything else loads.
// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { HOME, readText } from "../../util/fs.ts";

const env = process.env.AGENTGLASS_RULES;
export const RULES_FILE = env !== undefined && env !== "" ? env : join(HOME, ".agentglass", "rules.json");
export function rulesText(): string { return readText(RULES_FILE, 0, 1048576); }
// a rule on a per-call-row metric is in the file: --json alerts and --watch alert lines read call rows
export function rulesNeedRows(): boolean {
  const t = rulesText();
  return /"metric"\s*:\s*"tool_(calls|errors|error_rate)"/.test(t);
}
