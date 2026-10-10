// agentglass — self-check for the header row (alarms, live count and badges at any width): scriptc build src/ui/header.check.ts -o hc && ./hc
// SPDX-License-Identifier: Apache-2.0
import { S } from "../state.ts";
import { H } from "../hooks.ts";
import { buf } from "./screen.ts";
import { renderHeader, tabX0, tabX1 } from "./header.ts";
import { sessions } from "../model/sessions.ts";
import { cpuHist } from "../model/procs.ts";
import { newSess } from "../model/types.ts";
import "../features/ticker.ts"; // the flexible widget: what the live agents do, or "no live agents"

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
ok("60 columns: the widget gets room", header(60).indexOf("today") >= 0 && header(60).indexOf("●") >= 0, header(60)); // the count as "●N" here
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
ok("badge: alarms and live at 60", header(60).indexOf("⚠ 3") >= 0 && header(60).indexOf("●") >= 0, header(60));
ok("badge: alarms and live at 120", header(120).indexOf("⚠ 3") >= 0 && header(120).indexOf("live") >= 0, header(120));
ok("badge before the tabs", header(80).indexOf("REDACTED") < header(80).indexOf("Sessions"), header(80));
// the live count steps down to "●N" before it goes: with the badge and the alarms at 80 the full tab names and it both fit
for (const alarms of [false, true]) {
  H.headerWidgets.length = 0; if (alarms) H.headerWidgets.push((w: number) => "⚠ 3");
  for (const badge of [false, true]) {
    H.headerBadge.length = 0; if (badge) H.headerBadge.push(() => " REDACTED ");
    const at = (badge ? "badge, " : "") + (alarms ? "alarms, " : "");
    for (const W of [60, 80, 100, 120]) {
      const h = header(W);
      ok(at + "live count (long or ●N) at " + String(W), h.indexOf("● 0 live") >= 0 || h.indexOf("●0") >= 0, h);
      ok(at + "fits at " + String(W), h.replace(/\s+$/, "").length <= W, h);
      if (alarms) ok(at + "alarms at " + String(W), h.indexOf("⚠ 3") >= 0, h);
      if (W >= 80) ok(at + "full tab names at " + String(W), h.indexOf("2 Processes") >= 0 && h.indexOf("4 Repos") >= 0, h);
    }
  }
}
ok("badge, alarms, 80: the compact count", header(80).indexOf("●0") >= 0 && header(80).indexOf("live") < 0, header(80));
ok("badge, alarms, 120: the long count", header(120).indexOf("● 0 live") >= 0, header(120));
// no live agent: the ticker's "no live agents" shows whole or not at all (the stats say "● 0 live" anyway), never cut to
// "no live a…" (--redact's badge left it 9–13 columns at 160)
for (const badge of [false, true]) for (const alarms of [false, true]) {
  H.headerWidgets.length = 0; H.headerBadge.length = 0;
  if (alarms) H.headerWidgets.push((w: number) => "⚠ 3"); H.headerWidgets.push((w: number) => (w >= 14 ? "≈$101.08 today" : ""));
  if (badge) H.headerBadge.push(() => " REDACTED ");
  for (let W = 60; W <= 220; W++) { const h = header(W); ok("no live agents whole or gone at " + String(W) + (badge ? ", badge" : "") + (alarms ? ", alarms" : ""), h.indexOf("no live") < 0 || h.indexOf("no live agents") >= 0, h); }
}
H.headerWidgets.length = 0; H.headerBadge.length = 0;
// no jump or flicker: the stats keep their step while a count gains a digit (9 → 10 live) or cpu moves (9.9% → 10.1%)
function shape(h: string): string { return (h.indexOf("live") >= 0 ? "L" : h.indexOf("●") >= 0 ? "l" : "-") + (h.indexOf("busy") >= 0 ? "B" : "-") + (h.indexOf("cpu") >= 0 ? "C" : "-") + (h.indexOf("Processes") >= 0 ? "T" : "t") + (h.indexOf("today") >= 0 ? "$" : "-"); }
for (let i = 0; i < 10; i++) { const s = newSess("claude", "j" + String(i), "/j/" + String(i) + ".jsonl", false); s.pid = 1000 + i; sessions.set(s.path, s); }
const tenth = [...sessions.values()][9];
for (const cost of [false, true]) for (const alarms of [false, true]) for (const badge of [false, true]) {
  H.headerWidgets.length = 0; H.headerBadge.length = 0;
  if (alarms) H.headerWidgets.push((w: number) => "⚠ 3"); if (cost) H.headerWidgets.push((w: number) => (w >= 14 ? "≈$1,209 today" : "")); // as registered
  if (badge) H.headerBadge.push(() => " REDACTED ");
  for (let W = 60; W <= 200; W++) {
    const at = (cost ? "cost, " : "") + (alarms ? "alarms, " : "") + (badge ? "badge, " : "") + String(W);
    cpuHist.length = 0; cpuHist.push(9.9); tenth.pid = 0; const h9 = header(W); const x9 = JSON.stringify(tabX0);
    cpuHist.length = 0; cpuHist.push(10.1); tenth.pid = 1009; const h10 = header(W);
    ok(at + ": same step at 9 and 10 live", shape(h9) === shape(h10), h9 + " / " + h10);
    ok(at + ": tabs stay put", x9 === JSON.stringify(tabX0), x9 + " " + JSON.stringify(tabX0));
    ok(at + ": fits", h10.replace(/\s+$/, "").length <= W, h10);
    if (alarms) ok(at + ": the alarms keep their place (also beside the cost)", h9.indexOf("⚠ 3") >= 0 && h10.indexOf("⚠ 3") >= 0, h10);
    ok(at + ": a live count", h10.indexOf("●") >= 0, h10);
  }
}
console.log(bad ? bad + " failed" : "header: all checks passed");
if (bad) process.exit(1);
