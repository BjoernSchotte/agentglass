# Local web API and `agentglass web` — spec

Status: **draft** (2026-10-10). Roadmap: [../ROADMAP.md](../ROADMAP.md) — Round 3 (after 2026.10.10). A core
feature: it works in plain single-user agentglass; [fleet-teams](../fleet-teams/spec.md) adds team, room and member
as optional dimensions on top and depends on this spec. Both are built together, slice by slice (plans: shared slice
table).

## Goal
1. **A stable read model** for everything agentglass shows — sessions, events (with the event-kind filter), call
   graph, stats/cost, skills, wait, alerts, repos, fleet hosts, and (with fleet-teams) teams, rooms, members — with
   the shapes of the `--json` contract (`docs/cli-contract.md`), one schema, versioned.
2. **`agentglass serve --stdio`**: one persistent, read-mostly JSON-lines protocol on stdin/stdout (requests,
   subscriptions with resumable push events, and an explicit typed command channel). Every privacy rule (room
   policies, `skills.hide`, `--redact`) is applied inside agentglass before a byte leaves it.
3. **`agentglass-web`**: a second binary (TypeScript, compiled with Bun) that serves the web UI's static assets
   (embedded), a loopback-only HTTP/JSON API, Server-Sent Events and a WebSocket, hardened against other local users,
   other browser tabs and DNS rebinding. It never reads logs or caches: its only data source is one
   `agentglass serve --stdio` child.
4. **`agentglass web`**: finds and starts `agentglass-web` (or says how to install it), opens the browser with a
   one-time link.
5. **The web UI** (React, shadcn/ui, cmdk, lucide, IBM Plex): a Linear-style shell (collapsible sidebar, theme
   switch, ⌘K palette, TUI-like keys) with live views; this spec defines the shell, the first live views and the
   interaction model and the verified visualization stack (section 12).

## Why (user value)
- The TUI is the fastest way to watch agents in a terminal; a browser is better for wide tables, zoomable timelines,
  heatmaps, relationship graphs, and for people who live in a browser. Both should show the same numbers.
- Team members (fleet-teams) want their team's statistics in a page they can keep open, without a SaaS account.
- Integrations (dashboards, scripts, the herdr plugin later) want a live stream with stable shapes instead of
  re-running the CLI per question.
- Doing this inside agentglass keeps one source of truth for privacy: a web page can show only what the read model
  hands out.

## Today (current code, with path:line refs)
- **JSON contracts**: `--json` sessions, `session <ref>`, `cost`, `wait`, `events [<ref>]`, `open`, MCP — contract 1
  (`docs/cli-contract.md:7,44,84,103,120,154,179,209`). Sessions are `jsonSess()` (`src/features/cli.ts:200-211`).
- **A live stream exists as JSONL**: `agentglass --watch` streams new events of all agents (`src/features/cli.ts:81,
  486`), state per session through `watchLines()` (`src/features/fleet/watch.ts:28`); the alarm cadence is
  `H.onWatch` (1.5 s while agents are live, else 5 s; `src/hooks.ts:26`).
- **A persistent stdio JSON-RPC server exists**: `agentglass-mcp` frames stdin by bytes (`src/mcp/rpc.ts:16-30`,
  `MAX_LINE` 4 MB at `rpc.ts:9`), reads `process.stdin` events (`src/mcp/main.ts:193-194`), but answers each tool by
  running one `agentglass` CLI child (`docs/cli-contract.md:213`) — fine for an agent's few calls, not for a live UI.
- **HTTP in scriptc**: `agentglass receive` serves HTTP with `node:http` (`src/features/hub/server.ts`), but scriptc
  has no `maxConnections` and does not enforce `headersTimeout`, so the hub implements a connection cap and header
  timer itself (`server.ts:25,278-284`); no WebSocket server; TLS only in a separate C-backend binary
  (`src/receive-tls.ts:1-6`). Long-lived streaming responses and upgrades were never built in scriptc.
