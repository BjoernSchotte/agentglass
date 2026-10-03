// agentglass — scripts/otlp-transport.test.sh driver: send <file> to <url> with sendBatch (gzip on), the token from $OTLP_TEST_TOKEN
// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { sendBatch } from "../../src/features/otlp/send.ts";
const a = process.argv.slice(2);
const r = sendBatch({ url: a[0] ?? "", headers: [["Authorization", "Bearer " + (process.env["OTLP_TEST_TOKEN"] ?? "")]], timeoutS: 10, gzip: true, live: false },
  readFileSync(a[1] ?? "", "utf8"), (ms: number) => { execFileSync("sleep", [String(ms / 1000)]); });
console.log(JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
