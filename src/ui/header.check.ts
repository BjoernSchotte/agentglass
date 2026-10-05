// agentglass — self-check for the header row (badges stay at any width): scriptc build src/ui/header.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { buf } from "./screen.ts";
import { renderHeader } from "./header.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); }
function header(W: number): string { S.W = W; S.H = 30; buf.length = 0; renderHeader(); let row = ""; for (const b of buf) if (b.startsWith("\x1b[1;1H")) row = plain(b.slice(6)); return row; }

const none = (): void => {}; const nok = (k: string): boolean => k === "";
H.tabs.push({ name: "Stats", render: none, key: nok }); H.tabs.push({ name: "Repos", render: none, key: nok });
H.headerBadge.push(() => " REDACTED ");
H.headerWidgets.push((w: number) => "⚠ 3"); // an alarm count that does not size itself
for (const W of [60, 80, 120, 200]) {
  const h = header(W);
  ok("badge visible at " + String(W), h.indexOf("REDACTED") >= 0, h);
}
ok("never wider than the row", header(60).replace(/\s+$/, "").length <= 60, String(header(60).length));
ok("badge before the tabs", header(80).indexOf("REDACTED") < header(80).indexOf("Sessions"), header(80));
console.log(bad ? bad + " failed" : "header: all checks passed");
if (bad) process.exit(1);
