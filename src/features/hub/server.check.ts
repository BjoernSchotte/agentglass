// agentglass — self-check for the receive server's pure parts: stored-line splitting: scriptc build src/features/hub/server.check.ts -o sv && ./sv
// SPDX-License-Identifier: Apache-2.0
import { type Obj, obj, arr } from "../../util/json.ts";
import { splitLines, LINE_SPLIT } from "./server.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const pad = "p".repeat(1000);
function req(n: number): Obj {
  let s = "{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"host.id\",\"value\":{\"stringValue\":\"0011223344556677\"}}]},\"scopeSpans\":[{\"scope\":{\"name\":\"agentglass\"},\"spans\":[";
  for (let i = 0; i < n; i++) s += (i ? "," : "") + "{\"spanId\":\"" + String(i) + "\",\"name\":\"" + pad + "\"}";
  return obj(JSON.parse(s + "]}],\"schemaUrl\":\"u\"}]}")) ?? {};
}
const small = splitLines(req(10), "resourceSpans", false);
ok("small: one line", small.length === 1, String(small.length));
const big = splitLines(req(20000), "resourceSpans", false); // ~20 MB
ok("big: several lines", big.length >= 3, String(big.length));
let spans = 0; let okLines = true; const ids = new Set<string>();
for (const l of big) {
  if (l.length > LINE_SPLIT) { okLines = false; console.log("long " + String(l.length)); }
  const o = obj(JSON.parse(l)); const rs = obj(arr(o?.["resourceSpans"])[0]);
  if (!rs || JSON.stringify(rs["resource"]).indexOf("0011223344556677") < 0 || rs["schemaUrl"] !== "u") { okLines = false; console.log("res " + l.slice(0, 200)); }
  const sc = obj(arr(rs?.["scopeSpans"])[0]);
  if (!sc || JSON.stringify(sc["scope"]).indexOf("agentglass") < 0) { okLines = false; console.log("scope " + l.slice(0, 300)); }
  for (const sp of arr(sc?.["spans"])) { spans++; ids.add(String(obj(sp)?.["spanId"])); }
}
ok("each line ≤ 8 MB with resource and scope", okLines, "bad line");
ok("every span once", spans === 20000 && ids.size === 20000, String(spans));
const logs = obj(JSON.parse("{\"resourceLogs\":[{\"resource\":{\"attributes\":[]},\"scopeLogs\":[{\"logRecords\":[{\"body\":{\"stringValue\":\"x\"}}]}]}]}")) ?? {};
ok("logs: as is", splitLines(logs, "resourceLogs", true)[0] === JSON.stringify(logs), "changed");
if (bad) console.log(String(bad) + " failed"); else console.log("hub server: all checks passed");
if (bad) process.exit(1);
