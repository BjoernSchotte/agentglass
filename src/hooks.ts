// agentglass — extension seams. Feature modules push callbacks here at load time; main.ts imports them once.
// Empty arrays = stock behavior. Styled strings may carry ANSI escapes; widths are visible columns.
// SPDX-License-Identifier: Apache-2.0
import type { Ev, Sess, Proc } from "./model/types.ts";
import type { HelpSec } from "./state.ts";
import type { Mark } from "./model/marks.ts";

// a session's metadata as parsed, before H.meta replaced it for display (redact): filters match these
export interface RealMeta { cwd: string; title: string; prompt: string; branch: string; name: string; kind: string }
// mouse: left click inside the tab's body (0-based cell), dbl = second click on the same row within 450ms
export interface Tab { name: string; render: () => void; key: (k: string) => boolean; mouse?: (x: number, y: number, dbl: boolean) => void }
// full-screen feature view: shown while S.mode === "view" && S.fview === name; its keys arrive via H.keys with mode "view"
export interface View { name: string; render: () => void }

// the palette's origin snapshot: what an action sees when it runs (the same state a key press there would see)
export interface Ctx { mode: string; prevMode: string; tab: number; fview: string; sel: number; psel: number; sess: Sess | null; ev: number }
// a named action (palette): keys = display hint ("" = palette only), when = valid in the origin context
export interface Action { id: string; title: string; group: string; keys: string; when: (c: Ctx) => boolean; run: (c: Ctx) => void }

