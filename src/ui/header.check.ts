// agentglass — self-check for the header row (alarms, live count and badges at any width): scriptc build src/ui/header.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { buf } from "./screen.ts";
import { renderHeader, tabX0, tabX1 } from "./header.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
function plain(s: string): string { return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); }
function header(W: number): string { S.W = W; S.H = 30; buf.length = 0; renderHeader(); let row = ""; for (const b of buf) if (b.startsWith("\x1b[1;1H")) row = plain(b.slice(6)); return row; }

const none = (): void => {}; const nok = (k: string): boolean => k === "";
H.tabs.push({ name: "Stats", render: none, key: nok }); H.tabs.push({ name: "Repos", render: none, key: nok });
H.headerWidgets.push((w: number) => "⚠ 3"); // an alarm count that does not size itself
for (const W of [60, 80, 120]) {
  const h = header(W);
  ok("alarms visible at " + String(W), h.indexOf("⚠ 3") >= 0, h);
  ok("live count visible at " + String(W), h.indexOf("live") >= 0, h);
  ok("never wider than the row at " + String(W), h.replace(/\s+$/, "").length <= W, h);
  ok("active tab named at " + String(W), h.indexOf("1 Sessions") >= 0, h);
  for (let i = 0; i < 4; i++) ok("tab " + String(i + 1) + " hit area at " + String(W), h.charAt(tabX0[i] ?? -1) === String(i + 1) && (tabX1[i] ?? 0) > (tabX0[i] ?? 0), h + " " + JSON.stringify(tabX0));
}
ok("80 columns keep the tab names", header(80).indexOf("2 Processes") >= 0 && header(80).indexOf("4 Repos") >= 0, header(80));
S.tab = 2; ok("60 columns: the active tab keeps its name", header(60).indexOf("3 Stats") >= 0 && header(60).indexOf("Processes") < 0, header(60)); S.tab = 0;
H.headerWidgets.length = 0; H.headerWidgets.push((w: number) => (w >= 14 ? "≈$119.72 today" : "")); // the cost widget sizes itself
ok("80 columns: a widget that fits keeps the tab names", header(80).indexOf("2 Processes") >= 0 && header(80).indexOf("today") >= 0, header(80));
ok("60 columns: the widget gets room", header(60).indexOf("today") >= 0 && header(60).indexOf("live") >= 0, header(60));
H.headerWidgets.length = 0;
ok("60 columns, no widgets: the live count gets room", header(60).indexOf("live") >= 0, header(60));
ok("120 columns, no widgets: names", header(120).indexOf("4 Repos") >= 0, header(120));
// a badge (--redact's REDACTED) at every width, before the tabs; the alarms stay
H.headerBadge.push(() => " REDACTED "); H.headerWidgets.push((w: number) => "⚠ 3");
for (const W of [60, 80, 120, 200]) {
  const h = header(W);
  ok("badge visible at " + String(W), h.indexOf("REDACTED") >= 0, h);
  ok("badge: never wider than the row at " + String(W), h.replace(/\s+$/, "").length <= W, h);
  ok("badge: tab hit areas at " + String(W), h.charAt(tabX0[0] ?? -1) === "1", h + " " + JSON.stringify(tabX0));
}
ok("badge: alarms at 80 (tab names over the live count)", header(80).indexOf("⚠ 3") >= 0 && header(80).indexOf("4 Repos") >= 0, header(80));
ok("badge: alarms and live at 60", header(60).indexOf("⚠ 3") >= 0 && header(60).indexOf("live") >= 0, header(60));
ok("badge: alarms and live at 120", header(120).indexOf("⚠ 3") >= 0 && header(120).indexOf("live") >= 0, header(120));
ok("badge before the tabs", header(80).indexOf("REDACTED") < header(80).indexOf("Sessions"), header(80));
console.log(bad ? bad + " failed" : "header: all checks passed");
if (bad) process.exit(1);
