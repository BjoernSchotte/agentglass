# Command Palette and Deep Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl+K opens a fuzzy palette over actions, sessions, projects and tabs from every non-dialog mode; `agentglass open <ref>` (and `agentglass://open/…` URLs, trace/span ids) starts the TUI on a session and event — or hands the link to an already running agentglass through an owner-only hand-off (Unix socket when the runtime has one, else the spool directory `~/.agentglass/run/inbox/`); OSC 8 hyperlinks where the terminal supports them; an opt-in Linux URL handler.

**Architecture:** A new `palette` mode with its own input handling and a modal renderer drawn over the origin view. Actions are records on a new seam `H.actions` that wrap the functions the keys already call (`replayKey` for feature keys). A pure fuzzy matcher (`fuzzy.ts`) ranks items. A pure ref parser + resolver (`ref.ts`) turns links into `{s, cursor, ev}`; `H.start` applies the target before the first render; `openTranscriptAt` reads from a start cursor for events older than the 6 MB tail. Single instance is split into security primitives (`rundir.ts`: owner/mode checks, `O_EXCL` lock), a transport-free core (`handoff.ts`: request validation, rate limit, queue) with a view-only `apply.ts`, and transports (`spool.ts`, and `sock.ts` only if Task 0 proves Unix sockets work).

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — binding; this plan argues from it, including "Decisions (review 2026-10-02)".

**Phase:** 7. Starts when phases 1–6 are merged (otlp-export: `src/util/sha256.ts`, the id scheme of its §4.1 and `TurnCursor`; repo-view: project identity; filter-language: the `project is X` clause). Merge **after cli-agent-mode** (consumes `agentHost()`, `findSession()` from `src/model/sessref.ts`, help records `addCmd()`, `format.ts` table rendering for the OSC 8 id column). If related-events is merged, its view's `enter` switches to `openTranscriptAt` in Task 6 and "Show related events" becomes an action in Task 3.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (all `src/**/*.check.ts` + `scripts/*.test.sh`). A task is done only when both pass. Single check: `scriptc build <f> -o /tmp/x && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/x`.
- scriptc 0.1.7 limits: no `readlinkSync`; no `n.toString(radix)` (use `String(n)`; hex via a lookup table); nominal typing (pass fields); call optional function members via a local (`process.getuid`); out-of-range array reads trap (`numAt`/bounds checks); a zero-parameter arrow for an optional interface member is rejected (SC2003 — seams are arrays of functions, never optional members); no `Promise.race` over mixed types; static builds lack `Math.sqrt`/`Math.log`. Known from a probe on 2026-10-02 (Task 0 re-confirms): `fs.Stats` has no `uid`, `mode` or `isSocket()`; `os.hostname()` is absent; `process.umask`, `process.getuid?`, `openSync(path, flags: number, mode)` with `O_CREAT|O_EXCL|O_NOFOLLOW`, `fstatSync`, `chmodSync`, `mkdirSync({mode})`, `lstatSync().isSymbolicLink()` exist.
- **Links only open views.** No code path reachable from a link (CLI `open`, URL handler, socket, spool) may send, resume, kill, trash, export or answer a dialog. `apply.ts` imports only an allowlist (Task 8 test).
- **Owner-only hand-off.** `~/.agentglass/run/` must be a real directory (not a symlink), owned by the uid, mode without group/other bits; inbox the same; socket `0600`; files created `0600` with `O_EXCL|O_NOFOLLOW`. Any mismatch → single instance disabled for this run with one warning; foreign or tampered entries are never followed and never unlinked.
- Bounded input: a ref ≤ 512 chars, ids `[A-Za-z0-9._:-]{1,200}`, a request ≤ 1024 bytes incl. `\n`, a spool file read ≤ 4096 bytes; ≤ 10 applied links per minute; socket ≤ 4 open connections, 1 s read deadline.
- Privacy: palette text, hints and toasts go through `H.meta`/`display()`/the screen filter (fakes under `--redact`); fuzzy matching runs on the visible (fake) text; MRU stores ids only and is not written under `--redact`; hyperlinks off under `--redact` and in agent mode; never in JSON/CSV/JSONL/`--watch`.
- No network; nothing written into agent data dirs. New files only under `~/.agentglass/` (`palette.json`, `run/`) and, on explicit `--install-handler`, `~/.local/share/applications/agentglass-open.desktop`.
- Config keys: `open.singleInstance` (default `true`), `open.terminal` (string), `hyperlinks` (`auto`|`on`|`off`; env `AGENTGLASS_HYPERLINKS`); invalid → default with one startup toast. No ledger change → no `cache.ts` `VERSION` bump.
- Keys: `ctrl-k` handled before `H.keys` in list/transcript/detail/view, ignored in input/confirm, closes help and opens the palette; `Y` (copy canonical URL) in list and transcript, where it is unused today (`src/input.ts:133-187`, `:85-106`). No existing binding changes.
- Style: match the surrounding code — dense one-line helpers, short `//` why-comments, no new dependencies.
- Old behavior is a contract: `./agentglass --json --subagents --limit 400` identical before/after except volatile fields (`updated bytes activity live pid status attention stuck`).
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Worktree `../agentglass-command-palette`, branch `feat/command-palette`, PR to `main`, rebase-merge after green CI.

## Review Focus

1. **Tampered run directory or inbox** — symlinked `run/` or `inbox/`, foreign owner (stubbed), group/other bits, a symlink or FIFO inside the inbox, a foreign lock file: single instance disabled, nothing followed, nothing unlinked. Task 7 `rundir.check.ts` + Task 9 `spool.check.ts`.
2. **A link doing more than opening a view** — `apply.ts` imports only the allowlist; a link received in `input`/`confirm` is queued and never closes or answers the dialog. Task 8 `handoff.check.ts` + `scripts/handoff-imports.test.sh`.
3. **Ref parser strictness** — percent-decoding once, charset/length limits, `../` and absolute paths rejected, unknown anchors warned, the server re-parses every request itself. Task 5 `ref.check.ts` + Task 8.
4. **OSC 8 inside width math** — `fitStyled`/`fillTo`/`scrubStyled` measure visible width only; a cut inside a link closes it before `RST`; never in JSON/CSV/agent mode/`--redact`. Task 1 `text.check.ts` + Task 12.
5. **Esc restores the origin exactly; an action equals its key** — mode, tab, selection, scroll and the open transcript/detail are identical after Esc; each action's `run` yields the same state snapshot as the key press. Task 3 `actions.check.ts` + Task 4 `palette.check.ts`.

---

### Task 0: Worktree, prerequisites, open questions, platform facts

**Files:** none committed (probe programs live in `/tmp/agcp-probe/`).