export const H = {
  cli: [] as ((args: string[]) => boolean)[], // before the TUI starts, with argv[2..]; true = handled, the TUI does not start
  firstScan: [] as (() => void)[], // once, right before the first scan(): state only a run that reads sessions needs (the ledger cache; --help never loads it)
  start: [] as (() => void)[], // once, after the TUI's first scan/buildView and before its first frame (agentglass open: the link's target)
  tui: [] as (() => void)[], // main.ts: starts the TUI (startTui) — for a CLI handler that decides later (link hand-off fallback)
  onTick: [] as (() => void)[], // ledger, ticker, cache, prices, callgraph: cadence follows the activity level (500 ms … 5 s; 250 ms while the ledger indexes), before render
  onWatch: [] as (() => void)[], // alarms (watchdog, rules): 1.5 s while any agent is live, else 5 s, at every level
  redraw: [] as (() => void)[], // main.ts: draw a frame now (a link applied from a timer, outside input and the render cadence)
  onQuit: [] as (() => void)[], // right before the TUI exits (flush caches); keep it fast
  onFastTick: [] as (() => boolean)[], // every 50ms while any fastArmed source is armed (and the user is around); true = re-render
  onHeaderTick: [] as (() => boolean)[], // like onFastTick, but true = only the header row changed (marquee): redraws that row alone
  fastArmed: [] as (() => boolean)[], // true = this source needs 50ms frames now (marquee overflows, replay plays)
  keys: [] as ((mode: string, key: string) => boolean)[], // list/transcript/detail/view modes, before built-in keys; true = handled
  modal: [] as ((mode: string, key: string) => boolean)[], // every mode, before everything else (the palette: ctrl-k and its own keys); true = handled
  overlays: [] as (() => void)[], // drawn last, over the view and the footer (the palette box)
  actions: [] as Action[], // named actions for the palette (src/features/palette/actions.ts and features)
  dynActions: [] as (() => Action[])[], // actions built when the palette opens (one per unpriced model: model-prices), after the key-bound ones
  sessionActions: [] as ((s: Sess) => Action | null)[], // extra entries of a session's palette actions (→); run gets the origin ctx
  mouse: [] as ((mode: string, b: number, x: number, y: number, press: boolean) => boolean)[], // raw SGR mouse (b 0 left, 2 right, 64/65 wheel; 0-based x/y) before built-ins; true = handled
  enrich: [] as ((s: Sess) => void)[], // before a session is shown in preview/transcript/detail (runs every frame: cache!)
  complete: [] as ((s: Sess) => void)[], // blocking full computation of a session's derived fields, for exports (CLI --json/--watch)
  rowBadges: [] as ((s: Sess) => string)[], // styled glyphs in a 2-col slot before each session row's title
  rowPrefix: [] as ((s: Sess) => string)[], // styled text right before a session row's title (compare marks); its width comes off the title
  previewSections: [] as ((s: Sess, w: number) => string[])[], // styled lines after the preview's metadata block
  headerBadge: [] as (() => string)[], // styled marks right after the logo, at every width (e.g. REDACTED): the tabs move over
  headerWidgets: [] as ((w: number) => string)[], // styled segments between the tabs and the header stats; w = free width
  headerFlex: [] as ((w: number) => string)[], // laid out after headerWidgets, filling the width they leave (e.g. a ticker)
  footerHints: [] as ((mode: string) => string[][])[], // extra [key, label, tier?] footer hints (clickable when key is one keystroke; tier "0"–"3", see ui/footer.ts tierOf)
  tabs: [] as Tab[], // extra top-level tabs 3, 4, … after Sessions / Processes
  helpSections: [] as HelpSec[], // appended to the ? popup
  views: [] as View[], // full-screen views a feature enters by setting S.fview + S.mode = "view"
  meta: [] as ((s: Sess) => void)[], // after log parsing / process linking (re)set a session's title, cwd, branch or name; may override them
  agents: [] as ((name: string) => void)[], // a harness parsed a call that ran a subagent by name (Gemini: a tool named after it, invoke_agent's agent_name), before its events and ledger rows
  events: [] as ((s: Sess | null, evs: Ev[], from: number) => void)[], // after parseEvents appended evs[from..]; may rewrite them in place
  // what the events hooks do, for code that matches files and commands on the real events and shows the hooked ones
  // (related/build.ts): fakes = redact.ts fakes content (--redact); hides = some hook drops or rewrites events now
  // (skills.hide / --redact over skill loads); rewrote = a hook rewrote a call of this session (its files, its command). A hook's
  // presence says none of them: the skill hook is always registered
  fakes: [] as (() => boolean)[],
  rewrote: [] as ((s: Sess) => boolean)[],
  titles: [] as ((t: string, s: Sess) => string)[], // the shown title (titleOf): skills.hide scrubs the names of hidden skills
  // what makes the head/tail memos (sessions.ts) differ besides the log: the events hooks' rules (skills.hide), joined;
  // a memo kept under other rules is read again, so it never shows what the current rules hide
  memoKey: [] as (() => string)[],
  hides: [] as (() => boolean)[],
  display: [] as ((kind: string, text: string, s: Sess | null) => string)[], // display-time rewrite of text that bypasses parseEvents (stats "tool:<name>"/"cmd"/"prog"/"file", process "args"/"cwd")
  realCwd: [] as ((s: Sess) => string)[], // the session's real cwd when H.meta replaced s.cwd for display (redact); "" = not replaced
  realMeta: [] as ((s: Sess) => RealMeta | null)[], // the real title/prompt/cwd/branch/name when H.meta replaced them (redact); null = not replaced
  fakeSkill: [] as ((name: string) => string)[], // redact.ts: a user skill name → its stable fake (skills/vis.ts; a plain fallback without it)
  screenFilter: [] as ((s: string) => string)[], // every chunk written to the terminal (TUI frame chunks, CLI output lines); must keep visible widths
  listFilter: [] as (() => ((s: Sess) => boolean) | null)[], // once per buildView: the predicate of an active filter (null = none); a top-level session stays when every predicate passes for it or one of its subagents, matching subagents are expanded, the others hidden
  input: [] as ((action: string, ev: string, text: string) => boolean)[], // the input line of S.inputAction: ev change | enter | esc | tab; enter → true keeps it open
  confirmed: [] as ((action: string) => void)[], // a feature's y/n question (actions.ts confirm) answered yes, with its S.confirmAction
  procFilter: [] as ((p: Proc) => boolean)[], // the Processes table shows a root process when every hook passes
  boxChips: [] as ((where: string, w: number) => string)[], // styled filter chips for a built-in box title ("sessions" | "processes"), w = room
  emptyText: [] as ((where: string) => string)[], // the line an empty built-in list shows instead of the stock one ("" = stock)
  backlog: [] as (() => boolean)[], // true = a feature has background work its onTick slices through (filter head reads): tick at the indexing burst cadence
  remoteRows: [] as (() => Sess[])[], // fleet: read-only rows of other hosts (s.host set), appended to the top-level list by buildView
  remoteCard: [] as ((s: Sess, w: number) => string[])[], // the preview of a remote row, instead of previewSections (nothing local to read)
  markLines: [] as ((s: Sess, m: Mark, w: number) => string)[], // a mark's styled transcript line (skills: "✧ name · trigger · tok · $"); "" = not this hook's: the next, else the stock line
  detailHead: [] as ((s: Sess, evs: Ev[], i: number, w: number) => string[])[], // styled lines on top of event i's detail (the skill loads it anchors)
  linkView: [] as ((view: string, f: string, s: Sess) => string)[], // a link's view= and f= after its transcript opened (features/evkinds.ts: the event filter, the call graph); "" = applied, else what was not
};
// a reader that keeps lean events (callgraph/model.ts lean(): no replies, thinking or full text) parses with lean on: the
// events hooks may skip work on what it drops
export const READ = { lean: false };
// skills.hide in open views: n = the hidden names learnt so far, a count that only grows (s: the session shown; its names
// are looked up first); rescrub = events read when it was at, scrubbed in place for the names learnt since (a subagent's load
// the ledger indexes after the view opened), full texts too when full; true when a text changed. Stock: nothing hides
export const HIDE = { n: (s: Sess | null): number => 0, rescrub: (evs: Ev[], at: number, full: boolean): boolean => false };
export function startTui(): void { for (const f of H.tui) f(); }
export function backlog(): boolean { for (const f of H.backlog) if (f()) return true; return false; }
export function boxChips(where: string, w: number): string { let o = ""; for (const f of H.boxChips) o += f(where, w); return o; }
export function emptyText(where: string): string { for (const f of H.emptyText) { const t = f(where); if (t) return t; } return ""; }

