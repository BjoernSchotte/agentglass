# Fleet Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teams, rooms and members on top of fleet's snapshots: each device publishes per-room, sender-projected, sealed and signed snapshots into a team mailbox (a synced folder; phase 2 an `agentglass receive` relay) and reads the others'; invite codes, a one-screen consent, leave with a wipe request, key rotation on removal; a Team tab, `agentglass team …` CLI, filter keys `member`/`room`, display names bound to member keys and a signed activity log, the same data in the web UI (local-web-api), team commands from the browser as R3; phase 2 hub relay, wait data and an MCP `team` tool.

**Architecture:** `src/features/team/` — `crypto/` (vendored Monocypher 4.0.2 + `agcrypto.c` wrapper + `ffi.json`, bound by `crypto.ts`), `code.ts` (invite codes, ids), `policy.ts` (room scope, share policy, `teamRow()` projection), `manifest.ts` (signed public part + sealed private part, chain rules), `sealed.ts` (`agentglass-team/v1` file format), `keys.ts` (key store under `AGENTGLASS_TEAM_DIR`), `mailbox.ts` (layout, dir transport; phase 2 hub transport), `publish.ts` (room snapshots through `buildSnap(…, scope)`), `sync.ts` (admission, epochs, leave, publish, fetch), `feed.ts` (a `HostFeed` per room×member×device, room union, per-member exact merge), `cli.ts`, `tab.ts`. Fleet's `buildSnap()` gains a scope (selection, projection, ownership limit, changed-day deltas) and `applySnap()` merges `dd` day rows; fleet's own calls are unchanged (golden).

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build); C (Monocypher) through `scriptc --ffi`; checks are scriptc programs (`*.check.ts`), shell tests `scripts/*.test.sh` (POSIX sh, Python 3 for JSON asserts).

**Spec:** [spec.md](spec.md) — read it first, including "Measurements", "Decisions" and "Open questions". Also [../fleet/spec.md](../fleet/spec.md) sections 1, 12, 13, 15 and [../otlp-hub/spec.md](../otlp-hub/spec.md) sections 9–11 (phase 2).

**Cross-spec order:** fleet, otlp-hub, skill-usage, agent-wait (shipped); [local-web-api](../local-web-api/plan.md) is built with this plan slice by slice (table below); mcp-server merged before T14. No ledger `VERSION` bump (no cached data changes).

## Global Constraints