- **Actions** a web UI would trigger (all TUI-bound today): `sendPrompt(sub, msg)` (`src/actions.ts:83`, through the
  multiplexer's `send`, `src/mux/types.ts:32`), `resume(sub)` (`actions.ts:105`, mux `start`, `types.ts:36`),
  `killPid(pid, sig)` (`actions.ts:126`), `trash(s)` (`actions.ts:132`), mux `focus` (`types.ts:33`), and 53 palette
  actions that replay TUI keys in a restored TUI context (`src/features/palette/actions.ts:20`) — usable only with a
  TUI state, not as an API.
- **Single instance and hand-off**: `~/.agentglass/run/` spool files and `tui.lock` (`src/features/palette/spool.ts:17,
  58`, `rundir.ts:17-82`); scriptc 0.1.7 has no Unix-domain sockets.
- **Privacy switches** are process-wide: `REDACT` (`src/features/redact-on.ts:5`), `skills.hide` through `skillVis()`
  (`src/features/skills/vis.ts`), fake names (`src/features/redact.ts:128,152`).
- **No `package.json`, no JavaScript toolchain in the repo**: everything is scriptc TypeScript under `src/`, built by
  `build.sh`; releases are four native archives (`.github/workflows/build-artifacts.yml:17-24`).

### Measurements (2026-10-10, this machine)
Prototype `agentglass-web`: `Bun.serve` on 127.0.0.1 with an embedded HTML file and a 400 KB embedded asset, cookie
check, Host check, an SSE endpoint, a WebSocket echo, one `cat` child on stdio. Bun 1.3.14.

| what | result |
|---|---|
| `bun build --compile --minify` | 0.15 s |
| binary size linux-x64 / linux-arm64 / darwin-arm64 / darwin-x64-baseline | 95 / 94 / 64 / 70 MB (all cross-compiled from this Linux host) |
| linux-x64 archive | 36.3 MB gzip, 25.4 MB xz |
| exec → listening | 23 ms (2 ms inside the process) |
| idle, no client, no timers (30 s) | 0.07 s CPU (0.23 % of one core), 18.0 MB RSS |
| 3 SSE clients, one push per second (30 s) | 0.24 s CPU (0.8 %), 23.6 MB RSS |
| wrong `Host` → 421, no cookie → 401 | as designed |

Consequences: the web binary costs ~20 MB of RAM and next to no CPU; its download is large (≈ 25–36 MB compressed),
so it ships as a separate archive and never inflates the CLI/TUI download; pushes must be event-driven (no 1 s
polling timers), with a 25 s heartbeat.

## Design

### 1. Processes
```
browser ⇄ (http://127.0.0.1:<port>, cookie)  agentglass-web  (Bun binary: static UI, /api/v1, SSE, WS, auth, limits)
                                                   ⇅ one stdin/stdout pipe: agentglass-serve/1 (JSON lines)
                                             agentglass serve --stdio [--redact] [--read-only]  (scriptc: read model,
                                                   privacy, subscriptions, commands; same caches as the TUI)
```
- `agentglass web [--port N] [--no-open] [--allow-commands] [--redact]`: finds `agentglass-web` next to its own
  binary, then on `PATH`; missing → exit 2 with the install line for this platform (`brew install
  bjoernschotte/tap/agentglass-web`, or `install.sh --web`). Starts it (detached, logs to `~/.agentglass/logs/
  web.log` 0600), passes its own path; `agentglass-web` starts the serve child. A running instance (lock
  `run/web.lock` with port and pid) is reused: `agentglass web` only mints a new one-time link (section 4).
- The serve child is a headless agentglass: discovery, ledger, watch cadence, fleet/team feeds — the TUI's engine
  without rendering, reading the same caches (warm start). It exits when stdin closes.
- Running the TUI and the web at once means two engines (≈ the TUI's footprint twice: tui-footprint's ≤ 300 MB
  target). Decision 4 records why the TUI does not host the server.

### 2. Read model (`src/read/`, scriptc)
One module per resource, each a pure function from the engine's state to a contract object; the CLI's `--json`
commands are refactored to call them, so CLI, protocol and (where it renders the same aggregate) the TUI share code.

| resource | protocol method | HTTP | shape |
|---|---|---|---|
| meta | `meta` | `GET /api/v1/meta` | version, contract, protocol, caps, readOnly, redact, harnesses, teams (fleet-teams), me |
| sessions | `sessions.list {filter, limit, cursor, subagents}` | `GET /api/v1/sessions` | `--json` rows (`jsonSess`) + `host`, `member` (teams) |
| session | `sessions.get {ref}` | `GET /api/v1/sessions/{ref}` | `session <ref>` |
| events | `events.list {ref, kind, from, limit, content}` | `GET /api/v1/sessions/{ref}/events` | `events` (kind filter, presets) |
| call graph | `graph.get {ref, window}` | `GET /api/v1/sessions/{ref}/graph` | the lean call-graph events of #110, columnar |
| cost | `cost.get {by, period, filter}` | `GET /api/v1/cost` | `cost --json` |
| stats | `stats.get {period, filter}` | `GET /api/v1/stats` | Stats tab aggregates (per harness/model/day/hour) |
| skills | `skills.get {period, filter}` | `GET /api/v1/skills` | `skills --json` + advice |
| wait | `wait.get {by, since, filter}` | `GET /api/v1/wait` | `wait --json` |
| alerts | `alerts.list {since}` | `GET /api/v1/alerts` | alert log rows (rule id, severity, session, at, message) |
| repos | `repos.list {period}` | `GET /api/v1/repos` | Repos tab rows |
| fleet | `fleet.hosts` | `GET /api/v1/fleet` | `fleet status --json` |
| team (fleet-teams) | `team.*` | `GET /api/v1/team/…` | `team status/report/sessions/activity --json` |

- Every resource takes the filter language (`filter` = the TUI's expression) and returns `{data, at, gen}` with a
  generation counter per resource for cheap revalidation (`If-None-Match: "<gen>"` → 304).
- Aggregation is always server-side; the browser never sums raw rows.
- Pagination: `cursor` (opaque) + `limit` (≤ 1,000 rows; graph and events in columnar chunks).
- Transcript content: as local as the TUI — `content: true` returns event text locally (like `events --content`);
  never for remote fleet/team rows (they have none). `--redact` applies to everything.

### 3. Protocol `agentglass-serve/1` (stdin/stdout, JSON lines)
Framing: one JSON object per line, ≤ 4 MB (the MCP framer, `src/mcp/rpc.ts`, moved to `src/util/jsonl.ts` and shared).
```
→ {"id":1,"m":"hello","p":{"client":"agentglass-web","version":"…","want":1}}
← {"id":1,"ok":{"proto":1,"contract":1,"version":"2026.10.x","readOnly":true,"redact":false,"caps":["sessions",…,"cmd"]}}
→ {"id":2,"m":"sessions.list","p":{"filter":"live","limit":200}}
← {"id":2,"ok":{"data":[…],"at":…,"gen":17,"next":null}}
→ {"id":3,"m":"sub","p":{"topic":"sessions","from":"e3a9-1042"}}            topics: sessions, events:<ref>, alerts,
← {"id":3,"ok":{"sub":"s1","resumed":true}}                                  presence, stats, wait, fleet, team:<team>/<room>
← {"sub":"s1","ev":"e3a9-1043","k":"patch","d":{"upsert":[…],"remove":["claude:…"]}}
← {"sub":"s1","ev":"e3a9-1044","k":"hb"}                                      heartbeat every 25 s when quiet
→ {"id":4,"m":"unsub","p":{"sub":"s1"}}
→ {"id":5,"m":"cmd","p":{"cmd":"session.sendPrompt","args":{…},"idem":"<uuid>"}}   section 9
← {"id":5,"ok":{"state":"confirm","nonce":"…","summary":{…},"expiresAt":…}}
```
- Event ids: `<server epoch (4 hex)>-<seq>` per topic. Each topic keeps a ring of the last 1,000 events or 10 minutes;
  `from` inside the ring → replay then live (`resumed: true`); outside or another epoch → a `snapshot` event first
  (`resumed: false`). Patches are computed on the engine's existing cadence (watch tick, scan, ledger, feeds): no
  timers just for subscribers.
- Errors: `{"id":…, "err":{"code":"not_found|bad_filter|read_only|remote_session|rate|internal","msg":"…","hint":"…"}}`.
- Backpressure: the serve process writes with `writeSync(1, …)`; the BFF reads continuously and keeps its own
  per-client queues (section 5), so a slow browser never blocks the engine.
- The protocol is part of the CLI contract under its own number (`proto: 1`), documented in `docs/cli-contract.md`,
  with goldens.

### 4. Authentication and hardening (`agentglass-web`)
- **Bind**: `127.0.0.1` (and `::1` only with `--ipv6`), port random unless `--port`. Non-loopback addresses are
  refused in this release (no flag to expose it; remote access is an SSH tunnel, documented).
- **Token**: per run, 32 random bytes. `agentglass web` opens `http://127.0.0.1:<port>/#t=<token>`; the page's JS
  posts it once to `POST /api/v1/session`; the server answers `Set-Cookie: agw=<session id>; HttpOnly;
  SameSite=Strict; Path=/` and a CSRF token in the body; the JS removes the fragment (`history.replaceState`). Tokens
  are single-use (a replay from history fails) and expire after 2 minutes unused. A second `agentglass web` while one
  runs writes a new token into `run/web.tokens` (0600, hashes only), which the server re-reads. The fragment never
  reaches server logs or `Referer`.
- **Other local users**: loopback TCP is reachable by every local user; without the cookie every route except the
  static shell and `/api/v1/session` answers 401. `run/` is 0700 (`secureDir`).
- **Other browser tabs**: CORS off (no `Access-Control-*` headers ever); `SameSite=Strict`; every non-GET request and
  every WebSocket upgrade must carry `Origin` equal to `http://127.0.0.1:<port>` or `http://localhost:<port>`
  (cross-site WebSocket hijacking); POST requests carry `X-AG-CSRF` matching the session's CSRF token.
- **DNS rebinding**: `Host` must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>` → else 421.
- **Headers**: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr
  'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri
  'none'; form-action 'none'` (no inline script, no remote origin; `style-src-attr` because Radix positions popovers
  with style attributes — Open question 3), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`
  on `/api`.
- **Limits**: request body ≤ 64 KB; WS frame ≤ 64 KB; ≤ 16 concurrent streams (SSE + WS) per server; per socket ≤ 20
  commands and ≤ 50 requests per second; per-client outbound queue ≤ 2 MB — over it the socket closes with 1013 /
  the SSE stream ends and the client resumes from its last event id; header and idle timeouts (Bun.serve
  `idleTimeout`, heartbeats keep streams alive).
- **Logs**: `web.log` holds method, path (no query values), status and timing; never tokens, cookies, filters with
  values, prompt text or response bodies.

### 5. Streaming: WebSocket first, SSE + POST as fallback
- **WebSocket** (`GET /api/v1/ws`, authenticated at the upgrade): one socket per tab carries everything: requests
  `{id, m, p}`, subscriptions, push events, command frames `{id, cmd, args, idem, csrf}`, acks, progress and results.
  The BFF maps socket requests 1:1 onto the stdio protocol (its own id space) and fans subscription events out to
  sockets (one upstream subscription per topic+params, shared by all tabs).
- **SSE** (`GET /api/v1/stream?topics=…`, `Last-Event-ID` resume) + `POST /api/v1/commands` and the `GET` resources:
  the fallback where WebSockets fail (proxies, extensions). Same events, same ids.
- Reconnect: the client keeps the last event id per topic and resubscribes with `from`; a `snapshot` replaces its
  state when the ring no longer covers it.

### 6. Packages and repository layout
```
package.json, pnpm-workspace.yaml, pnpm-lock.yaml, .npmrc (engine-strict), .bun-version     (root: private, no deps)
packages/api-contract   JSON Schema (draft 2020-12) per resource, event and command = the one source; generated TS
                        types (committed); conformance tests (bun test) that run `agentglass serve --stdio` against
                        a fixture HOME and validate every response, event and the CLI `--json` goldens
packages/ui             shadcn/ui components (source, copied in), Tailwind preset, design tokens (CSS variables), IBM
                        Plex fonts (subset woff2, OFL), icons via lucide-react
packages/viz            visualizations (section 12: uPlot, ECharts, custom timeline, sigma, React Flow, tables), lazy per route
packages/web            React app (Vite + TypeScript), routes, state, cmdk palette; builds static assets
packages/bff            agentglass-web: Bun.serve, auth, SSE/WS, stdio client, embeds packages/web/dist
src/                    unchanged home of agentglass (scriptc): read model, `serve --stdio`, `web` launcher
```
- The scriptc side has no npm dependency; `build.sh` does not touch `packages/`. The CLI/TUI download and runtime are
  unchanged (Decision 6).
- Contract flow: schema → `pnpm --filter api-contract gen` → `types.gen.ts` (web, bff). The scriptc server cannot
  import npm code; it is held to the schema by the conformance test in CI (every method, every event kind, every
  command, plus negative cases).

### 7. The web UI
**Stack** (user decision; React version settled by the research, Decision 14): React 19.2.x, Vite, TypeScript, shadcn/ui (Radix primitives + Tailwind), `cmdk` (shadcn's
Command) for the palette, lucide-react icons, TanStack Router (typed search params: the URL holds the filter, period,
time range and selection — deep links mirror the TUI's `agentglass://` `f=`/`view=`), TanStack Query for request
caching over the socket. No CSS-in-JS runtime. Fonts: **IBM Plex Sans + IBM Plex Mono** (Decision 8), self-hosted,
subset to Latin + Latin-1 Supplement + punctuation/arrows used by the TUI, weights Sans 400/500/600, Mono 400/500,
`font-variant-numeric: tabular-nums` for every number column.

**React 19 constraints** (research 2026-10-10, section "React 18 vs 19"):
- shadcn/ui's current registry (Tailwind v4 style) passes `ref` as a prop and has no `forwardRef`; on React 18 the
  ref is dropped and Radix `asChild` triggers (Tooltip, Popover around our Button) break. React 18 would mean the
  older v3 component set and Tailwind v3: not chosen.
- Do not enable the React Compiler on TanStack Table v9 components (`"use no memo"` in those files): open issues
  TanStack/table #6577, #6524 (and #6601, a v9 rerender issue).
- Do not wrap React Flow in React 19.2 `<Activity>` (xyflow #6044: the store resets when a flow is hidden).
- Framework-agnostic libraries (uPlot, ECharts, sigma, graphology) are mounted imperatively in `useEffect` by our own
  thin wrappers that call `destroy()` / `dispose()` / `kill()` in cleanup (StrictMode double mount safe).
- Versions checked 2026-10-10: cmdk 1.1.1, radix-ui 1.7.0, @tanstack/react-query 5.104.1, zustand 5.0.15 — all with
  React `^18 || ^19` peers.

**Layout (Linear-style)**:
```
┌───────────────┬────────────────────────────────────────────────────────────────────┐
│ ▣ acme ▾      │  Sessions                       / filter…        ⌘K   ◐  ?          │
│   room: all ▾ │  ─────────────────────────────────────────────────────────────────  │
│ ▸ Sessions  1 │  ● claude  fix flaky test        api      $1.20   2m   ◆            │
│   Stats     2 │  ● codex   add retry to fetch    web      $0.40   5m                │
│   Skills    3 │  ○ pi      docs: install          docs     $0.05   1h               │
│   Wait      4 │                                                                     │
│   Alerts    5 │                                                                     │
│   Fleet     6 │                                                                     │
│   Team      7 │                                                                     │
│   Rooms     8 │                                                                     │
│ ─────────     │                                                                     │
│   Settings  , │                                                                     │
│ «  collapse   │  live · synced 2 s ago · 3 agents running                            │
└───────────────┴────────────────────────────────────────────────────────────────────┘
```
- **Sidebar**: sections mirror the TUI's tabs: Sessions, Stats, Skills, Wait, Alerts, Fleet, Team, Rooms, Settings
  (Team/Rooms only with a team; Fleet only with hosts). Collapsible to icons (`[` toggles; state in `localStorage`
  per browser, wrapped in try/catch). The team/room switcher sits at the top in team mode (`T` opens it).
- **Keys**: `⌘K`/`Ctrl-K` palette; `?` help; `/` filter (the TUI's expression language, with completion from the
  attribute model); `g` then a section letter or `1`–`9` for sections; `j`/`k`/`↑`/`↓` rows, `↵` open, `esc` back,
  `[`/`]` previous/next event in a transcript (TUI keys), `d`/`w`/`m`/`a` period where the TUI uses them. Every
  shortcut appears in the palette with its key hint.
- **Palette** (`cmdk`): navigation, filters incl. event-kind presets, open session (fuzzy over title/repo/id), switch
  team/room, theme, recent items (last 10, `localStorage`), commands (section 9, shown disabled with the reason when
  read-only). Items carry key hints. The command list comes from the server (`meta.caps`) so web and TUI palettes
  share names and ids where the action exists in both.
- **Theme**: dark / light / system (default system, follows `prefers-color-scheme` live). No flash: a 1 KB
  `theme.js` (same origin, CSP-allowed, loaded blocking in `<head>`) sets `data-theme` from `localStorage` before
  first paint; CSS sets `color-scheme`. Tokens (`packages/ui/tokens.css`): background, surface, border-subtle,
  border, text, text-muted, accent, focus, and the TUI's semantic colours (live, attention, stuck, error, cost,
  harness colours) for both themes, contrast ≥ 4.5:1 for text, ≥ 3:1 for UI glyphs.
- **Feel**: dense rows (28 px), calm type scale (13/14 px base), subtle 1 px borders over shadows, transitions
  ≤ 120 ms and none under `prefers-reduced-motion`.
- **A11y**: visible focus rings (2 px `--focus`), every action reachable by keyboard, landmarks and labelled
  sidebar, live regions for toasts, tables with proper headers, no information by colour alone (glyphs ●◆⚠ as in the
  TUI).
- **First live views** (this spec's slices): Sessions (live list, filter, detail drawer with the session's fields
  and events with the kind filter), Stats (cost today/week/month, per harness, per model), Alerts (live log), Fleet
  (hosts, staleness), Settings (read-only view of config, theme). Further views (Skills, Wait, call graph, Team,
  Rooms) arrive with their slices.

### 8. Interaction model across views
- One global **time range** and one **filter** per tab, held in the URL (deep-linkable, mirrors the TUI's `f=` and
  `view=`); brushing a range or clicking a bar in one chart sets the filter/range, and every other chart and table
  of the view follows (crossfilter).
- Hover shows exact numbers (tabular figures, the TUI's money format with `≈`, billing tags); click drills to the
  filtered session list; shift-click adds a clause.
- Live updates never move what the user is reading: new rows are counted in a "N new" pill until the user scrolls up
  or presses `.`.

### 9. Commands (a separate, typed, explicit channel)
- **Typed set only** (in `packages/api-contract/commands/*.json`): there is no generic "run CLI args" or shell
  passthrough, now or later. Each command has a risk class:

| class | commands | gate |
|---|---|---|
| R0 UI state | `view.set` (remembered view state per browser: stays in the BFF/browser, not in agentglass) | none |
| R1 local config | `filter.pin`/`unpin`, `budget.set`, `rules.set {rule, threshold}`, `skills.hide.set`, `prices.set` (model-prices) | CSRF + UI confirm; server: CSRF + idempotency key |
| R2 process | `session.sendPrompt {ref, text}`, `session.resume {ref}`, `session.focus {ref}`, `process.kill {pid, ref, signal}`, `session.trash {ref}` | two-step confirm with a nonce; kill and trash: typed confirmation (the session's short id) |
| R3 team | `team.join`, `team.share {room, add, remove, pause}`, `team.leave`, `team.invite`, `team.renameMe` (fleet-teams) | two-step confirm whose summary is the consent preview |

- **Two-step confirm**: the server answers a R2/R3 command with `{state: "confirm", nonce, summary, expiresAt}`
  (nonce: 16 random bytes, single use, 60 s, bound to the socket/session, the command and its arguments' hash); the
  summary says exactly what will happen ("send 42 characters to claude 3f2a… in herdr pane w2:t1 (busy: queued by
  herdr)", "kill pid 4242 claude (fix flaky test) with SIGTERM"); the UI shows it in a dialog like the TUI's confirm;
  the client sends `confirm {nonce}` → the result. `session.sendPrompt` refuses at an open approval dialog exactly as
  the TUI does (`mux-herdr`).
- **Read-only by default (first release)**: `agentglass web` starts the serve child with `--read-only` unless
  `--allow-commands` or config `web.commands: true`; the serve process rejects every R1–R3 command with `read_only`
  (defence in depth: a compromised BFF cannot execute). R0 never reaches agentglass.
- **Idempotency**: `idem` (UUID) per command; the serve process remembers results for 10 minutes; a repeat returns the
  first result.
- **Audit log**: `~/.agentglass/web-audit.log` (0600, JSON lines): time, command, target session/pid, argument
  summary (prompt: length and SHA-256 prefix, never the text), result, client (socket id, user agent family). `team
  doctor`-style `agentglass web --audit` prints the last entries.
- **TUI toast**: the serve process drops a note into `run/` (the spool of `palette/spool.ts`); a running TUI shows
  "web: sent a prompt to claude 3f2a… (fix flaky test)" once.
- **Own machine only (invariant)**: commands resolve their target among *local* sessions and processes only. A
  fleet host's row or a team member's row → `remote_session` with the hint `ssh <host> agentglass open <ref>` (fleet)
  or nothing at all (team). No command is ever forwarded to another machine, and no team stream carries commands.
  Tested (Testing).
- The TUI's palette actions are not exposed as such (they replay keys in TUI context, `palette/actions.ts:20`); the
  commands above call the underlying functions with explicit targets (`sendPrompt`, `resume`, `killPid`, `trash`,
  mux `focus`), refactored so the TUI and the serve process call the same code.

### 10. Team dimensions (fleet-teams on top)
- `meta.teams`, a `team` and `room` parameter on every list/aggregate resource, `member` as a dimension (`by:
  "member"`) and filter key, topics `team:<team>/<room>` and `presence`, resources `team.status`, `team.report`,
  `team.sessions`, `team.activity` — the shapes of fleet-teams section 11.
- Room policies are applied where they always are — at the publisher; the read model only ever holds what a room
  stream delivered. Member names are shown only inside their team's views; `--redact` fakes them.
- Without a team, these parameters and sections are absent; the API and UI are complete for a single user.

### 11. Release, CI and supply chain
- **Toolchain pins**: `.bun-version` (Bun), `packageManager: pnpm@<x>` in the root `package.json`; CI uses exactly
  these; `pnpm install --frozen-lockfile`; `bun install` is not used (pnpm owns dependencies; Bun only runs and
  compiles).
- **CI job `web`** (Linux): install, typecheck (`tsc -b`), lint, unit tests (`vitest` for `packages/web` and `ui`,
  `bun test` for `bff` and `api-contract`), conformance test against a freshly built `agentglass` (the existing
  build job's artifact), bundle-size budget check, Playwright smoke (Chromium only: open the one-time link, see the
  live Sessions view update when a fixture session file grows, try a cross-origin WebSocket and a wrong `Host` → refused).
- **Release**: one Linux job cross-compiles `agentglass-web` for linux-x64 (`bun-linux-x64-baseline`), linux-arm64,
  darwin-x64 (`bun-darwin-x64-baseline`, older CPUs) and darwin-arm64 (measured: all four build from one host), a
  smoke run of the linux-x64 binary, archives `agentglass-web-<target>.tar.gz`, checksums, build-provenance
  attestations like the main archives; macOS signing as the main binary gets (if any).
- **Install**: tap formula `agentglass-web` (depends on `agentglass`), its `test do` runs `agentglass-web --version`
  and a loopback start/stop; the formula-proof workflow covers it. `install.sh --web` downloads it next to
  `agentglass`.
- **Dependabot**: npm ecosystem on the root with groups `react` (react, react-dom, @types/react*), `ui` (@radix-ui/*,
  tailwindcss, lucide-react, cmdk, class-variance-authority, tailwind-merge), `build` (vite, typescript, vitest,
  @vitejs/*, playwright), `viz` (uplot, echarts, sigma, graphology*, @xyflow/react, dagre, @tanstack/react-table,
  @tanstack/react-virtual; sigma and uplot pinned exactly and bumped by hand after reading their changelogs), weekly; GitHub Actions group as today; Bun bumped by hand (`.bun-version`).
- **Supply chain**: no postinstall scripts allowed except an allowlist (`pnpm.onlyBuiltDependencies`), lockfile
  reviewed in PRs, `pnpm audit --prod` in CI (high/critical fail), no CDN at runtime.

### 12. Visualizations
Libraries verified by a research pass on 2026-10-10 (versions, activity, licences, gzip sizes and React peers from
the npm `latest` manifests and the projects' repositories; the facts are copied here). The use cases, interaction
model and budgets were fixed first, and the libraries were chosen to meet them.

| use case | library (version 2026-10-10) | licence | gzip | notes |
|---|---|---|---|---|
| time series: tokens/cost over time, spikes, sparklines; ≥ 100 k points, drag-zoom, range select, synced cursors | **uPlot** 1.6.32 | MIT | 22 KB | canvas; `cursor.sync` syncs cursor and select across charts; 1.7.0 is imminent and changes the legend DOM and `clearCache()` — pin exactly, own wrapper; one maintainer (small, vendorable) |
| heatmaps (hour × weekday, calendar), skill × session matrices, bars/stacked bars, histograms and p50/p95 boxplots, sankey (tokens → skills → cost) | **Apache ECharts** 6.1.0, modular imports, canvas renderer, dataZoom + brush + visualMap | Apache-2.0 | ~170–220 KB | the largest item: lazy-loaded per route only; `echarts.connect(group)` + brush/dataZoom events for linking; v6 changed the default theme (`echarts/theme/v5.js` gives the old look) |
| session timeline / flame chart / swimlanes (skills lanes, subagent spans, kind-filtered gaps; tens of thousands of spans) | **custom Canvas2D renderer** in `packages/viz` | ours | — | DevTools-FlameChart/speedscope ideas: interval index for hit-testing, level-of-detail merging of sub-pixel spans, an overlay layer for selection/hover, HiDPI, layout in a Web Worker (OffscreenCanvas where available); WebGL2 instanced rects only if profiling demands it; no maintained library fits (flame-chart-js is dead and React ≤ 18); optional "Open in Perfetto" export |
| relationship graphs (skills co-loaded, MCP servers ↔ sessions ↔ repos, members ↔ rooms ↔ repos) | **sigma.js** 4.0.0 + **graphology** 0.26.0, ForceAtlas2 layout in a worker, our own React hook | MIT | 111 KB (both) | sigma 4 shipped 2026-10-08 (WebGL SDF labels, drag, parallel edges; breaks v3 APIs): pin exactly, expect 4.0.x fixes; `@react-sigma/core` 5.0.6 still peers `sigma ^3`, so no react-sigma; needs WebGL2 → list-view fallback "graph unavailable"; alternative for very large graphs `@cosmos.gl/graph` 3.5.1 (MIT) |
| small diagrams (one session's agent → subagent tree, team/room topology, share-policy editor) | **@xyflow/react** 12.12.0 + **dagre** | MIT | 59 KB | never inside `<Activity>` (#6044) |
| tables (100 k rows, column resize, sticky headers, filters in the TUI's expression language) | **TanStack Table** v9 (9.2.8; new `useTable`/`tableFeatures` API, not v8 tutorials) + **TanStack Virtual** 3.14.14 | MIT | 21 KB | React Compiler off on table components; a `./legacy` entry exists if v9 blocks |
| small KPI cards | ECharts (one library fewer) or plain numbers | — | — | shadcn's chart component is Recharts 3 (SVG; ~10 k points already take seconds, recharts #1465): not used for data views; default: not at all |

- **Rejected on licence**: Cosmograph / `@cosmograph/react` (CC-BY-NC-4.0, React ≤ 18), Highcharts (commercial),
  amCharts 5 (free only with a logo), MUI X Charts (zoom/pan is Pro), AG Grid Enterprise, lightweight-charts
  (attribution link required); elkjs (EPL/GPL) not needed because dagre is enough.
- **No WebGPU dependency**: WebGPU reaches ~88 % globally, but Firefox on Linux ships it only in Nightly, and Chrome
  on Linux only for Intel Gen12+ or recent NVIDIA under Wayland; many agentglass users run Linux. WebGL2 is the
  baseline; WebGPU only behind feature detection, nowhere critical.
- **Theming**: shadcn v4 tokens are `oklch()`. Canvas 2D accepts oklch (uPlot gets resolved strings), but zrender
  (ECharts) parses only rgb/rgba/hsl/hsla/hex/named, and sigma/cosmos take hex or numbers. One `resolveTokens()` in
  `packages/ui` turns the current theme's tokens into hex/rgb (drawn on a 1×1 canvas and read back), and every viz
  adapter re-applies them on a theme change (`setOption`/`setTheme` for ECharts).
- **Linking (crossfilter)**: one shared brush/time-range store in React (zustand), mirrored in the URL; uPlot
  `cursor.sync` and `echarts.connect` within a route. Aggregation stays in agentglass (the read model), not in the
  browser: no DuckDB-WASM, Mosaic or `crossfilter2` (last release 2020).
- **Accessibility**: canvas is opaque to screen readers. Every chart has a text summary (min/max/p50/p95), a "view as
  table" toggle (TanStack Table), keyboard focus and arrow-key cursor movement (timeline: `[`/`]` like the TUI), and
  palettes that never rely on hue alone (ECharts `aria` decals where available).
- **Mounting**: imperative wrappers (create in `useEffect`, `destroy`/`dispose`/`kill` in cleanup), resize through
  `ResizeObserver`, data updates without re-creating the instance.
- **Budgets**: first meaningful chart ≤ 300 ms from cached data (served aggregate → paint); 60 fps pan/zoom on 50 k
  spans (M1 / a 2020 x64 laptop); JS gzip: shell (React, router, query, ui, cmdk) ≤ 160 KB; each route chunk ≤ 80 KB
  plus its viz chunk ≤ 250 KB (ECharts at ~170–220 KB is the ceiling case; the whole viz set is ~430 KB, and no route
  loads more than it draws); fonts ≤ 120 KB.
- **Risks** (accepted, with mitigations): sigma 4 is two days old (exact pin, list fallback, 3.0.3 as a fallback);
  uPlot has one maintainer (small, MIT, vendorable); four rendering stacks need four theming adapters (one
  `resolveTokens()`); the custom timeline is real engineering work (its own step in W9); TanStack Table v9 is two
  months old (`./legacy`).

## Failure modes
- **`agentglass-web` missing / wrong version**: `agentglass web` prints the install line; a protocol mismatch (`want`
  > `proto`) → the BFF shows "update agentglass" in the page and exits non-zero.
- **Serve child dies**: the BFF restarts it once per minute at most, marks every stream `stale` (UI banner),
  resubscribes; after 3 failures it stops and shows the last stderr lines (scrubbed) in the page.
- **Port taken**: `--port` given → exit 2 naming the process if known; else another random port.
- **Browser blocks WebSocket**: SSE fallback, same data, a small "fallback" badge.
- **Slow client**: queue over 2 MB → disconnect + resume (no unbounded memory).
- **Clock jumps / sleep**: heartbeats detect dead sockets within 60 s; resume by event id.
- **Two engines** (TUI + web): both read and write the ledger cache with the existing atomic writers; no shared
  mutable file beyond them.

## Privacy
- Loopback only, per-run token, cookie `HttpOnly; SameSite=Strict`, Host/Origin checks, CORS off, CSP without remote
  origins, fonts and assets self-hosted: no third-party request ever leaves the browser because of agentglass.
- The BFF holds no data of its own: everything comes through the protocol, with `--redact`, `skills.hide` and room
  policies applied inside agentglass. `agentglass web --redact` starts the child with `--redact` (for screenshots,
  demos, screen sharing).
- No telemetry, no analytics, no error reporting to anyone; the audit log and `web.log` stay local (0600).
- Team members' data in the browser is exactly what their room streams delivered (fleet-teams); no content.

## Interactions with other specs
- **fleet-teams**: depends on this spec for the web UI and the read-model/protocol; supplies the team dimensions
  (section 10). Shared slice table (plans).
- **mcp-server**: shares the JSON-lines framer (moved to `src/util/jsonl.ts`); MCP keeps its CLI-child model (agents
  ask rarely; isolation per call).
- **cli-agent-mode / CLI contract**: `--json` commands call the read model; shapes unchanged (goldens); the protocol
  is documented beside them.
- **command-palette**: command names/ids shared with the TUI palette where both exist; `run/` spool for toasts.
- **filter-language**: the `filter` parameter everywhere; completion data from the attribute registry.
- **adaptive-refresh / tui-footprint**: the serve engine uses the same cadences and lazy rows; pushes follow them.
- **skill-usage, agent-wait, rules-config, honest-costs, model-prices, repo-view, git-linkage**: their `--json`
  objects are the read model's resources.

## Testing
- **Read model** (scriptc checks): each resource function against fixtures equals the existing `--json` goldens
  (refactor safety).
- **Protocol** (scriptc check + `scripts/serve.test.sh`): hello/version negotiation, every method, subscription
  replay inside the ring, snapshot outside it, heartbeat, oversize line, unknown method, read-only rejections,
  idempotent repeat, confirm nonce (expired, reused, other args, other socket), `remote_session` for a fleet row and
  a team row.
- **Conformance** (`packages/api-contract`, bun test): every response/event validated against the schema; the CLI
  `--json` goldens validated against the same schema.
- **BFF** (bun test, in-process `Bun.serve` on 127.0.0.1:0): no cookie → 401; wrong Host → 421; cross-origin POST and
  WS upgrade → 403; missing/wrong CSRF → 403; token single use and expiry; rate limits; frame/body caps; slow-client
  disconnect; headers (CSP etc.) on every response; no token/cookie/prompt text in `web.log`.
- **Web** (vitest): theme without flash (data-theme set before React mounts), sidebar collapse persisted, palette
  items and key hints, keyboard map, URL state round trip, read-only commands disabled with reason.
- **E2E** (Playwright, Chromium): one-time link → live Sessions view updates when a fixture session grows; confirm
  dialog flow for a command against a fake `herdr` (no real agent); cross-site WS from another origin page refused.
- **Footprint**: idle `agentglass-web` ≤ 30 MB RSS and ≤ 0.5 % CPU with 0 clients; ≤ 40 MB / ≤ 1 % with 3 tabs on a
  quiet engine (measured prototype: 18 MB / 0.23 %, 24 MB / 0.8 % with one push per second).

## Out of scope
- Remote access other than an SSH tunnel; TLS for the local server; multi-user hosting.
- Views beyond those in the slices; mobile layout beyond "usable".
- Editing transcripts, starting new agents from the browser, any command on another machine.
- A web UI inside the TUI process (Decision 4).

## Decisions
Each: question · options · decision · why · cost if wrong.

1. **Split into `local-web-api` and `fleet-teams`.** Options: one spec; two specs, built slice by slice together.
   **Decision: two specs in one PR, one slice table** (user decision). Why: the API and web UI are core agentglass
   (single-user mode); teams are optional dimensions. Cost if wrong: cross-references between two documents.
2. **Where the BFF runs.** Options: (a) inside the scriptc binary; (b) a separate Bun-compiled binary
   `agentglass-web` talking to agentglass over stdio; (c) a Node package. **Decision: (b)** (user decision). Why:
   scriptc's HTTP has no connection cap or enforced header timeout (`server.ts:278`), no WebSocket server and no TLS
   in the main backend; Bun has `Bun.serve` with WebSockets, embeds assets, cross-compiles all four targets from one
   host (measured), starts in 23 ms and idles at 18 MB. Node would add a runtime dependency. Cost if wrong: a second
   binary of 64–95 MB (25–36 MB compressed) to build, sign and ship; a Bun regression blocks the web release (the
   CLI/TUI is unaffected).
3. **Data path.** Options: one CLI child per request (as MCP); one persistent stdio protocol; the BFF reading caches
   itself. **Decision: one persistent `serve --stdio` child.** Why: a live UI needs subscriptions and ms latency; a
   CLI child costs 0.7–1.4 s warm per call (fleet spec measurements) and re-indexes; reading caches would duplicate
   privacy logic outside agentglass. Cost if wrong: a long-running engine per web session (TUI-sized RAM).
4. **TUI hosts the server?** Options: the TUI serves the web; a separate engine. **Decision: separate engine.** Why:
   scriptc has no Unix sockets for a local hand-off; the web must work without a TUI (servers, people who never open
   it); coupling render and serve loops risks the TUI's frame budget. Cost if wrong: two engines' RAM when both run;
   a later "attach to running TUI" can share one engine.
5. **WebSocket primary, SSE + POST fallback** (user decision). Why: one socket for requests, pushes and commands;
   SSE covers environments where WS fails. Cost if wrong: two transports to test (both thin over one dispatcher).
6. **No runtime dependency for the CLI/TUI.** Decision: `packages/` never enters `build.sh`; `agentglass-web` ships as
   its own archive and formula. Why: the CLI stays one small binary; people who never open a browser download
   nothing more. Cost if wrong: two installs for web users (`install.sh --web` makes it one flag).
7. **Assets embedded in the Bun binary** (user decision). Options: embedded; installed next to it and found by path. **Decision:
   embedded** (measured: `with { type: "file" }` imports compile in). Why: one file per target, no path lookup, no
   version skew between UI and BFF. Cost if wrong: every UI change rebuilds the binary (CI does anyway).
8. **Fonts.** Options: Inter + JetBrains Mono; IBM Plex Sans + Plex Mono. **Decision: IBM Plex Sans + Mono**,
   self-hosted subsets. Why: one family with matched metrics between prose and the terminal-like data, tabular
   figures in both, OFL licence, ≈ 120 KB for five subset weights; no Google Fonts (offline, privacy). Cost if wrong:
   a swap is two `@font-face` blocks and tokens.
9. **Routing and data fetching.** Decision: TanStack Router (typed search params carry filter, period, range,
   selection) and TanStack Query over the socket. Why: URL-held state is the deep-link contract; both are small and
   framework-agnostic in data. Cost if wrong: a router swap touches route definitions only.
10. **Schema source.** Options: TS types as source; JSON Schema as source; generated from scriptc code. **Decision:
    JSON Schema files** → generated TS types, conformance tests against the scriptc server and the CLI goldens. Why:
    language-neutral (scriptc cannot import npm), validatable at runtime in tests, documents the CLI contract too.
    Cost if wrong: schema files to maintain beside the code; the conformance test catches drift.
11. **Commands: read-only by default in the first release; typed set; two-step confirm; own machine only** (typed set, confirm, invariant: user requirements; read-only default: decided here as the user asked to consider it). Why:
    the web is new attack surface on a machine running agents with shell access; a read-only first release ships the
    value (seeing) without the risk (acting); the serve process enforces it, not only the BFF. Cost if wrong: users
    pass `--allow-commands` once (or set `web.commands`).
12. **Visualization libraries** (user-proposed stack, verified by research 2026-10-10). Options per use case and
    the rejected ones are in section 12. **Decision:** uPlot (time series), ECharts 6 modular (heatmaps,
    distributions, sankey), a custom Canvas2D renderer (timeline/flame/swimlanes), sigma 4 + graphology with our own
    hook (graphs), @xyflow/react + dagre (small diagrams), TanStack Table v9 + Virtual (tables); no Recharts for data
    views; WebGL2 baseline, no WebGPU. Why: each is the canvas/WebGL tool that meets the 100 k-point / 50 k-span
    budgets under a permissive licence; framework-agnostic ones are wrapped so React upgrades do not touch them.
    Cost if wrong: four rendering stacks to theme and maintain; the young majors (sigma 4, Table v9) may need fixes
    — exact pins and fallbacks (sigma 3.0.3, Table `./legacy`, list views).
13. **Test tools.** vitest for React packages (Vite-native), `bun test` for BFF and contract, Playwright (Chromium
    only) for one smoke suite. Why: each tool where it is native; one browser keeps CI time small. Cost if wrong:
    Firefox/WebKit-only bugs found by users; adding a browser is one config line.

14. **React 19.2.x, not 18** (research 2026-10-10; the user allowed 18 if needed). Why: every pick supports 19;
    shadcn's current components need it (ref as prop; Radix `asChild` breaks on 18); no pick needs 18. Constraints:
    React Compiler off on TanStack Table views; no `<Activity>` around React Flow. Cost if wrong: none known;
    downgrading means shadcn's older component set and Tailwind v3.

## Open questions (technical verification during implementation)
1. Bun's `bun-linux-x64-baseline` binary on debian:12 glibc 2.36 and on an older CPU without AVX2 (CI runner with
   `qemu`/`-cpu` flags or a recorded manual run).
2. scriptc `process.stdin` throughput for many small request lines while the engine's tick runs (MCP reads few lines):
   measure 1,000 requests/s latency in Task W1.
3. Radix popovers and CSP: whether `style-src-attr 'unsafe-inline'` is enough (no `<style>` injection) with the
   shadcn components used; if a component injects `<style>`, replace it or use a nonce-free hashed style.
4. Bun `Bun.serve` per-socket backpressure API (`ws.getBufferedAmount()`, `send` return values) under a stalled
   client: verify the 2 MB queue cap is enforceable.
5. macOS signing/notarisation of a Bun-compiled binary (Gatekeeper on downloads outside Homebrew).