export const BADGE_SLOT = 2;
export function rowPrefix(s: Sess): string { let o = ""; for (const f of H.rowPrefix) o += f(s); return o; }
// a remote row (fleet) has nothing on this machine to enrich or index
export function enrich(s: Sess): void { if (s.host) return; for (const f of H.enrich) f(s); }
export function complete(s: Sess): void { if (s.host) return; for (const f of H.complete) f(s); }
export function remoteRows(): Sess[] { if (!H.remoteRows.length) return []; let o: Sess[] = []; for (const f of H.remoteRows) o = o.concat(f()); return o; }
// bounds-checked: in scriptc an out-of-range object read traps
export function tabAt(i: number): Tab | null { return i >= 0 && i < H.tabs.length ? H.tabs[i] : null; }
export function viewOf(name: string): View | null { for (const v of H.views) if (v.name === name) return v; return null; }
export function sawAgent(name: string): void { if (name) for (const f of H.agents) f(name); }
export function evFakes(): boolean { for (const f of H.fakes) if (f()) return true; return false; }
export function evHooked(): boolean { if (evFakes()) return true; for (const f of H.hides) if (f()) return true; return false; }
export function evRewrote(s: Sess): boolean { for (const f of H.rewrote) if (f(s)) return true; return false; }
export function memoKey(): string { let k = ""; for (const f of H.memoKey) k += f(); return k; }
export function applyMeta(s: Sess): void { for (const f of H.meta) f(s); }
export function display(kind: string, text: string, s: Sess | null): string { let t = text; for (const f of H.display) t = f(kind, t, s); return t; }
export function armed(): boolean { for (const f of H.fastArmed) if (f()) return true; return false; }
export function realMeta(s: Sess): RealMeta { for (const f of H.realMeta) { const r = f(s); if (r) return r; } return { cwd: s.cwd, title: s.title, prompt: s.prompt, branch: s.branch, name: s.name, kind: s.kind }; }
export function realCwd(s: Sess): string { for (const f of H.realCwd) { const r = f(s); if (r) return r; } return s.cwd; }
export function screenOut(s: string): string { let t = s; for (const f of H.screenFilter) t = f(t); return t; }