- [ ] **Step 1: Worktree** `git worktree add -b feat/command-palette ../agentglass-command-palette main && cd ../agentglass-command-palette && ./build.sh && sh scripts/check.sh` → Expected: build OK, all `ok`.
- [ ] **Step 2: Prerequisite names** (stop if missing — the producing plan is not merged):
  - `grep -n "export function" src/util/sha256.ts src/features/callgraph/turns.ts src/features/otlp/*.ts | grep -i "sha256\|Cursor\|feed\|traceId\|SpanId\|turnKeys\|function H"` → Expected (otlp-export plan names): `sha256Hex(s)`, `H(x)`, `newCursor()` + `feed(c, e, top)`, `turnKeys(firstTs)`, `traceId(R, T)`, `rootSpanId`, `chatSpanId`, `toolSpanId`, `agentSpanId`. Reuse them; do not re-derive the scheme.
  - `grep -n "export function findSession\|export function agentHost\|export function addCmd\|export function render" src/model/sessref.ts src/features/agentenv.ts src/features/clihelp.ts src/features/format.ts` (cli-agent-mode: `findSession(ref): Found` in `src/model/sessref.ts`, `agentHost(): AgentHost` in `src/features/agentenv.ts`, `addCmd(c: CmdRec)` in `src/features/clihelp.ts`, `render(rows, cols, fmt, single, pretty, tty, cols0)` in `src/features/format.ts`).
  - `grep -rn "export function identOfCwd\|export function realCwd" src` (repo-view) and `grep -n "export function localFor\|export function setLocal\|export function addClause" src/features/query/scope.ts` (filter-language; the `#` project item sets the Sessions local filter with them).
- [ ] **Step 3: Open question 2 — Unix sockets in scriptc.** Write `/tmp/agcp-probe/net.ts`: `createServer` + `srv.listen("/tmp/agcp-probe/s.sock", cb)` + `createConnection("/tmp/agcp-probe/s.sock")`, one round trip, with `process.umask(0o077)` around `listen`. `scriptc build net.ts -o net && ./net`. Evidence seen on 2026-10-02 with scriptc 0.1.7: build fails with `SC0001 … not assignable to parameter of type '{ port: number; host?: … }'`, and the runtime's `scr_net.c` opens only `AF_INET`/`AF_INET6`. Expected today: **no Unix sockets** → the spool transport (Task 9) is the hand-off and Task 10 is skipped with a `Ruling:`. If the probe builds and the round trip prints, Task 10 runs and the spool stays the fallback for runtimes where `listen(path)` throws.
- [ ] **Step 4: Platform facts** (record each):
  - `/tmp/agcp-probe/fs.ts` printing `Object.keys(lstatSync("/tmp"))`, `typeof process.getuid`, `require("node:os").userInfo().uid`, `process.umask()`, and a write with `openSync(p, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)` twice (second must throw `EEXIST`) and `openSync(symlink, O_RDONLY|O_NOFOLLOW)` (must throw `ELOOP`). Expected: no `uid`/`mode` in Stats → owner/mode via the `stat` CLI (Task 7).
  - `stat -c '%u %a %F' /tmp` (Linux, GNU coreutils) → `0 1777 directory`; on macOS `stat -f '%u %Lp %HT' /tmp` → `0 1777 Directory`; socket type strings: `socket` / `Socket`; symlink: `symbolic link` / `Symbolic Link` (without `-L`, `stat` describes the link itself).
  - Hostname for `file://` links: `cat /proc/sys/kernel/hostname` (Linux) and `uname -n` (macOS).
