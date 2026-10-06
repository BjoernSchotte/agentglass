# Fleet Implementation Plan (Part A: SSH pull MVP · Part B: snapshots, exact merge, `dir` hosts, live stream)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal (Part A, Tasks 0–9):** `agentglass fleet` and the TUI show sessions, cost and live state of several machines, pulled over SSH from each host's own agentglass (`fleet pull`), with host-qualified rows, a `host` filter attribute, a host badge, staleness, cached reports for offline hosts, `fleet status`, and a forced-command recipe that limits the viewer's key to read-only output.

**Goal (Part B, Tasks 10–16):** exact fleet figures: incremental `agentglass-snapshot/v1` with per-peer acknowledged generations, hashed Claude message-id ownership across hosts (the `≈` marks disappear for exact hosts), local re-pricing and time-zone re-bucketing through shadow ledger entries, `dir` hosts (snapshot drops through rsync/Syncthing), and the live `fleet watch` stream spooled and tailed.

**Architecture:** A remote host is a `HostFeed` that delivers `HostReport`s (`src/features/fleet/model.ts`). The only feed built here is SSH (`ssh.ts`): a detached `sh` snippet runs `ssh … agentglass fleet pull` into a spool file under `~/.agentglass/fleet/`, the tick only stats the `.rc` file and parses the report in line windows. `hosts.ts` turns reports into read-only `Sess` rows (`host` set, `pid` 0, never in the `sessions` map) that `buildView` appends; costs sum through the existing `ModeSum`/`budgetState`. The remote side (`pull.ts`, `serve.ts`, `authorize.ts`) reuses `jsonSess` and the `cost --json` object unchanged.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build), no runtime deps; OpenSSH client on the viewer, agentglass on each host. Checks are standalone scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh`.

**Spec:** [spec.md](spec.md) — read it first, including "Decisions" and "Open questions"; this plan argues from it.

**Round:** Round 2 (after 2026.10.4). No earlier plan must be merged first. Shares `src/util/hostid.ts` with [otlp-complete](../otlp-complete/plan.md): this plan's Task 1 creates it; if otlp-complete's Task 1 merged first, Task 1 here only verifies the interface (Step 1) and skips to its check.

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh`; a task is done only when both pass. Single check (builds and caches under your own dir, never `/tmp`): `C=$HOME/.cache/agentglass-agents/impl-fleet; mkdir -p $C/home; scriptc build --optimization dev --strip <f> -o $C/x && HOME=$C/home AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme $C/x` (the suite runs every check with `AGENTGLASS_REDACT=1`: branch expectations on `REDACT` as `src/features/otlp/encode.check.ts:112` does, and run once without it locally).
- Live runs of agentglass only with the full isolation set written out literally (zsh does not split `$VAR`): `AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp AGENTGLASS_FLEET_DIR=$S/fleet` (`S` = a short dir under `~/.cache/agentglass-agents/impl-fleet/`, `mkdir -p $S/run && chmod 700 $S/run`). Check `ls ~/.agentglass` before and after.
- **Never touch `~/.ssh`** (keys, config, `known_hosts`, `authorized_keys`). Manual SSH tests pass `-o UserKnownHostsFile=$S/known_hosts -o StrictHostKeyChecking=accept-new` through `AGENTGLASS_SSH` pointing at a wrapper script in `$S`. Forced-command tests use a throwaway container or user, never the developer's own `authorized_keys`.
- scriptc 0.1.7 limits: nominal typing (pass fields, not foreign interfaces); no `readlinkSync`; no `n.toString(radix)`; out-of-range array reads trap (bounds-check); no zero-parameter arrow for an optional interface member (SC2003); no `Record<string, RegExp>`; no Unix-domain sockets; SC1090 array-index quirks (use `+0`, no `.map` callbacks on index types, no `.replace` with a function).
- No secret in argv, the environment of children, logs, the cache or `--json`. The ssh argv holds only options, the destination and the remote words of spec 4.1.
- Remote rows never enter `sessions` (`src/model/sessions.ts`); every loop over `sessions` stays local. A remote row's `path` starts with `@` and is never opened, stat'ed or passed to an adapter.
- Kill only pids this process spawned (in memory) or recorded in our own `.pid` file with a matching start time. Never `pkill`/pattern kills.
- One build at a time; at most one TUI at a time, killed right after; `nice` heavy measurements.
- TUI baseline: works at 80 columns, `?` help documents every new element, footer hints stay correct, `--json` field order stable (new fields appended at their documented place), CLI errors through `cliError` with a hint.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branches: integration branch `feat/fleet` from `origin/main` in `../agentglass-fleet`. Parallel tasks run in their own worktrees `../agentglass-fleet-t<N>` on `feat/fleet-t<N>` branched from `feat/fleet` at the wave start; each merges back into `feat/fleet` (rebase, then fast-forward) in task-number order. One PR `feat/fleet` → `main`, rebase-merge after green CI.

## Waves (parallel vs sequential)

| Wave | Tasks | Run | Needs |
|---|---|---|---|
| 0 | T0 | alone | — |
| 1 | T1 host id · T2 config + model + report parser | **parallel** | T0 |
| 2 | T3 `fleet pull` · T5 SSH feed + store · T6 merge into the model | **parallel** | T1, T2 (T3 needs both; T5, T6 need T2) |
| 3 | T4 `fleet serve` + `authorize` · T7 CLI · T8 TUI | **parallel** | T4: T3 · T7: T3, T5, T6 · T8: T5, T6 |
| 4 | T9 end-to-end test, README, help | alone | T1–T8 |
| 5 | T10 msgrows sidecar + snapshot codec | alone (may start any time after T2: it touches only `usage/` and a new codec file) | T2 |
| 6 | T11 `fleet snapshot` writer · T12 snapshot feed (viewer) · T13 exact merge + re-pricing · T15 `fleet watch` | **parallel** | T11: T3, T4, T10 · T12: T5, T10 · T13: T6, T10 · T15: T4, T5, T8 |
| 7 | T14 `dir` drops (writer + reader) | alone | T11, T12 |
| 8 | T16 Part B end-to-end test, README | alone | T10–T15 |

Cross-spec order: [otlp-hub](../otlp-hub/plan.md) needs this plan's T2 and T6 (model, hosts) to start, and T13 (the exact merge index) for its own-row task; otherwise Part B and otlp-hub run in parallel. `src/model/state.ts` (`sessState`) is created by T15 or by [otlp-complete](../otlp-complete/plan.md) T4, whichever lands first.

Files are split so that no two tasks of one wave edit the same file, except `src/main.ts` imports (one line each; merge by keeping both).

## Review Focus

1. **Command injection through config or the remote side.** `ssh` destination `-oProxyCommand=…` must be refused (T2); remote words quoted (T5); `fleet serve` refuses `;`, `|`, `$(`, backticks, redirections, newlines and any command but `fleet pull`/`--version` (T4). No string built from config ever reaches `sh -c` (T5 snippet takes positional parameters only).
2. **Remote rows leaking into local code paths.** A remote `Sess` must never reach an adapter, the ledger, the watchdog, the exporter, `kill`, or a file read. T6 check asserts `enrich`/`complete`/`loadHead`/`loadTail` return at once and `sessions` never holds a `@` path; T8 asserts every guarded action toasts.
3. **Redaction at the source.** A viewer under `--redact` reads only `.r` caches and pulls with `--redact`; a `fleet serve --redact` host answers redacted whatever the viewer asks. T3/T4/T9 grep the outputs and caches for fixture titles.
4. **Never blocking the tick.** `poll()` = one `stat` per host plus ≤ 256 parsed lines; no `execFileSync` on the TUI tick (T5 check counts calls through a stub; T8 measures the tick).
5. **Honest totals.** Overlap `(harness, id)` on 2+ hosts → `≈` and `overlap` count; stale hosts → `≈`; allowance takes the newest `fetchedAt` per account and never sums (T6 check).
6. **Kill safety.** Timeout kills only our own spawned pids/process groups (T5 check with a fake ssh that sleeps).
7. **Exactness (Part B).** A fixture with one Claude history copied to two hosts under different session ids: fleet tokens and cost must equal the local ledger reading both copies on one home (T13, T16). No `≈` on exact hosts.
8. **No lost deltas (Part B).** Drop a snapshot between host and viewer: the next request must repair it (T11 check); a `dir` gap waits instead of double-applying (T14).

---

### Task 0: Worktree, open questions

**Files:** none committed; findings go into the PR description as `Ruling:` lines.

- [ ] **Step 1: Worktree + build:** `git worktree add -b feat/fleet ../agentglass-fleet origin/main && cd ../agentglass-fleet && AGENTGLASS_OUT=$HOME/.cache/agentglass-agents/impl-fleet/agentglass ./build.sh && sh scripts/check.sh`. Expected: build succeeds, all checks `ok`.
- [ ] **Step 2: Open question 1+2 — process groups in the native build.** Write `$HOME/.cache/agentglass-agents/impl-fleet/pg.ts`:

