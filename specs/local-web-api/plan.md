# Local Web API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shared read model in agentglass, a persistent `agentglass serve --stdio` protocol (requests, resumable subscriptions, a typed command channel), a hardened Bun-compiled `agentglass-web` (static UI embedded, loopback HTTP API, WebSocket + SSE), `agentglass web` as the launcher, and a React web UI (Linear-style shell, live views) — built slice by slice together with [fleet-teams](../fleet-teams/plan.md).

**Architecture:** scriptc side: `src/read/` (one pure function per resource; the CLI `--json` commands call them), `src/util/jsonl.ts` (the MCP framer, shared), `src/serve/` (`proto.ts` dispatcher, `subs.ts` topic rings and patches, `cmd.ts` typed commands with risk classes, nonces, idempotency, audit), `src/features/web-cli.ts` (`agentglass web`, `serve`). JavaScript side (pnpm workspace, Bun runtime): `packages/api-contract` (JSON Schema → TS types, conformance tests), `packages/ui` (shadcn components, tokens, IBM Plex), `packages/viz` (uPlot, ECharts 6 modular, custom Canvas2D timeline, sigma 4 + graphology, @xyflow/react, TanStack Table v9), `packages/web` (React, Vite, TanStack Router/Query, cmdk), `packages/bff` (`agentglass-web`: Bun.serve, auth, WS/SSE, stdio client, embedded assets).

**Tech Stack:** scriptc 0.1.7 (agentglass), Bun (pinned in `.bun-version`; measured 1.3.14) for the BFF build/runtime, pnpm (pinned via `packageManager`), React 19.2.x, Vite, TypeScript, Tailwind, shadcn/ui (Radix), cmdk, lucide-react, TanStack Router/Query, vitest, Playwright (Chromium).

**Spec:** [spec.md](spec.md) — read it first (Measurements, Decisions, Open questions). Also [../fleet-teams/spec.md](../fleet-teams/spec.md) sections 9–11 for the team dimensions.

## Slices (shared with fleet-teams; each slice = read model → protocol/stream → TUI + web view → tests)

| Slice | After it, a member sees | local-web-api tasks | fleet-teams tasks |
|---|---|---|---|
| S1 | own live sessions in the browser (TUI unchanged) | W0, W1 → W2 → (W3 ∥ W4 ∥ W5) → W6 | T0; T1 ∥ T2 ∥ T3 (no UI yet, parallel with W1–W5) |
| S2 | a teammate: members, devices, cost, presence in the Team tab and on the web Team page | W7 | T4 → T5 → (T6 ∥ T7) → T16 → (T8a ∥ T9a) |
| S3 | breadth: Stats, Alerts, Fleet, Skills, Wait, events with kind filter, team groupings | W8 (tables/KPIs), then W9 (viz, after research) | T9b |
| S4 | consent and sharing in TUI and browser: what I share, dry run, rename, leave, doctor, service, activity log | W10 | T8b ∥ T9c |
| S5 | commands from the browser (opt-in), audit, TUI toast | W11 → W12 | T17 |
| S6 | phase 2: hub relay, wait per room, MCP `team` | — | T11 ∥ T13, then T12 ∥ T14, then T15 |

Inside a slice, `∥` tasks run in parallel (separate worktrees), `→` is sequential. A slice merges as one PR when its tasks are green; S1 and S2 are the first two PRs.

## Global Constraints