- [ ] **Step 5: Open question 1 — OSC 8 clicks under SGR mouse reporting.** Build, then in each available terminal (kitty, WezTerm, iTerm2, GNOME Terminal, Konsole, Windows Terminal) run `printf '\e[?1000h\e[?1006h\e]8;;https://example.com\e\\link\e]8;;\e\\\n'; read x; printf '\e[?1000l\e[?1006l'` and Ctrl/Cmd+click the word. Record per terminal: opens / does not open. **Fallback (spec 6.5):** links stay a convenience; `auto` enables only terminals where the probe opened the link (terminals not probed keep the spec's list); results go into the README table in Task 14.
- [ ] **Step 6: Goldens** from this build: `./agentglass --help > /tmp/agcp-help-main.txt`; `./agentglass --json --subagents --limit 400 > /tmp/agcp-json-main.json`.

---

### Task 1: Escape-aware widths, `link()`, hyperlink enablement

**Files:** Modify `src/util/text.ts` (`fitStyled` `:47-58`, `fillTo` `:60-64`), `src/features/redact.ts` (`scrubStyled` `:214-224`), every other `\x1b\[` strip (`grep -rn '\\\\x1b\\\\\[' src` — list them in the commit message); Create `src/util/hyper.ts`; Test `src/util/text.check.ts` (create), `src/features/redact.check.ts` (extend).

**Interfaces — Produces:**
- `export const ESC_RE: RegExp` = `/\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g` (CSI, and OSC 8 terminated by BEL or ST); `export const ESC_HEAD: RegExp` = the same anchored (`^`, no `g`) for scanners.
- `fitStyled(s, w)` keeps escapes, tracks whether an OSC 8 link is open, and on a cut emits `\x1b]8;;\x1b\\` before `RST`.
- `export function link(url: string, text: string): string` (`src/util/hyper.ts`) — `hyperOn()` false → `text`; else `\x1b]8;;` + url (control chars and ESC removed) + `\x1b\\` + text + `\x1b]8;;\x1b\\`.
- `export function hyperMode(env: Record<string, string>, cfg: string, tty: boolean, agent: boolean, redact: boolean): boolean` — pure: agent or redact → false; `AGENTGLASS_HYPERLINKS`/cfg `on` → true, `off` → false; `auto`: `TMUX` or `TERM` starting `screen` → false; `TERM_PROGRAM` ∈ {iTerm.app, WezTerm, vscode, ghostty}, `TERM=xterm-kitty`, `VTE_VERSION` ≥ 5000, `WT_SESSION` → `tty`; else false (adjusted by Task 0 Step 5 rulings). `export function hyperOn(): boolean` caches it for the process.
- `export function fileUrl(abs: string): string` — `file://<hostname><percent-encoded path>`; hostname from Task 0 Step 4, cached; `""` hostname → `file://` + path.

- [ ] **Step 1: Failing checks** `text.check.ts`: `width(strip(link("u","abc")))` via `fillTo(link("agentglass://open/x","abc"), 10)` → 7 spaces; `fitStyled(fg + link("u","abcdef") + "gh", 4)` → visible `abcd`, ends with `\x1b]8;;\x1b\\` then `RST`, contains no `gh`; BEL-terminated link measured the same; `hyperMode` table (agent → false, redact → false, tmux auto → false, kitty auto tty → true, kitty auto non-tty → false, `on` in tmux → true, `off` with kitty → false); `fileUrl("/a b/c")` contains `/a%20b/c`. `redact.check.ts`: `scrubStyled` on a line with a link keeps the escape bytes untouched and scrubs only the visible text.
  Run: `scriptc build src/util/text.check.ts -o /tmp/tx && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/tx` → Expected: FAIL.
- [ ] **Step 2: Implement**; replace each CSI-only regex with `ESC_RE`/`ESC_HEAD`.
- [ ] **Step 3: Run** → PASS; `sh scripts/check.sh` → all `ok`; `./build.sh` and a visual smoke run of the TUI (list, transcript, detail render as before).
- [ ] **Step 4: Commit** `feat(text): escape-aware widths for OSC 8 links; link() and hyperlink enablement`.

---

### Task 2: Fuzzy matcher

**Files:** Create `src/features/palette/fuzzy.ts`, `src/features/palette/fuzzy.check.ts`.

**Interfaces — Produces:**
- `export interface Hit { i: number; score: number; pos: number[] }` — `i` = item index, `pos` = matched char positions in the haystack (for highlighting).
- `export function terms(q: string): { t: string; cs: boolean }[]` — split on spaces; `cs` = term contains an uppercase letter (smart case).
- `export function scoreTerm(hay: string, low: string, t: string, cs: boolean, pos: number[]): number` — greedy forward pass, backward pass to tighten the window; +16 at position 0, +10 after a separator (space `/ - _ . : ·`), +8 at a camelCase hump, +4 per consecutive continuation, −1 per skipped char inside the window (capped −30), −0.1 × haystack length; `-1` = no match.
- `export function match(hays: string[], lows: string[], q: string, prev: Hit[] | null, max: number): Hit[]` — AND over terms; `prev` non-null and the query extends the previous one → rescore only `prev` items (incremental narrowing); keeps the best `max` (200), sorted by score desc then index.

- [ ] **Step 1: Failing check** `fuzzy.check.ts`: `fx tmz` matches "Fix timezone bug in reports"; "fix" scores higher on "Fix bug" (boundary) than on "prefix bug" (mid-word); "abc" consecutive in "abcxyz" > scattered in "axbxcx"; `Fix` (uppercase) does not match "fix bug", `fix` matches "Fix bug"; "fix zz" requires both terms; incremental: `match(…, "fi", null)` then `match(…, "fix", prevHits)` equals `match(…, "fix", null)` (same ids, same order); benchmark: 20,000 synthetic titles (`"session " + i + " " + word`), 10 keystrokes typing `"fix tmzone"` incrementally → each call < 15 ms (`Date.now()` deltas; the check prints the max).
  Run: `scriptc build src/features/palette/fuzzy.check.ts -o /tmp/fz && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/fz` → Expected: FAIL.
- [ ] **Step 2: Implement** (no allocation per char in the hot loop; positions written into a reused array, copied only for kept hits).
- [ ] **Step 3: Run** → PASS (benchmark under 15 ms in the native build); suite `ok`.
- [ ] **Step 4: Commit** `feat(palette): fuzzy matcher with smart case, AND terms and incremental narrowing`.

---

### Task 3: Action registry, built-in actions, `replayKey`

**Files:** Modify `src/hooks.ts` (`H.actions`), `src/ui/help.ts` (export `HELP`), feature modules registering their actions (`src/features/callgraph/view.ts`, `src/features/replay.ts`, `src/features/themes.ts`, `src/features/usage/stats.ts`, related view if merged, otlp export if it has a TUI entry); Create `src/features/palette/actions.ts`, `src/features/palette/actions.check.ts`.

**Interfaces — Produces:**
- in `src/hooks.ts`: `export interface Ctx { mode: string; prevMode: string; tab: number; fview: string; sel: number; psel: number; sess: Sess | null; ev: number }` and `export interface Action { id: string; title: string; group: string; keys: string; when: (c: Ctx) => boolean; run: (c: Ctx) => void }`; `H.actions: [] as Action[]`.
- `src/features/palette/actions.ts`: `export function ctxNow(): Ctx` (origin snapshot); `export function restore(c: Ctx): void` (mode, prevMode, tab, fview, sel, psel; `S.tv`/`S.dv` stay as they were at open); `export function replayKey(k: string): (c: Ctx) => void` — `restore(c)` then `onInput(k)`; built-ins for every non-movement row of `HELP` (`src/ui/help.ts:10-39`): global (`?` help, Tab/1/2 tabs, `q` quit), sessions (`↵` open transcript, `space` fold, `/` filter, `F` full text, `h` harness cycle, `l` live only, `esc` clear filters, `s` send, `R` resume, `x` SIGTERM, `D` trash, `y` copy id, `Y` copy link — Task 6), processes (`↵`, `s`, `a`, `x`, `X`), transcript (`↵` detail, `G` follow, `t` expand, `n`/`N` subagent, `u` parent, `s`, `R`, `esc`), detail (`[`/`]`, `1-9`, `tab`/`o`/`e`, `z`, `w`, `v`, `y`, `esc`); each calls the same function the key calls (`openTranscript`, `ask`, `fullText`, `resume`, `confirm`, `copyText`, …) — confirm/input-opening actions open the same dialog; context switches ("Go to Stats", "Sessions", "Processes", feature tabs) are always valid.
- Feature actions: call graph (`c` → `replayKey("c")`), replay, one per theme (`theme.set.<name>`, "Theme: <name>"), Stats period and sort, related events (`r`) if merged, OTLP export only when `otlp.endpoint` is configured (its own confirm first).

- [ ] **Step 1: Failing check** `actions.check.ts`:
  - **coverage:** for every row of `HELP` whose key string is not in the movement set (`↑↓  j k`, `PgUp PgDn`, `g G  Home End`, `wheel`, `↑↓  j k  wheel`, `PgUp PgDn  b ␣`, `g  Home`, mouse section rows, prompt & dialogs rows) there is an action whose `keys` contains that row's first key token; the check prints the missing ones;
  - **equivalence:** for each action with a key (except `quit`), in a fresh fixture state (two sessions in `sessions`, list mode, sel 1; and transcript mode on session 2; and detail mode on event 3) take snapshot A after `onInput(key)` and snapshot B after `restore(ctx); action.run(ctx)`; `JSON.stringify` of `{mode, prevMode, tab, fview, sel, psel, filter, hfilter, liveOnly, inputAction, confirmAction, tvPath, tvCur, dvIdx}` equal; external effects neutralized by `process.env["AGENTGLASS_" + ID] = "true"` for each harness and `PAGER=true`, `EDITOR=true`;
  - `when()` hides transcript-only actions in list mode and vice versa.
  Run: `scriptc build src/features/palette/actions.check.ts -o /tmp/ac && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/ac` → Expected: FAIL.
- [ ] **Step 2: Implement** registry, built-ins, feature registrations.
- [ ] **Step 3: Run** → PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(palette): action registry — every key binding as a named action`.

---

### Task 4: Palette mode — keys, items, rendering, mouse, MRU

**Files:** Modify `src/state.ts` (`Mode` += `"palette"`, `:6`), `src/input.ts` (`keyName` `:37-44`: `"\x0b"` → `ctrl-k`, `"\x10"` → `ctrl-p`, `"\x0e"` → `ctrl-n`; dispatch before `H.keys` `:81`; help block `:72-79`), `src/main.ts` (`:36-39` treat `palette` like `help` for the underlying view; draw the palette after the footer like help `:49`), `src/ui/footer.ts` (`^K palette` hint in list mode), `src/ui/help.ts` (global row `ctrl-k  command palette`); Create `src/features/palette/view.ts`, `src/features/palette/mru.ts`, `src/features/palette/palette.check.ts`.

**Interfaces — Consumes:** `match`, `terms` (Task 2), `H.actions`, `ctxNow`, `restore` (Task 3), `sessions`, `titleOf`, `applyMeta` path via the list's display (`src/model/sessions.ts`), `display()`/`screenOut()` (`src/hooks.ts`), `harnessOf(h).glyph/color`, `identOfCwd`/`realCwd` (repo-view), `renderModal`-style drawing helpers (`src/ui/screen.ts:61-69`), `fit`, `width` (`src/util/text.ts`).

**Interfaces — Produces:**
- `export interface Item { id: string; kind: string; text: string; hint: string; s: Sess | null; act: Action | null; proj: string; tab: number }` — `kind` ∈ `action session project tab`; `id` `act:<id>` | `session:<h>:<id>` | `project:<key>` | `tab:<n>`.
- `export const P = { open: false, origin: <Ctx>, scroll0: number, tvScroll: number, q: string, scope: number, items: Item[], hays: string[], lows: string[], hits: Hit[], sel: number, selId: string, sub: Item | null, prevQ: string }`.
- `export function openPalette(prefill: string): void` — snapshot origin (`ctxNow()` + `S.top`, `tv.scroll/cur/follow`, `dv.scroll`), collect items once (sessions from `sessions.values()` with titles as the list shows them; projects from distinct `identOfCwd(realCwd(s))` keys with their labels (before resolution: `base(cwd)` + full cwd); actions with `when(ctx)`; tabs/views), lower-case haystacks once, `S.prevMode = S.mode`, `S.mode = "palette"`.
- `export function paletteKey(k: string): void` — printable → query; `bs`, `ctrl-u`, `ctrl-w` as in input mode (`input.ts:55-58`); `up/down/ctrl-p/ctrl-n/pgup/pgdn/home/end`; selection kept by `selId` across re-ranking; `enter` → run (restore origin, then `run()`: action → `act.run(ctx)`; session → `openTranscript(s)` (missing on disk → `that session is no longer on disk`); project → Sessions tab with `setLocal("Sessions", addClause(localFor("Sessions"), { key: "repo", op: "is", vals: [label], neg: false, pinned: false }).cs)` (`project` is the alias of filter-language's `repo` key; pins stay); tab → switch); `right` on a session → second level (open transcript, call graph, send prompt, resume, copy id, copy link, filter to project, export if configured); `left`/`esc` in the second level → back; `tab` cycles scope all → actions → sessions → projects → tabs; a first char `> @ # :` restricts the scope (not matched), `?` alone lists the prefixes; `esc`/`ctrl-k` close and restore everything snapshotted.
- `export function renderPalette(): void` — box `min(100, W − 4)` (≥ 40) wide, ≤ 17 rows; title "Go to…" + scope; input line `› query▏` with placeholder `actions, sessions, projects, tabs — > @ # : ?`; ≤ 15 rows (kind glyph, text with matched chars in `C.accent` bold, right-aligned hint; selected row `bg(C.sel)`); status `n of N · ↵ open · → actions · tab scope · esc close`; < 50 cols: no hints; < 12 rows: 5 results; empty results `no match — tab to change scope`; ranking per spec 3.3 (score, MRU +20 < 24 h / +10 older, group weight for an empty query, live first then `mtime`).
- `export function paletteMouse(b: number, x: number, y: number, press: boolean): boolean` — wheel scrolls, click on a row runs it, click outside closes.
- `mru.ts`: `export function mruLoad(path: string): { id: string; at: number }[]`, `export function mruTouch(id: string, now: number): void`, `export function mruSave(path: string, redact: boolean): void` — `{"v":1,"recent":[…]}`, ≤ 50, ids only, atomic (`.tmp` + rename) on `H.onQuit`, missing/corrupt → empty, `redact` → no write.

- [ ] **Step 1: Failing check** `palette.check.ts` (sessions in `sessions`, drive `onInput(keyName(raw))`):
  - `keyName("\x0b") === "ctrl-k"`; Ctrl+K opens from list, transcript, detail and the call-graph view (`S.mode === "palette"`, `prevMode` = origin); in `input` and `confirm` mode it changes nothing (`inputText` unchanged); in help it closes help and opens the palette;
  - Esc restores mode, tab, `sel`, `top`, `tv.scroll`, `tv.cur`, `tv.follow`, `dv.scroll` exactly (snapshot before Ctrl+K == after Esc), also after typing, scrolling and entering the second level;
  - typing `fx tmz` ranks "Fix timezone bug in reports" first; `@` restricts to sessions; `>` to actions; `tab` cycles 5 scopes; `?` shows the prefix list;
  - `enter` on an action equals its key (reuse one Task 3 case); on a session opens its transcript; `right` → 8 second-level entries (7 + export when configured); `left` back;
  - selection kept by id: select item X, type one more char that keeps X → X still selected;
  - under the check's `AGENTGLASS_REDACT=1`: rendered rows show the fake titles; querying a word that only occurs in a real title finds nothing;
  - MRU: `mruTouch` + `mruSave(tmp, false)` → file has ids only (no title strings), ≤ 50 entries after 60 touches; `mruSave(tmp2, true)` writes nothing; corrupt file → `[]`; an MRU id ranks above an equal-score item.
  Run: `scriptc build src/features/palette/palette.check.ts -o /tmp/pl && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/pl` → Expected: FAIL.
- [ ] **Step 2: Implement**.
- [ ] **Step 3: Run** → PASS; suite `ok`; `./build.sh`; manual: Ctrl+K in the TUI from each mode, mouse wheel/click/outside-click.
- [ ] **Step 4: Commit** `feat(palette): Ctrl+K palette over actions, sessions, projects and tabs`.

---

### Task 5: Ref grammar and resolver

**Files:** Create `src/features/palette/ref.ts`, `src/features/palette/ref.check.ts`.

**Interfaces — Consumes:** `findSession` (`src/model/sessref.ts`, cli-agent-mode), `harnessIds`/`isHarness`/`sourceOf`/`parseEvents`/`window` (`src/harness/index.ts`), `scan` (`src/model/sessions.ts`), `H` (otlp-export `ids.ts`, imported as `idH` because `src/hooks.ts` also exports `H`), `traceId`, `rootSpanId`, `chatSpanId`, `toolSpanId`, `agentSpanId`, `turnKeys`, `newCursor`/`feed` (otlp-export: `src/util/sha256.ts`, `src/features/callgraph/turns.ts`, `src/features/otlp/ids.ts`).

**Interfaces — Produces:**
- `export interface Ref { ok: boolean; err: string; warn: string; harness: string; sess: string; trace: string; span: string; akey: string; aval: string; ak: number }` — `akey` ∈ `"" turn call ts span`; `ak` = `~k` ordinal (`0` none); a bare turn number sets `akey "turn"`, `aval` = digits.
- `export function parseRef(raw: string): Ref` — pure, spec 5.1: whole ref ≤ 512 chars; `agentglass://open/[harness/]id[#anchor]` with one percent-decoding pass (invalid `%` → error); `[harness:]id[#anchor]`; 32 lowercase hex → trace, `trace/span` (16 hex); harness ∈ `harnessIds()`; id `[A-Za-z0-9._:-]{1,200}`; prefix ≥ 6; anchors `turn=<iso>[~k]|<n>`, `call=<id>`, `ts=<iso>`, `span=<16 hex>`; unknown anchor key → `warn`, ignored; anything containing `/` outside the URL form, `..`, a leading `/` or `~`, whitespace or control chars → `ok false`. Never touches the filesystem.
- `export interface Target { s: Sess | null; code: number; cands: Sess[]; cursor: number; kind: string; ts: string; id: string; text: string; turn: number; warn: string }` — `code` 0 ok, 3 not found, 4 ambiguous.
- `export function resolve(r: Ref): Target` — spec 5.2: `scan()`; ids and prefixes through `findSession(ref)` (`code`/`cands` mapped 1:1): exact id (narrowed by harness), else unique prefix (subagents included; several → 4 + `cands`); trace → index of `idH("s|" + h + "|" + id).slice(0, 16)` (`R = h + "|" + id`, as otlp-export) over top-level sessions (built on demand, cached by session count), then `traceId(R, T)` for each turn key `T` from `turnKeys` over one parse through `newCursor`/`feed`; span → root `invoke_agent` (turn's first event), `chat` (the request's assistant message), tool (the call), subagent `invoke_agent` (that subagent session, hosting turn); anchors: `turn=<ts>[~k]` → the k-th turn starting at `<ts>`; vanished key → first turn starting at/after `<ts>` + `warn`; `turn=<n>` → n-th turn; `call=` → the tool event with that id; `ts=` → first event at/after; `cursor` = start of the `window(src, 65536)` read that held the event (no per-line offsets needed, works for normalizing sources).
- `export function canonicalUrl(s: Sess, akey: string, aval: string): string` — `agentglass://open/<h>/<id>[#call=<id>|#turn=<ts>[~k]|#ts=<iso>]`, percent-encoding `#`, `%`, `/` inside components.

- [ ] **Step 1: Failing check** `ref.check.ts`:
  - parser table (each with expected fields or `ok false`): `abc123`, `claude:abc123def`, `abc123#call=toolu_01`, `abc123#turn=2026-09-30T10:00:00.000Z`, `…#turn=2026-09-30T10:00:00.000Z~1`, `abc123#turn=3`, `abc123#ts=2026-09-30T10:00:00Z`, `agentglass://open/codex/019a%2D11#call=c1` (decoded once: `019a-11`), `agentglass://open/abc123`, a 32-hex trace, `trace/16hex`, `abc12` (too short) → error, `bogus:abc123` → error, `../etc/passwd` → error, `/home/u/x.jsonl` → error, `~/x` → error, `abc 123` → error, `abc\x07def` → error, 513-char ref → error, 201-char id → error, `%zz` → error, `%252e%252e` decodes once to `%2e%2e` → charset error, `abc123#foo=1` → ok + warn;
  - resolver on fixture sessions: exact id; prefix; ambiguous prefix → code 4 with both; unknown → 3; `call=` → that tool event (`kind tool`, its `ts`/`id`); `ts=` → first event at/after; an event older than the last 6 MB of a 7 MB fixture → found with `cursor > 0`;
  - turn anchors on a hand-written Gemini session with a rewind that removed turn 2: `turn=<ts of turn 3>` → the same turn as before the rewind; `turn=3` → the next turn; a vanished key → first turn at/after + warn; `canonicalUrl` uses the timestamp form, never the index;
  - trace id: the otlp-export golden file's `traceId` → that session and turn; a tool `spanId` → that call.
  Run: `scriptc build src/features/palette/ref.check.ts -o /tmp/rf && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/rf` → Expected: FAIL.
- [ ] **Step 2: Implement**. **Step 3: Run** → PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(palette): strict link grammar and resolver (ids, prefixes, turn/call/ts anchors, trace and span ids)`.

---

### Task 6: `agentglass open`, `H.start`, start-cursor transcripts, `Y`

**Files:** Modify `src/hooks.ts` (`H.start`, `H.tui`), `src/main.ts` (split the TUI start `:58-84` into `tui()`, push it to `H.tui`; run `H.start` after `scan(); refreshProcs(); refreshSlow(); buildView();` and before `render()` `:60-61`), `src/ui/transcript.ts` (`openTranscriptAt`, `TV.from`), `src/state.ts` (`TV.from: number`), `src/input.ts` (`Y` in list `:166` and transcript), `src/features/clihelp.ts` (record for `open`); Create `src/features/palette/open.ts`, `src/features/palette/open.check.ts`. If related-events is merged: `src/features/related/view.ts` `enter` uses `openTranscriptAt` and drops its "older than the loaded transcript" toast.

**Interfaces — Produces:**
- `H.start: [] as (() => void)[]`; `H.tui: [] as (() => void)[]` (main.ts pushes `tui`); `export function startTui(): void { for (const f of H.tui) f(); }` — lets an async CLI handler (hand-off fallback, Tasks 9–10) start the TUI after `main()` returned.
- `export function openTranscriptAt(s: Sess, cursor: number, label: string): void` — reads `[align(s, cursor − window(src, 65536)), +window(src, 6291456))` first with a leading meta `showing from <local time> (opened by link)`; if the tail starts later, a meta gap line `… <size> not shown …` and the normal tail reader continues from `align(tailStart)`; `G`/follow go to the live end; `TV.from = cursor` (`-1` = tail mode, the default in `openTranscript`).
- `export function applyTarget(t: Target): void` (in `open.ts`; reused by `apply.ts`) — select the session's row (`S.tab = 0`, `S.sel` = its index in `S.view`, expanding its parent if it is a subagent), then `openTranscript` (or `openTranscriptAt` when `cursor > 0`) and `focusKind/focusTs/focusText` from the target.
- `open` CLI handler: `open <ref> [--print] [--print-url] [--new-instance]`; parse first (bad → exit 2, nothing contacted); `--print`, non-TTY stdout or `agentHost().on` → resolve and print `{harness, id, path, title, cwd, anchor:{kind, turn, ts, callId}, url}` (through `screenOut`; `--redact` fakes), exit 0/3/4; `--print-url` → `canonicalUrl`; otherwise (no hand-off yet in this task) store the target, push an `H.start` entry that resolves and applies it, return `false` so the TUI starts. Failures before the TUI: not found → exit 3, ambiguous → exit 4 with `harness:id title` lines on stderr.
- `Y`: list → `copyText(canonicalUrl(s, "", ""), "link")`; transcript → cursor event: tool/result → `call=<id>`, else `ts=<ts>`.

- [ ] **Step 1: Failing check** `open.check.ts`: `openTranscriptAt` on a 7 MB fixture at a cursor near 0 → first event is the meta `showing from …`, the anchored event is in `evs` and gets focused, a gap meta exists, the last event equals the file's last event; `applyTarget` on a subagent → parent expanded, row selected, transcript open on the subagent with focus; `canonicalUrl` for a tool event → `#call=`; `Y` in transcript on a user event → clipboard text (captured via the OSC 52 fallback written to a temp stdout) ends with `#ts=<iso>`.
  Run: `scriptc build src/features/palette/open.check.ts -o /tmp/op && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/op` → Expected: FAIL.
- [ ] **Step 2: Implement**. **Step 3: Run** → PASS; `./build.sh`; `./agentglass open <real id prefix> --print | python3 -m json.tool` ok; `./agentglass open zzzzzz --print; echo $?` → `3`; `./agentglass open ../x; echo $?` → `2`; `./agentglass --help | diff - /tmp/agcp-help-main.txt` → only the `open` rows; suite `ok`.
- [ ] **Step 4: Commit** `feat(palette): agentglass open <ref> — start on a session and event; Y copies a link`.

---

### Task 7: Run-directory security primitives

**Files:** Modify `src/platform/types.ts`, `src/platform/linux.ts`, `src/platform/darwin.ts` (`fileInfo`); Create `src/features/palette/rundir.ts`, `src/features/palette/rundir.check.ts`.

**Interfaces — Produces:**
- `Platform.fileInfo(path: string): { uid: number; mode: number; kind: string } | null` — lstat semantics via `execFileSync`: Linux `stat -c '%u %a %F' -- <path>`, macOS `stat -f '%u %Lp %HT' -- <path>`; `kind` normalized to `dir file socket link fifo other`; `mode` = permission bits parsed from octal; `null` when missing.
- `export interface FInfo { uid: number; mode: number; kind: string }`; `export type InfoFn = (path: string) => FInfo | null` (tests inject stubs; production passes `OS.fileInfo`).
- `export function myUid(): number` — `process.getuid` via a local, else `userInfo().uid`.
- `export function secureDir(dir: string, uid: number, info: InfoFn, create: boolean): string` — `""` = ok; absent + `create` → `mkdirSync(dir, {mode: 0o700})` under `umask(0o077)` then re-check; else the reason (`not a directory`, `is a symlink`, `owned by uid N`, `mode 0750 allows group/other`). Never chmods or unlinks an existing entry.
- `export function takeLock(dir: string, pid: number, uid: number, info: InfoFn, alive: (pid: number) => boolean, isOurs: (pid: number) => boolean): number` — `openSync(dir/tui.lock, O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600)` + write pid → `1`; `EEXIST` → `info` must say `file` + uid, else `-1` (tampered, disable); its pid alive and an agentglass process (`isOurs`: `OS.listProcs()` args basename `agentglass`) → `0`; stale → unlink, retry once → `1` or `0`.
- `export function releaseLock(dir: string, pid: number): void` — unlink `tui.lock` only when it still holds `pid`.
- `export function lockHolder(dir: string, uid: number, info: InfoFn, alive: (pid: number) => boolean, isOurs: (pid: number) => boolean): number` — the live server pid or `0`.

- [ ] **Step 1: Failing security checks** `rundir.check.ts` (temp root `/tmp/agentglass-rundir-<pid>/`):
  - absent dir + create → created; `OS.fileInfo` reports `dir`, our uid, mode `700`;
  - pre-existing dir chmod `0750` → reason mentions group/other; dir still `0750` (not chmodded), contents intact;
  - `run` as a symlink to another dir (`ln -s`) → `is a symlink`; target dir untouched, link not removed;
  - stubbed `InfoFn` reporting uid + 1 → `owned by uid …`; nothing created or removed;
  - lock: first `takeLock` → 1, file mode `600`, contains our pid; second with a live `isOurs` holder → 0; holder pid dead (pid of an exited child) → stale takeover → 1; holder alive but not agentglass (`isOurs` false) → takeover → 1; lock is a symlink (`ln -s /etc/passwd tui.lock`) → -1, `/etc/passwd` untouched and the link still there; stubbed foreign owner of the lock → -1, not unlinked;
  - concurrency: the check re-executes itself twice with `--race <dir>` via `spawn` (both started before either is awaited); each child calls `takeLock` and prints its result → exactly one prints `1`;
  - `releaseLock` with a different pid in the file → file stays.
  Run: `scriptc build src/features/palette/rundir.check.ts -o /tmp/rd && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/rd` → Expected: FAIL.
- [ ] **Step 2: Implement**. **Step 3: Run** → PASS on Linux; the macOS `stat -f` branch is exercised by CI's macOS runners (`sh scripts/check.sh` there). Suite `ok`.
- [ ] **Step 4: Commit** `feat(palette): owner-only run directory and O_EXCL server lock`.

---

### Task 8: Hand-off core — request validation, rate limit, queue, view-only apply

**Files:** Create `src/features/palette/handoff.ts`, `src/features/palette/apply.ts`, `src/features/palette/handoff.check.ts`, `scripts/handoff-imports.test.sh`.

**Interfaces — Consumes:** `parseRef`, `resolve` (Task 5), `applyTarget` (Task 6), `openPalette` (Task 4), `say` (`src/state.ts:57`).

**Interfaces — Produces:**
- `export function parseRequest(b: Uint8Array): { ref: string; err: string }` — ≤ 1024 bytes, exactly one trailing `\n`, UTF-8 valid, `open` + one space + a ref without control chars (bytes < 0x20 except the final `\n`, 0x7f); anything else → `err "bad-request"`; then `parseRef(ref).ok` must be true (server re-parses itself) → else `bad-request`.
- `export interface Rate { at: number[] }`, `export function allow(r: Rate, now: number): boolean` — ≤ 10 per rolling 60 s.
- `apply.ts`: `export function applyLink(ref: string, now: number): string` — the only entry from a transport into the UI; returns `ok`, `ok palette` (ambiguous prefix → `openPalette("@" + prefix)`), `err not-found`, `err busy` (rate); if `S.mode` is `input` or `confirm` → keep only the newest queued ref, toast `link received: <title> — applies when you leave this prompt` (title through `titleOf` → fakes under `--redact`), return `ok`; otherwise `applyTarget`, bell `\x07` unless `AGENTGLASS_NOTIFY=0`. `export function flushQueued(): void` — called on tick; applies the queued link once the mode is list/transcript/detail/view.
- **Import allowlist** for `apply.ts`: `../../state.ts`, `./ref.ts`, `./open.ts`, `./view.ts` (palette open only), `../../model/sessions.ts`; `open.ts` itself must not import `src/actions.ts`, `src/features/otlp/*`, `src/features/update.ts`.

- [ ] **Step 1: Failing security checks** `handoff.check.ts`:
  - `parseRequest`: valid `open abc123\n` → ref; 1025 bytes → bad-request; no newline → bad-request; two newlines → bad-request; `\x1b` or `\x07` inside → bad-request; `OPEN abc123\n`, `send abc123\n`, `open  abc123\n` (two spaces) → bad-request; `open ../x\n` → bad-request; invalid UTF-8 (`0xff`) → bad-request;
  - rate: 10 `allow` at t → true, 11th → false, at t + 60001 → true;
  - apply in list mode → `ok`, transcript open at the anchor, BEL written unless `AGENTGLASS_NOTIFY=0` (check runs with it `0` → no BEL);
  - apply in `confirm` mode (`S.confirmAction = "trash"`) → `ok`, `S.mode === "confirm"`, `confirmAction` unchanged, toast set; a second link replaces the queued one; `flushQueued()` while still confirm → nothing; after `onInput("esc")` + `flushQueued()` → the second link's transcript open, trash never ran (session file still present);
  - same for `input` mode with `S.inputText = "half typed"` → text unchanged after the link;
  - unknown session → `err not-found`; ambiguous prefix → `ok palette`, palette prefilled `@<prefix>`.
- [ ] **Step 2: Failing test** `scripts/handoff-imports.test.sh`: extracts `import … from "…"` specifiers of `src/features/palette/apply.ts` and `open.ts`; fails on any specifier outside the allowlist, or any match of `actions.ts|otlp|update.ts|sendPrompt|resume|killPid|trash|confirm(` in those two files.
  Run: `sh scripts/handoff-imports.test.sh` and the check → Expected: FAIL (files missing).
- [ ] **Step 3: Implement**. **Step 4: Run** → PASS; suite `ok`.
- [ ] **Step 5: Commit** `feat(palette): hand-off core — strict requests, rate limit, queued view-only apply`.

---

### Task 9: Spool transport (`~/.agentglass/run/inbox/`)

**Files:** Create `src/features/palette/spool.ts`, `src/features/palette/spool.check.ts`.

**Interfaces — Consumes:** `secureDir`, `takeLock`, `lockHolder`, `myUid`, `InfoFn` (Task 7), `parseRequest`, `allow`, `applyLink` (Task 8).

Spec 5b (Decision 5): the spool is the primary transport (scriptc 0.1.7 has no Unix-domain sockets); the server lock is `tui.lock` (holding the pid) for both transports; a spool file is read up to 4 KB but its content must pass the same 1024-byte request validation; the client waits up to 2 s for the `.res` reply, so `ok` exits 0, `not-found` exits 3 and a missing reply falls back to its own TUI (spec 5b).

**Interfaces — Produces:**
- `export function spoolSend(run: string, req: string, pid: number, now: number, uid: number, info: InfoFn): string` — `run` and `run/inbox` must pass `secureDir(…, false)` and a live `lockHolder` must exist, else `""` (open it yourself); writes `inbox/.tmp-<now>-<pid>` with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` 0600, then `renameSync` to `<now>-<pid>.link`; returns that path.
- `export function spoolAwait(path: string, timeoutMs: number, done: (reply: string) => void): void` — polls every 50 ms (timer) for `<path without .link>.res` (0600, ≤ 64 bytes, owner-checked); on reply: unlink it, `done(reply)`; on timeout: unlink our `.link` if still there, `done("")` (fall back).
- `export function spoolPoll(run: string, now: number, uid: number, info: InfoFn, rate: Rate): number` — server tick (only while this TUI holds the lock): skip when `inbox` mtime and entry count are unchanged; entries in name order, ≤ 16 per tick; names `^\d{13}-\d{1,10}\.link$` only; `info` must report `file` + our uid, else (symlink, fifo, foreign) → single instance disabled with one warning, entry neither opened nor unlinked; age from the name `> 60 s` or `> now + 5 s` → unlink unread; read via `openSync(p, O_RDONLY|O_NOFOLLOW)` + `fstatSync(fd).isFile()` + size ≤ 4096; `parseRequest` → `applyLink` (or `err busy` when `allow` is false) → write `.res` (`O_EXCL|O_NOFOLLOW` 0600) → unlink the `.link`; stale `.tmp-*` older than 60 s and orphan `.res` older than 60 s → unlink (own regular files only). Returns the number applied.
- Server start: `secureDir(run, uid, info, true)`, `secureDir(run/inbox, uid, info, true)`, `takeLock`; retry every 10 s on tick when not the server; on quit (`H.onQuit`, SIGTERM path `src/main.ts:68`, SIGINT, SIGHUP) `releaseLock`.

- [ ] **Step 1: Failing security checks** `spool.check.ts` (temp `run` dir; the server side is driven by calling `spoolPoll` directly, the client side by `spoolSend` + `spoolAwait` with a fake clock where possible):
  - round trip: lock held by the check's own pid (`isOurs` stub true) → `spoolSend` writes a `.link` of mode 600; `spoolPoll` applies it (transcript open), writes `.res` = `ok`, removes the `.link`; `spoolAwait` reads `ok` and removes the `.res`;
  - no lock holder → `spoolSend` returns `""` and writes nothing; dead holder pid → `""`;
  - unknown session → `.res` = `err not-found`; request content 1025 bytes or a file of 5000 bytes → `err bad-request`, never applied; `send abc123\n` → `err bad-request`; a ref the grammar rejects → `err bad-request`;
  - a `.link` named 61 s in the past → unlinked unread (no `.res`, not applied); a future name (+10 s) → unlinked unread; `notalink.txt` (own regular file) → ignored, not applied;
  - 11 valid links within a minute → 10 applied, the 11th gets `err busy`;
  - symlink `inbox/1700000000000-1.link → /etc/passwd` → not read, not unlinked, single instance disabled with one warning; a FIFO (`mkfifo`) entry → same (and `spoolPoll` does not block);
  - `inbox` replaced by a symlink to another dir → `secureDir` fails, server disables; the other dir untouched;
  - stubbed foreign owner on a `.link` → not read, not unlinked, disabled;
  - hung server: holder alive but `spoolPoll` never called → `spoolAwait` times out after 2 s, our `.link` is gone, `done("")` (client falls back);
  - two `.link` files → applied in name order.
  Run: `scriptc build src/features/palette/spool.check.ts -o /tmp/sp && AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme /tmp/sp` → Expected: FAIL.
- [ ] **Step 2: Implement**. **Step 3: Run** → PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(palette): spool-directory link hand-off with owner checks and replies`.

---

### Task 10: Unix-socket transport (only if Task 0 Step 3 passed)

**Gate:** Task 0 Step 3 built and completed a round trip. Otherwise mark this task skipped with `Ruling: scriptc <version> has no Unix-domain sockets (probe evidence); the spool transport is the hand-off`, and continue with Task 11.

**Files:** Create `src/features/palette/sock.ts`, `src/features/palette/sock.check.ts`.

**Interfaces — Produces:**
- `export function sockPathOk(path: string, platform: string): boolean` — byte length < 104 (darwin) / 108 (linux).
- `export function serve(run: string, uid: number, info: InfoFn, rate: Rate): boolean` — holding the lock: `tui.sock` exists → `info` must be `socket` + uid (else disable, leave it); connect: refused/`ENOENT` → stale, unlink; live → another server, release the lock; `listen()` under `umask(0o077)`, then `chmodSync(…, 0o600)`; `EADDRINUSE` → retry once; per connection: ≤ 4 open (5th destroyed at once), read until `\n` / 1024 bytes / 1 s (else `err bad-request`), `parseRequest` → `applyLink` → reply line, close.
- `export function sendSock(run: string, req: string, uid: number, info: InfoFn, done: (reply: string) => void): void` — `run` + `tui.sock` checks (dir 0700, socket 0600, owner); connect timeout 500 ms; reply wait 2 s; malformed/timeout/refused → `done("")`.
- Selection in `handoff.ts`: `export function transport(): string` — `"sock"` when the probe-proven API works at runtime (a `listen` that throws → `"spool"`), else `"spool"`.

- [ ] **Step 1: Failing security checks** `sock.check.ts`: socket created 0600 and `run/` 0700; stale socket file with no listener → unlinked, new server serves; a live server is never displaced (second `serve` → false); valid request → `ok`; 1025 bytes → `err bad-request`; no newline within 1 s → `err bad-request` at ~1 s; control char → bad-request; verb `send` → bad-request; the 5th concurrent connection is closed immediately; the 11th link in a minute → `err busy`; foreign socket owner (stub) → client returns `""` and never connects; `sockPathOk` with a 120-byte path → false (single instance disabled with one warning); quit → `tui.sock` and `tui.lock` gone.
  Run → Expected: FAIL. **Step 2: Implement.** **Step 3: Run** → PASS; suite `ok`.
- [ ] **Step 4: Commit** `feat(palette): Unix-socket link hand-off`.

---

### Task 11: Single instance wired end to end

**Files:** Modify `src/features/palette/open.ts` (client path), `src/features/palette/handoff.ts` (server lifecycle: start in `H.start`, retry every 10 s in `H.onTick`, `spoolPoll`/socket, `flushQueued`, release on quit/signals), `src/main.ts` (SIGINT/SIGHUP → `quit()` like SIGTERM `:68`), config `open.singleInstance`; Create `scripts/open.test.sh`.

**Interfaces — Produces:** `open` client order (spec 5b.4): parse → `--new-instance`, agent mode, `--print` or non-TTY → no hand-off → `open.singleInstance === false` → no hand-off → send via `transport()`; `ok`/`ok palette` → stderr `opened in running agentglass (pid N)`, exit 0; `err not-found` → exit 3; `err bad-request` → exit 2; `err busy`/`""` → `startTui()` with the target applied through `H.start` (that TUI then tries to become the server).

- [ ] **Step 1: Failing test** `scripts/open.test.sh` (build once `AGENTGLASS_OUT=$t/ag sh build.sh`; temp `HOME=$t/h` with two fixture sessions; a server TUI under a PTY kept alive by a FIFO: `mkfifo $t/in; (sleep 60 > $t/in &); HOME=$t/h script -qfc "$t/ag" /dev/null < $t/in > $t/tui.out &`; wait until `$t/h/.agentglass/run/tui.lock` exists):
  - `HOME=$t/h $t/ag open <id1>` (stdout redirected to a PTY via `script -qc`) → exit 0 within 2 s, stderr `opened in running agentglass (pid <server pid>)`, no second TUI process (`pgrep -c -f "$t/ag"` unchanged after it exits), inbox empty;
  - `open zzzzzz` (valid grammar, unknown session) → handed off, the server answers `err not-found` → exit 3, the server's view unchanged; `open ../x` → exit 2 before any hand-off, inbox untouched;
  - `open <id> --new-instance` under `script -qc` with `timeout 2` → starts its own TUI (exit 124 from timeout), inbox never written (`inotifywait` not required: compare inbox listing + mtime before/after);
  - `--print` → JSON, no hand-off;
  - `chmod 0750 $t/h/.agentglass/run` → client warns and starts its own TUI; restore 0700;
  - `kill -STOP <server pid>` → client falls back after ≤ 2.5 s; `kill -CONT`;
  - `kill -TERM <server pid>` → `tui.lock` (and `tui.sock` if Task 10 ran) removed.
  Run: `sh scripts/open.test.sh` → Expected: FAIL before wiring / PASS after.
- [ ] **Step 2: Implement** the wiring. **Step 3: Run** → PASS; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Commit** `feat(palette): links go to the running agentglass, else start a new one`.

---

### Task 12: OSC 8 hyperlinks in TUI and CLI table

**Files:** Modify `src/ui/list.ts` (preview `id` row `:87`), `src/ui/transcript.ts` (header: session id), `src/ui/detail.ts` (file list rows, `fileRow` `:274`), `src/features/format.ts` (table `id` column, cli-agent-mode), config `hyperlinks`; Test `src/util/text.check.ts`, `src/features/format.check.ts`.

**Interfaces — Consumes:** `link`, `fileUrl`, `hyperOn` (Task 1), `canonicalUrl` (Task 5).

- [ ] **Step 1: Failing checks**: with `hyperMode` forced on (test hook `setHyper(true)`), the preview id row contains `\x1b]8;;agentglass://open/<h>/<id>` and `fillTo` widths are unchanged; detail file rows link to `fileUrl(abs)`; `format.render(…, "table", tty=true)` id cells linked, `json`/`csv`/`jsonl` output contains no `\x1b]`; forced off (agent mode / `--redact`) → no `\x1b]` anywhere in a rendered frame.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; suite `ok`; manual in kitty/WezTerm/GNOME Terminal: Ctrl+click the preview id (per Task 0 Step 5 results).
- [ ] **Step 5: Commit** `feat(palette): OSC 8 links for session ids and files where the terminal supports them`.

---

### Task 13: Linux URL handler (opt-in)

**Files:** Create `src/features/palette/urlhandler.ts`, `src/features/palette/urlhandler.check.ts`; Modify `src/features/palette/open.ts` (`--install-handler`, `--uninstall-handler`), `src/features/clihelp.ts`.

**Interfaces — Produces:**
- `export function desktopFile(term: string, exe: string): string` — `[Desktop Entry]`, `Type=Application`, `Name=agentglass link`, `NoDisplay=true`, `MimeType=x-scheme-handler/agentglass;`, `Exec=<term> -e <exe> open %u` (`exe` = `process.execPath`, quoted per the Desktop Entry spec when it contains spaces).
- `export function pickTerminal(cfg: string, env: Record<string, string>, has: (cmd: string) => boolean): string` — `open.terminal`, else `$TERMINAL`, else `x-terminal-emulator`; none available → `""` (refuse with a message).
- install: write `~/.local/share/applications/agentglass-open.desktop` (atomic), `xdg-mime default agentglass-open.desktop x-scheme-handler/agentglass`, `update-desktop-database ~/.local/share/applications` if present; uninstall: remove the file, run `update-desktop-database` if present; macOS → message pointing to the README URL-router section, exit 2.

- [ ] **Step 1: Failing check**: `desktopFile("kitty", "/home/u/.local/bin/agentglass")` exact text; path with a space quoted; `pickTerminal` precedence table and `""` when none exists.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; suite `ok`.
- [ ] **Step 5: Commit** `feat(palette): opt-in Linux handler for agentglass:// links`.

---

### Task 14: Real-life verification, docs, final review

**Files:** Modify `README.md` (keys table: `Ctrl+K`, `Y`; palette section; `agentglass open` grammar and examples; Grafana data-link and Jaeger link-pattern examples `agentglass://open/${gen_ai.conversation.id}#call=${gen_ai.tool.call.id}`; single-instance and its security model; spool vs socket; OSC 8 terminal table from Task 0 Step 5; Linux handler; macOS URL-router route), `CHANGELOG.md`.

- [ ] **Step 1: Real sessions (read-only).** Palette over the user's real sessions: type a few words of a known title, `fx tmz`-style abbreviations, `>resume`, `@`, `#`, `:`; check the 20k-item feel on the real count. `agentglass open <prefix>#call=<id>` of an old event in a large real session → lands on it (start cursor). A trace id from a `--dry-run` export (if otlp-export is configured) → right session and turn. With a TUI running: `agentglass open <id>` from another terminal → the running TUI shows it and rings; with `--redact` the toast shows the fake title.
- [ ] **Step 2: URL handler on GNOME (VTE) and KDE (Konsole)** if available: `--install-handler`, `xdg-open 'agentglass://open/<h>/<id>'` with no agentglass running → a terminal opens with the transcript; with one running → the running TUI shows it and the handler's terminal exits; `--uninstall-handler` removes it.
- [ ] **Step 3: Docs** + help text; `sh scripts/check.sh` → all `ok`; `./agentglass --json --subagents --limit 400` identical to `/tmp/agcp-json-main.json` except volatile fields.
- [ ] **Step 4: Commit** `docs: command palette, deep links, single instance, hyperlinks`.
- [ ] **Step 5: Final whole-branch review** (most capable model) against spec + Review Focus, with a dedicated security pass over Tasks 7–11 (`rundir.ts`, `handoff.ts`, `apply.ts`, `spool.ts`, `sock.ts`); one fix pass, PR to `main`, CI green (Linux + macOS), rebase-merge, remove worktree + branch, remove `/tmp/agcp-probe`.