```ts
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
const ch = spawn("sh", ["-c", "sleep 30 & sleep 30; wait"], { stdio: "ignore", detached: true });
const pid = ch.pid ?? 0; ch.unref();
execFileSync("sleep", ["0.3"]);
console.log("pgid " + execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim() + " pid " + String(pid));
let neg = "ok"; try { process.kill(-pid, "SIGTERM"); } catch (e) { neg = "fail " + String(e); }
execFileSync("sleep", ["0.3"]);
let left = ""; try { left = execFileSync("ps", ["-o", "pid=", "-g", String(pid)], { encoding: "utf8" }).trim(); } catch (e) { left = ""; }
console.log("kill -pid " + neg + "; left: [" + left + "]");
```

  Run: `C=$HOME/.cache/agentglass-agents/impl-fleet; scriptc build $C/pg.ts -o $C/pg && $C/pg`. Expected: `pgid <pid> pid <pid>` (the child leads its group) and `kill -pid ok; left: []`. If `kill -pid` fails: Task 5 kills the `sh` pid, then its children found with `ps -o pid= -g <pgid>` (still only our group); record `Ruling: no negative-pid kill`. If the pgid differs from the pid: Task 5 wraps the snippet in `setsid` when `command -v setsid` succeeds (Linux), else kills the `sh` pid and relies on `ServerAliveInterval`; record it. Kill any `sleep` left by pid from the printed group.
- [ ] **Step 3: Open question 3 — account uuid location (keys only, no values):** `python3 -c "import json;c=json.load(open('$HOME/.claude.json'));u=c.get('cachedUsageUtilization',{});print(sorted(u.keys()))"`. Expected: a key list. If it contains `accountUuid` (or another `*Uuid`), Task 3 reads that key; else `account = ""` and the Ruling says so.
- [ ] **Step 4: Open question 4 — macOS id:** on the macOS CI runner (or a Mac): `ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID`. Expected: `"IOPlatformUUID" = "XXXXXXXX-…"`. Task 1's parser takes the quoted value after `=`.
- [ ] **Step 5:** No commit.

---

### Task 1: Host identity (`src/util/hostid.ts`) — wave 1, parallel with T2

**Files:** Create `src/util/hostid.ts`, `src/util/hostid.check.ts`.

**Interfaces — Produces:**
- `export const HOSTID = { machineFiles: ["/etc/machine-id", "/var/lib/dbus/machine-id"], idFile: "", ioreg: "ioreg" }` (checks repoint them; `idFile` defaults at first use to `join(HOME, ".agentglass", "host-id")`).
- `export function machineIdFrom(ioregOut: string): string` — pure: the value of `"IOPlatformUUID" = "…"`, `""` if absent.
- `export function hostIdOf(machineId: string, uid: number): string` — pure: `sha256Hex("agentglass/host/v1|" + machineId + "|" + String(uid)).slice(0, 16)`.
- `export function hostId(): string` — cached per process: `idFile` content if it is 16 lowercase hex digits; else `hostIdOf(machine id, uid)` when a machine id is readable (Linux files trimmed, non-empty, not all zeros; macOS `ioreg -rd1 -c IOPlatformExpertDevice`, 3 s timeout); else 16 random hex digits (`Math.random`, 8 × 2 digits via `String((Math.random() * 256) | 0)` padded — no `toString(16)`: use a 16-entry hex table) written to `idFile` (dir 0700, file 0600, atomic tmp + rename) and returned.
- `export function hostName(): string` — `uname -n` up to the first `.`, cached, `"unknown"` on failure. Used by fleet only; the OTLP exporter keeps its own full `uname -n` for `host.name` (`src/features/otlp/encode.ts:150`, not edited here).

- [ ] **Step 1: If `src/util/hostid.ts` already exists** (otlp-complete merged first): `grep -n "export function hostId\|export function hostIdOf\|export function machineIdFrom\|export function hostName\|export const HOSTID" src/util/hostid.ts`. Expected: all five. Then go to Step 4.
- [ ] **Step 2: Failing check** `src/util/hostid.check.ts`:

```ts
import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./fs.ts";
import { HOSTID, hostIdOf, machineIdFrom, hostId, hostName } from "./hostid.ts";
let bad = 0;
function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
const a = hostIdOf("0123456789abcdef0123456789abcdef", 1000);
ok("16 hex", /^[0-9a-f]{16}$/.test(a), a);
ok("stable", a === hostIdOf("0123456789abcdef0123456789abcdef", 1000), "differs");
ok("uid matters", a !== hostIdOf("0123456789abcdef0123456789abcdef", 1001), "same");
ok("ioreg", machineIdFrom('  | |   "IOPlatformUUID" = "AB12CD34-0000-1111-2222-333344445555"\n') === "AB12CD34-0000-1111-2222-333344445555", "parse");
ok("ioreg absent", machineIdFrom("nothing") === "", "not empty");
const d = join(HOME, "hid"); mkdirSync(d, { recursive: true });
HOSTID.machineFiles = [join(d, "missing")]; HOSTID.idFile = join(d, "host-id"); HOSTID.ioreg = "/nonexistent-ioreg";
const r = hostId();
ok("random written", /^[0-9a-f]{16}$/.test(r) && readFileSync(join(d, "host-id"), "utf8").trim() === r, r);
ok("file 0600", (statSync(join(d, "host-id")).mode & 0o077) === 0, String(statSync(join(d, "host-id")).mode));
ok("hostName", hostName().length > 0 && hostName().indexOf(".") < 0, hostName());
console.log(bad ? String(bad) + " failed" : "hostid: all checks passed");
if (bad) process.exit(1);
```

- [ ] **Step 3: Run** the single-check command on `src/util/hostid.check.ts`. Expected: build FAIL (module missing). Implement `hostid.ts`. Run again. Expected: `hostid: all checks passed`. A second process (same HOME) returns the same id: add to the check a `writeFileSync(join(d, "host-id"), "00112233445566ff\n")` + a fresh-cache helper `HOSTID_TEST.reset()` exported for checks, then `ok("file wins", hostId() === "00112233445566ff", …)`.
- [ ] **Step 4: Run** `sh scripts/check.sh`. Expected: all `ok`.
- [ ] **Step 5: Commit** `feat(util): host id from the machine id, uid and an override file`.

---

### Task 2: Fleet config, model types, report parser — wave 1, parallel with T1

**Files:** Create `src/features/fleet/config.ts`, `src/features/fleet/model.ts`, `src/features/fleet/report.ts`, `src/features/fleet/config.check.ts`, `src/features/fleet/report.check.ts`.

**Interfaces — Produces:**
- `config.ts`: `export interface HostCfg { name: string; ssh: string; agentglass: string; redact: boolean; enabled: boolean; kind: string /* "ssh" | "otlp" | "dir" | "" */ }`; `export interface FleetCfg { hosts: HostCfg[]; localName: string; refreshS: number; days: number; timeoutS: number; warns: string[] }`; `export function fleetFrom(raw: unknown): FleetCfg` (pure, spec 2 rules, one warning per problem, message style of `src/features/otlp/config.ts:17-28`); `export function loadFleet(): FleetCfg` (`rawSection("fleet")`, cached); `export function fleetOn(c: FleetCfg): boolean` (an enabled `ssh` host exists and neither `--no-fleet` nor `AGENTGLASS_FLEET=0`).
  - Name `^[a-z0-9][a-z0-9-]{0,15}$`, unique, ≠ `localName`; ssh `^[A-Za-z0-9._%+@:\[\]-]{1,255}$` and not `^-`; agentglass `^(~/)?[A-Za-z0-9._/+-]{1,255}$`; ranges refresh 15–3600 (60), days 1–90 (7), timeout 10–600 (90); `localName` same pattern as names (default `local`); ≤ 32 hosts.
  - An entry with `otlp` or `dir` and no `ssh` → kept with `kind` `"otlp"`/`"dir"`, `enabled: false`, warning `fleet host <name>: transport otlp needs a newer agentglass`.
- `model.ts`: `Hello`, `HostReport`, `FeedState`, `HostFeed` exactly as spec section 1; `export const FORMAT = "agentglass-fleet/v1"`.
- `report.ts`: `export interface Parse { hello: Hello | null; cost: Obj | null; allowance: Obj | null; sessions: SessRow[]; done: boolean; err: string }` (each `{"s": o}` line becomes `{s: o, key: o.harness + ":" + o.id, days: null, own: null, prov: []}`; `toReport` sets `live: null`, `exact: false`); `export function newParse(): Parse`; `export function feedLines(p: Parse, lines: string[]): void` (incremental: `{"hello"}` must come first, else `err = "not a fleet report"`; `{"end": {sessions: n}}` sets `done` when `n === sessions.length`, else `err = "incomplete report"`; a format major other than `v1` → `err = "newer format " + format`; unknown line keys ignored); `export function toReport(p: Parse): HostReport | null` (null unless `done && !err`); `export function reportLines(r: HostReport): string[]` (inverse, used by `fleet pull` and by checks).

