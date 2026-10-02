# Command palette and deep links — spec

Status: **draft** (2026-10-02). Roadmap: [../ROADMAP.md](../ROADMAP.md) — phase 7 (no hard dependency; trace-id links
need otlp-export's id scheme, project items use repo-view's identity when present).

## Goal
1. **Ctrl+K palette.** One fuzzy finder over everything agentglass can do or show: actions (every key binding,
   including feature keys), sessions (all harnesses, subagents too), projects and tabs/views. It is fully keyboard
   driven and works from the list, transcript, detail and feature views.
2. **Deep links.** `agentglass open <session-id>[#anchor]` starts the TUI on that session and event. An equivalent URL
   `agentglass://open/…` can be used in terminal hyperlinks (OSC 8), in exported spans (backend link templates) and in
   notes. `open` also accepts the trace and span ids that otlp-export emits.

## Why (user value)
- The key map has grown past what the `?` popup can teach: 40+ bindings over six contexts plus feature keys. The
  palette makes every action findable by name, and typing "resume" is faster than remembering `R`.
- Jumping to a session today means scrolling or `/`-filtering the list. The filter is a substring match, so `fx tmz`
  cannot find "Fix timezone bug in reports". A fuzzy palette over all sessions, ranked by recency, is the fastest
  route.
- Links make sessions addressable from outside: a commit message, an issue, a chat message, a span in Jaeger or
  Tempo, or a script's output can point straight at the event that matters.

## Today (current code, with path:line refs)
- **Keys:** `keyName` maps escape sequences and a few control characters (`src/input.ts:37-44`). Ctrl+K arrives as
  the raw `"\x0b"`, which no binding handles. Dispatch order:
  1. `input` and `confirm` modes (`input.ts:46-71`);
  2. the help popup (`:72-79`);
  3. feature keys through `H.keys` (`:81`);
  4. transcript (`:85-106`), detail (`:108-130`) and list (`:133-187`).
- **Modes:** `Mode` = list | transcript | detail | input | confirm | help | view (`src/state.ts:6`). Overlays remember
  `S.prevMode`.
- **Help** is a static table of display strings such as `"↑↓  j k"` (`src/ui/help.ts:10-41`), plus
  `H.helpSections` from features. These strings name keys for humans and cannot be executed.
- **Modals:** `renderModal(title, body, color)` draws a centered box (`src/ui/screen.ts:61-69`). The help popup is
  drawn last, over any view (`src/main.ts:49`).
- **Finding sessions:** `/` gives a substring filter over title, path, id and harness (`input.ts:157`); `F` gives
  ripgrep full-text search; `h`/`l` cycle the harness and toggle live-only. `y` copies the session id (`input.ts:166`).
  `Y` is unused in list, transcript and detail modes.
- **Jump to an event:** `TV.focusKind/focusTs/focusText` (`src/state.ts:10`) are consumed on the first render
  (`src/ui/transcript.ts:67-72`). The match needs kind **and** ts, plus either the same text or the same id. Stats
  uses this to jump to a tool call by id (`src/features/usage/stats.ts:360-365`). `openTranscript` reads only the
  last 6 MB (`transcript.ts:100-115`), so an older event cannot be focused.
- **Startup:** `H.cli` handlers either handle argv completely (return true, no TUI) or decline
  (`src/main.ts:57`). No handler can preset state for the TUI.
- **Escapes:** visible-width helpers know only CSI sequences: `fitStyled` (`src/util/text.ts:47-58`), `fillTo`
  (`:60-64`) and the redaction scrubber `scrubStyled` (`src/features/redact.ts:214-224`). agentglass prints no OSC 8
  hyperlinks; the only OSC it uses is 52 for the clipboard (`src/actions.ts:39`).

## Design

### 1. Action registry
1. **Registry.** A new seam `H.actions: Action[]` (`src/hooks.ts`):
   ```ts
   interface Action {
     id: string;            // stable, e.g. "session.resume", "theme.set.nord"; used for MRU
     title: string;         // "Resume session interactively"
     group: string;         // "Session", "Transcript", "View", "Theme", …
     keys: string;          // display hint, "R" ("" = palette only)
     when: (c: Ctx) => boolean;  // valid in the context the palette was opened from
     run: (c: Ctx) => void;
   }
   interface Ctx { mode: Mode; tab: number; fview: string; sess: Sess | null; ev: number } // origin snapshot
   ```
