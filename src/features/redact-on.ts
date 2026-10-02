// agentglass — is privacy mode on (--redact / AGENTGLASS_REDACT)? Kept apart from redact.ts so modules can ask without
// importing it (importing redact.ts registers its hooks, and their order follows import order)
// SPDX-License-Identifier: Apache-2.0
const envOn = process.env.AGENTGLASS_REDACT;
export const REDACT = process.argv.indexOf("--redact") >= 0 || (envOn !== undefined && envOn !== "" && envOn !== "0");
