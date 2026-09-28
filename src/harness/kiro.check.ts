// agentglass — self-check for the kiro-cli adapter against a real ~/.kiro install.
// Run: scriptc run src/harness/kiro.check.ts   (needs ~/.kiro/sessions/cli fixtures)
// SPDX-License-Identifier: Apache-2.0
import { readText, listDir, HOME } from "../util/fs.ts";
import { parse } from "../util/json.ts";
import type { Ev } from "../model/types.ts";
import { parseKiro } from "./kiro.ts";

let bad = 0;
function ok(what: string, cond: boolean, got: string): void { if (!cond) { bad++; console.log("FAIL " + what + ": " + got); } else console.log("ok   " + what + " (" + got + ")"); }

function events(path: string): Ev[] {
  const out: Ev[] = [];
  for (const l of readText(path, 0, 8388608).split("\n")) { if (!l) continue; const o = parse(l); if (o) parseKiro(o, out, null); }
  return out;
}
function main(): void {
  const dir = HOME + "/.kiro/sessions/cli/";
  const files = listDir(dir).filter((f) => f.length === 42 && f.endsWith(".jsonl"));
  ok("fixtures present", files.length > 0, files.length + " transcripts");
  if (!files.length) { process.exit(bad ? 1 : 0); }

  // aggregate over every real transcript: unknown kinds must never crash, and calls must pair to results
  let totalCalls = 0; let totalResults = 0; let paired = 0; let compactions = 0; let parsed = 0;
  let purposeSeen = false;
  for (const f of files) {
    const evs = events(dir + f);
    parsed++;
    const results = new Set<string>();
    const calls = new Map<string, boolean>();
    for (const e of evs) {
      if (e.kind === "tool" && e.id) { calls.set(e.id, true); totalCalls++; const i = e.text.indexOf("\u0000"); if (e.text.slice(i + 1).length > 0) purposeSeen = true; }
      else if (e.kind === "result" && e.id) { results.add(e.id); totalResults++; }
      else if (e.kind === "meta" && e.text === "context compacted") compactions++;
    }
    for (const id of calls.keys()) if (results.has(id)) paired++;
  }
  ok("parsed all transcripts without throwing", parsed === files.length, parsed + "/" + files.length);
  ok("tool calls found", totalCalls > 0, String(totalCalls));
  ok("results pair to calls", totalCalls > 0 && paired >= totalResults * 0.9, paired + " paired of " + totalResults + " results");
  ok("tool arg summaries populated", purposeSeen, "at least one non-empty arg");
  ok("compaction markers parsed", compactions > 0, compactions + " context-compacted events");

  // unknown/future kind must degrade to a single meta event, never crash
  const fut: Ev[] = [];
  parseKiro({ version: "v1", kind: "FutureThing", data: {} } as unknown as Record<string, unknown>, fut, null);
  ok("unknown kind → one meta event", fut.length === 1 && fut[0].kind === "meta", fut.length ? fut[0].kind + ":" + fut[0].text : "none");

  console.log(bad ? ("\n" + bad + " checks FAILED") : "\nall kiro adapter checks passed");
  process.exit(bad ? 1 : 0);
}
main();