2. **Built-in actions** (`src/features/palette/actions.ts`) wrap the functions the keys already call:
   `openTranscript`, `ask("filter"…)`, `fullText`, `sendPrompt`/`ask("send")`, `resume`, `confirm("TERM")`, the
   trash confirm, `copyText`, tab switching, harness cycle, the live toggle, clear filters and help. They do not
   re-implement these functions. Every current binding in `help.ts:10-41` that does something has an action; pure
   movement keys (↑↓, PgUp) do not.
3. **Feature actions.** Each feature registers its own: the call graph (`c`), replay, theme switching (one action per
   theme: "Theme: nord"), the Stats period and sort, and later the export ("Export this session to OTLP…", only shown
   when `otlp.endpoint` is configured; it confirms first because it sends data).
4. **Replay fallback.** A feature may register `run: replayKey("x")`. It restores the origin mode, tab and selection,
   then calls `onInput("x")`. Features get palette entries without exporting internals, and the behavior is identical
   to pressing the key.
5. **Context.** `when()` filters by the origin context. Session actions apply to the origin's selected session (list
   row, or the open transcript's session). Actions that switch context ("Go to Stats", "Open call graph of …") are
   always valid.

### 2. Palette items and sources
| Source | Prefix | Item text (matched) | Right-side hint | Enter |
|---|---|---|---|---|
| actions | `>` | `group: title` | key, e.g. `R` | `run(ctx)` |
| sessions | `@` | title · project · harness · branch · id (subagents: `⑂ kind`, parent title) | harness glyph, `ago`, cost, `●` if live | open transcript (subagent: its own transcript) |
| projects | `#` | project label (repo-view identity; before repo-view, `base(cwd)` + full cwd) | sessions count, last active | Sessions tab, filter = that project (filter-language `project is X` once it exists, else the cwd substring) |
| tabs and views | `:` | "Sessions", "Processes", "Stats", feature tabs, "Call graph", "Help" | number key | switch |

1. **No prefix** searches all sources together. Typing a prefix as the first character restricts the search (the
   prefix is not matched); `?` alone lists the prefixes. Tab cycles the scope: all → actions → sessions → projects →
   tabs → all.
2. **Session actions.** On a session item, `→` opens a second level: open transcript, call graph, send prompt, resume,
   copy id, copy link (4.5), filter to its project, and export (if configured). `←` or Esc goes back.
3. **Item collection.** Items are collected once when the palette opens:
   - sessions from `sessions.values()`, with the same `H.meta` overrides the list shows, so `--redact` fakes apply;
   - projects from the distinct cwds of those sessions;
   - actions where `when(ctx)` is true.

   Haystacks are lower-cased once per open. Sessions that appear while the palette is open show up on the next open.

### 3. Matching and ranking (`src/features/palette/fuzzy.ts`, pure)
1. **Terms.** The query is split on spaces into terms. An item matches if **every** term matches as a subsequence
   (AND). Smart case: a term with an uppercase letter matches case-sensitively.
2. **Score per term** (fzf-v1-style, greedy forward pass, then a backward pass to tighten the match window):
   - +16 for a match at position 0;
   - +10 after a separator (space `/ - _ . : ·`);
   - +8 at a camelCase hump;
   - +4 for each character that continues a consecutive run;
   - −1 for each skipped character inside the window, capped at −30;
   - −0.1 × (haystack length) as a tie-breaker for short items.

   An item's score is the sum over its terms. The matched positions are kept for highlighting.
3. **Ranking:** score, then the MRU boost, then group weight, then recency.
   - MRU boost: +20 for an id chosen in the last 24 h, +10 for one chosen earlier.
   - Group weight (empty query only): recent sessions first, then actions valid here.
   - Recency: live sessions first, then by `mtime`.

   With an empty query the palette lists MRU items, then the 20 newest sessions, then actions for the current context.
4. **Budget.** Scoring is O(items × query length). The target is < 15 ms per keystroke for 20,000 items in the native
   build. When the new query extends the previous one, only the previous matches are rescored (incremental narrowing).
   At most 200 results are kept and sorted.

### 4. UI and keys
1. **Opening.** `keyName` maps `"\x0b"` to `ctrl-k`. In the list, transcript, detail and view modes, `ctrl-k` opens
   the palette (new mode `palette`, `S.prevMode` = origin). It is handled before `H.keys`, so features cannot shadow
   it. In input and confirm modes Ctrl+K is ignored. In the help popup, Ctrl+K closes help and opens the palette.
