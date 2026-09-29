# Release management — spec

Status: **draft for review** (2026-09-29). Design agreed in conversation; plan follows after approval.

## Goal

agentglass ships as prebuilt native binaries on two channels:

- **stable** — calendar-versioned releases cut on demand (`2026.10.1`).
- **dev** — a daily build of `main` (only when `main` changed and CI is green).

Users install via Homebrew (`bjoernschotte/tap`), a one-line `install.sh`, or from source, and update with
`agentglass update` (modelled on `openclaw update`). The release process borrows from OpenClaw and from the
maintainer's atlcli project (same tap, same artifact naming, same dev-tag scheme) so one pattern is maintained.

## Background

- Today: version `0.1.0` hard-coded in `src/features/cli.ts`; no tags, no GitHub releases, no CI; install = git
  clone + `./build.sh` (Node 24 + scriptc + clang).
- OpenClaw (analysed 2026-09-29, `~/code/try/openclaw` at 2026.9.6): `YYYY.M.P` with P a per-month counter (moved
  away from day-of-month), betas `-beta.N`, channels stable/beta/extended-stable/dev, no published nightlies,
  `openclaw update --channel …` with downgrade protection. Pitfalls it hit and we avoid: `-N` suffixes sort
  before the final in semver; changing the scheme mid-life; tag floods (alpha tags, `release-publish/*`
  markers); releases visible before every platform artifact exists; sorting "latest" by date.
- atlcli (`BjoernSchotte/atlcli`) + `BjoernSchotte/homebrew-tap`: tag push `v*` → release; daily dev release
  (cron + dispatch) as immutable prerelease `dev-YYYYMMDD.<run>.<attempt>-<sha8>`; formulae `atlcli` and
  `atlcli-dev` (conflicting); tap workflows "Update Formula" (generic inputs) and "Update Dev Formula"
  (hard-wired to atlcli); runners `ubuntu-22.04`, `ubuntu-22.04-arm`, `macos-15-intel`, `macos-14`.

## Decisions

### 1. Versions and build metadata
- **Stable version** `YYYY.M.N`, no zero padding, N = release counter within the month starting at 1 (`2026.9.1`,
  `2026.9.2`, `2026.10.1`). Git tag `v<version>`, annotated, immutable (never moved, deleted or reused).
- **Dev release tag** `dev-YYYYMMDD.<run_number>.<run_attempt>-<sha8>` (UTC date), GitHub prerelease, immutable.
  **Dev version** reported by the binary: `<last stable>-dev.<YYYYMMDD>.<run_number>+<sha8>`
  (e.g. `2026.10.1-dev.20261005.12+a1b2c3d4`); before the first stable the base is `0.0.0`.
- **Local builds**: channel `local`, version `<last stable or 0.0.0>-local+<sha8>[-dirty]` from `git describe`.
- **Source of truth is the tag.** `build.sh` generates git-ignored `src/build-info.ts`
  (`VERSION`, `CHANNEL`, `COMMIT`, `BUILD_DATE`, `PLATFORM`) from env vars `AGENTGLASS_VERSION`,
  `AGENTGLASS_CHANNEL`, `AGENTGLASS_COMMIT` set by CI, or from git for local builds. The hard-coded `VERSION` in
  `src/features/cli.ts` goes away.
- **Output**: `agentglass --version` → the bare version (scripts, Homebrew tests);
  `agentglass --version --json` → `{version, channel, commit, date, platform, installMethod}`;
  `--help` header → `agentglass 2026.10.1 (stable, a1b2c3d4, linux-x64)`.
- **Comparison** is our own function over the tuple (year, month, N, channel rank, dev date, dev run), never
  a semver library and never by date. Invalid strings do not compare as newer than anything.

### 2. CI and the dev channel
- **`ci.yml`** on every push and PR: build + all `src/**/*.check.ts` + smoke (`--version`, `--version --json`,
  `--json --limit 1`) on `ubuntu-22.04` and `macos-14`.
- **`dev-release.yml`**: cron daily (02:43 UTC) + `workflow_dispatch` (optional `source_sha`, `force`).
  Skips when `main` equals the newest dev release's commit (unless `force`) or when `ci.yml` on that commit is
  not green. Builds the 4-platform matrix (below), creates the release as a **draft**, uploads
  `agentglass-<os>-<arch>.tar.gz` ×4 + `SHA256SUMS` + `build-metadata.json`, verifies all 6 assets, then
  publishes it as **prerelease**, then dispatches the tap's `update-agentglass-dev.yml`.
- **Retention**: after each dev release, delete dev releases (and their tags) beyond the newest 14 — never the
  one `homebrew-tap/metadata/agentglass-dev.json` points to.
- **Build matrix** (all releases): `linux-x64` on `ubuntu-22.04`, `linux-arm64` on `ubuntu-22.04-arm`,
  `darwin-x64` on `macos-15-intel`, `darwin-arm64` on `macos-14`; Node 24 + scriptc + clang; each artifact is
  smoke-tested on its own runner (`--version` must print the expected version). Archive layout: a single
  `agentglass` executable at the root of the tarball (atlcli-compatible). No macOS signing/notarization
  (Homebrew formulae and `curl | sh` installs are not quarantined); ad-hoc signature from the linker suffices.

### 3. Stable release
- **Shared logic** `scripts/release-lib.sh` (POSIX sh + git): `next_version` (from tags `vYYYY.M.*` of the current
  UTC month; `1` in a new month) and `changelog <from-tag> <to-ref>` (Conventional Commits grouped as
  Breaking changes (`!`/`BREAKING CHANGE`), Features, Fixes, Performance, Refactoring & other, Docs; drops
  `chore(release)` and merge commits; a revert and the commit it reverts both drop out when both fall in the
  range; each line = subject + short SHA).