- [ ] **Step 1: Failing check** `src/features/fleet/config.check.ts` — cases: a valid two-host config → 2 hosts, defaults applied; `{"name":"Ws"}` → skipped (uppercase) with a warning naming it; `"ssh": "-oProxyCommand=evil"` → skipped, warning contains `must not start with -`; `"ssh": "a b"` → skipped; duplicate name → second skipped; name `local` → skipped; `"agentglass": "~/bin/ag;rm"` → skipped; `refreshSeconds: 5` → 60 with a warning; `{"name":"ci","otlp":"/x"}` → kept, `kind "otlp"`, `enabled false`, warning `needs a newer agentglass`; 33 hosts → 32 + one warning; `fleet: 3` → defaults + warning `fleet in ~/.agentglass/config.json must be an object`. Same `ok()` style as Task 1; last line `fleet config: all checks passed`.
- [ ] **Step 2: Failing check** `src/features/fleet/report.check.ts`: build a `HostReport` literal (hello with `FORMAT`, cost `{today:{byMode:{api:1}}}`, two sessions `{id:"a",harness:"claude"}`, `{id:"b",harness:"codex"}`), `reportLines` → feed in two chunks (1 line, rest) → `toReport` deep-equals the input (compare `JSON.stringify`); without the `end` line → `toReport` null and `done` false; `end` with `sessions: 3` → `err` `incomplete report`; first line not hello → `not a fleet report`; hello format `agentglass-fleet/v2` → `newer format agentglass-fleet/v2`; a line `{"x":1}` between sessions is ignored. Last line `fleet report: all checks passed`.
- [ ] **Step 3: Run** both checks. Expected: build FAIL (modules missing).
- [ ] **Step 4: Implement** the three modules. `config.ts` uses `obj`, `str`, `arr` from `src/util/json.ts` and `rawSection` from `src/util/config.ts`.
- [ ] **Step 5: Run** both checks → `… all checks passed`; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 6: Commit** `feat(fleet): hosts config, the HostFeed/HostReport model and the report line format`.

---

### Task 3: `agentglass fleet pull` (the remote side) — wave 2, parallel with T5, T6

**Files:** Create `src/features/fleet/pull.ts`, `src/features/fleet/pull.check.ts`; Modify `src/features/cost-cli.ts:53` (`export function json`), `src/features/usage/bill-live.ts` (export `allowanceInfo()`), `src/main.ts` (import `./features/fleet/pull.ts`).

**Interfaces — Consumes:** `jsonSess` (`cli.ts:173`), `discover` (`cli.ts:192`), `json(c)` + `summary(harness)` from `cost-cli.ts` (export `summary` too), `hostId`/`hostName` (T1), `FORMAT`, `reportLines` (T2), `allowanceOf` (`billing.ts:256`), `claudeJson` (`billing.ts:170`), the Codex windows `L.rl` used by the header (`stats.ts:730`: find its owner with `grep -n "rl:" src/features/usage/*.ts` and export a getter `codexWins(): Obj | null` there).

**Interfaces — Produces:**
- `export function pullReport(days: number, now: number): HostReport` — `discover()`; candidates = top-level sessions with `mtime >= now − days·86400000` or `livePid(s) > 0`, newest first; for each `loadHead`, `loadTail(s, true)`, `complete(s)`, subagents `complete`; `sessions = jsonSess(s)` each; `cost = json(summary(""))`; `allowance = {claude: allowanceInfo(now), codex: codexWins()}`; `hello = {format: FORMAT, version: BUILD.version, hostId: hostId(), hostName: hostName(), os: process.platform, tzOffsetMin: -new Date().getTimezoneOffset(), redact: REDACT, days, now}`.
- `allowanceInfo(now): Obj | null` in `bill-live.ts`: `{account, fetchedAt, h5: {pct, reset} | null, d7: … | null}` from the same `claudeJson(CJ).usage` block and `allowanceOf`; `account` = `sha256Hex("agentglass/account/v1|" + uuid).slice(0, 12)` with the uuid key found in Task 0 Step 3 (else `""`). Only that block is read.
- CLI: `H.cli.unshift` handler for `args[0] === "fleet" && args[1] === "pull"`: `--days N` (1–90, else `cliError("usage", "--days needs 1–90", "e.g. fleet pull --days 7", 2)`), ignores the host's `fleet` config; writes `reportLines(...)` one per line with `writeSync(1, …)` (EPIPE → exit 0); exit 0. `addCmd` entry with usage, summary and options (shown under `fleet --help`).

- [ ] **Step 1: Failing check** `src/features/fleet/pull.check.ts`: a fixture HOME with two Claude sessions (one updated now, one 10 days ago; the `printf` lines of `scripts/cost.test.sh:11-14` as template, written with `writeFileSync`), `AGENTGLASS_CACHE_DIR` under HOME; `pullReport(7, Date.now())` → 1 session, its object `JSON.stringify`-equal to `jsonSess` of the same session; `pullReport(30, …)` → 2; `hello.format === FORMAT`, `hello.hostId` 16 hex; `cost.today.byMode` present; `reportLines` last line starts with `{"end"`. Last line `fleet pull: all checks passed`.
- [ ] **Step 2: Run** → build FAIL. Implement. Run → `fleet pull: all checks passed`.
- [ ] **Step 3: Contract check against the existing commands** (append to `scripts/cost.test.sh`, which already has the fixture): `p=$(run fleet pull --days 7)`; `eq pull-lines "$(echo "$p" | head -1 | jq -r '.hello.format')" agentglass-fleet/v1`; `eq pull-cost "$(echo "$p" | jq -c 'select(.cost)|.cost')" "$(run cost --json | jq -c .)"`; `eq pull-sess "$(echo "$p" | jq -c 'select(.s)|.s|{id,costUsd,tokens}')" "$(run --json | jq -c '.[]|{id,costUsd,tokens}')"`; `eq pull-end "$(echo "$p" | tail -1 | jq -r '.end.sessions')" 1`; redacted: `eq pull-redact "$(run fleet pull --redact | grep -c '/w/app' || true)" 0`.
- [ ] **Step 4: Run** `sh scripts/cost.test.sh` (with `AGENTGLASS_BIN` from a fresh build) → no `FAIL`; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Measure** on the dev box with the isolation set: `time ag fleet pull --days 7 | wc -c` warm vs the two commands of the spec's measurement table. Expected: ≤ the `--json --filter 'age < 7d'` time + 0.2 s; note the numbers in the PR.
- [ ] **Step 6: Commit** `feat(fleet): fleet pull prints a host report (hello, cost, allowance, sessions)`.

---

### Task 4: `fleet serve` (forced command) and `fleet authorize` — wave 3, parallel with T7, T8

**Files:** Create `src/features/fleet/serve.ts`, `src/features/fleet/serve.check.ts`; Modify `src/main.ts` (import).

**Interfaces — Produces:**
- `export function words(s: string): { w: string[]; err: string }` — pure POSIX-like splitter for plain words: whitespace separates; `'…'` literal; `"…"` with `\"` `\\` escapes; backslash outside quotes escapes the next char; any unquoted `` ` $ ; | & < > ( ) `` or newline → `err = "refused: shell syntax"`; unbalanced quote → `err = "refused: unbalanced quote"`.
- `export function allowed(w: string[]): { args: string[]; redact: boolean; err: string }` — `w[0]` must end with `agentglass` (basename); then exactly `fleet pull` with optional `--days N` (1–90) and `--redact`, or `--version` with optional `--json`; returns the argv for the child (without `w[0]`), `redact` when `--redact` was asked; else `err = 'only "fleet pull" and "--version" are allowed'`.
- `export function keyLine(execPath: string, pub: string, from: string, redact: boolean): { line: string; err: string }` — `pub` one line matching `^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\n"]{0,200})?$`; `from` empty or `^[0-9a-fA-F.:/,*]+$`; execPath must not contain `"` or whitespace (else `err` with a hint to install into a plain path); line = `restrict,` + (`from="<from>",` if set) + `command="<execPath> fleet serve` + (` --redact` if set) + `" ` + pub.
- CLI: `fleet serve [--redact]` — `SSH_ORIGINAL_COMMAND` unset → usage on stderr, exit 2; refused → stderr message, exit 126; allowed → `execFileSync(process.execPath, args, {stdio: "inherit", env: {...process.env, AGENTGLASS_REDACT: redact || ownRedact ? "1" : (process.env.AGENTGLASS_REDACT ?? "")}})`, exit with the child's code (catch → its `status`). `ownRedact` = serve's own `--redact` (or `REDACT`). `fleet authorize <file> [--from c] [--redact]` → prints `keyLine(...)`, exit 0, or `cliError("usage", err, "…", 2)`.

- [ ] **Step 1: Failing check** `serve.check.ts`: `words("agentglass fleet pull --days 7").w` → `["agentglass","fleet","pull","--days","7"]`; `words("a 'b c' \"d\\\"e\"")` → `["a","b c","d\"e"]`; refused: `a;b`, `a | b`, `a $(id)`, `` a `id` ``, `a > f`, `a\nb`, `'a` (unbalanced); `allowed(["/x/agentglass","fleet","pull","--days","7","--redact"])` → args `["fleet","pull","--days","7","--redact"]`, `redact true`; refused: `["sh","-c","x"]`, `["agentglass","--json"]`, `["agentglass","fleet","pull","--days","999"]`, `["agentglass","fleet","pull","--x"]`, `["agentglass-evil","fleet","pull"]` (basename must be exactly `agentglass`); `keyLine("/h/.local/bin/agentglass", "ssh-ed25519 AAAAC3Nz me@x", "100.64.0.0/10", true).line === 'restrict,from="100.64.0.0/10",command="/h/.local/bin/agentglass fleet serve --redact" ssh-ed25519 AAAAC3Nz me@x'`; a pub with a newline or `"` → err. Last line `fleet serve: all checks passed`.
- [ ] **Step 2: Run** → FAIL; implement; run → passed.
- [ ] **Step 3: Shell test** (new `scripts/fleet-serve.test.sh`, fixture from `cost.test.sh`): `SSH_ORIGINAL_COMMAND='agentglass fleet pull --days 7' run fleet serve | head -1 | jq -r .hello.format` → `agentglass-fleet/v1`; `SSH_ORIGINAL_COMMAND='agentglass --json' run fleet serve; echo $?` → `126`; `SSH_ORIGINAL_COMMAND='agentglass fleet pull; id' …` → 126; `run fleet serve` without the variable → 2; forced: `SSH_ORIGINAL_COMMAND='agentglass fleet pull' run fleet serve --redact | grep -c '/w/app'` → `0`; `run fleet authorize "$t/k.pub" --from 10.0.0.0/8` matches `^restrict,from="10.0.0.0/8",command="`.
- [ ] **Step 4: Run** `sh scripts/fleet-serve.test.sh` → no FAIL; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Commit** `feat(fleet): fleet serve (forced command, read-only) and fleet authorize`.