2. **Layout.** A centered box `min(100, W − 4)` wide (at least 40) and up to 17 rows high, drawn after the view like
   help:
   - title row "Go to…" and the scope (`all`/`actions`/…);
   - an input line `› query▏` with the placeholder `actions, sessions, projects, tabs — > @ # : ?`;
   - up to 15 result rows: kind glyph, text with matched characters in `C.accent` bold, and the hint right-aligned;
     the selected row uses `bg(C.sel)`;
   - a status row "12 of 2,340 · ↵ open · → actions · tab scope · esc close".

   Below 50 columns the hints are dropped; below 12 rows only 5 results are shown.
3. **Keys inside the palette:**
   - printable characters edit the query; `bs`, `ctrl-u` and `ctrl-w` work as in `input` mode (`input.ts:55-58`);
   - `↑`/`↓`, `ctrl-p`/`ctrl-n`, `PgUp`/`PgDn`, `Home`/`End` move the selection; the selection is kept by item id
     across re-ranking when that item still matches;
   - `↵` runs the item; `→` opens the session sub-list; `tab` cycles the scope;
   - `esc` or `ctrl-k` closes and restores the origin unchanged.

   The mouse wheel scrolls, a click on a row runs it, and a click outside the box closes the palette.
4. **Running an item.** Before `run()`, the origin mode, tab and selection are restored, so the action sees the same
   state as a key press there. The palette then closes. Actions that open an input or confirm dialog (send, kill,
   trash) work unchanged.
5. **Discoverability.** A footer hint `^K palette` in list mode, a "global" help row, and README keys table rows.
6. **MRU file.** `~/.agentglass/palette.json`: `{"v":1,"recent":[{"id":"session:<harness>:<id>","at":<ms>}, …]}`.
   - It holds at most 50 entries, keeps **ids only** (never titles), is written atomically on `H.onQuit`, and read
     once at start. A missing or corrupt file means an empty list.
   - Under `--redact` the MRU is read but not written, so a screencast session leaves no trace.

### 5. Deep links
1. **Grammar** (`src/features/palette/ref.ts`, pure parser + resolver):
   ```
   ref     = [harness ":"] sessref ["#" anchor] | url | traceid ["/" spanid]
   url     = "agentglass://open/" [harness "/"] session-id ["#" anchor]
   sessref = session-id | prefix (≥ 6 chars)
   anchor  = "turn=" n | "call=" tool-call-id | "ts=" iso-8601 | "span=" spanid
   traceid = 32 lowercase hex; spanid = 16 lowercase hex
   ```
   - URL components are percent-decoded once.
   - Harness ids are validated against `harnessIds()`. Ids allow only `[A-Za-z0-9._:-]`, at most 200 characters; a
     whole ref is at most 512 characters.
   - Unknown anchor keys are ignored with a warning.
   - No component is ever treated as a file path: a ref selects among already-scanned sessions only.
2. **Resolution:**
   1. `scan()`, then an exact id match across harnesses, narrowed by the harness if given.
   2. Else a unique prefix match (subagents included). Several matches exit 4 with the candidates as `harness:id
      title` lines on stderr. In the TUI the palette opens prefilled with `@<prefix>` instead.
   3. Trace ids (otlp-export §4.1): hash the first half `H("s|" + h + "|" + id)` for every top-level session; the
      index is built on demand and costs about 1 ms per 1,000 sessions. The second half selects the turn by hashing
      that session's turn keys (one parse via the shared `TurnCursor`). A span id resolves to a chat (turn), a tool
      (call) or an `invoke_agent` (subagent session) span.
   4. Anchors: `turn=n` → the turn's first event. `call=id` → the tool event with that id. `ts=` → the first event at
      or after that time.

   The resolver returns `{s, cursor, ev: {kind, ts, id, text}}`, where `cursor` is the source position of the
   record that holds the event.