- **Normal path `scripts/release.sh`** (`--dry-run` supported): requires branch `main`, clean tree, in sync with
  `origin/main`, and a successful `ci.yml` run for HEAD; computes the version, prepends the changelog section to
  `CHANGELOG.md`, opens `$EDITOR` (abort = no release), commits `chore(release): <version>`, creates the annotated
  tag, `git push --atomic origin main v<version>`.
- **Fallback path**: workflow `release-cut.yml` (`workflow_dispatch`, input `dry_run`) runs the same library in
  CI without the editor step and pushes commit + tag.
- **`release.yml`** on tag push `v*` (+ `workflow_dispatch` with input `tag` to re-run): validates the tag against
  `^v[0-9]{4}\.[1-9][0-9]?\.[1-9][0-9]*$` and that it is reachable from `main`; builds the matrix with channel
  `stable`; creates a **draft** release whose notes are the tag's section of `CHANGELOG.md`; uploads the 4
  archives + `SHA256SUMS` + `build-metadata.json` + build provenance attestation; publishes only when all
  assets are present; then dispatches the tap's generic "Update Formula" (`formula=agentglass`,
  `tag=v<version>`, `repository=BjoernSchotte/agentglass`). A failed platform leaves the draft unpublished; a
  re-run attaches to the same draft; the tag never moves.
- **Secret**: `HOMEBREW_TAP_TOKEN` in the agentglass repo — fine-grained PAT with `actions: write` on
  `BjoernSchotte/homebrew-tap` (the maintainer adds it once).

### 4. Distribution
- **`install.sh`** (POSIX sh, needs `curl`, `tar`, `sha256sum` or `shasum`):
  `curl -fsSL https://raw.githubusercontent.com/BjoernSchotte/agentglass/main/install.sh | sh`
  with `--channel stable|dev`, `--version <v>`, `--prefix <dir>` (default `~/.local/bin`). Detects OS/arch,
  downloads the archive + `SHA256SUMS` from the selected release, verifies, installs atomically, warns if the
  prefix is not on `PATH`, writes `~/.agentglass/install.json` `{method: "script", channel, path, version}`.
- **Homebrew** in `BjoernSchotte/homebrew-tap`: `Formula/agentglass.rb` (updated by the existing generic
  "Update Formula" workflow) and `Formula/agentglass-dev.rb` + `metadata/agentglass-dev.json` (updated by a new
  `update-agentglass-dev.yml`, a copy of the atlcli dev workflow adapted to agentglass; atlcli files untouched).
  Formulae conflict with each other; tests assert `--version` (stable) and channel/commit via
  `--version --json` (dev). README of the tap lists both.
- **From source** stays: `./build.sh` → channel `local`.
- **README**: install section (brew, script, source), "Releases & channels", link to `CHANGELOG.md`; "local
  only" keeps its promise with one sentence: only `agentglass update` contacts GitHub, and only when run.

### 5. `agentglass update`
- `agentglass update [--channel stable|dev] [--tag <version|dev-tag>] [--dry-run] [--json] [--yes]`,
  `agentglass update status [--json]`, `agentglass update --rollback`.
- Channel persisted as `update.channel` in `~/.agentglass/config.json` **only after a successful update**; default
  `stable`. `--tag` is one-off and never persisted.
- Target resolution via the GitHub Releases API (`/repos/BjoernSchotte/agentglass/releases`, paginated): stable =
  highest non-prerelease `v*` by our comparison; dev = highest `dev-*` prerelease that has all assets.
- Install method: Homebrew (binary under `brew --prefix` / a `Cellar` path) → refuse with the matching
  `brew upgrade agentglass` / `brew install agentglass-dev` hint; `local` channel → refuse with
  `git pull && ./build.sh` unless `--force`; script/unknown → proceed.
- Procedure: download archive + `SHA256SUMS` to a temp dir next to the binary → verify checksum → extract →
  run the candidate `--version --json` and require expected version + channel → keep the current binary as
  `agentglass.prev` → atomic `rename` over the running binary → persist channel → print old → new.
  `--rollback` swaps `agentglass.prev` back.
- Downgrade (target older than installed, e.g. dev → stable): interactive confirmation, skipped by `--yes`;
  refused in non-interactive mode without `--yes`.
- Errors (no network, rate limit, missing asset, checksum mismatch, no write permission, candidate fails
  verification): clear message, non-zero exit, installed binary unchanged, temp files removed.
- `update` uses the Platform port only where OS specifics arise (paths, permissions); Windows is out of scope.

## Testing
- `src/features/version.check.ts`: parse/compare (month roll-over, dev vs stable ordering, local, invalid tags,
  `2026.10.1` > `2026.9.12`).
- `src/features/update.check.ts`: target selection from a fixture release list (prereleases, drafts, missing
  assets), downgrade detection, install-method detection, the swap + rollback in a temp dir with a fake binary
  that prints `--version --json`.
- `scripts/release-lib.test.sh`: `next_version` across a month boundary and with gaps; changelog grouping on a
  temp git repo.
- CI: per-artifact smoke; `install.sh` exercised against the just-built dev release on Linux and macOS.
- Real run: one manual dev release → `install.sh --channel dev`, `agentglass update --dry-run`,
  `brew install bjoernschotte/tap/agentglass-dev` + `brew test`; then the first stable release.

## Out of scope
Windows builds, macOS signing/notarization, beta/extended-stable channels, background update checks,
Linux distro packages, Docker images.
