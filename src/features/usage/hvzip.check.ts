// agentglass — self-check for usage/hvzip.ts: day heavy texts packed by zipStep leave hv empty and hz set, heavy() and
// peekHeavy() give the same maps as the text did, a save (accOut) writes the identical text, a budget stops early and
// resumes, a day whose packed form does not come back exactly keeps its text, and nothing is packed without zipOn
//   scriptc build src/features/usage/hvzip.check.ts -o hz && ./hz
// SPDX-License-Identifier: Apache-2.0
import { accOut, accIn } from "./codec.ts";
import { newAcc, bucket, tool, file, heavy, peekHeavy, HEAVY, type Acc, type Day } from "./record.ts";
import { ledger } from "./ledger.ts";
import { parse } from "../../util/json.ts";
import { zipOn, zipStep } from "./hvzip.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
// a log of n days with tool calls and files, as the cache would load it (heavy parts as text)
function loaded(n: number): Acc {
  const a = newAcc();
  for (let k = 0; k < n; k++) {
    const d = bucket(a, 0, "2026-09-" + String(10 + k) + "T09:30:00.000Z");
    for (let i = 0; i < 40; i++) { tool(a, d, i % 3 ? "Bash" : "Read", "claude-sonnet-4-5", 0); file(a, d, "Edit", "/w/src/file-" + String(i % 9) + ".ts", i, 1); }
  }
  return accIn(parse(JSON.stringify(accOut(a, 64))) ?? {});
}
function days(a: Acc): Day[] { const o: Day[] = []; for (const d of a.days.values()) o.push(d); return o; }
function maps(d: Day): string { const h = peekHeavy(d); return JSON.stringify([[...h.tt.keys()], [...h.prog.keys()], [...h.cmds.keys()], [...h.files.keys()]]); }

const a = loaded(6); const want = JSON.stringify(accOut(a, 64)); const wantMaps = days(a).map(maps).join("|");
ledger.set("/check/a.jsonl", a);
ok("loaded as text", days(a).every((d: Day): boolean => d.hv !== "" && d.hz === null && d.hx === null), "");
ok("without zipOn nothing is packed", zipStep(1000) && days(a).every((d: Day): boolean => d.hv !== ""), "");
zipOn(); HEAVY.texts = 6;
// a budget of 0 ms stops before the first day, and says so
ok("budget 0: not done", !zipStep(0), "done");
ok("then all packed", zipStep(1000) && days(a).every((d: Day): boolean => d.hv === "" && d.hz !== null), days(a).map((d: Day): string => String(d.hv.length)).join(","));
ok("packed: smaller", days(a).every((d: Day): boolean => (d.hz ? d.hz.length : 1e9) < 2000), days(a).map((d: Day): string => String(d.hz ? d.hz.length : -1)).join(","));
ok("peek sees the same maps", days(a).map(maps).join("|") === wantMaps, "");
ok("a save writes the identical text", JSON.stringify(accOut(a, 64)) === want, "");
const d0 = days(a)[0] as Day; const h0 = heavy(d0);
ok("heavy() decodes and drops the packed form", d0.hz === null && d0.hv === "" && h0.tt.size > 0, String(h0.tt.size));
// a near-empty day stays text and does not hold the step up
const e = loaded(1); const ed = days(e)[0] as Day; ed.hv = "{\"tt\":{},\"p\":{},\"m\":{},\"f\":{}}"; ledger.set("/check/e.jsonl", e); HEAVY.texts = 1;
ok("a near-empty day: done, kept as text", zipStep(1000) && ed.hv.length === 30 && ed.hz === null, ed.hv);
// a day whose packed form does not come back exactly keeps its text
const b = loaded(1); ledger.set("/check/b.jsonl", b); HEAVY.texts = 1;
const real = HEAVY.unzip; HEAVY.unzip = (z: Uint8Array): string => "";
zipStep(1000); HEAVY.unzip = real;
ok("a lossy round trip keeps the text", days(b).every((d: Day): boolean => d.hv !== "" && d.hz === null), "");
console.log(bad ? String(bad) + " failed" : "usage/hvzip: all checks passed");
if (bad) process.exit(1);