---

### Task 5: SSH feed and the spool store — wave 2, parallel with T3, T6

**Files:** Create `src/features/fleet/ssh.ts`, `src/features/fleet/store.ts`, `src/features/fleet/ssh.check.ts`, `src/features/fleet/store.check.ts`; Modify `src/platform/posix.ts:37-39` (add `detachedPid`), `src/platform/types.ts` + `linux.ts`/`darwin.ts` only if `detached` is re-exported through `OS` (check with `grep -n detached src/platform/*.ts`), `scripts/check.sh` (add `-u AGENTGLASS_FLEET_DIR -u AGENTGLASS_SSH` to the `env -u` list at `scripts/check.sh:28-29`).

**Interfaces — Produces:**
- `posix.ts`: `export function detachedPid(cmd: string, args: string[]): number` — like `detached`, returns `ch.pid ?? 0`.
- `store.ts`: `export function fleetDir(): string` (`AGENTGLASS_FLEET_DIR` or `~/.agentglass/fleet`); `export function ensureDir(): string` (`secureDir(dir, myUid(), OS.fileInfo, true)` from `rundir.ts:17`; returns `""` or the reason); `export function keyOf(name: string, redact: boolean): string` (`name` or `name + ".r"`); `export interface Spool { rcAt: number; rc: number; err: string }`; `export function spoolOf(k: string): Spool | null` (stat `k.rc`, read it and the first line of `k.err` ≤ 4 KB); `export interface Reader { k: string; off: number; p: Parse; at: number }`, `export function newReader(k: string): Reader`, `export function readStep(r: Reader, maxLines: number): HostReport | null | undefined` (`undefined` = not finished yet; `null` = finished with `r.p.err`; else the report). Uses `readLines(path, off, off + 4194304, false)` from `src/util/fs.ts:43` and feeds at most `maxLines` per call (keeps the rest for the next call by tracking the byte offset of the last consumed line).
  - `export function forget(names: string[]): void` — delete files of hosts no longer configured (only names matching the name pattern, only inside `fleetDir()`).
- `ssh.ts`:
  - `export function sshBin(): string` — `AGENTGLASS_SSH` or `ssh`, probed once with `-V` (stderr), `""` if missing (same shape as `curlBin`, `http.ts:12-19`).
  - `export function q(w: string): string` — `'` + `w.split("'").join("'\\''")` + `'`; a leading `~/` stays outside the quotes.
  - `export function controlPath(runDir: string, target: string): string` — `join(runDir, "f-" + sha256Hex(target).slice(0, 12))`; `""` when `Buffer.byteLength`-equivalent (`new TextEncoder().encode(p).length`) `+ 17 > 107`.
  - `export function sshArgs(h: HostCfg, days: number, redact: boolean, cp: string): string[]` — `["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "Compression=yes"]` + (cp ? `["-o", "ControlMaster=auto", "-o", "ControlPath=" + cp, "-o", "ControlPersist=600"]` : `[]`) + `[h.ssh, q(h.agentglass), q("fleet"), q("pull"), q("--days"), q(String(days))]` + (redact ? `[q("--redact")]` : `[]`).
  - `export const SNIPPET` — the fixed text of spec 5.3 (exactly, one line per statement).
  - `export function statusOf(rc: number, err: string, h: HostCfg): { code: string; msg: string }` — codes `ok`, `ssh` (255: first `.err` line), `missing` (127), `refused` (126), `old` (2 and `/unknown command/`), `timeout` (rc −1, set by the killer), `other`; `msg` per spec 5.6.
  - `export function sshFeed(h: HostCfg, f: FleetCfg, redact: boolean, now: () => number, spawn: (cmd: string, args: string[]) => number): HostFeed` — `start()`: refuse if running or `ensureDir()` fails; remove stale `k.rc`; `pid = spawn("sh", ["-c", SNIPPET, "sh", fleetDir(), k, sshBin(), ...sshArgs(...)])`; write `k.pid` (`pid start-ms`); `poll()`: a running pull older than `timeoutS` → `process.kill(-pid, "SIGTERM")` (Task 0 ruling decides the fallback), `state.code = "timeout"`; a new `k.rc` → reader started (`rc === 0`) or status set; `readStep(…, 256)`; `stop()`: kill a running pull (our pid only).
  - The `spawn` parameter is `detachedPid` in production and a stub in checks (the check counts calls and asserts argv).

- [ ] **Step 1: Failing check** `ssh.check.ts`: `q("a'b") === "'a'\\''b'"`; `q("~/.local/bin/agentglass") === "~/'.local/bin/agentglass'"`; `controlPath("/home/u/.agentglass/run", "ws")` → starts with that dir + `/f-`, 12 hex; `controlPath("/" + "x".repeat(80), "ws") === ""`; `sshArgs({name:"ws",ssh:"me@ws",agentglass:"agentglass",redact:false,enabled:true,kind:"ssh"}, 7, true, "/r/f-0123")` deep-equals the expected array (write it out); destination is the first non-option argument (no `-` start, guaranteed by T2); `statusOf(255, "ssh: Could not resolve hostname ws: Name or service not known", h).msg` contains `Could not resolve hostname`; `statusOf(127, "", h).msg` contains `set fleet.hosts[].agentglass`; `statusOf(2, "agentglass: unknown command fleet", h).code === "old"`; `SNIPPET` contains `mv -f "$d/$k.rc.tmp" "$d/$k.rc"` and no `${` expansion of config values. Feed with a stub spawn: `start()` true, second `start()` false while running; the stub records `["sh","-c",SNIPPET,"sh",dir,"ws",…]`. Last line `fleet ssh: all checks passed`.
- [ ] **Step 2: Failing check** `store.check.ts` (HOME fixture, `AGENTGLASS_FLEET_DIR` set via `process.env` before import is not possible — make `fleetDir()` read the env at call time): `ensureDir()` creates 0700; a group-writable dir → reason contains `allows group/other access`; write a 900-session report with `reportLines` to `ws.jsonl` → `readStep(r, 256)` returns `undefined` three times, then the report (900 sessions); a file without `end` → `null` and `r.p.err === "incomplete report"`; `keyOf("ws", true) === "ws.r"`; `forget(["ws"])` removes `old.jsonl` but not `ws.jsonl`, and never a file outside the dir. Last line `fleet store: all checks passed`.
- [ ] **Step 3: Run** both → FAIL; implement; run → passed.
- [ ] **Step 4: Process test** (append to `ssh.check.ts`, real spawn): a fake ssh script in HOME (`#!/bin/sh\nsleep 30`) as `AGENTGLASS_SSH`, `timeoutS` 10 replaced by a test hook `FEEDTEST.timeoutMs = 300`: `start()`, poll after 500 ms → `code "timeout"`, and `ps -o pid= -g <pid>` empty after 300 ms more. A fake ssh that prints `reportLines` of a fixture report and exits 0 → after the `.rc` appears, polls return the report within ≤ 4 polls at 256 lines.
- [ ] **Step 5: Run** `sh scripts/check.sh` → all `ok`.
- [ ] **Step 6: Commit** `feat(fleet): SSH feed with detached spool pulls, timeouts and a 0700 report store`.

---

### Task 6: Merge reports into the model (rows, overlap, cost, allowance, `host` attribute) — wave 2, parallel with T3, T5

**Files:** Create `src/features/fleet/hosts.ts`, `src/features/fleet/hosts.check.ts`; Modify `src/model/types.ts:5-27` (`host`, `rlive`, `rat` on `Sess` + `newSess`), `src/model/sessions.ts` (`isLive`, `buildView` appends `remoteRows()` from a registry hook, `loadHead`/`loadTail` early return), `src/hooks.ts:72-73` (`enrich`/`complete` early return for `s.host`), `src/hooks.ts` (new `H.remoteRows: (() => Sess[])[]`), `src/ui/list.ts:32-35` (`glyphKind` uses `isLive`), `src/features/query/attrs.ts` (register `host`), `src/features/query/eval.ts:49-89` (`livePid` unchanged; `live`/`state` cases use `isLive`; new `case "host"`), `src/features/query/attrs.ts:23-33` (`enumValues`/`canonEnum` for `enumFn "host"`), `src/features/query/eval.check.ts` (host cases).

