// agentglass — self-check for the events read model (read/events.ts): a whole read in small slices lists exactly what
// the CLI's one-pass readAll lists; a tail read starts with {unread: bytes}, sets truncated, drops the cut first line
// and lists only the tail's events; viewFor rejects a bad filter, an unknown preset and keeps no pinned clause.
//   scriptc build src/read/events.check.ts -o ec && HOME=$(mktemp -d) AGENTGLASS_REDACT=0 ./ec   (check.sh does this)
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync } from "node:fs";
import { type Obj, str } from "../util/json.ts";
import { CLAUDE } from "../util/fs.ts";
import { discover } from "./index.ts";
import { sessions } from "../model/sessions.ts";
import type { Sess } from "../model/types.ts";
import { readAll, listEvents } from "../features/events-cli.ts";
import { viewFor, evRead, evStep, eventsJson } from "./events.ts";
import { kindVer } from "../model/kinds.ts";
import "../features/redact.ts";
import "../features/skills/marks.ts";

let bad = 0;
function eq(what: string, got: string, want: string): void { if (got !== want) { bad++; console.log("FAIL " + what + ": got " + JSON.stringify(got) + " want " + JSON.stringify(want)); } }
const ID = "eeeeeee1-0000-4000-8000-000000000001";
const dir = CLAUDE + "/projects/-w-evc"; mkdirSync(dir, { recursive: true });
let log = "";
for (let k = 0; k < 40; k++) {
  const ts = "2026-10-01T08:" + String(10 + k).padStart(2, "0") + ":00.000Z";
  log += "{\"type\":\"user\",\"sessionId\":\"" + ID + "\",\"cwd\":\"/w/evc\",\"timestamp\":\"" + ts + "\",\"message\":{\"role\":\"user\",\"content\":\"step " + String(k) + "\"}}\n";
  log += "{\"type\":\"assistant\",\"sessionId\":\"" + ID + "\",\"cwd\":\"/w/evc\",\"timestamp\":\"" + ts + "\",\"message\":{\"id\":\"m" + String(k) + "\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t" + String(k) + "\",\"name\":\"Bash\",\"input\":{\"command\":\"pnpm test\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n";
  log += "{\"type\":\"user\",\"sessionId\":\"" + ID + "\",\"cwd\":\"/w/evc\",\"timestamp\":\"" + ts + "\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t" + String(k) + "\",\"content\":\"" + (k % 7 === 3 ? "Exit code 1\\nfailed" : "ok") + "\"}]}}\n";
}
writeFileSync(dir + "/" + ID + ".jsonl", log);
discover();
let found: Sess | null = null; for (const x of sessions.values()) if (x.id === ID) found = x;
if (!found) { console.log("FAIL no fixture session"); process.exit(1); }
const s = found as Sess;

// whole, in slices of 0 ms (one window per step), equals the one-pass CLI listing
eq("viewFor errors preset", viewFor("", "errors") === null ? "ok" : "err", "ok");
const want = JSON.stringify(listEvents(s, readAll(s), 0, false).events);
const r = evRead(s, 0); let steps = 0; while (!evStep(r, 1)) steps++;
const held = r.evs; const whole = eventsJson(r, 0, "errors");
eq("whole read = readAll listing", JSON.stringify(whole["events"]), want);
eq("whole read: not truncated", String(whole["truncated"]), "false");
eq("the read lets its events go (no kinds memo, an empty read)", String(kindVer(held)) + " " + String(r.evs.length), "-1 0");

// a tail of a third of the log: {unread} first, truncated, fewer events, none from before the tail
const tail = Math.floor(log.length / 3);
viewFor("", "");
const t = evRead(s, tail); while (!evStep(t, 1)) { /* on */ }
const o = eventsJson(t, 0, ""); const evs = o["events"] as Obj[];
eq("tail: unread bytes first", String((evs[0] ?? {})["unread"]), String(log.length - tail));
eq("tail: truncated", String(o["truncated"]), "true");
const all = listEvents(s, readAll(s), 0, false).total;
const tt = typeof o["total"] === "number" ? o["total"] : 0;
eq("tail: fewer events than the whole log", String(tt < all && tt > 0), "true");
// the first whole line after the cut holds the earliest time a tail event may have
const nl = log.indexOf("\n", log.length - tail); const m = /"timestamp":"([^"]+)"/.exec(log.slice(nl + 1, nl + 400));
eq("tail: its first event is from the first whole line on", String(str((evs[1] ?? {})["ts"]) >= (m ? m[1] ?? "" : "~")), "true");

// controller errors; no pinned clause survives
const e1 = viewFor("event.kind is", ""); eq("bad filter", e1 ? e1.code : "", "bad_filter");
const e2 = viewFor("", "nope"); eq("unknown preset", e2 ? e2.code : "", "bad_param");

console.log(bad ? bad + " failed" : "read/events: all checks passed");
if (bad) process.exit(1);
