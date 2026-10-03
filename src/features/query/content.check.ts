// agentglass — self-check for content ~ (full-text search): scriptc build src/features/query/content.check.ts -o cc && ./cc
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync, appendFileSync, rmSync, statSync } from "node:fs";
import { newSess } from "../../model/types.ts";
import { sessions } from "../../model/sessions.ts";
import { contentSet } from "./content.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const dir = "/tmp/agentglass-content-check"; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const pa = dir + "/a.jsonl"; const pb = dir + "/b.jsonl";
writeFileSync(pa, "{\"text\":\"hello\"}\n"); writeFileSync(pb, "{\"text\":\"a Needle here\"}\n");
for (const p of [pa, pb]) { const s = newSess("claude", p, p, false); s.size = statSync(p).size; sessions.set(p, s); }
function hits(q: string): string { const r = contentSet(q, [pa, pb]); const o: string[] = []; for (const p of [pa, pb]) if (r.paths.has(p)) o.push(p.slice(dir.length + 1)); return o.join(","); }
ok("finds, case-insensitive", hits("needle") === "b.jsonl", hits("needle"));
// a live session writes the text later: the next evaluation searches the grown file again (only the changed one)
appendFileSync(pa, "{\"text\":\"now a needle too\"}\n");
const sa = sessions.get(pa); if (sa) sa.size = statSync(pa).size;
ok("grown transcript searched again", hits("needle") === "a.jsonl,b.jsonl", hits("needle"));
rmSync(dir, { recursive: true, force: true });
console.log(bad ? bad + " failed" : "content search: all checks passed");
if (bad) process.exit(1);
