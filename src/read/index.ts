// agentglass — the read model (local-web-api §2): one module per resource, shared by the CLI's --json commands and
// agentglass serve --stdio. Callers import from here.
// SPDX-License-Identifier: Apache-2.0
import { type Page, type Err, type SessQ, type SessR, type OneR, readSessions, readSession } from "./sessions.ts";
import { PROTO, CAPS, gen, readMeta } from "./meta.ts";
import { JSON_FIELDS, MUX_FLAT, jsonSess, discover, pickSessions, rowsOf } from "./row.ts";
export { type Page, type Err, type SessQ, type SessR, type OneR, readSessions, readSession, PROTO, CAPS, gen, readMeta, JSON_FIELDS, MUX_FLAT, jsonSess, discover, pickSessions, rowsOf };
