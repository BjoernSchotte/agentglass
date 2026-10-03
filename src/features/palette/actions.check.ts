// agentglass — self-check for the palette's action registry: every ? help binding is an action that does what the key does
// SPDX-License-Identifier: Apache-2.0
import { rmSync } from "node:fs";
import { S, type TV } from "../../state.ts";
import { H, type Ctx, type Action } from "../../hooks.ts";
import { HELP } from "../../ui/help.ts";
import { onInput } from "../../input.ts";
import { renderTranscript, openTranscript } from "../../ui/transcript.ts";
import { harnessIds } from "../../harness/index.ts";
import { tmpDir, addSess, convo } from "./fixture.ts";
import { ctxNow, restore } from "./actions.ts";
import "./links.ts";
import "../replay.ts";
import "../themes.ts";
import "../watchdog.ts";
import "../usage/stats.ts";
import "../query/ui.ts";
import "../callgraph/view.ts";
import "../triage/view.ts";

let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
// external effects off: harness commands, pager, editor, clipboard tools (OSC 52 goes to stdout)
for (const h of harnessIds()) process.env["AGENTGLASS_" + h.toUpperCase()] = "true";
process.env["PAGER"] = "true"; process.env["EDITOR"] = "true"; process.env["VISUAL"] = "true";
process.env["DISPLAY"] = ""; process.env["WAYLAND_DISPLAY"] = ""; process.env["TMUX"] = "";

// coverage: every non-movement ? row has an action with that row's first key, valid in that row's context
function cx(mode: string, tab: number): Ctx { return { mode, prevMode: "list", tab, fview: "", sel: 0, psel: 0, sess: null, ev: -1 }; }
const SEC: Record<string, Ctx> = { global: cx("list", 0), sessions: cx("list", 0), processes: cx("list", 1), transcript: cx("transcript", 0), "event details": cx("detail", 0) };
const MOVE = ["ctrl-k", "↑↓  j k", "PgUp PgDn", "g G  Home End", "wheel", "↑↓  j k  wheel", "PgUp PgDn  b ␣", "g  Home"];
const missing: string[] = [];
for (const sec of HELP) {
  if (sec.name === "mouse" || sec.name === "prompt & dialogs") continue;
  for (const row of sec.keys) {
    const k = row[0] ?? "";
    if (MOVE.indexOf(k) >= 0) continue;
    const first = k.split(" ")[0] ?? "";
    const c = SEC[sec.name]; if (!c) { missing.push("no context for section " + sec.name); continue; }
    let found = false; for (const a of H.actions) if (a.keys === first && a.when(c)) found = true;
    if (!found) missing.push(sec.name + ": " + k);
  }
}
ok("every ? binding has an action", missing.length === 0, missing.join(" | "));

// equivalence: the key press and the action leave the same state
const dir = tmpDir("actions");
const s1 = addSess(dir, "aaaaaa-0001", "first session", convo(1), Date.now() - 5000, "");
addSess(dir, "bbbbbb-0002", "second session", convo(2), Date.now() - 1000, "");
function snap(): string {
  const tv = S.tv; const dv = S.dv; const loc: string[] = [];
  for (const [k, v] of S.local) loc.push(k + "=" + JSON.stringify(v));
  return JSON.stringify({ mode: S.mode, prevMode: S.prevMode, tab: S.tab, fview: S.fview, sel: S.sel, psel: S.psel, local: loc.join(";"), pins: JSON.stringify(S.pins),
    inputAction: S.mode === "input" ? S.inputAction : "", inputText: S.mode === "input" ? S.inputText : "", confirmAction: S.mode === "confirm" ? S.confirmAction : "",
    tvPath: tv ? tv.s.path : "", tvCur: tv ? tv.cur : -9, tvFollow: tv ? tv.follow : false, tvExpand: tv ? tv.expand : false, dvIdx: dv ? dv.idx : -9, toast: S.toast, wrap: S.wrapCode, foldAll: S.foldAll });
}
function tvNow(): TV | null { return S.tv; } // S.tv was set to null above: TS would narrow it
const KEY: Record<string, string> = { "↵": "enter", "space": " ", "Tab": "tab", "esc": "esc", "1-9": "1" };
function base(ctx: string): void {
  S.mode = "list"; S.prevMode = "list"; S.tab = 0; S.fview = ""; S.tv = null; S.dv = null; S.local.clear(); S.pins = []; S.toast = ""; S.wrapCode = true; S.foldAll = false;
  S.sel = 1;
  if (ctx === "list") return;
  openTranscript(s1); renderTranscript();
  const tv = tvNow(); if (tv) { tv.cur = 2; tv.follow = false; }
  if (ctx === "detail") onInput("enter");
}
const SKIP = ["app.quit", "theme.cycle", "detail.pagerAll"]; // quit exits; T writes ~/.agentglass/theme, v ~/.agentglass/tmp (the real HOME)
let n = 0;
for (const ctx of ["list", "transcript", "detail"]) {
  base(ctx);
  const c0: Ctx = ctxNow();
  for (const a of H.actions) {
    if (!a.keys || SKIP.indexOf(a.id) >= 0 || !a.when(c0)) continue;
    const key = KEY[a.keys] ?? a.keys;
    base(ctx); onInput(key); const A = snap();
    base(ctx); const c: Ctx = ctxNow(); S.mode = "list"; S.tab = 2; S.sel = 0; // the palette moved things: run must restore
    a.run(c); const B = snap();
    ok(ctx + " " + a.id + " == key " + key, A === B, A + "\n   vs " + B); n++;
  }
}
ok("ran equivalence cases", n > 30, String(n));
// when(): transcript-only actions hidden in list mode and vice versa
base("list"); const cl = ctxNow();
function vis(c: Ctx, id: string): boolean { for (const a of H.actions) if (a.id === id) return a.when(c); return false; }
ok("list: no transcript actions", !vis(cl, "transcript.detail") && vis(cl, "session.open"), "");
base("transcript"); const ct = ctxNow();
ok("transcript: no list actions", vis(ct, "transcript.detail") && !vis(ct, "session.open") && !vis(ct, "session.trash"), "");
ok("ctx carries the session and event", ct.sess === s1 && ct.ev === 2, String(ct.ev));
ok("theme per name", vis(cl, "theme.set.nord") || H.actions.some((a: Action) => a.id.startsWith("theme.set.")), "");
restore(cl); ok("restore", S.mode === "list" && S.sel === 1, S.mode);
console.log("\n" + (bad ? bad + " failed" : "actions: all checks passed (" + String(H.actions.length) + " actions, " + String(n) + " equivalence cases)"));
rmSync(dir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
