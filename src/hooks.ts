// agentglass — extension seams. Feature modules push callbacks here at load time; main.ts imports them once.
// Empty arrays = stock behavior. Styled strings may carry ANSI escapes; widths are visible columns.
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess } from "./model/types.ts";
import type { HelpSec } from "./state.ts";

// mouse: left click inside the tab's body (0-based cell), dbl = second click on the same row within 450ms
export interface Tab { name: string; render: () => void; key: (k: string) => boolean; mouse?: (x: number, y: number, dbl: boolean) => void }
// full-screen feature view: shown while S.mode === "view" && S.fview === name; its keys arrive via H.keys with mode "view"
export interface View { name: string; render: () => void }

export const H = {
  cli: [] as ((args: string[]) => boolean)[], // before the TUI starts, with argv[2..]; true = handled, the TUI does not start
  onTick: [] as (() => void)[], // ledger, ticker, cache, prices, callgraph: cadence follows the activity level (500 ms … 5 s; 250 ms while the ledger indexes), before render
  onWatch: [] as (() => void)[], // alarms (watchdog, rules): 1.5 s while any agent is live, else 5 s, at every level
  onQuit: [] as (() => void)[], // right before the TUI exits (flush caches); keep it fast
  onFastTick: [] as (() => boolean)[], // every 50ms while any fastArmed source is armed (and the user is around); true = re-render
  onHeaderTick: [] as (() => boolean)[], // like onFastTick, but true = only the header row changed (marquee): redraws that row alone
  fastArmed: [] as (() => boolean)[], // true = this source needs 50ms frames now (marquee overflows, replay plays)
  keys: [] as ((mode: string, key: string) => boolean)[], // list/transcript/detail/view modes, before built-in keys; true = handled
  mouse: [] as ((mode: string, b: number, x: number, y: number, press: boolean) => boolean)[], // raw SGR mouse (b 0 left, 2 right, 64/65 wheel; 0-based x/y) before built-ins; true = handled
  enrich: [] as ((s: Sess) => void)[], // before a session is shown in preview/transcript/detail (runs every frame: cache!)
  complete: [] as ((s: Sess) => void)[], // blocking full computation of a session's derived fields, for exports (CLI --json/--watch)
  rowBadges: [] as ((s: Sess) => string)[], // styled glyphs in a 2-col slot before each session row's title
  previewSections: [] as ((s: Sess, w: number) => string[])[], // styled lines after the preview's metadata block
  headerWidgets: [] as ((w: number) => string)[], // styled segments between the tabs and the header stats; w = free width
  headerFlex: [] as ((w: number) => string)[], // laid out after headerWidgets, filling the width they leave (e.g. a ticker)
  footerHints: [] as ((mode: string) => string[][])[], // extra [key, label] footer hints (clickable when key is one keystroke)
  tabs: [] as Tab[], // extra top-level tabs 3, 4, … after Sessions / Processes
  helpSections: [] as HelpSec[], // appended to the ? popup
  views: [] as View[], // full-screen views a feature enters by setting S.fview + S.mode = "view"
  meta: [] as ((s: Sess) => void)[], // after log parsing / process linking (re)set a session's title, cwd, branch or name; may override them
  events: [] as ((s: Sess | null, evs: Ev[], from: number) => void)[], // after parseEvents appended evs[from..]; may rewrite them in place
  display: [] as ((kind: string, text: string, s: Sess | null) => string)[], // display-time rewrite of text that bypasses parseEvents (stats "tool:<name>"/"cmd"/"prog"/"file", process "args"/"cwd")
  screenFilter: [] as ((s: string) => string)[], // every chunk written to the terminal (TUI frame chunks, CLI output lines); must keep visible widths
};

export const BADGE_SLOT = 2;
export function enrich(s: Sess): void { for (const f of H.enrich) f(s); }
export function complete(s: Sess): void { for (const f of H.complete) f(s); }
// bounds-checked: in scriptc an out-of-range object read traps
export function tabAt(i: number): Tab | null { return i >= 0 && i < H.tabs.length ? H.tabs[i] : null; }
export function viewOf(name: string): View | null { for (const v of H.views) if (v.name === name) return v; return null; }
export function applyMeta(s: Sess): void { for (const f of H.meta) f(s); }
export function display(kind: string, text: string, s: Sess | null): string { let t = text; for (const f of H.display) t = f(kind, t, s); return t; }
export function armed(): boolean { for (const f of H.fastArmed) if (f()) return true; return false; }
export function screenOut(s: string): string { let t = s; for (const f of H.screenFilter) t = f(t); return t; }