3. **`agentglass open <ref>`** (TUI):
   - A new seam `H.start: ((): void)[]` runs once in `main()` after the first `scan()`/`buildView()`, before the
     first render (`main.ts:60-61`). The `open` CLI handler parses and resolves the ref, stores the target, and
     returns **false**, so the TUI starts and `H.start` applies the target: it selects the session's row and opens its
     transcript with the focus set.
   - If the event lies before the 6 MB tail, `openTranscript` gains an optional start cursor. It reads from
     `align(s, cursor − 64 KB)` and puts a meta line "showing from <time> (opened by link)" first. `G` and follow still
     go to the live end.
   - The focus matcher (`transcript.ts:70`) is unchanged; the resolver fills kind, ts and id exactly.
   - Failures exit before the TUI starts: not found → exit 3, ambiguous → exit 4, bad ref → exit 2, each with one
     stderr line.
4. **Without a TUI** (stdout not a TTY, `--print`, or agent mode from cli-agent-mode): print the resolution as JSON
   `{harness, id, path, title, cwd, anchor: {kind, turn, ts, callId}, url}` and exit 0. Scripts and agents can then
   resolve links without a screen.
5. **Canonical URL:** `agentglass://open/<harness>/<session-id>[#call=<id> | #turn=<n>]`.
   - `Y` copies it in the list (session) and in the transcript (cursor event: `call=` for a tool or result event,
     else `ts=`) through `copyText` (`actions.ts:29-41`). `y` keeps copying the bare id.
   - `agentglass open --print-url <ref>` prints the canonical form.
   - Exported spans need no extra attribute. A backend link template builds the URL from span attributes, for example
     `agentglass://open/${gen_ai.conversation.id}#call=${gen_ai.tool.call.id}`; the harness segment is optional for
     that reason. The README shows Grafana data-link and Jaeger link-pattern examples. Copying the trace id from any
     backend and running `agentglass open <trace-id>` works without any configuration.
6. **OS URL handler** (opt-in, Linux):
   - `agentglass open --install-handler` writes `~/.local/share/applications/agentglass-open.desktop`:
     `Type=Application`, `NoDisplay=true`, `MimeType=x-scheme-handler/agentglass;`,
     `Exec=<terminal> -e <absolute agentglass path> open %u`. It then runs
     `xdg-mime default agentglass-open.desktop x-scheme-handler/agentglass`, and `update-desktop-database` if
     present. `--uninstall-handler` reverses this.
   - Terminal choice: `open.terminal` in config, else `$TERMINAL`, else `x-terminal-emulator`. If none exists the
     command refuses and says so.
   - macOS needs an app bundle that declares `CFBundleURLTypes` (open question 1); until then macOS users run
     `agentglass open '<url>'`.
   - **Security:** any web page can trigger a scheme link. `open` only reads and shows: it never sends, resumes,
     kills or exports. A link can do nothing more than open a viewer on an existing session. The strict grammar
     (5.1) rejects everything else.
7. **No IPC.** A link always starts a new agentglass. Handing a link to a running instance is out of scope.

### 6. OSC 8 terminal hyperlinks
1. **Form:** `ESC ] 8 ; ; <url> ESC \ <text> ESC ] 8 ; ; ESC \`. A new helper `link(url, text)` in `src/util/text.ts`
   returns `text` unchanged when hyperlinks are off.
2. **Where:**
   - CLI `--format table` (cli-agent-mode): the session id column links to its `agentglass://` URL.
   - TUI: the session id in the preview metadata and the transcript header (`agentglass://`), and file paths in the
     detail view's file list (`file://<hostname><abs path>`).
   - Never in JSON, CSV, JSONL or `--watch` output.
3. **Enablement.** Config `"hyperlinks": "auto" | "on" | "off"` and env `AGENTGLASS_HYPERLINKS`.
   - `auto` is on for stdout TTYs whose terminal is known to support OSC 8: `TERM_PROGRAM` ∈ {iTerm.app, WezTerm,
     vscode, ghostty}, `TERM=xterm-kitty`, `VTE_VERSION` ≥ 5000, or `WT_SESSION`.
   - `auto` is off inside tmux (`TMUX` set) and screen, because pass-through needs tmux ≥ 3.4 with
     `terminal-features hyperlinks`. Users can force `on`.
   - Always off in agent mode and under `--redact`. In a redacted session a `file://` URL would carry the real path
     inside an invisible escape (the scrubber only rewrites visible text), and screencasts can record it.