- scriptc side: `./build.sh`, `sh scripts/check.sh` (`--changed` after each edit). JS side: `pnpm install --frozen-lockfile && pnpm -r typecheck && pnpm -r test && pnpm -r build`. A task is done only when everything it touches passes.
- Builds, binaries, node_modules caches and Playwright browsers for local runs under `~/.cache/agentglass-agents/<agent-name>/` (`PNPM_STORE_DIR`, `PLAYWRIGHT_BROWSERS_PATH`, `BUN_INSTALL_CACHE_DIR` pointed there), never `/tmp`. One build at a time; `nice`.
- Live runs only with the full isolation set (fleet-teams plan, incl. `AGENTGLASS_TEAM_DIR`) written inline or via `bash -c`; `ls ~/.agentglass` before/after unchanged. The web server in tests binds `127.0.0.1` port 0 only and is killed by its pid in `trap`; at most one browser (Playwright, headless) at a time, closed after the run.
- **Privacy is applied in agentglass**: the BFF never reads `~/.claude`, `~/.codex`, `~/.agentglass` caches or logs; its only data source is the serve child. Review rejects any `fs` read in `packages/bff` outside its own embedded assets, `run/web.tokens` and `run/web.lock`.
- **No generic command**: no protocol method, HTTP route or WS frame takes argv, a shell string or a path to execute. Commands are the typed set of spec section 9.
- **Secrets**: the one-time token, session ids, CSRF tokens and nonces never in logs, argv (the token goes to the browser via the opened URL's fragment only), `--json` or error messages.
- scriptc limits as in the fleet-teams plan; plus: `process.stdin` is the only input of `serve --stdio`; output only via `writeSync(1, line + "\n")`.
- CLI/TUI path free of JS dependencies: `build.sh` and `scripts/check.sh` never touch `packages/`; the main release archives are unchanged in content except the new subcommands.
- Commits: conventional, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branches: one integration branch per slice (`feat/web-s1`, `feat/web-s2` …, shared with fleet-teams' tasks of the same slice), parallel tasks in their own worktrees `../agentglass-web-w<N>`.

## Review Focus

1. **Auth boundary** (W4): every route but `/`, static assets and `POST /api/v1/session` requires the cookie; Host and Origin checks on every request/upgrade; CSRF on POST and command frames; token single use; CORS headers never present.
2. **Privacy in one place** (W1, W2): every resource goes through the read model with `REDACT`, `skillVis` and (teams) room data only; a conformance test runs the whole method set under `--redact` and greps the output for fixture real names.
3. **Commands** (W11, W12): read-only default enforced by the serve process; two-step nonce (single use, bound to socket, command and args hash, 60 s); local targets only (`remote_session` for fleet and team rows); idempotency; audit log without prompt text.
4. **Resource use** (W2, W4): no polling timers for subscribers; rings bounded; per-client queues bounded; idle CPU/RAM within the spec's footprint numbers.
5. **Contract** (W3): schema ↔ server conformance and CLI goldens in CI; generated types committed and checked fresh.

---

### Task W0: Probes (S1, alone)

**Files:** none committed; `Ruling:` lines in the S1 PR.

- [ ] **Step 1:** Open question 1: `bun build --compile --target=bun-linux-x64-baseline` of the spec's prototype; run it in `debian:12` (`docker run --rm -v $C:/w debian:12 /w/bff --version`, if Docker is available; else on the CI runner in W6). Expected: starts. Record.
- [ ] **Step 2:** Open question 2: a scriptc probe reading `process.stdin` lines and answering each with `writeSync(1, …)` while a 1.5 s `setInterval` does 50 ms of work; drive 1,000 requests from a Bun script. Expected: p50 < 2 ms outside the busy window, no lost line. Record p50/p99.
- [ ] **Step 3:** Open question 4: in the Bun prototype, a WS client that stops reading; `ws.send` return values / `getBufferedAmount()` as the server sends 4 MB. Expected: buffered amount observable → W4 enforces the 2 MB cap with it; else close on `send` returning backpressure (-1) twice.
- [ ] **Step 4:** Open question 3: render the shadcn `Popover`, `DropdownMenu`, `Dialog`, `Command`, `Tooltip` under the spec's CSP in Chromium (Playwright), collect CSP violation reports. Expected: only `style-src-attr` uses. Record any `<style>` injector and its replacement.

---

### Task W1: Read model and shared framer (S1)

**Files:** Create `src/read/sessions.ts`, `src/read/meta.ts`, `src/read/index.ts`, `src/read/sessions.check.ts`, `src/util/jsonl.ts` (moved from `src/mcp/rpc.ts:16-60` framing, re-exported there). Modify `src/features/cli.ts` (`snapshot()` at `cli.ts:230` calls `readSessions()`), `src/mcp/rpc.ts` (import the framer).

**Interfaces — Produces:**
```ts
export interface Page<T> { data: T[]; at: number; gen: number; next: string | null }
export function readSessions(p: { filter: string; limit: number; cursor: string; subagents: boolean; team: string; room: string }): { page: Page<Obj> | null; err: Err | null };
export function readMeta(readOnly: boolean): Obj;                  // version, contract, proto, caps, readOnly, redact, harnesses, teams
export interface Err { code: string; msg: string; hint: string }
export function gen(resource: string): number;                     // bumped when the resource's inputs change (scan, ledger, procs)
```

- [ ] **Step 1: Failing check:** `readSessions` over the existing CLI fixtures equals the `--json` golden rows (same objects); `cursor` pages of 2 cover the list exactly once; a bad filter → `{code: "bad_filter", msg with column}`; under `AGENTGLASS_REDACT=1` titles are fakes; `gen("sessions")` unchanged across two calls without input change, bumped after a fixture append + `discover()`. Run: `scriptc build --optimization dev --strip src/read/sessions.check.ts -o $C/x && HOME=$C/home $C/x`. Expected: FAIL.
- [ ] **Step 2: Implement**; move the framer; `src/mcp/rpc.check.ts` still passes unchanged.
- [ ] **Step 3: Run** the new check, `src/mcp/*.check.ts`, `src/features/cli.check.ts`, the CLI contract test. Expected: pass; `agentglass --json` byte-identical to before on the fixture HOME.
- [ ] **Step 4: Commit** `refactor(read): sessions read model and shared JSON-lines framer`.

### Task W2: `agentglass serve --stdio` (S1)

**Files:** Create `src/serve/proto.ts` (dispatcher), `src/serve/subs.ts` (topics, rings, patches, heartbeats), `src/serve/main.ts` (`serveCli`), `src/serve/proto.check.ts`, `scripts/serve.test.sh`; Modify `src/main.ts` (register `serve`), `docs/cli-contract.md` (protocol section, `proto: 1`).

**Interfaces — Produces:** the protocol of spec section 3: `hello`, `meta`, `sessions.list`, `sessions.get`, `sub` (`sessions` topic in S1), `unsub`; events `snapshot`/`patch`/`hb`; error codes. Engine loop: `discover()` + the TUI's slow jobs and `H.onWatch` cadence without rendering; patches computed after each cadence step from `gen()` changes only.

- [ ] **Step 1: Failing check** `proto.check.ts` (in-process dispatcher, fake clock): hello negotiates `proto 1`, `want: 2` → error `proto`; `sessions.list` result = `readSessions`; `sub sessions` → `snapshot`, then a fixture append → one `patch` with that row upserted; `from` inside the ring → replay of the missed patches, `resumed: true`; `from` of another epoch → `snapshot`; 25 s quiet → `hb`; ring cap 1,000 → oldest dropped; unknown method → `-`/`unknown_method`; a 5 MB line → `oversize` error, the loop continues. Expected: FAIL.
- [ ] **Step 2: Failing test** `scripts/serve.test.sh` (`AGENTGLASS_BIN`, fixture HOME, isolation set): a Python driver writes `hello`, `sub sessions`, appends to a fixture session file, reads until a `patch` for it arrives (≤ 3 s), sends `unsub`, closes stdin → the process exits 0 within 2 s. Expected: FAIL.
- [ ] **Step 3: Implement.** No timer per subscriber; heartbeats from one shared 25 s timer that only runs while subscriptions exist.
- [ ] **Step 4: Run** both; measure idle CPU of `serve --stdio` with one subscription over 60 s on the fixture HOME (record; expect ≈ the TUI's idle without rendering). **Step 5: Commit** `feat(serve): agentglass-serve/1 over stdio with resumable subscriptions`.

### Task W3: Workspace and `packages/api-contract` (S1, parallel with W4, W5)

**Files:** Create root `package.json` (`private`, `packageManager: "pnpm@<pinned>"`, scripts `typecheck`/`test`/`build`/`gen`), `pnpm-workspace.yaml`, `.npmrc` (`engine-strict=true`), `.bun-version`, `packages/api-contract/{package.json,schema/*.json,src/types.gen.ts,src/index.ts,test/conformance.test.ts,scripts/gen.ts}`; Modify `.gitignore` (`node_modules`, `packages/*/dist`).

**Interfaces — Produces:** schemas `meta`, `session` (the `jsonSess` object; fields from `docs/cli-contract.md:44-83`), `page`, `error`, `event` (snapshot/patch/hb), `request`, `response`, `command` (S5); `types.gen.ts` generated by `json-schema-to-typescript`; `validate(name, value)` (Ajv 2020) for tests.

- [ ] **Step 1: Failing test** `conformance.test.ts` (bun test): spawns `$AGENTGLASS_BIN serve --stdio` with a fixture HOME (env set in the test), runs hello/meta/sessions.list/sub and validates every message; also validates `$AGENTGLASS_BIN --json` on the same HOME against `session[]`. Expected: FAIL (schemas missing).
- [ ] **Step 2:** write schemas; `pnpm --filter api-contract gen`; a `gen:check` script fails when `types.gen.ts` is stale.
- [ ] **Step 3: Run** `AGENTGLASS_BIN=$C/agentglass pnpm --filter api-contract test`. Expected: pass. **Step 4: Commit** `feat(web): pnpm workspace and the API contract package`.

### Task W4: `packages/bff` — `agentglass-web` (S1, parallel with W3, W5)

**Files:** Create `packages/bff/{package.json,src/main.ts,src/auth.ts,src/stdio.ts,src/ws.ts,src/sse.ts,src/http.ts,src/assets.gen.ts,src/limits.ts,test/*.test.ts,scripts/embed.ts}`.

**Interfaces — Produces:** CLI `agentglass-web --agentglass <path> [--port N] [--redact] [--allow-commands] [--ipv6] [--version]`; prints one JSON line `{port, url}` (URL with `#t=<token>`) to stdout for the launcher, nothing else; routes of spec sections 4–5; `stdio.ts` = one child, request multiplexing (own id space), shared upstream subscriptions per topic+params, restart policy (once a minute, 3 strikes).

- [ ] **Step 1: Failing tests** (bun test, in-process server on 127.0.0.1:0, a fake serve child written in TS that speaks the protocol): `GET /api/v1/sessions` without cookie → 401; token exchange → cookie flags `HttpOnly; SameSite=Strict; Path=/`, second exchange with the same token → 401, after 2 min → 401; wrong `Host` → 421; POST with foreign `Origin` → 403; POST without `X-AG-CSRF` → 403; WS upgrade without cookie → 401, with foreign Origin → 403; WS request → response through the fake child; two tabs subscribing `sessions` → one upstream `sub`; slow WS client over 2 MB → closed 1013; body 65 KB → 413; 60 requests/s → 429; every response has the spec's security headers and no `Access-Control-*`; `web.log` lines contain no token, cookie value or query values. Expected: FAIL.
- [ ] **Step 2: Implement** with `Bun.serve` (`idleTimeout`, `websocket` handlers), `crypto.getRandomValues` for tokens/ids, constant-time compares; `scripts/embed.ts` generates `assets.gen.ts` importing every file of `packages/web/dist` `with { type: "file" }` plus a path → content-type map (an empty placeholder page when web is not built).
- [ ] **Step 3: Run** `pnpm --filter bff test`; `bun build --compile --minify src/main.ts --outfile $C/agentglass-web`; footprint: start it with a real `$C/agentglass` on the fixture HOME, 0 clients 60 s, then 3 SSE clients 60 s (`/proc/<pid>/stat` ticks, `VmRSS`). Expected within the spec's Testing numbers; record. **Step 4: Commit** `feat(web): agentglass-web — loopback BFF with WebSocket, SSE and per-run auth`.

### Task W5: `packages/ui` and `packages/web` shell + live Sessions (S1, parallel with W3, W4)

**Files:** Create `packages/ui/{package.json,tokens.css,tailwind.preset.ts,fonts/IBMPlexSans-{400,500,600}.subset.woff2,fonts/IBMPlexMono-{400,500}.subset.woff2,fonts/LICENSE-OFL.txt,src/components/*.tsx}` (shadcn: button, dialog, dropdown-menu, command, tooltip, scroll-area, separator, badge, table, sheet), `packages/web/{package.json,index.html,public/theme.js,vite.config.ts,src/main.tsx,src/shell/{Sidebar,TopBar,Palette,Help,ThemeSwitch}.tsx,src/routes/{sessions,settings}.tsx,src/live/socket.ts,src/live/store.ts,test/*.test.tsx}`, `scripts/subset-fonts.sh` (pyftsubset, run by hand; the subset files are committed).

**Interfaces — Consumes:** `@agentglass/api-contract` types; the WS API. **Produces:** the shell of spec section 7 (sidebar with all sections, those without data hidden; collapse persisted; theme dark/light/system without flash; ⌘K palette with navigation, theme, open session; `?` help; keys), the live Sessions route (list with live/attention/stuck glyphs, filter input with the expression language, "N new" pill, detail drawer with fields).

- [ ] **Step 1: Failing tests** (vitest + jsdom): `theme.js` sets `data-theme` from `localStorage` before `main.tsx` runs (and `system` follows a mocked `matchMedia` change); sidebar collapse persisted (and a throwing `localStorage` does not break render); palette lists items with key hints and fuzzy-matches "sess"; `?` opens help listing every shortcut; URL search params round-trip filter/period/selection; the socket store applies `snapshot` then `patch` and resumes with `from` after a reconnect; no inline `<script>` in `index.html`. Expected: FAIL.
- [ ] **Step 2: Implement.** Bundle budget check script (`pnpm --filter web size`): shell ≤ 160 KB gzip, fonts ≤ 120 KB. **Step 3: Run** `pnpm --filter ui --filter web test build size`. Expected: pass, sizes printed. **Step 4: Commit** `feat(web): Linear-style shell, theme, palette and live Sessions view`.

### Task W6: `agentglass web` launcher, CI job, release artifacts (S1, after W2–W5)

**Files:** Create `src/features/web-cli.ts` (+ check), `.github/workflows/web.yml` (or a job in `ci.yml`), `scripts/build-web.sh`, `scripts/web-e2e.test.ts` (Playwright); Modify `.github/workflows/build-artifacts.yml` (an `agentglass-web` job on ubuntu-24.04 cross-compiling 4 targets), `release.yml` (attest + upload), `scripts/package.sh` (web archive), `install.sh` (`--web`), the tap formula workflow (`formula.yml`: `agentglass-web` formula + test), `.github/dependabot.yml` (npm groups of spec 11), `README.md` (web section).

- [ ] **Step 1: Failing check** `web-cli.check.ts`: finds `agentglass-web` beside the binary, then on PATH; missing → exit 2 with the platform's install line; a live lock (`run/web.lock` with a running pid) → writes a token hash into `run/web.tokens` and prints the new URL without starting a second server; `--port` passes through; `--allow-commands` passes through; never prints the token except in the URL line it opens/prints. Expected: FAIL.
- [ ] **Step 2: Implement** (browser opener: `xdg-open`/`open`, `--no-open` prints the URL; detached child with logs to `logs/web.log` 0600).
- [ ] **Step 3: E2E** `scripts/web-e2e.test.ts` (Playwright Chromium, `PLAYWRIGHT_BROWSERS_PATH` in the cache dir): build both binaries, fixture HOME, `agentglass web --no-open` → open the URL → Sessions list shows the fixture rows → append to a fixture session → the row updates within 3 s → a page served from another port tries `new WebSocket("ws://127.0.0.1:<port>/api/v1/ws")` → refused. Expected: pass.
- [ ] **Step 4: CI:** job `web` (setup Bun from `.bun-version`, pnpm via corepack, `pnpm install --frozen-lockfile`, typecheck, lint, test, `gen:check`, build, size, conformance with the main build's artifact, e2e). Release: four `agentglass-web-<target>.tar.gz` (baseline targets for x64), `sha256sums`, attestations; the release dry-run workflow builds them; `formula.yml` proves `brew install agentglass-web` + `brew test`. Expected: green on the PR; record archive sizes.
- [ ] **Step 5: Commit** `feat(web): agentglass web launcher, CI and release artifacts`. **S1 PR** (with fleet-teams T1–T3).

---

### Task W7: Team dimensions in the protocol and the web Team page (S2)

**Files:** Create `src/read/team.ts` (wrapping fleet-teams `buildView`, `team status/report/sessions/activity`), schemas `team-*.json`, `packages/web/src/routes/{team,rooms}.tsx`, team/room switcher in the sidebar; Modify `src/serve/proto.ts` (methods `team.status`, `team.report`, `team.sessions`, `team.activity`; topics `team:<team>/<room>`, `presence`), `readMeta` (`teams`).

- [ ] **Step 1: Failing tests:** protocol check — with the fleet-teams two-member fixture (T7's), `team.report {by: member}` equals `team report --json`; `presence` pushes when a member's device publishes a live session; without a team the methods answer `no_team` and `meta.teams` is `[]`; under `--redact` member names are fakes. Web (vitest): the switcher appears only with teams; the Team page renders members, devices `n/m`, live/attention glyphs, cost, top harness from a fixture stream; the activity list renders "Anna joined room web · 10:42". Conformance: new schemas validated. Expected: FAIL.
- [ ] **Step 2: Implement. Step 3: Run** all suites + e2e with two fixture HOMEs (A's web shows B after B's `team sync`). **Step 4: Commit** `feat(web): team, room and member dimensions; Team page`. **S2 PR** (with fleet-teams T4–T7, T16, T8a, T9a).

### Task W8: Breadth — Stats, Alerts, Fleet, Skills, Wait, events (S3)

**Files:** `src/read/{stats,cost,alerts,fleet,skills,wait,events,graph,repos}.ts` (+ checks; CLI `--json` commands refactored onto them), protocol methods/topics of spec section 2, schemas, web routes `stats`, `alerts`, `fleet`, `skills`, `wait`, session detail events tab with the event-kind filter and presets — tables and KPI cards only (charts come with W9).

- [ ] **Step 1: Failing checks:** each read function equals its CLI golden (`cost --json`, `wait --json`, `skills --json`, `events --json`, `fleet status --json`); `events.list {kind}` honours the kind filter and presets; `graph.get` returns the lean columnar events of #110 within a window; `alerts` topic pushes a rule firing. Web tests per route (render from fixtures, filter in URL, keyboard). Expected: FAIL.
- [ ] **Step 2: Implement. Step 3: Run** all. **Step 4: Commit** per resource (`feat(read): …`), one PR for S3a.

### Task W9: Visualizations (S3, after W8)

**Files:** `packages/viz/*`, chart components in the routes of W8, a Web Worker for the timeline layout.

- [ ] **Step 0: Pins and adapters.** Libraries are decided (spec section 12, Decisions 12 and 14). Add exact pins: `uplot@1.6.32`, `echarts@6.1.0`, `sigma@4.0.0`, `graphology@0.26.0` (+ `graphology-layout-forceatlas2`), `@xyflow/react@12.12.0`, `dagre`, `@tanstack/react-table@9.2.8`, `@tanstack/react-virtual@3.14.14`, `zustand@5.0.15`; the Dependabot `viz` group; `packages/ui` `resolveTokens()` (oklch → hex/rgb via a 1×1 canvas) with a vitest check that every token resolves in both themes. Re-check versions on npm and record newer patches in the PR (uPlot 1.7.0 if shipped: adapt the legend wrapper).
- [ ] **Step 1: Failing tests:** budget check per route chunk (≤ 80 KB + viz ≤ 250 KB gzip); a 50 k-span synthetic call graph renders, zooms around the cursor and box-selects (Playwright, a frame-time probe: p95 ≤ 16.7 ms during a scripted pan); brushing a time range on one chart filters the table of the same route; reduced motion disables transitions. Expected: FAIL.
- [ ] **Step 2: Implement** per spec section 12, one component per commit, each an imperative wrapper with cleanup (StrictMode test: mount → unmount → mount leaves one canvas/WebGL context): `TimeSeries` (uPlot, `cursor.sync`), `Heatmap`/`Bars`/`Distribution`/`Sankey`/`Calendar` (ECharts modular, lazy chunk, `echarts.connect`), `Timeline` (custom Canvas2D: interval index, LOD merge, overlay, HiDPI, worker layout, minimap, box-select, `[`/`]`), `Graph` (sigma 4 + graphology, FA2 in a worker, WebGL2 check → list fallback), `Diagram` (@xyflow/react + dagre, never in `<Activity>`), `DataTable` (TanStack Table v9 + Virtual, `"use no memo"`); each chart with a text summary and "view as table". **Step 3: Run.** **Step 4: Commit** `feat(viz): …` per component; S3b PR.

### Task W10: Sharing and activity in the web (S4)

**Files:** `packages/web/src/routes/team/share.tsx` (What I share), `activity.tsx`; read model `team.share` (my policy per room: repos, level, since, paused, last publish), `team.preview {room}` (the consent screen data and dry-run lines).

- [ ] **Step 1: Failing tests:** the share page shows per room the same data as the TUI's `s` panel (fixture); dry run shows exactly the lines `team share --dry-run` prints; editing is disabled until S5 (read-only) with the reason shown. Expected: FAIL. **Step 2: Implement. Step 3: Run. Step 4: Commit** `feat(web): what I share and the team activity log`. S4 PR (with fleet-teams T8b, T9c).

### Task W11: Command channel in the protocol (S5)

**Files:** Create `src/serve/cmd.ts`, `src/serve/cmd.check.ts`, `src/serve/audit.ts`; schemas `command-*.json`; Modify `src/actions.ts` (split `sendPrompt`/`resume`/`killPid`/`trash` into target-explicit cores used by both the TUI and the serve process; the TUI wrappers keep their behaviour), `src/serve/main.ts` (`--read-only` default unless `--allow-commands`/`web.commands`), `src/features/palette/spool.ts` (a `web-note` spool kind the TUI turns into a toast).

**Interfaces — Produces:** `cmd {cmd, args, idem, csrf?}` and `confirm {nonce}` per spec section 9; risk classes R1–R3; results `{ok}` / `{state: "confirm", nonce, summary, expiresAt}`; errors `read_only`, `remote_session`, `nonce_expired`, `nonce_used`, `nonce_mismatch`, `approval_open`, `not_found`.

- [ ] **Step 1: Failing check** `cmd.check.ts` (fake mux, fake process table): read-only → every R1–R3 command `read_only`; `session.sendPrompt` on a local live session → `confirm` with a summary naming harness, short id, title, pane and character count → `confirm {nonce}` → the fake mux received exactly the text; the same nonce again → `nonce_used`; after 61 s → `nonce_expired`; nonce from another socket or with changed args → `nonce_mismatch`; a fleet host's row and a team member's row as target → `remote_session` (fleet: hint `ssh <host> agentglass open <ref>`), nothing sent anywhere (**invariant test**: the fake mux and fake kill record zero calls, and no file is written under the team mailbox); `process.kill` requires the typed short id in `args.typed`; idempotent repeat with the same `idem` → the first result, one execution; audit log line per execution with the prompt's length and SHA-256 prefix, never its text, file mode 0600; a spool note for the TUI. Expected: FAIL.
- [ ] **Step 2: Implement. Step 3: Run** the check, `src/features/palette/*.check.ts`, `scripts/serve.test.sh`. **Step 4: Commit** `feat(serve): typed command channel with confirm nonces, audit and read-only default`.

### Task W12: Commands in the BFF and the web UI (S5)

**Files:** `packages/bff/src/ws.ts` (command frames, CSRF per frame, per-socket 20/s), `packages/bff/src/http.ts` (`POST /api/v1/commands` fallback), `packages/web/src/commands/*` (confirm dialog with the server's summary; typed confirmation for kill/trash; palette entries enabled when `meta.readOnly` is false; disabled with the reason otherwise), TUI toast handling in `src/` (spool kind from W11).

- [ ] **Step 1: Failing tests:** BFF — command frame without/with wrong `csrf` → refused; 21 frames in a second → `rate`; `confirm` frames forwarded only for nonces issued on the same socket. Web — R2 dialog shows the server summary verbatim and sends `confirm`; kill requires typing the short id; read-only shows commands disabled with "started read-only: agentglass web --allow-commands". E2E — `agentglass web --allow-commands` with a fake `herdr` on PATH: send prompt from the browser → fake herdr receives it → the TUI (tmux, isolation set) shows the toast. Expected: FAIL.
- [ ] **Step 2: Implement. Step 3: Run** all suites + e2e. **Step 4: Commit** `feat(web): commands over the socket with two-step confirm`. S5 PR (with fleet-teams T17).