**Interfaces — Produces:**
- `Sess.host: string` (`""` local), `Sess.rlive: boolean`, `Sess.rat: number`; `newSess` sets `"", false, 0`.
- `sessions.ts`: `export const FRESH = { ok: (host: string): boolean => true }` (hosts.ts sets it); `export function isLive(s: Sess): boolean` — `s.pid > 0 || (s.host !== "" && s.rlive && FRESH.ok(s.host))`.
- `hosts.ts`:
  - `export interface RemoteHost { cfg: HostCfg; feed: HostFeed; report: HostReport | null; rows: Sess[]; okAt: number; dupOf: string; alertsSeen: Set<string> }`.
  - `export const FLEET = { hosts: [] as RemoteHost[], cfg: null as FleetCfg | null, localId: "" }`.
  - `export function rowsOf(h: string, r: HostReport, at: number): Sess[]` — spec 7.1 field mapping; `path = "@" + h + "/" + harness + ":" + id`; `headDone = true`; `tailSize = 0`; `cost = costUsd === null ? -1 : costUsd`.
  - `export function applyReport(rh: RemoteHost, r: HostReport, at: number, ids: Map<string, string>): void` — `ids` maps hostId → first name; a report whose `hello.hostId` equals `FLEET.localId` or an earlier host's id → `rh.dupOf = <name or localName>`, `rows = []`; else rows replaced.
  - `export function freshOf(rh: RemoteHost, now: number, f: FleetCfg): boolean` — `rh.report !== null && now - rh.okAt <= 2 * interval + f.timeoutS * 1000` (interval = `refreshS * 1000`; unfocused stretch is the caller's concern: pass the effective interval).
  - `export function overlap(local: Sess[], hosts: RemoteHost[]): Set<string>` — keys `h + ":" + id` present on ≥ 2 hosts (local counts as a host).
  - `export interface FleetCost { today: ModeSum; week: ModeSum; month: ModeSum; projByMode: number[]; approx: boolean; perHost: { name: string; today: number; week: number; month: number; age: number; stale: boolean }[] }`; `export function sumOf(cost: Obj | null): { today: ModeSum; week: ModeSum; month: ModeSum; proj: number[] }` (reads `byMode` per `MODES` index, `unpriced.tokens` → `unk`, `estimatedUsd` → `est`); `export function fleetCost(localNow: CostNow, hosts: RemoteHost[], now: number, f: FleetCfg, ov: number): FleetCost` (adds with `addSum`; `approx` when any host stale, `ov > 0`, or a host's `month.projected` is null).
  - `export function fleetBudget(fc: FleetCost): BState` — `budgetState(budget, fc.month, fc.projByMode)`, `approx ||= fc.approx`.
  - `export function fleetAllowance(local: Obj | null, hosts: RemoteHost[]): Obj | null` — per `account`, the claude window with the largest `fetchedAt`; codex: the newest `at`.
  - `H.remoteRows.push(() => rows of every enabled host)` and `FRESH.ok = (h) => freshOf(hostNamed(h), Date.now(), cfg)`.
- Filter: `r("host", [], "session", "enum", false, [], "host", [])`; `enumValues` → `[localName, ...names]`; eval `case "host": return V([s.host || localName])`.

- [ ] **Step 1: Failing check** `hosts.check.ts`: a report literal with 2 sessions (one `live: true`), `rowsOf("ws", r, now)` → 2 rows, `path` starts `@ws/`, `pid === 0`, `cost` −1 for `costUsd: null`; `isLive(row)` true while `FRESH.ok` returns true, false after setting `FRESH.ok = () => false`; `applyReport` with `hello.hostId === FLEET.localId` → `dupOf === "local"`, no rows; second host with the first's id → `dupOf === "ws"`; `overlap` with local `{h:"claude",id:"x"}` and ws `x` → size 1; `fleetCost` of local `today.by[0] = 1` + ws report `today.byMode.api = 2` → `today.by[0] === 3`, a stale host → `approx true`; `fleetAllowance` with ws `{claude:{account:"a",fetchedAt:10,h5:{pct:40}}}` and vm1 `{…fetchedAt:20,h5:{pct:55}}` → `h5.pct === 55` (newest, not 95). Under a fake `sessions` with one local session: `enrich(row)` and `complete(row)` and `loadHead(row)` do not throw and change nothing (`JSON.stringify` before/after equal); `sessions.has(row.path) === false` after `buildView()`, and `S.view` includes the row. Last line `fleet hosts: all checks passed`.
- [ ] **Step 2: Failing cases** in `src/features/query/eval.check.ts` (follow its existing fixture helpers): `host is local` matches a local session and not a row with `host = "ws"`; `host is ws` the reverse; `host is_one_of ws,vm1`; `host is nope` → a parse/validation error listing `local, ws`; `tool is Bash` never matches a remote row.
- [ ] **Step 3: Run** both → FAIL; implement; run → passed.
- [ ] **Step 4: Regression:** `sh scripts/check.sh` → all `ok`; `./build.sh && <isolated> ./agentglass --json --limit 50 | jq -S '[.[]|{id,live,costUsd}]'` before/after this task (no `fleet` config) → identical (no host field added to plain `--json`).
- [ ] **Step 5: Commit** `feat(fleet): host-qualified remote rows, overlap, fleet cost/budget/allowance, host filter key`.

---

### Task 7: CLI `fleet`, `fleet cost`, `fleet status` — wave 3, parallel with T4, T8

**Files:** Create `src/features/fleet/cli.ts`, `src/features/fleet/cli.check.ts`; Modify `src/main.ts` (import).

**Interfaces — Consumes:** `loadFleet` (T2), `sshFeed`, `fleetDir`, `spoolOf` (T5), `FLEET`, `rowsOf`, `fleetCost`, `overlap` (T6), `jsonSess`, `JSON_FIELDS`, `TABLE_COLS`, `formatRows` (`cli.ts`), `costNow`, `json` (cost-cli, exported in T3), `cliError`, `addCmd`.

**Interfaces — Produces:**
- `export function pullAll(f: FleetCfg, force: boolean, redact: boolean, now: number): { ok: string[]; failed: { name: string; msg: string; age: number }[] }` — starts due hosts (cache older than `refreshS`, or `force`), ≤ 4 at once, polls every 100 ms (`execFileSync("sleep", ["0.1"])`) until all finished or `timeoutS`, reads reports with `readStep(r, 1e9)`.
- `fleetJson(rows)`: every local `jsonSess` with `host: localName` inserted after `harness` and `stale: false` after `live`; remote rows from the report objects with `host` and `stale`; sorted by `updated` desc; `--filter`, `--format`, `--fields` through the existing `cliFilter`/`formatRows` (with `host` and `stale` added to the field list for `--fields`).
- `fleet cost --json`: `{hosts: [{name, ok, stale, ageSec, cost}], total: <cost --json shape built from FleetCost>, overlap: n, approx: bool}`; text: one table row per host (`today`, `7 days`, `month`, `age`) plus `fleet` total and budget line (`budget: … (fleet)`); `--check` → 3 when `fleetBudget` is `over`.
- `fleet status [--json] [--close]`: per host `{name, kind, target, enabled, okAgeSec, err, code, version, hostId, redact, tzOffsetMin, sessions, live, overlap, sharing, dupOf}`; text: one block per host, problems first; `--close` runs `ssh -O exit -o ControlPath=<cp> <target>` for each (our ControlPaths only).
- Exit codes: `--strict` → 5 when any enabled host failed or is stale; no hosts → `cliError("usage", "no hosts configured", 'add "fleet": {"hosts": [{"name": "ws", "ssh": "…"}]} to ' + CONFIG_FILE, 2)`; no ssh → 2 `fleet needs ssh (AGENTGLASS_SSH)`.
- `addCmd` rows for `fleet`, `fleet cost`, `fleet status`, `fleet pull`, `fleet serve`, `fleet authorize` (usage, summary, options, fields incl. `host`, `stale`), so `agentglass --help`, `fleet --help` and the agent-mode JSON help list them.

- [ ] **Step 1: Failing check** `cli.check.ts` (pure parts): `fleetJson` inserts `host` right after `harness` and `stale` right after `live` (compare `Object.keys` order); the cost envelope sums two host fixtures plus local; `--strict` decision function `strictCode(failed, stale)` → 5/0. Last line `fleet cli: all checks passed`.
- [ ] **Step 2: Run** → FAIL; implement; run → passed.
- [ ] **Step 3: Help:** `<isolated> ./agentglass fleet --help` lists the six commands; `<isolated> AGENTGLASS_AGENT=1 ./agentglass fleet --help --format json | jq -r '.commands[].cmd' | grep -c '^fleet'` → `6` (adjust the jq path to `jsonHelp`'s shape, `src/features/clihelp.ts`).
- [ ] **Step 4: Run** `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Commit** `feat(fleet): agentglass fleet, fleet cost and fleet status`.

---

### Task 8: TUI (badge, header, Stats line, remote preview, guards, palette, help, cadence, alerts) — wave 3, parallel with T4, T7

**Files:** Create `src/features/fleet/tui.ts`, `src/features/fleet/tui.check.ts`; Modify `src/features/usage/stats.ts:723-735` (header cost widget reads `fleetCost`/`fleetBudget`/`fleetAllowance` when `fleetOn`), `src/features/usage/stats.ts` (Stats summary: one `fleet` line, spec 8), the preview renderer for the Sessions list (`grep -n "function preview\|renderPreview" src/ui/*.ts` — add the remote card branch), `src/actions.ts`, `src/input.ts`, `src/features/callgraph/view.ts`, `src/features/vcs/view.ts`, `src/features/repos/tab.ts`, `src/features/palette/actions.ts`, `src/features/palette/links.ts`, `src/features/compare/marks.ts`, `src/features/watchdog.ts` (each `current()` entry point that opens, kills, approves, marks or reads a file: add `if (remoteOnly(s, "<action>")) return`), `src/main.ts` (import).

**Interfaces — Produces:**
- `export function remoteOnly(s: Sess | null, what: string): boolean` — `s && s.host` → `say("info", "remote session on " + s.host + ": " + what + " needs the host (" + sshHint(s) + ")")`, true; else false.
- `export function sshHint(s: Sess): string` — `ssh <target> -t <agentglass> open <h>:<id>` from the host's config.
- `H.onTick` job: when `fleetOn`: per host `feed.poll(now)`; due hosts `feed.start(now)` (interval `refreshS`, `max(refreshS, 300)` while unfocused/idle — read the adaptive-refresh focus flag: `grep -n "focus" src/sched.ts`), backoff after failures (30 s doubling to 900 s); new report → `applyReport`, `buildView()` invalidated (bump its signature: add the fleet generation to `sigOf`), alert transitions → `say("warn", host + " · " + title + ": " + message)` once per `host|session|rule|since`.
- `H.rowBadges.push(s => s.host ? fg(C.purple) + s.host.slice(0, 4) + RST : "")` (dim when stale); the age column shows `<age>?` for stale rows; `≈` after the cost for overlapping rows.
- `H.headerWidgets` segment: `· N hosts` (+ `· vm1 stale 2h` yellow / `· vm1 ✗` red), dropped first when narrow.
- Palette: `addActions([...])` with `fleet.refresh` "fleet: refresh hosts now" and `fleet.status` "fleet: status" (`when`: `fleetOn`).
- `H.helpSections.push({ name: "fleet", ctx: "Sessions", keys: [...] })` — badge, header, staleness, `host is …`, remote limits, palette actions, config path.
- `H.onQuit`: `feed.stop()` for every host (kills running pulls only; SSH masters persist).
- Footer: on a remote row the `↵` hint label is `remote`.

- [ ] **Step 1: Failing check** `tui.check.ts`: `remoteOnly(null, "x") === false`; on a remote row it returns true and `S.toast` contains `remote session on ws` and `ssh`; the header segment text for 3 hosts with one stale at widths 120/60/30 (`· 3 hosts · vm1 stale 2h` / `· 3 hosts` / `""`); the alert de-dup: the same transition in two consecutive reports toasts once; cadence: due after `refreshS`, `300 s` while unfocused, backoff 30 → 60 → … → 900. Last line `fleet tui: all checks passed`.
- [ ] **Step 2: Run** → FAIL; implement; run → passed.
- [ ] **Step 3: Guard sweep:** `grep -n "current()" src/actions.ts src/input.ts src/features/*/view.ts src/features/repos/tab.ts src/features/palette/actions.ts src/features/palette/links.ts src/features/compare/marks.ts src/features/watchdog.ts` — every call site that opens a transcript, the call graph, git/related views, kills, approves, marks for compare, or opens in the harness has a `remoteOnly` line before it; record the list in the commit body.
- [ ] **Step 4: Tick budget:** with a fake ssh (Task 5 Step 4 script printing a 900-session fixture report) and two hosts, run the TUI in tmux with the isolation set + `AGENTGLASS_SSH`, 60 s, then `ps -o rss=,time= -p <pid>`; compare with the same run without `fleet` config. Expected: CPU time difference ≤ 1 s per minute and no frame over 50 ms during report ingestion (`AGENTGLASS_DEBUG_FRAMES` if available, else visual: no stall). Kill the TUI by its pid.
- [ ] **Step 5: Visual check** (tmux, isolated): 80, 120, 200 columns — badges, header segment, stale dimming, Enter on a remote row toasts, `?` shows the fleet section, palette lists both actions. Screenshots (text captures via `tmux capture-pane -p`) go into the PR.
- [ ] **Step 6: Run** `sh scripts/check.sh` → all `ok`.
- [ ] **Step 7: Commit** `feat(fleet): remote rows in the TUI — host badge, header hosts, Stats fleet line, guarded actions, palette`.

---

### Task 9: End-to-end test, README, final help — wave 4

**Files:** Create `scripts/fleet.test.sh`; Modify `README.md` (new section "Several machines (fleet)" after "Scriptable"), `CHANGELOG.md` (Unreleased).

- [ ] **Step 1: Shell test** `scripts/fleet.test.sh` (template: `scripts/cost.test.sh:1-9`): two fixture homes `h1` (the viewer) and `h2`, `h3` (hosts); a fake ssh `$t/ssh`:

```sh
#!/bin/sh
# fake ssh: skip options, take the destination, run the remote words in the host's fixture home
while [ $# -gt 0 ]; do case "$1" in -o) shift 2;; -T) shift;; -O) shift 2;; *) break;; esac; done
dest=$1; shift
[ "$dest" = slow ] && exec sleep 60
[ "$dest" = gone ] && { echo "ssh: connect to host gone port 22: Connection refused" >&2; exit 255; }
HOME="$FAKE_HOMES/$dest" AGENTGLASS_CACHE_DIR="$FAKE_HOMES/$dest/cache" eval "$*"
```

  with `FAKE_HOMES=$t`, `AGENTGLASS_SSH=$t/ssh`, `PATH=$t/bin:$PATH` where `$t/bin/agentglass` is a copy of the binary. Viewer config: hosts `h2`, `h3`, `gone`, `slow` (`timeoutSeconds: 10`). Assertions (`eq`):
  - `fleet --json | jq length` = local + h2 + h3 sessions; every row has `host`; `h2` rows have `stale false`.
  - `fleet cost --json | jq .total.today.byMode.api` = sum of the three `cost --json` figures (computed with `jq` from each home).
  - `fleet status --json`: `gone` → `code "ssh"`, msg contains `Connection refused`; `slow` → `code "timeout"`; `h2` → `ok`.
  - `fleet --strict; echo $?` → `5`.
  - Same session id in `h2` and `h3` (copy one transcript) → `fleet cost --json | jq .overlap` = `1`, `.approx` = `true`.
  - `h3` configured with the viewer's own `host-id` file content → `fleet status --json` `dupOf` = `local`, its rows absent.
  - `h2` with `redact: true` → `grep -rc '<fixture title>' $AGENTGLASS_FLEET_DIR` = 0 for `h2.r.jsonl`.
  - A truncated report (fake ssh variant `cut` that drops the last line) → the previous `h2` report stays, status `incomplete report`.
  - `ps` shows no leftover `sleep 60` from `slow` after the run (only checks pids under our test dir).
- [ ] **Step 2: Run** `sh scripts/fleet.test.sh` → no FAIL; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 3: README** "Several machines (fleet)": what moves and what stays (spec 11), the config block (spec 2), the forced-command recipe with `fleet authorize` and `restrict` + `from=` (spec 4.2), `redact` per host first, the overlap `≈` limit, timezone and price notes, Tailscale SSH works unchanged, `fleet status` as the first troubleshooting step, the exit codes.
- [ ] **Step 4: Manual SSH run** (no change to `~/.ssh`): `AGENTGLASS_SSH=$S/ssh-wrap` where `ssh-wrap` = `exec ssh -o UserKnownHostsFile=$S/known_hosts -o StrictHostKeyChecking=accept-new "$@"`, viewer config with `{"name":"lo","ssh":"localhost","agentglass":"<abs path of the build>"}`: `fleet status` → `ok`; second `fleet --refresh` time − first ≈ the remote `fleet pull` time (sharing on); `fleet status --close` ends the master. Note timings in the PR.
- [ ] **Step 5: Commit** `test(fleet): end-to-end fleet test with a fake ssh; docs(readme): several machines`.

---

## Part B — exactness

### Task 10: Per-message rows sidecar and the snapshot codec — wave 5

**Files:** Create `src/features/usage/msgrows.ts`, `src/features/usage/msgrows.check.ts`, `src/features/fleet/snap.ts`, `src/features/fleet/snap.check.ts`; Modify `src/features/usage/record.ts:398-400` (Booking gains `id: string`, `iso: string`, `hour: number`), the Claude booking call site (`src/harness/claude.ts:252-256`: pass the message id and timestamp to the tap), `src/features/usage/ledger.ts:78` (`OWN.restart` also calls `msgrowsReset(path)`).

**Interfaces — Produces:**
- `msgrows.ts`:
  - `export function msgHash(id: string): string` — `sha256Hex("agentglass/msg/v1|" + id).slice(0, 16)`.
  - `export function rowsDir(): string` — `join(cacheDir(), "msgrows")` (0700).
  - `export function rowsFile(path: string): string` — `join(rowsDir(), sha256Hex(path).slice(0, 16) + ".tsv")`.
  - `export interface MsgRow { h: string; key: number; d: string; hr: number; m: string; prov: string; n: number[] }` (`n` = `[in, out, cacheRead, write5m, write1h, usd, priced]`).
  - `export function tapOn(path: string): void` / `tapOff(): void` — while on, every Claude booking with an id appends one TSV line (`h key d hr m prov in out cr w5 w1 usd priced`) to the buffer of that path; `flushRows()` appends buffers to the files (called by the ledger's save path and by the snapshot writer).
  - `export function msgrowsReset(path: string): void` — truncate the file before `OWN.restart` re-reads.
  - `export function readRows(path: string, from: number): { rows: MsgRow[]; n: number; ok: boolean }` — rows from index `from`; `ok = false` when the file is missing or a line does not parse (caller re-reads the log with the tap on).
  - Only owned messages produce rows: the tap is called after `claim()` succeeded (`claude.ts:254`); a message that later moves to another file is removed by that file's `OWN.restart` reset + re-read.
- `snap.ts` (pure codec, used by writer, readers and checks):
  - `export const SNAP = "agentglass-snapshot/v1"`.
  - `export interface Snap { head: Obj; gen: string; base: string; full: boolean; sess: SessRow[]; own: { key: string; reset: boolean; rows: OwnRow[] }[]; gone: string[]; cost: Obj | null; allowance: Obj | null; done: boolean; err: string }`.
  - `export function snapLines(x: Snap): string[]`, `export function newSnapParse(): Snap`, `export function feedSnap(p: Snap, lines: string[]): void` (order and `end` counts per spec 12.1; a format major ≠ v1 → `err`).
  - `export function applySnap(cur: HostReport | null, own: Map<string, OwnRow[]>, x: Snap): HostReport` — `full` → replace; else apply `sess` replacements, `own` appends/resets, `gone` removals; sets `exact = true`.
  - `export function dayRows(a: Acc, days: string[]): DayRow[]` — from `Day.tp/hx(cp minus table-priced)/unk/um/uc/tools/turns` (spec 12.2).

- [ ] **Step 1: Failing check** `msgrows.check.ts`: a fixture HOME with one Claude log of 3 messages (2 models) + a copy of message 2 in a second log (later timestamp); `ledger` indexing with the tap on → log 1 has 3 rows, log 2 has 0 (message 2 owned by log 1); rows' `n` summed equal `accOf(log1)` tokens and cost; then make log 2's copy earlier (rewrite its timestamp) and re-index → log 1 has 2 rows after its `OWN.restart`, log 2 has 1; `msgHash("msg_x")` 16 hex and stable; a corrupt line → `readRows(...).ok === false`. Last line `msgrows: all checks passed`.
- [ ] **Step 2: Failing check** `snap.check.ts`: round trip `snapLines` → `feedSnap` (chunked) → deep-equal; missing `end` → not done; `applySnap` full then a delta with one replaced session, one own append, one gone → expected report; an own `reset` replaces rows. Last line `fleet snap: all checks passed`.
- [ ] **Step 3: Run** both → FAIL; implement (Task 0 open question 6: if the Booking path lacks the id, add the tap call next to `claim()` in `claude.ts` instead and note it); run → pass.
- [ ] **Step 4: Size check** on the dev box (isolated cache): index Claude history with the tap on, `du -sh $S/cache/msgrows` and `wc -l` total. Expected ≈ the distinct message count (235 k at spec time) and ≤ 15 MB. Record in the PR.
- [ ] **Step 5: Run** `sh scripts/check.sh` → all `ok`; `--json --limit 400` before/after: tokens and cost field-identical (the tap does not change booking).
- [ ] **Step 6: Commit** `feat(usage): per-message rows sidecar for owned Claude messages; snapshot codec`.

---

### Task 11: `fleet snapshot` writer with per-peer generations — wave 6, parallel with T12, T13, T15

**Files:** Create `src/features/fleet/snapshot.ts`, `src/features/fleet/snapshot.check.ts`; Modify `src/features/fleet/serve.ts` (`allowed()` accepts `fleet snapshot` with `--peer`/`--ack` 16 hex, `--full`, `--days`, `--redact`, and `fleet watch [--redact]`), `src/features/fleet/serve.check.ts`, `src/main.ts`.

**Interfaces — Produces:**
- `export interface PeerState { acked: Gen | null; pending: Gen | null }`, `export interface Gen { gen: string; sig: Map<string, string> /* key → size:mtime:ownN:ownSig */ }`.
- `export function peerFile(peer: string): string` — `~/.agentglass/fleet-peers/<peer>.json` (dir 0700, file 0600; peer must match `^[0-9a-f]{16}$|^drop$`).
- `export function baseFor(st: PeerState, ack: string, full: boolean): Gen | null` — spec 12.3.
- `export function buildSnap(days: number, base: Gen | null, now: number): { snap: Snap; next: Gen }` — candidates as `pullReport` (Task 3); a session goes out when its signature differs from `base`; own rows from `readRows(path, base ownN)` (re-read with the tap when `!ok`); `gone` = base keys not in the window; `gen` = 16 hex from `/dev/urandom` (read 8 bytes) — no `Math.random` for ids.
- `export function savePeer(peer: string, st: PeerState, next: Gen): void` — `pending = next` (atomic write; at most 16 peer files, the oldest by mtime deleted).
- CLI `fleet snapshot …` prints `snapLines` (EPIPE → exit 0) and saves the peer state only after the `end` line was written (a failed write leaves the state as it was).

- [ ] **Step 1: Failing check** `snapshot.check.ts` (fixture HOME, 3 sessions): first call (`ack ""`) → full, 3 sess, own rows for the Claude ones; second call with `ack = first.gen` → `base = first.gen`, 0 sess (nothing changed); append a line to one log → third call with `ack = second.gen` → 1 sess, its new own row only (state now: acked = second, pending = third); a fourth call again with `ack = second.gen` (the third was lost) → a delta relative to `second`: the same 1 sess and own row as the third; `ack = "ffffffffffffffff"` → full; a deleted log → `gone` holds its key; 17 peers → 16 files. Last line `fleet snapshot: all checks passed`.
- [ ] **Step 2: Failing cases** in `serve.check.ts`: `agentglass fleet snapshot --peer 00112233445566ff --ack 0011223344556677 --days 7` allowed; `--peer x` refused; `agentglass fleet watch --redact` allowed; `agentglass fleet drop /tmp` refused (drops run locally, never through serve).
- [ ] **Step 3: Run** → FAIL; implement; run → pass. `sh scripts/check.sh` → all `ok`.
- [ ] **Step 4: Commit** `feat(fleet): fleet snapshot — incremental snapshots with per-peer acknowledged generations`.

---

### Task 12: Snapshot feed on the viewer — wave 6, parallel with T11, T13, T15

**Files:** Modify `src/features/fleet/ssh.ts` (snapshot mode, `--peer`/`--ack`, fallback to pull), `src/features/fleet/store.ts` (current report + own rows per host persisted as a full snapshot file `k.snap` after each applied delta; `k.ack` = last applied generation), `src/features/fleet/ssh.check.ts`, `src/features/fleet/store.check.ts`.

**Interfaces — Produces:**
- `sshArgs(h, days, redact, cp, mode: "pull" | "snapshot", ack: string)` — snapshot: remote words `fleet snapshot --peer <hostId()> --ack <ack> --days N [--redact]`.
- The feed applies a finished snapshot with `applySnap`, writes `k.snap` (the merged state, `snapLines` of a full snapshot, 0600, atomic) and then `k.ack`; on start it loads `k.snap` as the current report and `k.ack` as the next request's ack.
- Fallback: a snapshot run that ends with code `old` (Task 5 `statusOf`) → this host uses `pull` for the rest of the process; `fleet status` shows `exact: no (update agentglass on <host>)`.
- A snapshot carries `own` rows in the report's `SessRow.own`; `report.exact = true`.

- [ ] **Step 1: Failing cases**: argv for snapshot mode (expected array written out); a fake-ssh process test that serves two consecutive snapshot outputs (full, then delta) → the feed's report equals `applySnap(applySnap(null, full), delta)`, `k.ack` holds the delta's gen; a cut delta (no `end`) → report unchanged, `k.ack` unchanged, next request acks the previous gen; `old` → pull mode.
- [ ] **Step 2: Run** → FAIL; implement; run → pass; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 3: Commit** `feat(fleet): snapshot feed — acknowledged deltas, persisted state, pull fallback`.

---

### Task 13: Exact merge, shadow ledger, re-pricing, time zones — wave 6, parallel with T11, T12, T15

**Files:** Create `src/features/fleet/merge.ts`, `src/features/fleet/merge.check.ts`; Modify `src/features/fleet/hosts.ts` (`fleetCost` from shadow entries when all contributing reports are exact; overlap `≈` only for non-exact hosts), `src/features/usage/summary.ts` (export a `sumDaysOf(accs: Acc[], days, harness)` variant of `sumDays`, `summary.ts:23`, that takes the entries instead of the ledger).

**Interfaces — Produces:**
- `export interface Occ { host: string; hostId: string; key: string; row: OwnRow }`.
- `export function ownerIndex(occs: Occ[]): Map<string, Occ>` — per `h` the occurrence with the smallest `row.key`, ties by `hostId`, then `key` (spec 13.2).
- `export function shadowOf(r: SessRow, shiftMin: number): Acc` — `newAcc()` filled from `DayRow`s: `tp` rows re-keyed `(day, hour)` shifted by `shiftMin` (whole hours, `Math.round(shiftMin / 60)`), `hx` into `cp`/cost, `unk`/`um`/`uc`, `tools`/`turns`; `bill`/`plan` from `r.s.billing`; `cp` provider modes from `r.prov`.
- `export function subtract(a: Acc, row: OwnRow, shiftMin: number): void` — removes one message's tokens and cost from the matching `tp` key (priced) or `unk`/`um` (unpriced), and from the day/acc totals; never below 0.
- `export function exactFleet(local: { path: string; rows: MsgRow[] }[], hosts: { name: string; hostId: string; r: HostReport; shiftMin: number }[], reprice: boolean): { accs: Acc[]; removed: number }` — builds shadows, runs `ownerIndex` over local rows (from `readRows` of local Claude logs) and remote own rows, subtracts every non-owner remote occurrence from its shadow and every non-owner local occurrence into a local correction entry (a negative-only shadow for that local session, so the local ledger stays untouched), re-prices shadows with `reprice(a)` (`record.ts:382`) when `reprice`.
- `hosts.ts`: `fleetCost` uses `sumDaysOf(localAccs ++ accs, …)` and the projection helpers when every fresh contributing report is exact; else Part A's sum with `approx`.

- [ ] **Step 1: Failing check** `merge.check.ts`: fixture A (host `ws`) with Claude session `s1` holding messages m1–m3; fixture B (host `vm1`) with `s9` holding copies of m2–m3 (later keys) + m4; local with none. Expected after `exactFleet`: total tokens = m1+m2+m3+m4 (computed by indexing one fixture HOME that holds both logs with the real ledger: the ground truth), cost likewise; `removed === 2`; swap keys (B earlier) → the A shadow loses m2–m3 instead, totals unchanged; tie → smaller hostId wins; local holding a copy of m1 with an earlier key → local keeps it, A's shadow loses it; `reprice` with a user price for the model changes the total cost by the expected amount; `shiftMin = 120` moves a 23:30 row into the next day. Last line `fleet merge: all checks passed`.
- [ ] **Step 2: Run** → FAIL; implement; run → pass; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 3: TUI/CLI effect**: `fleet cost --json` `approx` false and `overlap` 0 for exact hosts (Task 7's envelope gains `exact: true`); the Stats fleet line drops `≈` for them (Task 8's renderer reads `FleetCost.approx`).
- [ ] **Step 4: Commit** `feat(fleet): exact cross-host merge by hashed message ownership; fleet re-pricing and time zones`.

---

### Task 14: `dir` drops — wave 7

**Files:** Create `src/features/fleet/drop.ts`, `src/features/fleet/dirfeed.ts`, `src/features/fleet/drop.check.ts`; Modify `src/features/fleet/hosts.ts` (construct a `dirFeed` for `kind: "dir"` entries), `src/features/fleet/config.ts` (`dir` path validation: `~/` or absolute, ≤ 1024 chars).

**Interfaces — Produces:**
- `drop.ts`: CLI `fleet drop <dir> [--every <dur>] [--redact]` (`--every` 1m–24h): writes per spec 15.2 with `buildSnap(days, base, now)` and peer `drop`, gzip via `gzip()` (`src/util/gzip.ts:75`) + `writeBin`, `.tmp` then `renameSync`; base when no base exists, at the first run of a day, or when the deltas since the base exceed half its size; pruning after 24 h. Warns once when `--redact` is off and `<dir>` is outside `HOME`.
- `dirfeed.ts`: `export function dirFeed(h: HostCfg, f: FleetCfg): HostFeed` — `poll()` lists `<dir>` (`listDirCached`, 5 s), refuses files not owned by the user or group/world-writable (`OS.fileInfo`), reads the newest base + contiguous deltas (gunzip with `zlib.gunzipSync`; refuse > 256 MB by the ISIZE trailer, spec open question 8), applies with `applySnap`; a gap → keep the last complete state; no progress for an hour → rebuild from the newest base and set `err = "chain incomplete: rebuilt from the base of <time>"`; at most one file decompressed per tick.

- [ ] **Step 1: Failing check** `drop.check.ts`: writer into a temp dir three times with a changing fixture → 1 base + 2 deltas, names per pattern, all 0600; reader → report equals the writer's state; delete delta 1 → reader stays at the base state; a group-writable file → refused with a status; a file owned by root (skip when not root-capable: assert via a stubbed `OS.fileInfo`) → refused; pruning after a faked 25 h. Last line `fleet drop: all checks passed`.
- [ ] **Step 2: Run** → FAIL; implement; run → pass; `sh scripts/check.sh` → all `ok`.
- [ ] **Step 3: Commit** `feat(fleet): dir hosts — snapshot drops (base + deltas) for synced folders`.

---

### Task 15: `fleet watch` — wave 6, parallel with T11, T12, T13

**Files:** Create `src/features/fleet/watch.ts`, `src/features/fleet/watchfeed.ts`, `src/features/fleet/watch.check.ts`; Create or reuse `src/model/state.ts` (`sessState(s): { live; busy; attention; approval; stuck }` — if otlp-complete T4 created it, import it); Modify `src/features/cli.ts:241-333` (`watch()` gains a state-only mode: no event polling, rules on, a `Sink` that receives transitions — if otlp-complete T4 already added `Sink.alert`, reuse it), `src/features/fleet/tui.ts` (live rows override, notify), `src/main.ts`.

**Interfaces — Produces:**
- Remote: CLI `fleet watch [--redact]` → JSON lines per spec 16.1 (`hello`, `live`, `alert`, `turn`, `beat`), EPIPE → exit 0.
- Viewer: `export function watchFeed(h: HostCfg, cp: string): { start(now): void; poll(now): LiveRow[]; beatAt: number; stop(): void }` — detached `sh -c 'd=$1; k=$2; shift 2; exec "$@" >> "$d/$k.watch.jsonl" 2>> "$d/$k.watch.err"' sh <dir> <k> <ssh> <args… fleet watch>`; tail with a byte cursor (`readLines`, ≤ 256 lines per poll); restart with backoff 5 s → 5 min when the pid is gone; at 16 MB kill and restart into a truncated file; `stop()` kills our pid.
- `hosts.ts`: `LiveRow`s set `rlive`, `attention`, `stuck` on the host's rows; host live-fresh while `now − beatAt ≤ 90 s`; `turn` lines schedule the host's next snapshot in 5 s (≥ 10 s apart).
- `tui.ts`: alert lines toast; `critical` fire/escalate → `OS.notify` (respects `AGENTGLASS_NOTIFY=0`), once per `host|key|rule|since`.

- [ ] **Step 1: Failing check** `watch.check.ts`: the remote side with stub sessions and a fake clock: start → one `live` per live session; a busy→idle change → one `live`; 300 s → repeat; `beat` every 30 s; a stub rule transition → one `alert`. Viewer side: a file fed by the test → `poll()` returns the rows; a 16 MB file → restart requested; `beatAt` older than 90 s → rows not live; a `critical` alert calls the notify stub once, a repeat does not.
- [ ] **Step 2: Run** → FAIL; implement; run → pass.
- [ ] **Step 3: Cost** (open question 7): isolated `fleet watch` on the dev box for 10 min → `ps -o time=` ≤ 6 s; record.
- [ ] **Step 4: Run** `sh scripts/check.sh` → all `ok`.
- [ ] **Step 5: Commit** `feat(fleet): fleet watch — live state and alarms from remote hosts within seconds`.

---

### Task 16: Part B end-to-end, README — wave 8

**Files:** Modify `scripts/fleet.test.sh`, `README.md` ("Several machines (fleet)": exact merge, re-pricing, `dir` drops with a cron/systemd timer example, `fleet watch`), `CHANGELOG.md`.

- [ ] **Step 1: Extend `scripts/fleet.test.sh`**: hosts `h2`, `h3` serve `fleet snapshot` through the fake ssh; `h3` holds a copy of `h2`'s Claude history under a new session id (rewrite `sessionId` in the copied lines, keep message ids):
  - `fleet cost --json`: `.approx == false`, `.overlap == 0`, `.total.today` tokens equal to `cost --json` of a home that holds both logs (ground truth);
  - a second `fleet --refresh` sends a delta: the fake ssh logs the remote words; the second request carries `--ack <first gen>`;
  - a host forced to `snapshot: false` → `approx: true` again;
  - `fleet drop $t/drop` on `h2` + a `dir` entry in the viewer config → the same sessions as over ssh;
  - `fleet watch` through the fake ssh: make a fixture session "live" (a fake pid file as the existing live tests do, see `scripts/agent-mode.test.sh`) → the viewer's `fleet status --json` shows it live within 3 s.
- [ ] **Step 2: Run** `sh scripts/fleet.test.sh` and `sh scripts/check.sh` → no FAIL, all `ok`.
- [ ] **Step 3: README + CHANGELOG**; manual: `fleet snapshot` over real `ssh localhost` (Task 9 Step 4 wrapper), first full and second delta sizes recorded in the PR.
- [ ] **Step 4: Commit** `test(fleet): exact merge, deltas, dir drops and the live stream end to end; docs(readme): fleet Part B`.
