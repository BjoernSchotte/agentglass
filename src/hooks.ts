// agentglass — extension seams. Feature modules push callbacks here at load time; main.ts imports them once.
// Empty arrays = stock behavior. Styled strings may carry ANSI escapes; widths are visible columns.
// SPDX-License-Identifier: Apache-2.0
import type { Sess } from "./model/types.ts";
import type { HelpSec } from "./state.ts";

export interface Tab { name: string; render: () => void; key: (k: string) => boolean }

export const H = {
  cli: [] as ((args: string[]) => boolean)[], // before the TUI starts, with argv[2..]; true = handled, the TUI does not start
  onTick: [] as (() => void)[], // every 500ms tick, before render
  onFastTick: [] as (() => boolean)[], // every 50ms (timer only runs when any are registered); true = re-render
  keys: [] as ((mode: string, key: string) => boolean)[], // list/transcript/detail modes, before built-in keys; true = handled
  enrich: [] as ((s: Sess) => void)[], // before a session is shown in preview/transcript/detail (runs every frame: cache!)
  complete: [] as ((s: Sess) => void)[], // blocking full computation of a session's derived fields, for exports (CLI --json/--watch)
  rowBadges: [] as ((s: Sess) => string)[], // styled glyphs in a 2-col slot before each session row's title
  previewSections: [] as ((s: Sess, w: number) => string[])[], // styled lines after the preview's metadata block
  headerWidgets: [] as ((w: number) => string)[], // styled segments between the tabs and the header stats; w = free width
  headerFlex: [] as ((w: number) => string)[], // laid out after headerWidgets, filling the width they leave (e.g. a ticker)
  footerHints: [] as ((mode: string) => string[][])[], // extra [key, label] footer hints (clickable when key is one keystroke)
  tabs: [] as Tab[], // extra top-level tabs 3, 4, … after Sessions / Processes
  helpSections: [] as HelpSec[], // appended to the ? popup
};

export const BADGE_SLOT = 2;
export function enrich(s: Sess): void { for (const f of H.enrich) f(s); }
export function complete(s: Sess): void { for (const f of H.complete) f(s); }
// bounds-checked: in scriptc an out-of-range object read traps
export function tabAt(i: number): Tab | null { return i >= 0 && i < H.tabs.length ? H.tabs[i] : null; }