- Build `./build.sh`; tests `sh scripts/check.sh` (after each edit `sh scripts/check.sh --changed`); a task is done only when both pass. Single check: `C=$HOME/.cache/agentglass-agents/impl-fleet-teams; mkdir -p $C/home; scriptc build --optimization dev --strip [--ffi src/features/team/crypto/ffi.json] <f> -o $C/x && HOME=$C/home AGENTGLASS_NOTIFY=0 $C/x` (the `--ffi` part only for checks with `// check: crypto`).
- Builds, binaries and test mailboxes under `~/.cache/agentglass-agents/<agent-name>/`, never `/tmp` (RAM tmpfs) or the repo. One build at a time; `nice` heavy runs.
- Live runs only with the full isolation set written out literally, plus `AGENTGLASS_TEAM_DIR=$S/team`: `AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR=$S/cache AGENTGLASS_CONFIG=$S/config.json AGENTGLASS_RULES=$S/rules.json AGENTGLASS_RUN_DIR=$S/run AGENTGLASS_PALETTE_FILE=$S/palette.json AGENTGLASS_THEME_FILE=$S/theme AGENTGLASS_PRICES=$S/prices.json AGENTGLASS_OTLP_DIR=$S/otlp AGENTGLASS_FLEET_DIR=$S/fleet AGENTGLASS_HUB_DIR=$S/hub AGENTGLASS_TEAM_DIR=$S/team`. zsh does not split `$VAR`: write them inline or run via `bash -c`. `ls ~/.agentglass` before and after; it must not change.
- scriptc 0.1.7 limits: nominal typing (pass fields, not foreign interfaces); no `Record<string, RegExp>` (C backend); out-of-range array reads trap (`numAt`/bounds checks); SC2003 (no zero-parameter arrow for an optional interface member); no Unix-domain sockets; no `readlinkSync`; no `n.toString(radix)`. FFI: every function in a manifest passed to a build must be `declare`d in that program (a check that imports `crypto.ts` declares all of them; a build without the manifest compiles and throws on the first call). A `bytes` parameter is `(uint8_t *, size_t)` in C.
- **Secrets**: no key, invite secret or room key in argv, environment, logs, toasts, `--json`, error messages or plaintext files other than the 0600 key files; key buffers wiped with `ag_wipe` after use where they are not kept. Randomness only from `randomBytes()` (`src/util/rand.ts:8`), never `Math.random`.
- Every team file 0600, every team directory 0700 (`secureDir`, `src/features/palette/rundir.ts:17`); refuse to read keys from a non-private directory.
- **The sender decides**: selection and projection happen in `publish.ts` only; viewer code never receives or filters fields it should not have. Any new `jsonSess` field is dropped from team streams until added to `policy.ts` levels (the allowlist golden fails first).
- Fleet behaviour is a contract: `buildSnap(days, base, now)` without a scope produces byte-identical lines to before (Task 3 golden), `fleet drop`/`dirFeed`/`fleet snapshot` unchanged.
- Listeners in tests (phase 2) bind `127.0.0.1` port 0 only, killed by their own pid in `trap`.
- Commits: conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branches: integration branch `feat/fleet-teams` from `origin/main` in `../agentglass-fleet-teams`; parallel tasks in `../agentglass-fleet-teams-t<N>` on `feat/fleet-teams-t<N>`, merged back in task order. One PR per slice (shared with local-web-api's tasks of that slice).

## Slices (shared with local-web-api; parallel vs sequential)

Built together with [local-web-api](../local-web-api/plan.md), slice by slice (user decision 2026-10-10): each slice
goes read model → protocol/stream → TUI + web view → tests, and merges as one PR.

| Slice | After it, a member sees | local-web-api tasks | fleet-teams tasks |
|---|---|---|---|
| S1 | own live sessions in the browser (TUI unchanged) | W0, W1 → W2 → (W3 ∥ W4 ∥ W5) → W6 | T0; T1 ∥ T2 ∥ T3 (no UI yet, parallel with W1–W5) |
| S2 | a teammate: members, devices, cost, presence in the Team tab and on the web Team page | W7 | T4 → T5 → (T6 ∥ T7) → T16 → (T8a ∥ T9a) |
| S3 | breadth: Stats, Alerts, Fleet, Skills, Wait, events with kind filter, team groupings | W8, then W9 (viz, after research) | T9b |
| S4 | consent and sharing in TUI and browser: what I share, dry run, rename, leave, doctor, service, activity log | W10 | T8b ∥ T9c |
| S5 | commands from the browser (opt-in), audit, TUI toast | W11 → W12 | T17 |
| S6 | phase 2: hub relay, wait per room, MCP `team`, team server image + compose | W13 | T11 ∥ T13, then T12 ∥ T14 ∥ T18, then T19, then T15 |
| S7 | team server for enterprises: Helm chart, built-in OIDC, NetworkPolicy | W14 | T20 |

`∥` = parallel (separate worktrees), `→` = sequential. T10 (end-to-end, docs) runs at the end of S4 for phase 1.

Task splits for slicing: **T8a** (S2) = `team create`, `invite`, `join` with the consent screen (name, device label,
rooms; non-interactive flags; agent-mode refusal), `sync`, `report`, `sessions`, `status`; **T8b** (S4) = `share`
(add/remove/pause/level, `--dry-run`), `leave`, `remove`, `admin`, `admit`, `rooms`, `doctor`, `service`,
`rename-me`, `activity`. **T9a** (S2) = the Team tab with the member grouping, presence, header widget, filter key
`member`; **T9b** (S3) = groupings harness/repo/room/skill/model, `$/COMMIT`, room budget line, filter key `room`;
**T9c** (S4) = the `s` share panel, `l` activity overlay, `n` rename, `i` invite overlay, toasts. Each split keeps
the steps of its task restricted to its commands/keys; T8's test script grows per split.

## Review Focus

1. **Nothing outside the room and the member's choice leaves** (T2 projection golden, T3 selection, T5 publish): a session of another repo, a path-identity session, a pre-history session, a secret in a title, a cwd, a commit message — none in any sealed plaintext. T10 decrypts every file in the test mailbox and greps.
2. **Crypto use** (T1, T4): nonces random 24 bytes, never reused with a key; signature covers header incl. MAC; associated data binds the header; verification before decryption; length checks in C; no secret in logs/argv/`--json`.
3. **Manifest chain and admission** (T4, T6): a non-admin cannot produce a manifest a reader accepts; expired/used-up/wrong-secret invites refused; a device cannot join twice; removal rotates every room the member held.
4. **Exactness** (T7): copies between one member's devices count once; one session in two rooms counts once; the same session key in two members counts once; totals equal the sum of the senders' selected sessions.
5. **Fleet unchanged** (T3): scope-less `buildSnap` lines byte-equal; `applySnap` without `dd` unchanged.
6. **Consent UX** (T8): no publish before an explicit choice; agent mode without `--yes` exits 2 with the screen as JSON; `--dry-run` output equals the plaintext a publish seals.

---

### Task 0: Worktree and probes

**Files:** none committed; findings as `Ruling:` lines in the PR description.

- [ ] **Step 1: Worktree + build:** `git worktree add -b feat/fleet-teams ../agentglass-fleet-teams origin/main && cd ../agentglass-fleet-teams && AGENTGLASS_OUT=$C/agentglass nice ./build.sh`. Expected: success, `$C/agentglass --version` prints a version.
- [ ] **Step 2: Monocypher source:** `curl -sSL -o $C/mc.tgz https://monocypher.org/download/monocypher-4.0.2.tar.gz && tar xzf $C/mc.tgz -C $C && sha256sum $C/monocypher-4.0.2/src/monocypher.c $C/monocypher-4.0.2/src/monocypher.h`. Record both hashes in the PR (Task 1 copies these files unmodified and its check compares the hashes).
- [ ] **Step 3: Open question 2 (zero-length `bytes`):** probe `agcrypto.c` entry `int ag_len(uint8_t *p, size_t n) { return p == 0 ? -1 : (int)n; }`, call with `new Uint8Array(0)`. Expected: prints `-1` or `0`. Either way Task 1's wrapper never dereferences a pointer whose length is 0 (Ruling records which).
- [ ] **Step 4: Open question 4 (macOS sync roots):** on the macOS CI runner or a Mac: `ls -d ~/Library/CloudStorage/* ~/Library/Mobile\ Documents/com~apple~CloudDocs 2>/dev/null`. Record names; Task 8 Step 2 (sync-root detection) uses the list in spec section 3 plus any found.
- [ ] **Step 5:** if a probe contradicts the spec, write a `Ruling:` line and follow the measured behaviour.

---

### Task 1: Crypto through FFI (S1, parallel)

**Files:** Create `src/features/team/crypto/monocypher.c`, `monocypher.h` (unmodified 4.0.2), `LICENCE.monocypher.md`, `agcrypto.c`, `ffi.json`, `src/features/team/crypto.ts`, `src/features/team/crypto.check.ts`. Modify `build.sh:9-13`, `scripts/check.sh:14-16,76,134` (crypto marker + manifest), `scripts/build-tls.sh` (pass the manifest), `scripts/package.sh:9-10` (symbol guard), `README.md` licence section (Monocypher: 2-clause BSD / CC0, vendored unmodified).

**Interfaces — Produces** (`crypto.ts`; every function throws `Error("crypto: <what>")` on a wrapper error, never returns partial output):
```ts
export interface SignKeys { sk: Uint8Array /* 64 */; pk: Uint8Array /* 32 */ }
export interface BoxKeys { sk: Uint8Array /* 32 */; pk: Uint8Array /* 32 */ }
export function signKeys(seed32: Uint8Array): SignKeys;
export function sign(sk: Uint8Array, msg: Uint8Array): Uint8Array;                 // 64 bytes
export function verify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean;
export function boxKeys(sk32: Uint8Array): BoxKeys;
export function seal(pk: Uint8Array, msg: Uint8Array): Uint8Array;                 // eph pk 32 | nonce 24 | mac 16 | ct
export function sealOpen(keys: BoxKeys, box: Uint8Array): Uint8Array | null;
export function lock(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, msg: Uint8Array): { ct: Uint8Array; mac: Uint8Array };
export function unlock(key: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ct: Uint8Array, mac: Uint8Array): Uint8Array | null;
export function kdf(key: Uint8Array, label: string, n: number): Uint8Array;        // keyed BLAKE2b, n ≤ 64
export function hash16(b: Uint8Array): string;                                     // BLAKE2b-256 → first 16 hex
export function wipe(b: Uint8Array): void;
export function selfTest(): string;                                                // "" ok, else what failed (doctor)
export const CRYPTO_LIB = "monocypher 4.0.2";
```

- [ ] **Step 1: Failing check** `crypto.check.ts` (first line `// check: crypto`): RFC 7748 §5.2 X25519 vector (scalar `a546e36b…`, u `e6db6867…` → `c3da5537…`) through a test-only `ag_x25519(sk, pk, out)` entry; XChaCha20-Poly1305 vector from draft-irtf-cfrg-xchacha-03 A.3.1 (key `808182…9f`, nonce `404142…57`, ad `50515253c0c1c2c3c4c5c6c7`, the "Ladies and Gentlemen…" plaintext → ciphertext prefix `bd6d179d3e83d43b9576579493c0e939` and tag `c0875924c1c7987947deafd8780acf49`); EdDSA sign/verify round trip and a flipped bit in msg, sig and pk → false; seal/sealOpen round trip, wrong key → null; lock/unlock with a flipped byte in ct, mac, ad, nonce → null; a 0-length msg and ad; wrong-length key → throws `crypto:` (wrapper returned -2, output buffer unchanged); `sha256` of `monocypher.c`/`.h` equals the Task 0 hashes. Build: `scriptc build --optimization dev --strip --ffi src/features/team/crypto/ffi.json src/features/team/crypto.check.ts -o $C/x && $C/x`. Expected: FAIL (files missing).
- [ ] **Step 2: Wrapper** `agcrypto.c`: `#include "monocypher.c"`; entry points of spec section 8 with `(uint8_t *, size_t)` per `bytes`, explicit length checks first (-2, no write), no dereference when a length is 0 (Task 0 Step 3), `crypto_wipe` of stack secrets; `ag_seal`: ephemeral X25519 from caller-supplied 32 random bytes (TS passes `randomBytes(32)`; C has no RNG), shared = `crypto_x25519`, key = keyed BLAKE2b(shared, eph pk ‖ recipient pk), nonce from caller, `crypto_aead_lock`. `ffi.json` lists every entry with `bytes`/`i32` params, `"libraries": ["agcrypto.c"]`. Compile with warnings: `cc -fsyntax-only -Wall -Wextra -Werror src/features/team/crypto/agcrypto.c`. Expected: no output.
- [ ] **Step 3: `crypto.ts`**: `declare function` for every manifest entry; typed wrappers above; `selfTest()` runs one seal/open + sign/verify on fixed inputs.
- [ ] **Step 4: Build wiring:** `build.sh`: `ffi="--ffi ${AGENTGLASS_SRC:-src}/features/team/crypto/ffi.json"` always, plus the darwin manifest on Darwin (two `--ffi`, measured to work); `agentglass-mcp` build unchanged. `scripts/check.sh`: `CHECK_CRYPTO="--ffi $PWD/src/features/team/crypto/ffi.json"` on every OS, added to the `bin`/`release` builds and to checks with `^// check: crypto` (with `--backend c` on macOS like `// check: ffi`); a `cc:` job for `agcrypto.c` with `-Wall -Wextra -Werror` (as `libproc.c`). `scripts/build-tls.sh`: the same manifest. `scripts/package.sh`: `nm ./agentglass | grep -q ' T _\{0,1\}ag_lock$' || { echo "package.sh: $target binary has no team crypto (build.sh --ffi)" >&2; exit 1; }` for every target.
- [ ] **Step 5: Run:** the Step 1 build command. Expected: `crypto: all checks passed`. `sh scripts/check.sh`. Expected: all ok, including `cc:src/features/team/crypto/agcrypto.c`. `./build.sh && sh scripts/package.sh linux-x64 0.0.0-test` (in `$C`). Expected: archive written.
- [ ] **Step 6: macOS (Open question 1):** push the branch; CI's macOS jobs build with both manifests and `--backend c` on darwin-x64 (release dry run workflow: `gh workflow run release-dry-run.yml --ref feat/fleet-teams-t1`). Expected: green; record in the PR.
- [ ] **Step 7: Commit** `feat(team): Monocypher crypto through FFI on every target`.

---

### Task 2: Invite codes, ids, room scope, share policy, projection (S1, parallel; pure)

**Files:** Create `src/features/team/code.ts`, `src/features/team/policy.ts`, `src/features/team/code.check.ts`, `src/features/team/policy.check.ts`, `src/features/team/testdata/row-numbers.golden.json`, `row-titles.golden.json`.

**Interfaces — Produces:**
```ts
// code.ts
export interface Invite { v: number; team: string; invite: string; secret: Uint8Array /* 16 */; root: string /* 32 hex */; kind: "dir" | "hub"; where: string /* folder name or URL */ }
export function inviteCode(i: Invite): string;                       // "agt1-" + Crockford base32 + 2 check chars
export function parseInvite(code: string): { i: Invite | null; err: string };  // err names the first bad position
export function deviceId(team: string, hostId: string): string;     // sha256("agentglass/team/v1|"+team+"|"+hostId)[:16]
export function teamSessId(team: string, sessKey: string): string;  // sha256("agentglass/team/sess/v1|"+team+"|"+key)[:16]
// policy.ts
export interface Room { id: string; name: string; scope: string[]; level: "numbers" | "titles"; budgetUsd: number; epoch: number }
export interface RoomShare { room: string; on: boolean; repos: string[]; level: "numbers" | "titles"; since: number; paused: boolean }
export function scopeMatch(pattern: string, repoKey: string): boolean;   // repoKey without "git:"; * one segment, ** any
export function inScope(r: Room, sh: RoomShare, identKey: string, startedMs: number): boolean;
export function suggest(r: Room, sh: RoomShare, identKeys: string[]): string[];  // matching repos not yet chosen
export function teamRow(s: Obj, level: string, team: string): Obj;       // allowlist projection of a jsonSess object
export const LEVEL_FIELDS: Record<string, string[]>;                       // the allowlist, per level
```
(`teamSessId` uses `sha256Hex`, not crypto: no FFI needed in this task.)

- [ ] **Step 1: Failing checks.** `code.check.ts`: round trip for a dir and a hub invite; every single-character substitution at every position and every adjacent swap of a sample code → `err` non-empty naming a position; codes > 200 characters or with a URL that is not http(s) → err; `deviceId` deterministic, differs per team. `policy.check.ts`: `scopeMatch("github.com/acme/*","github.com/acme/api")` true, `…/acme/api/sub` false, `github.com/acme/**` true for both, case per `CI_HOSTS` (`src/model/project.ts:17`); `inScope` false for `path:/home/x`, for a repo not in `sh.repos`, for `startedMs < sh.since`, for `paused`; `suggest` lists only matching, unchosen keys; `teamRow` on a fixture `jsonSess` object with every field set (title with `sk-ant-api03-SECRET`, cwd, path, remote, branch, activity, stuck, alert messages, mux labels, git commits with messages and PR URLs, billing plan) equals the goldens byte for byte; a fixture with an unknown extra field `zzz` → dropped; `titles` title is secret-scrubbed (`scrubSecrets`, `src/util/secrets.ts:23`). Run: `scriptc build --optimization dev --strip src/features/team/policy.check.ts -o $C/x && $C/x`. Expected: FAIL.
- [ ] **Step 2: Implement** `code.ts` (Crockford alphabet, 2-character check = mod-1021 polynomial over symbols, hub URL validated like `urlErr`, `src/features/otlp/export.ts:81`) and `policy.ts` (levels exactly spec section 6; `skills` passed through as given — the publisher passes names already through `skillVis()`; `alerts` → rule ids only; `git` → `{produced, prs: count, costPerCommit}`; `repo` → `{key, label}`).
- [ ] **Step 3: Goldens:** write the two golden files from the spec's level lists by hand (not from output), then run. Expected: `policy: all checks passed`, `code: all checks passed`.
- [ ] **Step 4: Commit** `feat(team): invite codes, room scope and the field-level projection`.

---

### Task 3: Snapshot scope and changed-day deltas in fleet's builder (S1, parallel)

**Files:** Modify `src/features/fleet/snapshot.ts:133-211` (`buildSnap`), `src/features/fleet/snap.ts:43-60,101+` (`sessOut`/`sessIn`, `applySnap`), `src/features/fleet/snapshot.check.ts`, `src/features/fleet/snap.check.ts`; Create `src/features/fleet/testdata/snap-noscope.golden` (lines of a fixture build, generation ids normalised).

**Interfaces — Produces:**
```ts
export interface SnapScope {
  pass: (s: Sess) => boolean;          // selection (team: policy.inScope over identSync(s).key)
  row: (o: Obj) => Obj;                // projection of jsonSess/shortSess output (team: teamRow)
  head: (h: Obj) => Obj;               // head rewrite (device id, no hostName, room/epoch/member/level)
  ownAll: boolean;                     // false: ownership rows only for selected sessions (no "rest" sessions)
  dayDelta: boolean;                   // true: delta rows carry changed days only, "dd": true
  cost: boolean;                       // true: cost line = summary over selected sessions
  allowance: boolean;
}
export function buildSnap(days: number, base: Gen | null, now: number, scope: SnapScope | null = null): Built;
```
`Gen.sig` gains per-day keys `d:<sessKey>|<day>` (only written when `dayDelta`). `SessRow` gains `dd: boolean` (`fleet/model.ts:21-27`); `applySnap` with `dd` merges days by `d` into the existing row's days (a day present replaces that day; absent days stay), else replaces as today.

- [ ] **Step 1: Golden first:** with the current code, a fixture HOME (the existing `snapshot.check.ts` fixtures) → `snapLines(buildSnap(7, null, NOW).snap)` with `gen`/`base` replaced by `G` → write `snap-noscope.golden`; add the comparison to `snapshot.check.ts`. Run: Expected: pass (it describes today).
- [ ] **Step 2: Failing checks:** scope selecting one of two repos → only its `sess` and `own` lines, no `|*` lines (`ownAll: false`), the cost line equals `summary` over the selected sessions (compare `costUsd` sums); `row` applied (a field dropped by the scope is absent from every line); a second build with `base` after appending one message to a selected session today, `dayDelta: true` → its row carries only today's day row and `"dd":true`; `applySnap(base report, delta)` deep-equals `applySnap(base report, the same delta built with dayDelta false)` (days compared sorted). Expected: FAIL.
- [ ] **Step 3: Implement:** thread `scope` through `buildSnap` (`win`/`rest` filtering at `snapshot.ts:138-142`, `row` around `jsonSess(s)`/`shortSess(s)` at the row build, skip the `rest` loop when `!ownAll`, the cost line from a selection-aware `summary` variant — add `summaryOf(sess: Sess[])` beside `summary()` in `src/features/cost-cli.ts` (today `summary("")` covers the whole host, `snapshot.ts:20,208`); per-day sigs `sha256Hex(JSON.stringify(dayOut(d))).slice(0,16)`). `sessOut` writes `dd` only when true; `sessIn` reads it (default false).
- [ ] **Step 4: Run** `snapshot.check.ts`, `snap.check.ts`, `snapfeed.check.ts`, `drop.check.ts`, `merge.check.ts`. Expected: all pass, golden byte-equal. `sh scripts/check.sh --changed`. Expected: ok.
- [ ] **Step 5: Commit** `feat(fleet): snapshot scope and changed-day deltas (team streams; fleet unchanged)`.

---

### Task 4: Key store, manifest, sealed files (S2, first)

**Files:** Create `src/features/team/keys.ts`, `manifest.ts`, `sealed.ts`, and `keys.check.ts`, `manifest.check.ts`, `sealed.check.ts` (all `// check: crypto`).

**Interfaces — Produces:**
```ts
// keys.ts — AGENTGLASS_TEAM_DIR (default ~/.agentglass/team), 0700 dirs, 0600 files, refuse non-private
export function teamDir(): string;
export interface MemberKeys { id: string; sign: SignKeys; box: BoxKeys }
export function newMember(): MemberKeys;                          // ids: hash16(sign.pk)
export function saveMember(team: string, k: MemberKeys): string;  // "" ok, else why
export function loadMember(team: string): { k: MemberKeys | null; err: string };
export function saveRoomKey(team: string, room: string, epoch: number, key: Uint8Array): string;
export function roomKey(team: string, room: string, epoch: number): Uint8Array | null;
// manifest.ts
export interface MemberPub { id: string; signPk: string; boxPk: string; devices: string[]; admin: boolean; removedAt: number }
export interface InvitePub { id: string; verifier: string; expires: number; uses: number }
export interface Manifest { team: string; version: number; root: string; at: number; members: MemberPub[]; rooms: { id: string; epoch: number }[]; invites: InvitePub[]; priv: Uint8Array /* sealed private part */ }
export interface Private { name: string; names: Record<string, string>; rooms: Room[] }
export function signManifest(m: Manifest, k: MemberKeys): Uint8Array;            // the .agm file bytes
export function readManifest(b: Uint8Array, prev: Manifest | null): { m: Manifest | null; err: string };
export function openPrivate(m: Manifest, teamKey: Uint8Array): Private | null;
export function sealPrivate(p: Private, teamKey: Uint8Array): Uint8Array;
// sealed.ts
export interface Head { team: string; room: string; epoch: number; member: string; device: string; kind: string; n: number; gen: string; base: string; at: number }
export function sealFile(h: Head, plain: Uint8Array, roomKey: Uint8Array, k: MemberKeys): Uint8Array;
export function openFile(b: Uint8Array, m: Manifest, keyOf: (room: string, epoch: number) => Uint8Array | null): { h: Head | null; plain: Uint8Array | null; err: string };
```

- [ ] **Step 1: Failing checks.** `keys.check.ts`: save/load round trip; a 0755 team dir → `loadMember` err "not private"; file modes 0600. `manifest.check.ts`: v1 by root accepted with `prev` null only if `root` = signer; v2 signed by an admin of v1 accepted; v2 signed by a non-admin member → err; v3 signed by an admin removed in v2 → err; same version twice → the higher signer id; `prev` newer → err "older than"; tampered byte anywhere → err; private part opens with the team key, not with another. `sealed.check.ts`: round trip; signer not in manifest → err "unknown member"; device not the member's → err; removed member, `at` after removal → err, before → ok; wrong epoch key → err "no key for epoch"; flipped byte in header/ct/mac/sig → err; truncated → err; `plain` > 256 MB declared → refused before allocation. Build each with `--ffi src/features/team/crypto/ffi.json`. Expected: FAIL.
- [ ] **Step 2: Implement** per spec sections 5 and 7 (file layout `"AGT1" | u32 LE | header JSON | ct | sig`; AD = header JSON with `"mac":""`; signature over `"agentglass-team/v1|"` ‖ full header bytes; header schema strict: unknown keys → err). Manifest file: `"AGM1" | u32 | public JSON | priv bytes | sig` with signer id in the public JSON.
- [ ] **Step 3: Run** the three checks. Expected: `… all checks passed`.
- [ ] **Step 4: Commit** `feat(team): key store, signed manifest and sealed snapshot files`.

---

### Task 5: Mailbox (folder) and publish (S2, after T4)

**Files:** Create `src/features/team/mailbox.ts`, `publish.ts`, `mailbox.check.ts`, `publish.check.ts` (`// check: crypto`). Reuse `nextKind`/`prune` from `src/features/fleet/drop.ts:37-60` (export a variant taking a name parser if needed).

**Interfaces — Produces:**
```ts
export interface Mailbox { kind: string; list(dir: string): { name: string; size: number; at: number }[]; get(path: string, max: number): Uint8Array | null; put(path: string, b: Uint8Array): string; del(path: string): string; problem(): string }
export function dirMailbox(root: string): Mailbox;                 // tmp + rename, regular files only, layout names only
export const NAMES: { room: RegExp; join: RegExp; welcome: RegExp; key: RegExp; leave: RegExp; manifest: RegExp; invite: RegExp };
export function publishRoom(mb: Mailbox, team: string, room: Room, share: RoomShare, me: MemberKeys, device: string, now: number, dry: boolean): { name: string; bytes: number; plain: string[]; err: string };
```
`publishRoom` builds `buildSnap(days, base, now, scope)` with `scope.pass` = `inScope` over `identSync(s)`, `row` = `teamRow`, `head` per spec 6, `ownAll: false`, `dayDelta: true`, `cost: true`, `allowance` only for personal teams; peer state per room in `<teamDir>/<team>/state/<room>` (fleet's `PeerState` shape); `dry` returns `plain` and writes nothing.

- [ ] **Step 1: Failing checks.** `mailbox.check.ts`: put/get/list/del in a temp root; a `.sync-conflict-…` file and a `(conflicted copy)` file are not listed; a symlink is not listed; a tmp file never appears under its final name before rename. `publish.check.ts` (fixture HOME with two repos, one Claude and one Codex session each, the policy choosing one repo): first call writes `rooms/<room>/<member>-<device>.base-<gen>.agt`; `openFile` + gunzip → lines whose `sess` keys are only the chosen repo's, `own` lines only for those, head without hostName and with the device id; `dry: true` → `plain` equals those decrypted lines and nothing written; second call after a fixture append → a delta with `dd` rows; paused share → nothing written. Expected: FAIL.
- [ ] **Step 2: Implement.** Skill names through `skillVis()` before `teamRow` (the jsonSess object already applies it: `cli.ts:201`; assert in the check that a `skills.hide` `omit` skill does not appear).
- [ ] **Step 3: Run** both checks. Expected: pass. **Measure** on the fixture: bytes per base and per delta, printed by the check (record in the PR).
- [ ] **Step 4: Commit** `feat(team): folder mailbox and per-room sealed publishing`.

---

### Task 6: Sync — admission, epochs, leave (S2, parallel with T7)

**Files:** Create `src/features/team/sync.ts`, `src/features/team/state.ts` (team list, policy.json read/write), `sync.check.ts` (`// check: crypto`).

**Interfaces — Produces:**
```ts
export interface TeamState { id: string; mailbox: string; kind: string; me: MemberKeys; device: string; manifest: Manifest | null; priv: Private | null; policy: RoomShare[] }
export function loadTeams(): TeamState[];
export function createTeam(name: string, mailbox: string, rooms: Room[], personal: boolean, now: number): { t: TeamState | null; err: string };
export function makeInvite(t: TeamState, rooms: string[], uses: number, expiresMs: number, device: boolean, approve: boolean, now: number): { code: string; err: string };
export function readCard(code: Invite, mb: Mailbox): { card: Obj | null; err: string };       // the consent screen's data
export function requestJoin(code: Invite, mb: Mailbox, name: string, shares: RoomShare[], now: number): { t: TeamState | null; err: string };
export interface SyncOut { admitted: string[]; pending: string[]; published: string[]; fetched: number; removed: string[]; wiped: string[]; problems: string[] }
export function syncOnce(t: TeamState, now: number, dry: boolean): SyncOut;                    // admins: process join/remove; all: welcome, keys, leave notices, publish
export function removeMember(t: TeamState, member: string, now: number): string;
export function leaveTeam(t: TeamState, keep: boolean, now: number): string;
```

- [ ] **Step 1: Failing check** with two temp HOMEs (`AGENTGLASS_TEAM_DIR` switched between them inside the check) and one folder: A creates (room `backend` scope `github.com/acme/*`), invites (1 use, 1 h); B reads the card (names, rooms, scopes visible; no keys); B requests with `backend`; A `syncOnce` admits (manifest v2, `keys/backend/1/<B>.key`, `welcome/<B>-<dev>.key`); B `syncOnce` stores the team key and the room key and publishes; A's reader (T7 later; here `openFile`) opens B's base. Refusals: second use of the invite, expired invite (`now + 2h`), wrong secret (flip a byte of the request MAC), B's device joining again as C → "device already in the team"; `--approve` invite → request pending until `admit`. Removal: A removes B → manifest v3, `backend` epoch 2, B cannot open a file A writes after; A can still open B's epoch-1 files. Leave: C leaves → `leave/<C>.tomb` signed, C's room files deleted from the folder, A's next sync drops C's cached state and lists C in `wiped`; with `keep` no tomb. Expected: FAIL.
- [ ] **Step 2: Implement** per spec sections 3–5 (the TUI calls `syncOnce` from a slow job in Task 9; CLI in Task 8). Admission refuses when the manifest would exceed 64 devices or 16 rooms.
- [ ] **Step 3: Run.** Expected: `sync: all checks passed`.
- [ ] **Step 4: Commit** `feat(team): admission, key epochs, removal and leave`.

---

### Task 7: Viewer feeds, room union, per-member merge, bench (S2, parallel with T6)

**Files:** Create `src/features/team/feed.ts`, `src/features/team/view.ts`, `feed.check.ts`, `bench.check.ts` (`// check: crypto`, `// check: timing`). Modify `src/features/fleet/hosts.ts` only to export what `exactMerge`/`fleetCost` need for synthetic `RemoteHost`s (no behaviour change).

**Interfaces — Produces:**
```ts
export function teamFeed(t: TeamState, room: string, member: string, device: string, lines: number): HostFeed;   // kind "team"
export interface TeamView { team: string; room: string; at: number; members: { id: string; name: string; devices: { id: string; online: boolean; at: number; live: number; attention: number; stuck: number }[] }[];
  sessions: Sess[]; cost: FleetCost | null; skipped: { file: string; why: string }[]; truncated: number }
export function buildView(t: TeamState, room: string, now: number): TeamView;   // room "" = all rooms
export function viewTick(until: number): boolean;                                // sliced, like mergeTick (hosts.ts:302)
```

- [ ] **Step 1: Failing checks** (`feed.check.ts`, fixture mailbox written with T5's `publishRoom` from fixture HOMEs): B's chain base + 2 deltas → one report equal to a fresh base built at the end; a gap waits; a forged file is skipped with its reason in `skipped`; **room union**: B's session in both rooms → once in the all-rooms view, its days merged; **per-member merge**: the same Claude log copied between B's two devices → tokens counted once (as `merge.check.ts` does for hosts); the same session key from B and C → once; totals = sum of the senders' selected sessions; my own other device's rows flagged `mine` (for T9). `bench.check.ts`: synthesise 10 members × 3 devices × 300 sessions (Claude rows with distinct hashes, 30 days) sealed in a temp mailbox, then `buildView` all rooms; print time and `process.memoryUsage().rss`; assert ≤ 5 s and ≤ 400 MB on CI (adjust only with a recorded measurement). Expected: FAIL.
- [ ] **Step 2: Implement:** feeds reuse `dirFeed`'s chain walk (`src/features/fleet/dirfeed.ts:53-78`) through a decrypting reader; members merged one at a time through `exactMerge` with a member's devices as `RemoteHost`s, results summed with a session-key join across members; caps: 64 devices (newest `at` first), 16 rooms, `truncated` counts the rest.
- [ ] **Step 3: Run.** Expected: both pass; record bench numbers. **Open question 5:** run the TUI steady-state measurement once with 30 streams from `hosts30r`-style data of the measuring machine (spec Measurements) and record RSS; if > 150 MB above local, drop other members' ownership rows after their member merge (and re-measure).
- [ ] **Step 4: Commit** `feat(team): team feeds, room union and per-member exact merge`.

---

### Task 8: CLI (T8a in S2, T8b in S4; parallel with T9a / T9c)

**Files:** Create `src/features/team/cli.ts`, `src/features/team/consent.ts` (the join screen: TTY render + key loop + JSON form), `src/features/team/doctor.ts`, `src/features/team/service.ts`; `scripts/team.test.sh`; Modify `src/main.ts` (import `./features/team/cli.ts` beside fleet's), `src/features/clihelp.ts` (help entries), `docs/cli-contract.md` (team JSON shapes).

**Interfaces — Produces:** the commands of spec section 2 through `addCmd()`/`rec()` (as `src/features/fleet/cli.ts:356-394`), each with `--json`; `team report --json` and `team sessions --json` shapes of spec 11, `team status --json` = `{teams: [{id, name, mailbox, kind, me: {id, name, device}, admin, rooms: [{id, name, scope, level, epoch, budget, share: {on, repos, level, since, paused, lastPublishAt, lastBytes}}], members: [...], pending: n, problems: [...]}]}`.

- [ ] **Step 1: Failing test** `scripts/team.test.sh` (items 1–4 in T8a; 5–8 and the `rename-me`/`activity` cases in T8b) (uses `AGENTGLASS_BIN`; two temp HOMEs A and B with fixture sessions in `github.com/acme/api` and `github.com/acme/secret`, full isolation set per HOME, one temp folder):
  1. A: `team create acme --dir $F --room backend=github.com/acme/api --json` → `ok`, `invite` code present.
  2. B: `team join $CODE --dir $F --name bob --json` (agent mode, no `--yes`) → exit 2, JSON screen lists room `backend`, `you have` contains `github.com/acme/api`, not `secret`.
  3. B: `team join $CODE --dir $F --name bob --share backend --dry-run --json` → `plain` lines; none contains `secret`, `/home/`, a title (level numbers).
  4. B: `… --share backend --yes` then A: `team sync`, B: `team sync`, A: `team report --by member --json` → rows for `bob` with B's api session cost; `team sessions --member bob --json` → only api sessions, no `cwd`/`title` keys.
  5. A decrypts every file under `$F/rooms` through a hidden check helper (`team doctor --verify-files --json` lists opened files and counts) and greps the plaintext for `secret`: none.
  6. B: `team share --pause --room backend`, `team sync` → no new file; `--resume` → a delta.
  7. B: `team leave --yes` → `$F/rooms/*/<bob>-*` gone, `leave/<bob>.tomb` present; A: `team sync` then `team report --json` → no `bob` rows.
  8. `team doctor --json` with a `x.sync-conflict-1.agt` file and one admin → findings `conflict-copy`, `single-admin`.
  Expected: FAIL (command unknown).
- [ ] **Step 2: Implement** commands; sync-root detection list (spec 3, plus Task 0 Step 4 names); consent screen exactly spec section 3 at 80 columns (space toggles, `d` dry run into `$PAGER`, enter, esc); agent-mode refusal; `team service` prints the unit/plist, `--write` installs after `[y/N]` (`systemctl --user enable --now agentglass-team.service` / `launchctl bootstrap gui/$UID …`), never without a TTY confirmation or `--yes`; doctor checks: mailbox exists/writable/private, sync conflict copies, unknown names, manifest chain, single admin with ≥ 3 members, key dir modes, clock skew (from newest peer files' `at` vs mtime), crypto `selfTest()`, last publish age per room, folder outside `$HOME` notes.
- [ ] **Step 3: Run** `sh scripts/team.test.sh` with `AGENTGLASS_BIN=$C/agentglass`. Expected: `team.test.sh: ok`. `sh scripts/check.sh`. Expected: all ok (CLI contract golden updated deliberately).
- [ ] **Step 4: Commit** `feat(team): team CLI — create, invite, join with consent, share, report, leave, doctor, service`.

---

### Task 9: Team tab, filter keys, my devices in Sessions (T9a S2, T9b S3, T9c S4)

**Files:** Create `src/features/team/tab.ts`, `tab.check.ts`; Modify `src/main.ts` (import after `./features/wait/tab.ts`, so the tab is 6th), `src/features/query/attrs.ts` (keys `member`, `room` after `host`, `attrs.ts:80`), `src/ui/help.ts` (Team section), `src/features/fleet/hosts.ts` (my devices' team rows join `FLEET.hosts` as `kind: "team"` hosts with the device name, deduplicated against `fleet.hosts` by device id).

**Interfaces — Consumes:** `buildView`, `viewTick`, `syncOnce`, `loadTeams`. **Produces:** `H.tabs.push(TEAM_TAB)` only when `loadTeams().length > 0` (re-checked on the slow job); a slow job (60 s) calling `syncOnce` then `buildView` sliced; header widget `team ●n`.

- [ ] **Step 1: Failing check** `tab.check.ts` (fixture `TeamView`): 80-column render equals the spec section 10 layout (members, devices `n/m`, `●`/`◆`/`⚠`/`○ age`, today/week, `$/COMMIT`, top harness with share, skills count, budget line, footer keys); `b` cycles member → harness → repo → room → skill → model; `d/w/m/a` periods; `↵` opens the group's read-only session rows (no `s`/`R` actions offered); `s` share panel lists rooms with repos, level, since, last publish and handles `space` (pause), `a`, `x`, `d`; `i` invite overlay shown only for admins; `?` help has a Team section; footer at 80 columns lists `d w m a · b · ↵ · s · i`. Filter: `member is bob` and `room is backend` compile; in the Sessions list `member is me` matches local rows. Expected: FAIL.
- [ ] **Step 2: Implement.** Toasts per spec 10 (join request, new matching repo, member left/removed, budget once a day via `budgetState`, `src/features/usage/costs.ts:161`, plus `OS.notify` unless `AGENTGLASS_NOTIFY=0`, mailbox problem once).
- [ ] **Step 3: Run** `tab.check.ts`, `src/ui/footer.check.ts`, `src/features/query/*.check.ts`. Expected: pass. One live TUI in tmux with the isolation set and the T8 test's two HOMEs (A's view), `6` → the tab renders; capture `tmux capture-pane -p` into the PR; kill the tmux session by name.
- [ ] **Step 4: Commit** `feat(team): Team tab, member/room filter keys, my devices in the Sessions list`.

---

### Task 10: End-to-end, docs, real-life verification (end of S4, alone)

**Files:** Modify `README.md` (Teams section: create/invite/join/leave in four commands, Syncthing recipe incl. `.stignore` for `.*.tmp` if Task 0/Open question 3 requires it, privacy statement, metadata visible to the mailbox, keys without passphrase), `docs/cli-contract.md`, `specs/ROADMAP.md` (status), `specs/fleet-teams/spec.md` (Rulings folded into Decisions/Open questions).

- [ ] **Step 1:** Two isolated HOMEs on this machine with the real local sessions in A only (read-only use of the logs; no agent is started or prompted), folder under `$C`: create → invite → join (B with fixture sessions) → both `team sync` → A `team report --by harness --json`. Record times (create, join to first view), base/delta sizes per room, and compare with spec Measurements.
- [ ] **Step 2:** Decrypt-and-grep the whole folder (Task 8 Step 1.5 helper) for A's home path, hostname, any title (level numbers): none. Expected: 0 hits.
- [ ] **Step 3:** `ls ~/.agentglass` unchanged; remove `$C` test data.
- [ ] **Step 4:** Docs; PR description lists Rulings, measurements, and the phase-2 follow-up.
- [ ] **Step 5: Commit** `docs(team): teams in README, CLI contract, roadmap status`.

---

---

### Task 16: Display names and the activity log (S2, after T6 ∥ T7)

**Files:** Create `src/features/team/names.ts`, `src/features/team/activity.ts`, `names.check.ts`, `activity.check.ts` (`// check: crypto`); Modify `sync.ts` (publish my claim at join and on rename; read claims and member events), `consent.ts` (name + device-label fields, default from `git config --global user.name`), `src/features/redact.ts` (`fakeMember`, `fakeDevice` on the `fakeAgent` pattern, `redact.ts:152`).

**Interfaces — Produces:**
```ts
export interface NameClaim { member: string; name: string; devices: Record<string, string>; seq: number; at: number }
export function signClaim(c: NameClaim, k: MemberKeys, teamKey: Uint8Array): Uint8Array;
export function readClaim(b: Uint8Array, m: Manifest, teamKey: Uint8Array): { c: NameClaim | null; err: string };
export function displayNames(m: Manifest, claims: NameClaim[]): Map<string, string>;   // collisions → "anna·3f2a"
export interface Act { at: number; actor: string; kind: string; room: string; text: string }   // kind: joined|left|removed|renamed|shares|paused|resumed|room|rotated|admin
export function activity(t: TeamState, since: number): Act[];
```

- [ ] **Step 1: Failing checks:** a claim signed by another member → `err "not signed by member"`; seq 2 beats seq 1, an older seq after a newer one is ignored; two `Anna`s → `Anna` (earlier manifest order) and `Anna·<4 hex>`; a rename changes the name on past rows (attribution by id); `--redact` (`AGENTGLASS_REDACT=1`) → stable fakes for names and labels; activity from a fixture history (join, share on, pause, rename, removal, rotation) renders the spec 5a lines in time order; a forged `activity/` file is dropped; a 91-day-old event is gone. Grep check: build a fleet snapshot and an OTLP export dry run on the fixture → no member name. Expected: FAIL.
- [ ] **Step 2: Implement. Step 3: Run.** Expected: pass. **Step 4: Commit** `feat(team): display names bound to member keys and the activity log`.

### Task 17: Team commands through the command channel (S5, after local-web-api W11)

**Files:** Modify `src/serve/cmd.ts` (R3 commands `team.join`, `team.share`, `team.leave`, `team.invite`, `team.renameMe` calling `sync.ts`/`state.ts`; the confirm summary = the consent preview object of `readCard`/`team share --dry-run`), `packages/api-contract/schema/command-team-*.json`, `packages/web/src/routes/team/*` (join/share/leave dialogs showing the preview).

- [ ] **Step 1: Failing check:** read-only → `read_only`; `team.share {room, add: [repo]}` → `confirm` whose summary lists the repo, level, recipients by name and history start → `confirm` → policy changed, next publish includes it; `team.leave` summary carries the honest wipe sentence; invariant: no team command writes into another member's mailbox paths or names another member's device; a command whose target is a team member's session → `remote_session`. Web test: the share dialog renders the preview verbatim. Expected: FAIL.
- [ ] **Step 2: Implement. Step 3: Run** with W11/W12's suites. **Step 4: Commit** `feat(team): team commands from the web with consent previews`.

## Phase 2

### Task 11: Hub relay routes on `agentglass receive` (S6, parallel with T13)

**Files:** Create `src/features/hub/team.ts`, `team.check.ts` (`// check: crypto`); Modify `src/features/hub/server.ts:204-230` (route `/team/v1/` before the OTLP paths), `src/features/hub/config.ts` (`receive.team.enabled`, `receive.team.maxMB` default 2048), `src/features/hub/tokens.ts` (token flag `team`: `agentglass receive token add <name> --team`), `src/features/hub/store.ts` (team tree under the disk budget and retention).

**Interfaces — Produces:** `handleTeam(rt, req, res, path, method)`; auth per spec 13 (`AGT` signed requests against the newest valid public manifest the hub holds per team; `AGI` invite proofs for `GET invites/<id>.card` and `PUT join/…`; `Bearer` hub token only for the first `PUT manifest/1.agm` of a new team id, binding it).

- [ ] **Step 1: Failing check** (in-process handler, no listener): new team with a team token → bound; a second v1 for the same id → 409; member B `PUT rooms/<r>/<B>-<d>.base-….agt` ok, `PUT rooms/<r>/<C>-…` → 403; removed member `GET` → 403; current member `GET` listing → names, sizes, mtimes; time 6 min off → 401 with the skew; invite proof wrong/expired → 401; body over limit → 413; team over `maxMB` → 507 with `Retry-After`. Expected: FAIL.
- [ ] **Step 2: Implement**; `scripts/hub-team.test.sh`: `agentglass receive --listen 127.0.0.1:0 --team` with the port written to a file, curl checks of the status codes above, killed by pid in `trap`.
- [ ] **Step 3: Run** both. Expected: pass. **Step 4: Commit** `feat(hub): team mailbox relay with signed requests`.

### Task 12: Hub mailbox client and join over a hub (S6, parallel with T14)

**Files:** Modify `src/features/team/mailbox.ts` (`hubMailbox(url, signer)` via the existing curl-config HTTP path, `src/util/http.ts`, and the TLS settings of `otlp.tls`), `src/features/team/cli.ts` (`--hub`), `scripts/team.test.sh` (a hub variant).

- [ ] **Step 1: Failing test:** `team create acme --hub http://127.0.0.1:$PORT` (with a team token from `receive token add acme --team`, passed via stdin or a 0600 file, never argv) → invite code holds the URL; B `team join $CODE --share backend --yes` with no `--dir` → admitted, published; A sees B; A `team remove bob` → B's `GET` → 403 and B's `team doctor` says "removed from acme". Expected: FAIL.
- [ ] **Step 2: Implement** (listing cached per sync; files cached sealed under `<teamDir>/<team>/cache/`; `del` for own files on leave). **Step 3: Run.** Expected: `team.test.sh: ok (dir, hub)`. **Step 4: Commit** `feat(team): hub mailbox — join with one code`.

### Task 13: Wait data in team streams (S6, parallel with T11)

**Files:** Modify `src/features/team/publish.ts` (a `wait` line: the device's `wait --json` object over the room's selection, families/kinds only, the hook `PULL_WAIT` of `src/features/fleet/pull.ts:33-46` with a session predicate), `src/features/fleet/snap.ts` (parse `wait` lines into `HostReport.wait`), `src/features/team/view.ts`, `src/features/team/tab.ts` (`b` adds `wait`).

- [ ] **Step 1: Failing check:** a fixture with `pnpm test` calls in a selected session and `make deploy` in an unselected one → the wait line has `pnpm test`, not `make deploy`, and no command line text; the tab's wait grouping shows p50/p95 per member. Expected: FAIL. **Step 2: Implement. Step 3: Run.** Expected: pass. **Step 4: Commit** `feat(team): wait families per room`.

### Task 14: MCP `team` tool (S6)

**Files:** Modify `src/mcp/tools.ts` (tool `team` after `fleet`, `tools.ts:121`), `src/mcp/tools.check.ts`, the golden `tools/list`, `docs/cli-contract.md`.

- [ ] **Step 1: Failing check:** `tools/list` contains `team` with its schema; a call maps to `agentglass team report --json --room <the calling session's repo's room>` in agent mode; without a team → a clear "no team" result, not an error; size cap and cursor as the other tools; `numbers` rooms never return titles. Expected: FAIL. **Step 2: Implement. Step 3: Run** `src/mcp/*.check.ts`. Expected: pass. **Step 4: Commit** `feat(mcp): team tool`.

### Task 18: Server members and `--no-local` engine (S6, after T12)

**Files:** Modify `src/features/team/manifest.ts` (member kind `server`), `code.ts` (`--server` invites), `sync.ts`, `cli.ts` (`team invite --server`, `team join --server`, `team link-web <code>`, `team link-web --revoke <member>`), `src/serve/main.ts` (`--no-local`: no discovery/process scan; team feeds only), `consent.ts` (the "visible on the team server <label>" line), `activity.ts`; Create `src/features/team/link.ts` (+ check).

- [ ] **Step 1: Failing checks:** a server invite admits a `server` member that receives only the granted rooms' keys and publishes nothing; it never appears in member groupings or counts; `team remove` of the server rotates its rooms; a member's consent screen for a room granted to a server lists it; `link-web` signs `{code, member, server}`, a claim signed by another key or for another server is ignored, `--revoke` by an admin removes the binding; `serve --stdio --no-local` on a fixture HOME with local sessions returns none of them and no process data. Expected: FAIL. **Step 2: Implement. Step 3: Run. Step 4: Commit** `feat(team): server members, web links and a team-only engine`.

### Task 19: Team server image, compose, CI (S6, after T18 and local-web-api W13)

**Files:** Create `deploy/docker/Dockerfile` (multi-arch, `FROM gcr.io/distroless/cc-debian12:nonroot`, `COPY` of the release binaries per `TARGETARCH` with checksum verification in a builder stage, `USER 65532`, `ENTRYPOINT` none: commands per service), `deploy/compose/{compose.yaml,Caddyfile,.env.example,README.md}` (embedded as templates by `src/features/team/serverinit.ts`: `team server init`), `.github/workflows/image.yml` (buildx, GHCR push on release, `--sbom=true --provenance=mode=max`, `actions/attest-build-provenance`), `.github/dependabot.yml` (`docker` for `deploy/docker`), `scripts/image.test.sh`.

- [ ] **Step 1: Failing test** `scripts/image.test.sh` (Docker required; skipped with a notice where absent, never on CI): build the image for the host arch from `$C` binaries; `docker run --rm --read-only --cap-drop ALL <img> agentglass --version` and `agentglass-web --version` → versions; `docker run --rm <img> sh` → fails (no shell); `ldd`-equivalent check passed at build (Open question 6); compose up (relay + web, no Caddy) with a temp volume → `curl -fsS http://127.0.0.1:<port>/healthz` → `ok`; container user 65532; root filesystem read-only (a write outside `/data` and `/tmp` fails in the healthcheck's self-test). Expected: FAIL.
- [ ] **Step 1b: Failing check** `serverinit.check.ts`: `team server init --dir <tmp>` writes exactly the four files with the image digest of this version and OIDC placeholders, mode 0600 for `.env.example`'s copy only when `--env` is given, refuses existing files without `--force`, spawns no process (a fake `docker` on PATH records zero calls). Expected: FAIL.
- [ ] **Step 2: Implement**; CI job: buildx for both arches on release tags and PRs touching `deploy/` (push only on tags), smoke steps of Step 1, SBOM + attestation on push.
- [ ] **Step 3: Measure and record** (spec 16): compressed image size per arch, idle RSS of both processes with 0 and 3 users, the team bench (T7 synthetic mailbox mounted) RSS and first-view time, relay upload throughput. **Step 4: Commit** `feat(deploy): team server image and compose`.

### Task 20: Helm chart and OIDC hardening (S7, after T19 and local-web-api W14)

**Files:** Create `deploy/helm/agentglass-team-server/{Chart.yaml,values.yaml,values.schema.json,templates/*.yaml,templates/tests/healthz.yaml,README.md}`, `.github/workflows/helm.yml` (`helm lint`, `kubeconform -strict`, `ct install` into `kind`, OCI push to GHCR on release with attestation), Dependabot `helm` entry.

- [ ] **Step 1: Failing checks:** `helm template` with defaults → Deployment replicas 1, `Recreate`, two containers, PVC, `runAsNonRoot`, `readOnlyRootFilesystem`, `capabilities.drop: [ALL]`, seccomp `RuntimeDefault`, NetworkPolicy ingress only from the configured ingress namespace and egress only to DNS + OIDC issuer; values schema rejects a missing `oidc.issuer` when `auth.mode=oidc`; `ct install` in kind → the test hook's `/healthz` passes. Expected: FAIL. **Step 2: Implement. Step 3: Run** in CI (kind) and once locally if a kind cluster can be created within the resource budget. **Step 4: Commit** `feat(deploy): Helm chart for the team server`.

### Task 15: Phase 2 end-to-end and docs (S6, alone)

- [ ] **Step 1:** Hub over `tailscale serve` documented (no live tailnet test in CI); local end-to-end with receive on 127.0.0.1 port 0 and two HOMEs; record join-to-first-view time.
- [ ] **Step 2:** README hub section, `docs/cli-contract.md`, ROADMAP status. **Step 3: Commit** `docs(team): hub relay, wait and MCP`.
