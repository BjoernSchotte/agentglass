// agentglass — scripts/gzip.test.sh driver: gzip <in> <out> with src/util/gzip.ts
// SPDX-License-Identifier: Apache-2.0
import { statSync } from "node:fs";
import { gzip, writeBin } from "../../src/util/gzip.ts";
import { readBytes } from "../../src/util/fs.ts";
const a = process.argv.slice(2);
const inp = a[0] ?? ""; const out = a[1] ?? "";
const b = readBytes(inp, 0, statSync(inp).size);
if (!writeBin(out, gzip(b))) process.exit(1);