4. **Escape-aware widths.** A shared `ESC_RE` in `text.ts` matches CSI **and** OSC 8 sequences (terminated by ST or
   BEL). `fitStyled`, `fillTo`, `scrubStyled` and every `\x1b\[` strip use it. Cutting a line inside a link closes the
   link (`ESC ] 8 ; ; ESC \`) before `RST`, so the hyperlink cannot spill into the next cell.
5. **Mouse.** agentglass enables SGR mouse reporting, so a plain click goes to agentglass. Whether Ctrl/Cmd+click
   still opens hyperlinks under mouse reporting depends on the terminal (kitty, WezTerm and iTerm2 are reported to
   allow it; to verify, open question 3). Links stay a convenience; every target is also reachable with keys.

### 7. Failure modes and privacy
- **Empty results:** "no match — tab to change scope". With 0 sessions, the session scope says so.
- **A session disappears** while the palette is open (trashed in another window): running its item warns "that
  session is no longer on disk", as Stats does (`stats.ts:361`).
- **Redaction:** under `--redact`, palette text and hints go through the same `H.meta`/`H.display`/screen filter as
  the list, so titles and projects show their fakes. Fuzzy matching runs on the fake text the user sees, never on the
  hidden real titles.

## Interactions with other specs
- **otlp-export:** the trace-id and span-id resolution uses its id scheme (§4.1, `src/util/sha256.ts`) and the shared
  `TurnCursor` for `turn=` anchors. Its export action appears in the palette when an endpoint is configured.
- **cli-agent-mode:** `open` prints JSON in agent mode. `--format table` uses OSC 8 links when enabled. Both share the
  `<ref>` grammar with `agentglass session <ref>`.
- **filter-language:** the project item applies a `project is X` clause (pinned filters stay). Saved filters could
  become palette items later.
- **repo-view:** project identity and labels for `#` items. A project item could open the Repos tab instead of a
  filtered list once that tab exists.
- **related-events:** "Show related events" registers as a transcript/detail action.

## Testing
- **Fuzzy unit checks** (`fuzzy.check.ts`):
  - `fx tmz` finds "Fix timezone bug";
  - boundary beats mid-word, consecutive beats scattered;
  - smart case;
  - AND across terms;
  - incremental narrowing gives the same ranking as a full rescore;
  - a 20k-item benchmark stays under 15 ms in the native build.
- **Registry coverage:** every non-movement row of `help.ts` HELP has an action with the same key hint (a check
  diffs the two lists). Each action's `run` in its context gives the same state as the key press (state snapshot
  before and after, via `replayKey` and via the direct call).
- **Key handling:** `\x0b` → `ctrl-k` opens from list, transcript, detail and the call-graph view; ignored in input
  and confirm; Esc restores mode, tab, selection and scroll exactly.
- **Ref parser:** table tests for every grammar form, percent-decoding, length and charset limits, unknown anchors,
  and rejection of `../` and absolute paths.
- **Resolver on a fixture HOME:** exact id, prefix, ambiguous prefix (exit 4), a trace id from an otlp-export golden
  file → the right session and turn, a span id → the right call, and an event older than the 6 MB tail is focused.
- **Width with OSC 8:** `fitStyled`, `fillTo` and `scrubStyled` on strings with links measure the visible width
  only; a cut inside a link closes it.
- **Manual:** the Linux handler install and uninstall on GNOME (VTE) and KDE (Konsole); a link from a browser opens a
  terminal with the transcript.

## Out of scope
- Handing a link to an already running instance (IPC, single-instance mode).
- A macOS app bundle and a Windows protocol handler.
- User-defined palette commands or macros.
- Fuzzy matching inside transcript content (that is `F` full-text search).
- Changing existing key bindings.

## Open questions
1. **macOS handler.** Ship a minimal `.app` wrapper (an `Info.plist` with `CFBundleURLTypes` plus a launcher script
   that opens Terminal or iTerm with `agentglass open`), or document a third-party URL router? The wrapper adds
   signing and quarantine questions.
2. **Single instance.** When an agentglass TUI is already running, should a link focus it (through a small Unix
   socket under `~/.agentglass/run/`) instead of starting a second one? The value is real, but so is the attack
   surface.
3. **Clicks under mouse reporting.** Which terminals open OSC 8 links on Ctrl/Cmd+click while SGR mouse reporting is
   on? To be checked in kitty, WezTerm, iTerm2, GNOME Terminal, Konsole and Windows Terminal before `auto` is
   considered final.
4. **Turn anchors.** Should `turn=n` use the stable turn key (start timestamp) instead of the index? Then a link stays
   valid when a Gemini rewind removes earlier turns. The trade-off is less readable URLs: `turn=2026-10-02T09:14:03.120Z`.
