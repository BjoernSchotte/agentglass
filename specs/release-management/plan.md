# Release Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agentglass ships prebuilt binaries on a stable CalVer channel (`YYYY.M.N`) and a daily dev channel, installable via Homebrew tap, `install.sh` or source, and self-updatable with `agentglass update`.

**Architecture:** The git tag is the single source of truth for versions; `build.sh` bakes version/channel/commit into a generated `src/build-info.ts`. GitHub Actions build a 4-platform matrix through one reusable workflow used by CI-independent `release.yml` (tag push) and `dev-release.yml` (daily cron); releases are drafts until every asset is present. `agentglass update` resolves targets from the GitHub Releases API, downloads with `curl`, verifies `SHA256SUMS`, self-verifies the candidate and swaps atomically.

**Tech Stack:** TypeScript → native binary via scriptc 0.1.7 (Node 24 to build; clang to link); POSIX `sh` for release scripts and `install.sh`; GitHub Actions; Homebrew formulae (Ruby) in `BjoernSchotte/homebrew-tap`; `gh` CLI in workflows.

**Spec:** [spec.md](spec.md) — binding; this plan argues from it.

## Global Constraints

- Stable version `YYYY.M.N` (no zero padding, N = counter within the UTC month from 1); tag `v<version>`, annotated, never moved/deleted/reused. Tag regex: `^v[0-9]{4}\.[1-9][0-9]?\.[1-9][0-9]*$`.
- Dev release tag `dev-YYYYMMDD.<run_number>.<run_attempt>-<sha8>` (UTC date, 8 hex chars), GitHub prerelease. Dev version `<base>-dev.<YYYYMMDD>.<run_number>+<sha8>`, base = newest stable reachable from the commit or `0.0.0`.
- Local version `<base>-local+<sha8>` plus `-dirty` when the tree is dirty; channel `local`.
- Assets per release: `agentglass-linux-x64.tar.gz`, `agentglass-linux-arm64.tar.gz`, `agentglass-darwin-x64.tar.gz`, `agentglass-darwin-arm64.tar.gz` (each contains only `agentglass` at the root), `SHA256SUMS`, `build-metadata.json`.
- Runners: linux-x64 `ubuntu-22.04`, linux-arm64 `ubuntu-22.04-arm`, darwin-x64 `macos-15-intel`, darwin-arm64 `macos-14`. Node 24, scriptc 0.1.7.
- Dev cron `43 2 * * *`; dev retention: newest 14 dev releases + the one `homebrew-tap/metadata/agentglass-dev.json` points to.
- Secret `HOMEBREW_TAP_TOKEN` (fine-grained PAT, `actions: write` on `BjoernSchotte/homebrew-tap`). Tap workflows: existing `update-formula.yml` (inputs `formula`, `tag`, `repository`), new `update-agentglass-dev.yml`.
- Files: `~/.agentglass/config.json` key `update.channel` (default `stable`); `~/.agentglass/install.json` `{method, channel, path, version}` written by `install.sh`.
- Only `agentglass update` / `update status` touch the network, and only when run.
- scriptc limits: no `Response.arrayBuffer()` (download binaries with `curl`), no `readlinkSync`, nominal typing, optional function members called via a local, out-of-range array reads trap, no Map spread, no number `.toString(radix)`. `process.execPath` is the resolved real path of the running binary.
- Existing behavior unchanged: all `src/**/*.check.ts` pass; `./agentglass --json --subagents --limit 400` identical to `main` except volatile fields (updated bytes activity live pid status attention stuck).
- Commits: conventional (`feat:`, `fix:`, `ci:`, `build:`, `docs:`), each ending with a blank line + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Workflow runs are exercised by pushing the feature branch (not `main`) and by `workflow_dispatch` on it; the tap repo gets a branch + PR, never a direct push to its `main`.

## Review Focus

1. **First release ever / month rollover** — no `v*` tags yet → `2026.9.1`; tags only from last month → `.1` of the new month; gaps (`2026.9.1`, `2026.9.3`) → `2026.9.4`. Pinned in Task 3 `release-lib.test.sh`.
2. **One platform build fails** → the release stays a draft, nothing reaches the tap; a re-run attaches to the same draft. Pinned in Task 4 by `scripts/verify-release-assets.sh` + its test.
3. **Where the binary lives** — Homebrew Cellar path, a `~/code/agentglass` source build symlinked into `~/.local/bin`, a read-only directory → `update` refuses (or explains) instead of breaking the install. Pinned in Task 7 `update.check.ts`.
4. **Non-interactive downgrade** (`agentglass update --channel stable` from dev inside a script, no TTY, no `--yes`) → refused with exit 2, binary unchanged. Pinned in Task 7.
5. **Corrupt or partial download / checksum mismatch / candidate that fails `--version --json`** → binary unchanged, temp files removed, exit ≠ 0. Pinned in Task 7 with `file://` fixture releases.

---

### Task 1: Build info and versions

**Files:**
- Create: `scripts/build-info.sh`, `src/features/version.ts`, `src/features/version.check.ts`, `scripts/check.sh`
- Modify: `build.sh` (call build-info before `scriptc build`), `.gitignore` (+ `src/build-info.ts`), `src/features/cli.ts` (drop `VERSION` const; `--version`, `--version --json`, help header)

**Interfaces:**
- Produces:
  ```ts
  // src/build-info.ts (generated)
  export const BUILD = { version: string, channel: string, commit: string, date: string, platform: string };
  // src/features/version.ts
  export interface Ver { y: number; m: number; n: number; rank: number; devDate: number; devRun: number; raw: string } // rank: 0 stable, 1 dev, 2 local
  export function parseVersion(s: string): Ver | null;
  export function compareVersions(a: Ver, b: Ver): number;          // <0, 0, >0
  export function parseDevTag(tag: string): { date: number; run: number; attempt: number; sha: string } | null;
  export function versionOfTag(tag: string): string;                // "v2026.9.1" → "2026.9.1"; dev tags → "" (dev version comes from build-metadata)
  export function installMethod(execPath: string, channel: string, installJson: string): string; // "homebrew" | "script" | "source" | "unknown"
  export function versionInfo(): Obj;                               // {version, channel, commit, date, platform, installMethod}
  ```
  `scripts/check.sh` — builds and runs every `src/**/*.check.ts`, exit 1 on any failure (used by CI and humans).

- [ ] **Step 1: `scripts/build-info.sh`** (POSIX sh, run from repo root, writes `src/build-info.ts`):
  ```sh
  #!/bin/sh
  # writes src/build-info.ts — CI passes AGENTGLASS_VERSION/CHANNEL/COMMIT; local builds derive them from git
  set -e
  cd "$(dirname "$0")/.."
  commit="${AGENTGLASS_COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
  sha8=$(printf %s "$commit" | cut -c1-8)
  base=$(git describe --tags --match 'v[0-9]*' --abbrev=0 2>/dev/null | sed 's/^v//' || true); [ -n "$base" ] || base=0.0.0
  dirty=""; [ -z "$(git status --porcelain 2>/dev/null)" ] || dirty="-dirty"
  channel="${AGENTGLASS_CHANNEL:-local}"
  version="${AGENTGLASS_VERSION:-$base-local+$sha8$dirty}"
  os=$(uname -s | tr 'A-Z' 'a-z'); case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) arch=$(uname -m);; esac
  date=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  cat > src/build-info.ts <<EOF
  // generated by scripts/build-info.sh — do not edit, not committed
  export const BUILD = { version: "$version", channel: "$channel", commit: "$commit", date: "$date", platform: "$os-$arch" };
  EOF
  ```
  `build.sh`: add `sh scripts/build-info.sh` right before `scriptc build src/main.ts -o agentglass`. `.gitignore`: add `src/build-info.ts`.
- [ ] **Step 2: `scripts/check.sh`**:
  ```sh
  #!/bin/sh
  # build + run every self-check; exit 1 if any fails
  set -e
  cd "$(dirname "$0")/.."
  sh scripts/build-info.sh
  . ./scripts/toolchain.sh   # sets PATH to a Node 24 + scriptc (extracted from build.sh, see below)
  out=$(mktemp -d); fail=0
  for f in $(git ls-files 'src/*.check.ts' 'src/**/*.check.ts') src/features/version.check.ts; do
    [ -f "$f" ] || continue
    if ! scriptc build "$f" -o "$out/c" >"$out/log" 2>&1; then echo "BUILD FAIL $f"; cat "$out/log"; fail=1; continue; fi
    if AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme "$out/c" >"$out/run" 2>&1; then echo "ok   $f: $(tail -1 "$out/run")"; else echo "FAIL $f"; cat "$out/run"; fail=1; fi
  done
  rm -rf "$out"; exit $fail
  ```
  Move the Node/scriptc/clang discovery block of `build.sh` (everything between `cd` and `scriptc build`) into `scripts/toolchain.sh` and source it from both scripts (dedupe; `git ls-files` lists each file once — drop the explicit `version.check.ts` after the file is committed).
- [ ] **Step 3: Failing check `src/features/version.check.ts`:**
  ```ts
  // agentglass — self-check for version parsing/ordering: sh scripts/check.sh
  // SPDX-License-Identifier: Apache-2.0
  import { parseVersion, compareVersions, parseDevTag, versionOfTag, installMethod } from "./version.ts";
  let bad = 0;
  function ok(w: string, c: boolean, got: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + got); } }
  function cmp(a: string, b: string): number { const x = parseVersion(a); const y = parseVersion(b); return x && y ? compareVersions(x, y) : 99; }
  ok("stable parses", parseVersion("2026.9.1") !== null, "");
  ok("zero-padded month rejected", parseVersion("2026.09.1") === null, "");
  ok("N=0 rejected", parseVersion("2026.9.0") === null, "");
  ok("month rollover", cmp("2026.10.1", "2026.9.12") > 0, String(cmp("2026.10.1", "2026.9.12")));
  ok("counter", cmp("2026.9.2", "2026.9.10") < 0, String(cmp("2026.9.2", "2026.9.10")));
  ok("dev after its base", cmp("2026.9.1-dev.20260930.4+a1b2c3d4", "2026.9.1") > 0, "");
  ok("dev before next stable", cmp("2026.9.1-dev.20260930.4+a1b2c3d4", "2026.9.2") < 0, "");
  ok("dev by date then run", cmp("2026.9.1-dev.20260930.4+a1b2c3d4", "2026.9.1-dev.20261001.1+b1b2c3d4") < 0 && cmp("2026.9.1-dev.20261001.2+aaaaaaaa", "2026.9.1-dev.20261001.1+bbbbbbbb") > 0, "");
  ok("dev before any stable", cmp("0.0.0-dev.20260930.1+a1b2c3d4", "2026.9.1") < 0, "");
  ok("local parses", parseVersion("2026.9.1-local+a1b2c3d4-dirty") !== null && parseVersion("0.0.0-local+a1b2c3d4") !== null, "");
  ok("garbage rejected", parseVersion("latest") === null && parseVersion("v2026.9.1") === null && parseVersion("2026.9.1-1") === null, "");
  const d = parseDevTag("dev-20260930.12.2-a1b2c3d4");
  ok("dev tag", !!d && d.date === 20260930 && d.run === 12 && d.attempt === 2 && d.sha === "a1b2c3d4", JSON.stringify(d));
  ok("bad dev tag", parseDevTag("dev-2026093.1.1-a1b2c3d4") === null && parseDevTag("dev-20260930.1.1-XYZ") === null, "");
  ok("versionOfTag", versionOfTag("v2026.9.1") === "2026.9.1" && versionOfTag("dev-20260930.1.1-a1b2c3d4") === "" && versionOfTag("v2026.09.1") === "", "");
  ok("brew", installMethod("/opt/homebrew/Cellar/agentglass/2026.9.1/bin/agentglass", "stable", "") === "homebrew", "");
  ok("linuxbrew", installMethod("/home/linuxbrew/.linuxbrew/Cellar/agentglass-dev/x/bin/agentglass", "dev", "") === "homebrew", "");
  ok("script", installMethod("/home/u/.local/bin/agentglass", "stable", "{\"method\":\"script\",\"path\":\"/home/u/.local/bin/agentglass\"}") === "script", "");
  ok("script marker for another path", installMethod("/usr/local/bin/agentglass", "stable", "{\"method\":\"script\",\"path\":\"/home/u/.local/bin/agentglass\"}") === "unknown", "");
  ok("source", installMethod("/home/u/code/agentglass/agentglass", "local", "") === "source", "");
  console.log(bad ? bad + " failed" : "version: all checks passed");
  process.exit(bad ? 1 : 0);
  ```
- [ ] **Step 4: Run it — expect build failure** (`version.ts` missing): `sh scripts/check.sh`.
- [ ] **Step 5: Implement `src/features/version.ts`:**
  ```ts
  // agentglass — versions: stable YYYY.M.N, dev <base>-dev.<YYYYMMDD>.<run>+<sha8>, local <base>-local+<sha8>[-dirty]; own ordering, never semver or dates
  // SPDX-License-Identifier: Apache-2.0
  import { type Obj, parse } from "../util/json.ts";
  import { BUILD } from "../build-info.ts";

  export interface Ver { y: number; m: number; n: number; rank: number; devDate: number; devRun: number; raw: string }
  const BASE = "(0\\.0\\.0|[0-9]{4}\\.[1-9][0-9]?\\.[1-9][0-9]*)";
  const STABLE = new RegExp("^" + BASE + "$");
  const DEV = new RegExp("^" + BASE + "-dev\\.([0-9]{8})\\.([1-9][0-9]*)\\+[0-9a-f]{8}$");
  const LOCAL = new RegExp("^" + BASE + "-local\\+[0-9a-f]{7,40}(-dirty)?$");
  function base(b: string, raw: string, rank: number, dd: number, dr: number): Ver {
    const p = b.split("."); return { y: Number(p[0]), m: Number(p[1]), n: Number(p[2]), rank, devDate: dd, devRun: dr, raw };
  }
  export function parseVersion(s: string): Ver | null {
    let m = STABLE.exec(s); if (m && m[1] !== "0.0.0") return base(m[1] ?? "", s, 0, 0, 0);
    m = DEV.exec(s); if (m) return base(m[1] ?? "", s, 1, Number(m[2]), Number(m[3]));
    m = LOCAL.exec(s); if (m) return base(m[1] ?? "", s, 2, 0, 0);
    return null;
  }
  // same base: stable < its dev builds (by date, run) ; local builds sort with dev builds of that base, lowest
  export function compareVersions(a: Ver, b: Ver): number {
    return a.y - b.y || a.m - b.m || a.n - b.n || (a.rank === 0 ? 0 : 1) - (b.rank === 0 ? 0 : 1) || a.devDate - b.devDate || a.devRun - b.devRun;
  }
  const DEV_TAG = /^dev-([0-9]{8})\.([1-9][0-9]*)\.([1-9][0-9]*)-([0-9a-f]{8})$/;
  export function parseDevTag(tag: string): { date: number; run: number; attempt: number; sha: string } | null {
    const m = DEV_TAG.exec(tag); return m ? { date: Number(m[1]), run: Number(m[2]), attempt: Number(m[3]), sha: m[4] ?? "" } : null;
  }
  export function versionOfTag(tag: string): string { const v = tag.startsWith("v") ? tag.slice(1) : ""; const p = parseVersion(v); return p && p.rank === 0 ? v : ""; }
  export function installMethod(execPath: string, channel: string, installJson: string): string {
    if (execPath.indexOf("/Cellar/") >= 0) return "homebrew";
    const o = parse(installJson.trim());
    if (o && o["method"] === "script" && o["path"] === execPath) return "script";
    return channel === "local" ? "source" : "unknown";
  }
  export function versionInfo(): Obj {
    const ij = readText(join(HOME, ".agentglass", "install.json"), 0, 65536);
    return { version: BUILD.version, channel: BUILD.channel, commit: BUILD.commit, date: BUILD.date, platform: BUILD.platform,
      installMethod: installMethod(process.execPath, BUILD.channel, ij) };
  }
  ```
  (imports: `join` from `node:path`, `HOME, readText` from `../util/fs.ts`.)
- [ ] **Step 6: CLI** in `src/features/cli.ts`: remove `export const VERSION = "0.1.0"`; `--version` prints `BUILD.version`; `--version --json` prints `JSON.stringify(versionInfo())`; the usage header becomes `agentglass <version> (<channel>, <commit8>, <platform>) — browse, …`; `grep -rn VERSION src` must show only the cache's own `VERSION` in usage/cache.ts. Update any other import of `VERSION`.
- [ ] **Step 7: Run `sh scripts/check.sh` — all pass** (incl. version). `./build.sh && ./agentglass --version` prints e.g. `0.0.0-local+a920c87e-dirty`; `./agentglass --version --json` has all six keys; `AGENTGLASS_VERSION=2026.9.1 AGENTGLASS_CHANNEL=stable ./build.sh && ./agentglass --version` prints `2026.9.1`. Regression `--json --subagents --limit 400` vs the main binary.
- [ ] **Step 8: Commit** `build: version and channel from the git tag, baked in at build time`.

---

### Task 2: CI workflow and the reusable build matrix

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/build-artifacts.yml`, `scripts/package.sh`

**Interfaces:**
- Consumes: `scripts/check.sh`, `scripts/toolchain.sh`, `scripts/build-info.sh` (Task 1).
- Produces: reusable workflow `build-artifacts.yml` (`workflow_call`, inputs `ref` (sha), `version`, `channel`; uploads one artifact per target named `agentglass-<target>` containing `agentglass-<target>.tar.gz`). `scripts/package.sh <target> <expected-version>` → smoke-tests `./agentglass` and writes `dist/agentglass-<target>.tar.gz`.

- [ ] **Step 1: `scripts/package.sh`**:
  ```sh
  #!/bin/sh
  # smoke-test the freshly built ./agentglass and pack it as dist/agentglass-<target>.tar.gz
  set -e
  target="$1"; want="$2"
  got=$(./agentglass --version)
  [ "$got" = "$want" ] || { echo "package.sh: built version '$got' != expected '$want'" >&2; exit 1; }
  ./agentglass --version --json | grep -q "\"platform\":\"$target\"" || { echo "package.sh: platform is not $target" >&2; exit 1; }
  ./agentglass --json --limit 1 >/dev/null
  mkdir -p dist && tar -czf "dist/agentglass-$target.tar.gz" agentglass
  ```
- [ ] **Step 2: `build-artifacts.yml`**:
  ```yaml
  name: Build artifacts
  on:
    workflow_call:
      inputs:
        ref: { type: string, required: true }
        version: { type: string, required: true }
        channel: { type: string, required: true }
  permissions: { contents: read }
  jobs:
    build:
      name: build ${{ matrix.target }}
      runs-on: ${{ matrix.os }}
      strategy:
        fail-fast: false
        matrix:
          include:
            - { target: linux-x64, os: ubuntu-22.04 }
            - { target: linux-arm64, os: ubuntu-22.04-arm }
            - { target: darwin-x64, os: macos-15-intel }
            - { target: darwin-arm64, os: macos-14 }
      steps:
        - uses: actions/checkout@v4
          with: { ref: "${{ inputs.ref }}", fetch-depth: 0 }
        - uses: actions/setup-node@v4
          with: { node-version: 24 }
        - run: npm i -g scriptc@0.1.7
        - if: runner.os == 'Linux'
          run: sudo apt-get update && sudo apt-get install -y clang
        - run: ./build.sh
          env:
            AGENTGLASS_VERSION: ${{ inputs.version }}
            AGENTGLASS_CHANNEL: ${{ inputs.channel }}
            AGENTGLASS_COMMIT: ${{ inputs.ref }}
        - run: sh scripts/package.sh ${{ matrix.target }} "${{ inputs.version }}"
        - uses: actions/upload-artifact@v4
          with: { name: "agentglass-${{ matrix.target }}", path: "dist/agentglass-${{ matrix.target }}.tar.gz", retention-days: 7, if-no-files-found: error }
  ```
  If scriptc needs a newer clang than Ubuntu 22.04's default (14), install it via `https://apt.llvm.org/llvm.sh 20` and set `SCRIPTC_LINKER=clang-20`; record which was needed in the report.
- [ ] **Step 3: `ci.yml`**:
  ```yaml
  name: CI
  on:
    push: { branches: ["**"] }
    pull_request:
  permissions: { contents: read }
  concurrency: { group: "ci-${{ github.ref }}", cancel-in-progress: true }
  jobs:
    check:
      name: check ${{ matrix.os }}
      runs-on: ${{ matrix.os }}
      strategy:
        fail-fast: false
        matrix: { os: [ubuntu-22.04, macos-14] }
      steps:
        - uses: actions/checkout@v4
          with: { fetch-depth: 0 }
        - uses: actions/setup-node@v4
          with: { node-version: 24 }
        - run: npm i -g scriptc@0.1.7
        - if: runner.os == 'Linux'
          run: sudo apt-get update && sudo apt-get install -y clang sqlite3
        - run: ./build.sh
        - run: sh scripts/check.sh
        - run: ./agentglass --version && ./agentglass --version --json && ./agentglass --json --limit 1 >/dev/null
  ```
- [ ] **Step 4: Verify on GitHub** — push the feature branch; `gh run watch` the CI run → green on both OS. Dispatch a throwaway caller to exercise the matrix: add temporarily `.github/workflows/build-probe.yml` (`workflow_dispatch` → `uses: ./.github/workflows/build-artifacts.yml` with `ref: ${{ github.sha }}`, `version: 0.0.0-dev.20260101.1+<sha8 of HEAD>`, `channel: dev`), run it, download the 4 artifacts (`gh run download`), check each tarball contains only `agentglass` and that the linux-x64 one runs here (`--version`, `--version --json` platform). Delete `build-probe.yml` again before committing.
- [ ] **Step 5: Commit** `ci: checks on every push; reusable 4-platform build`.

---

### Task 3: Version bump + changelog library, `release.sh`

**Files:**
- Create: `scripts/release-lib.sh`, `scripts/release-lib.test.sh`, `scripts/release.sh`, `CHANGELOG.md`

**Interfaces:**
- Produces (functions in `release-lib.sh`, sourced with `. scripts/release-lib.sh`):
  - `next_version [<YYYY.M prefix>]` → prints e.g. `2026.9.1`; the prefix defaults to the current UTC `$(date -u +%Y).$(date -u +%-m)` (use `date -u +%m | sed 's/^0//'` for portability).
  - `last_stable_tag [<ref>]` → newest `v*` tag reachable from ref by version order, empty if none.
  - `changelog <from-tag-or-empty> <to-ref>` → Markdown section body (no heading).
  - `notes_for <version>` → prints the `## <version>` section of `CHANGELOG.md` without the heading.
  - `sort_versions` → reads stable versions on stdin, prints them ascending by (Y, M, N) numerically.

- [ ] **Step 1: Failing test `scripts/release-lib.test.sh`** (creates a temp git repo, sources the lib):
  ```sh
  #!/bin/sh
  set -e
  here=$(cd "$(dirname "$0")" && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
  cd "$t" && git init -q && git config user.email t@t && git config user.name t
  . "$here/release-lib.sh"
  fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
  c() { echo "$1" >> f; git add f; git commit -qm "$1"; }
  c "feat: first"
  eq "no tags at all" "$(next_version 2026.9)" "2026.9.1"
  git tag -a v2026.8.3 -m x
  eq "only last month" "$(next_version 2026.9)" "2026.9.1"
  c "fix: a"; git tag -a v2026.9.1 -m x; c "fix: b"; git tag -a v2026.9.3 -m x
  eq "gap" "$(next_version 2026.9)" "2026.9.4"
  git tag -a v2026.9.10 -m x
  eq "numeric not lexical" "$(next_version 2026.9)" "2026.9.11"
  eq "last stable" "$(last_stable_tag HEAD)" "v2026.9.10"
  eq "sort" "$(printf '2026.9.10\n2026.10.1\n2026.9.2\n' | sort_versions | tr '\n' ' ')" "2026.9.2 2026.9.10 2026.10.1 "
  c "feat(update)!: self update"; c "fix: crash on empty list"; c "perf: faster scan"; c "docs: readme"
  c "refactor: split module"; c "chore(release): 2026.9.11"; c "feat: to be reverted"
  git revert --no-edit HEAD >/dev/null
  log=$(changelog v2026.9.10 HEAD)
  echo "$log" | grep -q '^### Breaking changes' || { echo "FAIL breaking section"; fail=1; }
  echo "$log" | grep -q '^- \*\*update:\*\* self update (' || { echo "FAIL scope rendering"; fail=1; }
  echo "$log" | grep -q '^### Fixes' && echo "$log" | grep -q 'crash on empty list' || { echo "FAIL fixes"; fail=1; }
  echo "$log" | grep -q '^### Performance' || { echo "FAIL perf"; fail=1; }
  echo "$log" | grep -q 'chore(release)\|2026.9.11' && { echo "FAIL release commit leaked"; fail=1; }
  echo "$log" | grep -q 'to be reverted' && { echo "FAIL revert pair leaked"; fail=1; }
  printf '# Changelog\n\n## 2026.9.2\n\nsecond\n\n## 2026.9.1\n\nfirst\n' > CHANGELOG.md
  eq "notes_for" "$(notes_for 2026.9.1)" "first"
  [ $fail = 0 ] && echo "release-lib: all tests passed"; exit $fail
  ```
- [ ] **Step 2: Run** `sh scripts/release-lib.test.sh` — expect failure (lib missing).
- [ ] **Step 3: Implement `scripts/release-lib.sh`** (POSIX sh; `awk`, `sed`, `git` only):
  - `sort_versions`: `awk -F. '{printf "%06d %04d %06d %s\n", $1, $2, $3, $0}' | sort | cut -d' ' -f4`.
  - `next_version`: `prefix=${1:-$(date -u +%Y).$(date -u +%m | sed 's/^0//')}`; list `git tag -l "v$prefix.*"`, keep those matching `^v[0-9]{4}\.[1-9][0-9]?\.[1-9][0-9]*$`, strip `v`, `sort_versions | tail -1`, take the third field, print `$prefix.$((n+1))` (or `$prefix.1`).
  - `last_stable_tag`: `git tag --merged "${1:-HEAD}" -l 'v*'` → filter the regex → strip `v` → `sort_versions | tail -1` → prefix `v`.
  - `changelog from to`: range = `from..to` (or `to` when from is empty); `git log --no-merges --format='%H%x09%s%x09%b%x1e' range`; drop subjects starting `chore(release)`; drop a `Revert "<subj>"` commit together with the commit whose subject is `<subj>` when both are in range; classify by `^(feat|fix|perf|refactor|docs|build|ci|chore|test|style)(\(([^)]+)\))?(!)?: (.*)`; breaking when `!` or body contains `BREAKING CHANGE`; sections in order `Breaking changes`, `Features` (feat), `Fixes` (fix), `Performance` (perf), `Refactoring & other` (refactor, build, ci, chore, test, style, unmatched), `Docs` (docs); line format `- **<scope>:** <text> (<sha7>)` or `- <text> (<sha7>)`; empty sections omitted; empty range → `- No changes.`.
  - `notes_for`: `awk -v v="## $1" '$0==v{f=1;next} /^## /{if(f)exit} f' CHANGELOG.md | sed '/./,$!d'` and trim trailing blank lines.
- [ ] **Step 4: Run the test — pass.**
- [ ] **Step 5: `scripts/release.sh`**:
  ```sh
  #!/bin/sh
  # cut a stable release: sh scripts/release.sh [--dry-run] [--yes]
  set -e
  cd "$(dirname "$0")/.."; . scripts/release-lib.sh
  dry=0; yes=0; for a in "$@"; do case "$a" in --dry-run) dry=1;; --yes) yes=1;; *) echo "usage: release.sh [--dry-run] [--yes]" >&2; exit 2;; esac; done
  [ "$(git branch --show-current)" = main ] || { echo "release.sh: not on main" >&2; exit 1; }
  [ -z "$(git status --porcelain)" ] || { echo "release.sh: working tree not clean" >&2; exit 1; }
  git fetch -q origin main --tags
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "release.sh: main is not in sync with origin/main" >&2; exit 1; }
  ci=$(gh run list --workflow ci.yml --commit "$(git rev-parse HEAD)" --json conclusion -q '.[0].conclusion' 2>/dev/null || true)
  [ "$ci" = success ] || { echo "release.sh: CI for HEAD is '${ci:-missing}', need success" >&2; exit 1; }
  v=$(next_version); prev=$(last_stable_tag HEAD)
  body=$(changelog "$prev" HEAD)
  printf '## %s\n\n%s\n' "$v" "$body"
  [ $dry = 1 ] && { echo "(dry run — nothing written)"; exit 0; }
  prepend_changelog "$v" "$body"
  [ $yes = 1 ] || { ${EDITOR:-vi} CHANGELOG.md; printf 'release %s? [y/N] ' "$v"; read -r ok; [ "$ok" = y ] || { git checkout CHANGELOG.md; echo aborted; exit 1; }; }
  git add CHANGELOG.md && git commit -qm "chore(release): $v"
  git tag -a "v$v" -m "agentglass $v"
  git push --atomic origin main "v$v"
  echo "released v$v — https://github.com/BjoernSchotte/agentglass/actions/workflows/release.yml"
  ```
  `CHANGELOG.md` starts as three lines: `# Changelog`, blank, `All notable changes to agentglass. Versions are \`YYYY.M.N\` (N counts releases within the month).`
  Add to `release-lib.sh`: `prepend_changelog <version> <body>` — writes `CHANGELOG.md` as: the first 3 lines unchanged, blank line, `## <version>`, blank, body, blank, then the remaining lines (via `head -3`, `tail -n +4 | sed '/./,$!d'`, tmp file + `mv`). Extend `release-lib.test.sh`: on the 3-line file, `prepend_changelog 2026.9.2 "- x"` then `prepend_changelog 2026.9.3 "- y"` → line 1–3 unchanged, `notes_for 2026.9.3` = `- y`, `notes_for 2026.9.2` = `- x`, and `## 2026.9.3` appears before `## 2026.9.2`.
- [ ] **Step 6: Verify** `sh scripts/release.sh --dry-run` on the feature branch fails with "not on main" (expected), and on a temp clone of main prints `## 2026.9.1` (or the current month) with a plausible changelog of the repo's history.
- [ ] **Step 7: Commit** `build: release-lib, release.sh and CHANGELOG.md`.

---

### Task 4: Stable release workflows

**Files:**
- Create: `.github/workflows/release.yml`, `.github/workflows/release-cut.yml`, `scripts/release-assets.sh`, `scripts/verify-release-assets.sh`, `scripts/verify-release-assets.test.sh`

**Interfaces:**
- Consumes: `build-artifacts.yml` (Task 2), `release-lib.sh` (`next_version`, `last_stable_tag`, `changelog`, `notes_for`) (Task 3).
- Produces: `scripts/verify-release-assets.sh <dir>` → exit 0 iff `<dir>` holds exactly the 4 archives + `SHA256SUMS` + `build-metadata.json` and every archive's hash matches `SHA256SUMS`. `build-metadata.json`: `{"schema":"agentglass.build-metadata/v1","version","channel","tag","sourceSha","builtAt","archives":{"<name>":"<sha256>",…}}`.

- [ ] **Step 1: Failing test `scripts/verify-release-assets.test.sh`** — builds a fixture dir with 4 dummy tarballs, correct `SHA256SUMS` and metadata → expect 0; then (a) delete one archive → 1, (b) corrupt one byte → 1, (c) extra unexpected file → 1, (d) missing `build-metadata.json` → 1. Uses `sha256sum` or `shasum -a 256` (whichever exists).
- [ ] **Step 2: Implement `verify-release-assets.sh`** (hash tool detection: `command -v sha256sum >/dev/null && H="sha256sum" || H="shasum -a 256"`; `cd "$1" && $H -c SHA256SUMS`; exact file set check with `ls | sort` compared to the expected list). Run the test → pass.
- [ ] **Step 3: `release.yml`**:
  ```yaml
  name: Release
  on:
    push: { tags: ["v*"] }
    workflow_dispatch:
      inputs:
        tag: { description: "existing tag to (re)build, e.g. v2026.9.1", required: true, type: string }
  permissions: { contents: read }
  concurrency: { group: "release-${{ github.event.inputs.tag || github.ref_name }}", cancel-in-progress: false }
  jobs:
    meta:
      runs-on: ubuntu-22.04
      outputs: { tag: "${{ steps.m.outputs.tag }}", version: "${{ steps.m.outputs.version }}", sha: "${{ steps.m.outputs.sha }}" }
      steps:
        - uses: actions/checkout@v4
          with: { fetch-depth: 0 }
        - id: m
          env: { TAG: "${{ github.event.inputs.tag || github.ref_name }}" }
          run: |
            echo "$TAG" | grep -Eq '^v[0-9]{4}\.[1-9][0-9]?\.[1-9][0-9]*$' || { echo "::error::bad tag $TAG"; exit 1; }
            sha=$(git rev-list -n1 "$TAG")
            git merge-base --is-ancestor "$sha" origin/main || { echo "::error::$TAG is not on main"; exit 1; }
            echo "tag=$TAG" >> "$GITHUB_OUTPUT"; echo "version=${TAG#v}" >> "$GITHUB_OUTPUT"; echo "sha=$sha" >> "$GITHUB_OUTPUT"
    build:
      needs: meta
      uses: ./.github/workflows/build-artifacts.yml
      with: { ref: "${{ needs.meta.outputs.sha }}", version: "${{ needs.meta.outputs.version }}", channel: stable }
    publish:
      needs: [meta, build]
      runs-on: ubuntu-22.04
      permissions: { contents: write, id-token: write, attestations: write }
      env: { GH_TOKEN: "${{ github.token }}", TAG: "${{ needs.meta.outputs.tag }}", VERSION: "${{ needs.meta.outputs.version }}", SHA: "${{ needs.meta.outputs.sha }}" }
      steps:
        - uses: actions/checkout@v4
          with: { ref: "${{ needs.meta.outputs.sha }}", fetch-depth: 0 }
        - uses: actions/download-artifact@v4
          with: { pattern: "agentglass-*", path: out, merge-multiple: true }
        - name: checksums + metadata
          run: sh scripts/release-assets.sh out stable "$TAG" "$VERSION" "$SHA"
        - run: sh scripts/verify-release-assets.sh out
        - uses: actions/attest-build-provenance@v2
          with: { subject-path: "out/agentglass-*.tar.gz" }
        - name: draft (create or reuse) and upload
          run: |
            . scripts/release-lib.sh; notes_for "$VERSION" > notes.md; [ -s notes.md ] || echo "Release $VERSION" > notes.md
            gh release view "$TAG" >/dev/null 2>&1 || gh release create "$TAG" --draft --verify-tag --title "agentglass $VERSION" --notes-file notes.md
            gh release upload "$TAG" out/* --clobber
        - name: publish when complete
          run: |
            mkdir -p check && gh release download "$TAG" -D check && sh scripts/verify-release-assets.sh check
            gh release edit "$TAG" --draft=false --latest
    tap:
      needs: [meta, publish]
      runs-on: ubuntu-22.04
      steps:
        - env: { GH_TOKEN: "${{ secrets.HOMEBREW_TAP_TOKEN }}" }
          run: gh workflow run update-formula.yml -R BjoernSchotte/homebrew-tap -f formula=agentglass -f tag="${{ needs.meta.outputs.tag }}" -f repository=BjoernSchotte/agentglass
  ```
  `scripts/release-assets.sh <dir> <channel> <tag> <version> <sha>` writes `SHA256SUMS` (sorted, `<hash>  <file>`) and `build-metadata.json` (schema above) for the 4 archives in `<dir>`; covered by `verify-release-assets.test.sh` (its fixture is created with `release-assets.sh`).
- [ ] **Step 4: `release-cut.yml`** (fallback button):
  ```yaml
  name: Release cut
  on:
    workflow_dispatch:
      inputs: { dry_run: { type: boolean, default: true } }
  permissions: { contents: write }
  concurrency: { group: release-cut, cancel-in-progress: false }
  jobs:
    cut:
      runs-on: ubuntu-22.04
      steps:
        - uses: actions/checkout@v4
          with: { ref: main, fetch-depth: 0, token: "${{ secrets.HOMEBREW_TAP_TOKEN }}" }
        - env: { GH_TOKEN: "${{ github.token }}" }
          run: |
            git config user.name "github-actions[bot]"; git config user.email "github-actions[bot]@users.noreply.github.com"
            if [ "${{ inputs.dry_run }}" = true ]; then sh scripts/release.sh --dry-run; else sh scripts/release.sh --yes; fi
  ```
  Note: a tag pushed with the default `GITHUB_TOKEN` does not trigger `release.yml`; the checkout therefore uses `HOMEBREW_TAP_TOKEN`, which must also have `contents: write` on `BjoernSchotte/agentglass` — document this in the README's maintainer section. `release.sh --yes` skips the editor and the prompt.
- [ ] **Step 5: Verify without releasing** — on the feature branch: `sh scripts/verify-release-assets.test.sh` passes; `release-cut.yml` is dispatched with `dry_run: true` against the branch (`gh workflow run release-cut.yml --ref <branch> -f dry_run=true`) and prints the next version + changelog. `release.yml` itself is exercised end to end only in Task 8 with the user's approval (a real tag is a publish).
- [ ] **Step 6: Commit** `ci: stable release on tag push, drafts until every asset is there`.

---

### Task 5: Daily dev release and retention

**Files:**
- Create: `.github/workflows/dev-release.yml`, `scripts/dev-retention.sh`, `scripts/dev-retention.test.sh`

**Interfaces:**
- Consumes: `build-artifacts.yml`, `release-assets.sh`, `verify-release-assets.sh`, `release-lib.sh` (`last_stable_tag`).
- Produces: `scripts/dev-retention.sh <keep> <pinned-tag>` reads dev tags (one per line) on stdin and prints the tags to delete: all `dev-*` tags beyond the newest `<keep>` by (date, run, attempt), never `<pinned-tag>`.

- [ ] **Step 1: Failing test `scripts/dev-retention.test.sh`**: 20 tags over 3 days with mixed runs/attempts → keep 14 → 6 deletions, the oldest by (date, run, attempt); pinned tag among the old ones → not deleted (5 deletions); fewer than 14 tags → nothing; non-dev lines ignored.
- [ ] **Step 2: Implement** with `sed -n 's/^dev-\([0-9]\{8\}\)\.\([0-9]*\)\.\([0-9]*\)-[0-9a-f]\{8\}$/\1 \2 \3 &/p' | sort -k1,1n -k2,2n -k3,3n | cut -d' ' -f4`, then `head -n -<keep>` equivalent portable (`awk -v k=14 '{a[NR]=$0} END{for(i=1;i<=NR-k;i++) print a[i]}'`), filter out the pinned tag. Test → pass.
- [ ] **Step 3: `dev-release.yml`**:
  ```yaml
  name: Dev release
  on:
    schedule: [{ cron: "43 2 * * *" }]
    workflow_dispatch:
      inputs:
        source_sha: { description: "commit on main (empty = origin/main)", required: false, type: string, default: "" }
        force: { description: "build even if unchanged", required: false, type: boolean, default: false }
  permissions: { contents: read }
  concurrency: { group: dev-release, cancel-in-progress: false }
  jobs:
    decide:
      runs-on: ubuntu-22.04
      outputs: { go: "${{ steps.d.outputs.go }}", sha: "${{ steps.d.outputs.sha }}", tag: "${{ steps.d.outputs.tag }}", version: "${{ steps.d.outputs.version }}" }
      steps:
        - uses: actions/checkout@v4
          with: { ref: main, fetch-depth: 0 }
        - id: d
          env: { GH_TOKEN: "${{ github.token }}", SRC: "${{ inputs.source_sha }}", FORCE: "${{ inputs.force }}" }
          run: |
            sha=${SRC:-$(git rev-parse origin/main)}; git merge-base --is-ancestor "$sha" origin/main || { echo "::error::$sha not on main"; exit 1; }
            sha8=$(echo "$sha" | cut -c1-8)
            last=$(gh release list --limit 50 --json tagName,isPrerelease -q '.[] | select(.isPrerelease) | .tagName' | grep '^dev-' | sort -t. -k1,1 -k2,2n | tail -1 || true)
            if [ "$FORCE" != true ] && [ -n "$last" ] && [ "${last##*-}" = "$sha8" ]; then echo "unchanged since $last"; echo "go=false" >> "$GITHUB_OUTPUT"; exit 0; fi
            ci=$(gh run list --workflow ci.yml --commit "$sha" --json conclusion -q '.[0].conclusion' || true)
            [ "$ci" = success ] || { echo "CI for $sha is '${ci:-missing}' — skipping"; echo "go=false" >> "$GITHUB_OUTPUT"; exit 0; }
            . scripts/release-lib.sh; base=$(last_stable_tag "$sha" | sed 's/^v//'); [ -n "$base" ] || base=0.0.0
            day=$(date -u +%Y%m%d)
            echo "go=true" >> "$GITHUB_OUTPUT"; echo "sha=$sha" >> "$GITHUB_OUTPUT"
            echo "tag=dev-$day.${{ github.run_number }}.${{ github.run_attempt }}-$sha8" >> "$GITHUB_OUTPUT"
            echo "version=$base-dev.$day.${{ github.run_number }}+$sha8" >> "$GITHUB_OUTPUT"
    build:
      needs: decide
      if: needs.decide.outputs.go == 'true'
      uses: ./.github/workflows/build-artifacts.yml
      with: { ref: "${{ needs.decide.outputs.sha }}", version: "${{ needs.decide.outputs.version }}", channel: dev }
    publish:
      needs: [decide, build]
      runs-on: ubuntu-22.04
      permissions: { contents: write, id-token: write, attestations: write }
      outputs: { meta: "${{ steps.h.outputs.meta }}", sums: "${{ steps.h.outputs.sums }}" }
      env: { GH_TOKEN: "${{ github.token }}", TAG: "${{ needs.decide.outputs.tag }}", VERSION: "${{ needs.decide.outputs.version }}", SHA: "${{ needs.decide.outputs.sha }}" }
      steps:
        - uses: actions/checkout@v4
          with: { ref: "${{ needs.decide.outputs.sha }}" }
        - uses: actions/download-artifact@v4
          with: { pattern: "agentglass-*", path: out, merge-multiple: true }
        - run: sh scripts/release-assets.sh out dev "$TAG" "$VERSION" "$SHA" && sh scripts/verify-release-assets.sh out
        - uses: actions/attest-build-provenance@v2
          with: { subject-path: "out/agentglass-*.tar.gz" }
        - run: |
            . scripts/release-lib.sh; prev=$(last_stable_tag "$SHA"); { echo "Dev build of \`$(echo $SHA | cut -c1-8)\` — not a stable release."; echo; changelog "$prev" "$SHA"; } > notes.md
            gh release create "$TAG" --draft --prerelease --target "$SHA" --title "agentglass $VERSION" --notes-file notes.md
            gh release upload "$TAG" out/*
            mkdir -p check && gh release download "$TAG" -D check && sh scripts/verify-release-assets.sh check
            gh release edit "$TAG" --draft=false --prerelease --latest=false
        - id: h
          run: |
            h() { sha256sum "$1" | cut -d' ' -f1; }
            echo "meta=$(h out/build-metadata.json)" >> "$GITHUB_OUTPUT"; echo "sums=$(h out/SHA256SUMS)" >> "$GITHUB_OUTPUT"
    tap:
      needs: [decide, publish]
      runs-on: ubuntu-22.04
      steps:
        - env: { GH_TOKEN: "${{ secrets.HOMEBREW_TAP_TOKEN }}" }
          run: |
            gh workflow run update-agentglass-dev.yml -R BjoernSchotte/homebrew-tap \
              -f dev_tag="${{ needs.decide.outputs.tag }}" -f source_sha="${{ needs.decide.outputs.sha }}" \
              -f request_id="${{ github.run_id }}-${{ github.run_attempt }}-${{ needs.decide.outputs.tag }}" \
              -f metadata_sha256="${{ needs.publish.outputs.meta }}" -f checksums_sha256="${{ needs.publish.outputs.sums }}"
    retention:
      needs: [decide, publish]
      runs-on: ubuntu-22.04
      permissions: { contents: write }
      steps:
        - uses: actions/checkout@v4
        - env: { GH_TOKEN: "${{ github.token }}" }
          run: |
            pinned=$(gh api repos/BjoernSchotte/homebrew-tap/contents/metadata/agentglass-dev.json -q .content 2>/dev/null | base64 -d | sed -n 's/.*"tag": *"\([^"]*\)".*/\1/p' || true)
            gh release list --limit 200 --json tagName -q '.[].tagName' | sh scripts/dev-retention.sh 14 "$pinned" | while read -r t; do gh release delete "$t" --cleanup-tag -y; done
  ```
  Tag-ordering note: the `last` lookup in `decide` must use the same (date, run, attempt) order as `dev-retention.sh` — reuse it: `… | sh scripts/dev-retention.sh 0 "" | tail -1` prints the newest when keep=0 lists all in ascending order (make `dev-retention.sh` with keep 0 print every dev tag ascending and cover that in the test).
- [ ] **Step 4: Verify without publishing** — run `sh scripts/dev-retention.test.sh`; push the branch and dispatch `gh workflow run dev-release.yml --ref <branch> -f source_sha=0000000000000000000000000000000000000000` → the run must fail in `decide` with "not on main" and create nothing (`gh release list` unchanged). The first real dev release happens in Task 8 after the user's approval.
- [ ] **Step 5: Commit** `ci: daily dev prerelease of green main, keep the newest 14`.

---

### Task 6: `install.sh`

**Files:**
- Create: `install.sh`, `scripts/install.test.sh`

**Interfaces:**
- Consumes: release asset names + `SHA256SUMS` (Tasks 4/5).
- Produces: `install.sh [--channel stable|dev] [--version <v|dev-tag>] [--prefix <dir>]`; env overrides for tests: `AGENTGLASS_RELEASES_API` (URL or `file://` JSON of `GET /repos/…/releases`), `AGENTGLASS_DOWNLOAD_BASE` (replaces `https://github.com/BjoernSchotte/agentglass/releases/download`). Writes `~/.agentglass/install.json`.

- [ ] **Step 1: Failing test `scripts/install.test.sh`**: builds `./agentglass` (local), packs it as `agentglass-<os>-<arch>.tar.gz` into a temp dir laid out as `<base>/<tag>/<asset>`, writes `SHA256SUMS`, a fake releases JSON (`[{"tag_name":"v2026.9.2","prerelease":false,"draft":false},{"tag_name":"dev-20260930.3.1-a1b2c3d4","prerelease":true,"draft":false},{"tag_name":"v2026.9.1",…}]`), then with `HOME=<tmp>` and both overrides as `file://` URLs asserts:
  - default → installs from `v2026.9.2` into `$HOME/.local/bin/agentglass`, executable, `install.json` = `{"method":"script","channel":"stable","path":"<abs path>","version":"2026.9.2"}`.
  - `--channel dev` → uses the dev tag; `install.json.channel` = `dev`.
  - `--version 2026.9.1` → uses `v2026.9.1`.
  - corrupted archive (hash mismatch) → exit ≠ 0, no binary written, message contains "checksum".
  - `--prefix` on a read-only dir → exit ≠ 0 with a clear message.
  - unsupported arch (`AGENTGLASS_TEST_UNAME_M=riscv64`) → exit ≠ 0 "unsupported".
- [ ] **Step 2: Implement `install.sh`** (POSIX sh, `set -eu`, all temp files in `mktemp -d` removed by `trap`):
  - OS/arch from `uname -s`/`uname -m` (`${AGENTGLASS_TEST_UNAME_M:-$(uname -m)}` for tests) → `linux|darwin` × `x64|arm64`, else error.
  - Tag: `--version X` → `vX` if `X` is a stable version, the dev tag if it starts with `dev-`; else resolve from the releases JSON: stable = highest `tag_name` matching the stable regex among `"prerelease":false,"draft":false`, dev = highest `dev-` tag among prereleases, compared with the same (date,run,attempt) / (Y,M,N) numeric sort as the release scripts (inline `awk`, no jq dependency).
  - Download archive + `SHA256SUMS` with `curl -fsSL --retry 2`; verify with `sha256sum -c` / `shasum -a 256 -c` restricted to the one archive line; extract to temp; `chmod 755`; install via `mv` into a temp name in `$prefix` then `mv` onto `$prefix/agentglass` (atomic); write `install.json` (version from `./agentglass --version`); warn if `$prefix` is not in `PATH`; print `agentglass <version> installed to <path>`.
- [ ] **Step 3: Run the test — pass.** Add to `ci.yml` a step `sh scripts/install.test.sh` on both OSes.
- [ ] **Step 4: Commit** `feat: install.sh for stable and dev binaries`.

---

### Task 7: `agentglass update`

**Files:**
- Create: `src/features/update.ts` (CLI + orchestration), `src/features/update-core.ts` (pure selection/verification helpers), `src/features/update.check.ts`, `scripts/update.test.sh`
- Modify: `src/platform/types.ts`, `src/platform/darwin.ts`, `src/platform/linux.ts` (+ `sha256File`), `src/util/config.ts` (+ `setConfig`), `src/main.ts` (import `./features/update.ts`), `src/features/cli.ts` (usage lines)

**Interfaces:**
- Consumes: `parseVersion`, `compareVersions`, `parseDevTag`, `versionOfTag`, `installMethod`, `BUILD` (Task 1); asset names (Tasks 4/5); env overrides `AGENTGLASS_RELEASES_API`, `AGENTGLASS_DOWNLOAD_BASE` (same meaning as in `install.sh`).
- Produces:
  ```ts
  // update-core.ts
  export interface Rel { tag: string; prerelease: boolean; draft: boolean; assets: string[] }
  export function relsFromJson(text: string): Rel[];                        // GitHub API array → Rel[] (assets = asset names)
  export function pickTarget(rels: Rel[], channel: string, tag: string, platform: string): Rel | null; // tag "" = newest of channel with all assets; else exact tag
  export function isDowngrade(installed: string, target: string): boolean;  // by compareVersions; unparsable installed (local) → false
  export function sumFor(sums: string, asset: string): string;              // hash for asset from SHA256SUMS text, "" if absent
  // Platform port
  sha256File(path: string): string;  // hex, "" on failure (linux: sha256sum, darwin: shasum -a 256)
  // util/config.ts
  export function setConfig(sectionName: string, key: string, value: string): void; // atomic merge into ~/.agentglass/config.json
  ```
  CLI: `agentglass update [status] [--channel stable|dev] [--tag T] [--dry-run] [--json] [--yes] [--force] [--rollback]`; exit 0 ok/up to date, 1 error, 2 refused (downgrade without consent, wrong install method).

- [ ] **Step 1: Failing check `src/features/update.check.ts`** — pure part:
  ```ts
  import { relsFromJson, pickTarget, isDowngrade, sumFor } from "./update-core.ts";
  let bad = 0; function ok(w: string, c: boolean, g: string): void { if (!c) { bad++; console.log("FAIL " + w + ": " + g); } }
  const A = (tag: string, pre: boolean, draft: boolean, assets: string[]) => ({ tag_name: tag, prerelease: pre, draft, assets: assets.map((n) => ({ name: n })) });
  const ALL = ["agentglass-linux-x64.tar.gz", "agentglass-linux-arm64.tar.gz", "agentglass-darwin-x64.tar.gz", "agentglass-darwin-arm64.tar.gz", "SHA256SUMS", "build-metadata.json"];
  const rels = relsFromJson(JSON.stringify([
    A("dev-20261002.9.1-cccccccc", true, false, ALL.slice(1)),              // newest dev but missing linux-x64
    A("dev-20261001.8.2-bbbbbbbb", true, false, ALL),
    A("dev-20261001.8.1-aaaaaaaa", true, false, ALL),
    A("v2026.10.1", false, true, ALL),                                      // draft
    A("v2026.9.10", false, false, ALL), A("v2026.9.9", false, false, ALL), A("nightly", true, false, ALL)]));
  const t = (c: string, tag: string) => { const r = pickTarget(rels, c, tag, "linux-x64"); return r ? r.tag : ""; };
  ok("stable skips drafts, numeric order", t("stable", "") === "v2026.9.10", t("stable", ""));
  ok("dev skips incomplete, attempt order", t("dev", "") === "dev-20261001.8.2-bbbbbbbb", t("dev", ""));
  ok("dev incomplete ok for another platform", pickTarget(rels, "dev", "", "linux-arm64")?.tag === "dev-20261002.9.1-cccccccc", "");
  ok("exact tag", t("stable", "v2026.9.9") === "v2026.9.9", t("stable", "v2026.9.9"));
  ok("exact tag missing", t("stable", "v2026.1.1") === "", "");
  ok("downgrade dev→stable", isDowngrade("2026.9.10-dev.20261001.8+bbbbbbbb", "2026.9.10"), "");
  ok("no downgrade stable→dev", !isDowngrade("2026.9.10", "2026.9.10-dev.20261001.8+bbbbbbbb"), "");
  ok("local never a downgrade", !isDowngrade("2026.9.10-local+abcdef12-dirty", "2026.9.9"), "");
  ok("sumFor", sumFor("aa  agentglass-linux-x64.tar.gz\nbb  SHA256SUMS\n", "agentglass-linux-x64.tar.gz") === "aa" && sumFor("", "x") === "", "");
  console.log(bad ? bad + " failed" : "update: all checks passed"); process.exit(bad ? 1 : 0);
  ```
  plus an end-to-end part driving the built binary is in Step 5 (shell), because swapping needs a real executable.
- [ ] **Step 2: Run — expect build failure.**
- [ ] **Step 3: Implement `update-core.ts`** (pure, no I/O): `relsFromJson` via `parse`/`arr`/`obj`; `pickTarget` filters `!draft`, channel `stable` → `versionOfTag(tag) !== ""` and `!prerelease`, `dev` → `parseDevTag(tag)` and `prerelease`; requires `agentglass-<platform>.tar.gz` and `SHA256SUMS` in assets; newest by `compareVersions` (stable) or (date, run, attempt) (dev); exact `tag` → that release if present, complete and not a draft. `isDowngrade(a, b)`: both parse and `compareVersions(b, a) < 0`, but `a.rank === 2` → false. `sumFor`: line split on whitespace, second field equals asset (tolerate a leading `*`).
- [ ] **Step 4: Implement `update.ts`**, registered via `H.cli.push` for `args[0] === "update"`:
  1. Parse flags; `status` → print `{installed: versionInfo(), channel: <config or stable>, latest: <pickTarget of that channel>}` (`--json` or text) and exit 0.
  2. `method = installMethod(process.execPath, BUILD.channel, installJson)`; `homebrew` → print `installed with Homebrew — run: brew upgrade agentglass` (or `brew uninstall agentglass && brew install bjoernschotte/tap/agentglass-dev` when `--channel dev`), exit 2; `source` without `--force` → `built from source — run: git pull && ./build.sh`, exit 2.
  3. `--rollback` → if `<execPath>.prev` exists: rename current → `.rollback-tmp`, `.prev` → execPath, `.rollback-tmp` → `.prev`; print both versions (run `.prev --version`); else exit 1.
  4. Channel = `--channel` or config `update.channel` or `stable`; fetch releases: `AGENTGLASS_RELEASES_API` (`file://` → `readText`) or `fetch("https://api.github.com/repos/BjoernSchotte/agentglass/releases?per_page=100", {headers: {"user-agent": "agentglass", accept: "application/vnd.github+json"}, signal: AbortSignal.timeout(20000)})`; non-200 → message incl. `x-ratelimit-remaining` when 0; exit 1.
  5. `target = pickTarget(rels, channel, tagArg, BUILD.platform)`; none → "no complete <channel> release for <platform>", exit 1. Target version: stable → `versionOfTag`; dev → download `build-metadata.json` and read `version`.
  6. Up to date (`compareVersions == 0` and same channel) → "already on <v>", exit 0. Downgrade → with `--yes` proceed; interactive TTY (`process.stdin.isTTY`) → prompt `downgrade <a> → <b>? [y/N]` read from stdin; otherwise refuse, exit 2.
  7. `--dry-run` → print `{channel, installed, target, tag, downgrade, method, actions:[…]}` (`--json` or text) and exit 0.
  8. Work dir `mkdtemp` **next to** the binary (`dirname(execPath)/.agentglass-update-XXXX`) so `rename` stays on one filesystem; unwritable → "cannot write to <dir> — reinstall with install.sh --prefix <writable dir>", exit 1.
  9. `curl -fsSL --retry 2 -o <work>/<asset> <base>/<tag>/<asset>` and `SHA256SUMS` (base = `AGENTGLASS_DOWNLOAD_BASE` or the GitHub download URL); `OS.sha256File` must equal `sumFor`; mismatch → "checksum mismatch", cleanup, exit 1.
  10. `tar -xzf` into `<work>/x`; candidate `<work>/x/agentglass`; `chmod 755`; run `candidate --version --json` (execFileSync, 10 s timeout) → must parse and have `version === target version` and `channel === channel`; else "downloaded binary failed its self-check", cleanup, exit 1.
  11. `copyFileSync(execPath, execPath + ".prev")`, `renameSync(candidate, execPath)`; then `setConfig("update", "channel", channel)` (only now); if `install.json` exists for this path, rewrite its `channel` and `version`; cleanup; print `updated <old> → <new> (<channel>)`.
  Every failure path removes the work dir and leaves `execPath` untouched.
- [ ] **Step 5: End-to-end test `scripts/update.test.sh`** (added to `scripts/check.sh` runs and CI): builds two binaries into a temp release tree — "old" `AGENTGLASS_VERSION=2026.9.1 AGENTGLASS_CHANNEL=stable ./build.sh` and "new" `2026.9.2` — packs `v2026.9.2` + `SHA256SUMS`, writes a fake API JSON, installs "old" as `$tmp/bin/agentglass` with a matching `install.json` (`HOME=$tmp`), then asserts:
  - `update --dry-run --json` → target `v2026.9.2`, binary unchanged;
  - `update` → `--version` prints `2026.9.2`, `agentglass.prev --version` prints `2026.9.1`, config `update.channel` = `stable`;
  - `update --rollback` → back to `2026.9.1`;
  - corrupted archive → exit 1, still `2026.9.1`, no `.agentglass-update-*` left;
  - archive whose binary reports another version → exit 1 "self-check", unchanged;
  - `--channel dev` to an older dev build with stdin not a TTY and no `--yes` → exit 2, unchanged; with `--yes` → switched, channel persisted `dev`;
  - binary under a path containing `/Cellar/` → exit 2 with the brew hint;
  - bin dir `chmod 555` → exit 1 with the reinstall hint, unchanged.
- [ ] **Step 6: Platform + config** — `sha256File` in `darwin.ts` (`run("shasum", ["-a", "256", path]).split(" ")[0]`) and `linux.ts` (`run("sha256sum", [path])…`); `setConfig` reads the file, merges `{[section]: {...old, [key]: value}}`, writes via tmp + `renameSync`. Run `sh scripts/check.sh` and `sh scripts/update.test.sh` — pass.
- [ ] **Step 7: Commit** `feat: agentglass update — stable/dev channels, checksum + self-check, atomic swap, rollback`.

---

### Task 8: Homebrew tap, README, first real dev release

**Files:**
- In `BjoernSchotte/homebrew-tap` (branch `agentglass`, PR — never push to its `main`): create `Formula/agentglass.rb`, `Formula/agentglass-dev.rb`, `metadata/agentglass-dev.json`, `.github/workflows/update-agentglass-dev.yml`, `scripts/agentglass_dev_release.rb` (+ its test if the atlcli one has a test harness), update `README.md`.
- In agentglass: `README.md` (Install, Releases & channels, maintainer notes: `release.sh`, `release-cut.yml`, secret `HOMEBREW_TAP_TOKEN` with `actions: write` on the tap and `contents: write` on agentglass).

**Interfaces:**
- Consumes: asset names, `build-metadata.json` schema, dev tag format, `--version` / `--version --json` output (Tasks 1–5); dispatch inputs used by `dev-release.yml` (`dev_tag`, `source_sha`, `request_id`, `metadata_sha256`, `checksums_sha256`).

- [ ] **Step 1: `Formula/agentglass.rb`** — mirror `Formula/atlcli.rb`: `desc "See every coding agent on your machine — live"`, `homepage "https://github.com/BjoernSchotte/agentglass"`, `license "Apache-2.0"`, `version "0.0.0"` and all four `sha256 "0"*64` placeholders (the existing generic "Update Formula" workflow fills them on the first stable release), URLs `https://github.com/BjoernSchotte/agentglass/releases/download/v#{version}/agentglass-<platform>.tar.gz`, `conflicts_with "agentglass-dev"`, `bin.install "agentglass"`, `test do assert_match version.to_s, shell_output("#{bin}/agentglass --version") end`. Verify the generic workflow's `sed` patterns match this file layout (platform comment/URL line followed by the `sha256` line) by running its update logic locally against a fake release dir.
- [ ] **Step 2: Dev formula + workflow** — copy `Formula/atlcli-dev.rb`, `metadata/atlcli-dev.json`, `.github/workflows/update-dev-formula.yml`, `scripts/dev_release.rb` to the agentglass names and replace: repository `BjoernSchotte/atlcli` → `BjoernSchotte/agentglass`, formula/class names, binary name, asset prefix, the dev-tag regex (`dev-YYYYMMDD.<run>.<attempt>-<sha8>` — same shape, confirm), the metadata schema id (`agentglass.homebrew-dev-pointer/v1`), concurrency group `agentglass-dev-formula`, and the formula test: `info = JSON.parse(shell_output("#{bin}/agentglass --version --json"))`, assert `channel == "dev"`, `commit == <source sha>`, `version == <dev version from build-metadata.json>`. The Homebrew formula `version` stays atlcli-style monotonic (`<YYYYMMDDHHMMSS>.<run>.<attempt>`). Keep atlcli files byte-identical (`git diff --stat` on the PR lists only new agentglass files + README).
- [ ] **Step 3: README (agentglass)** — Install section order: Homebrew (`brew install bjoernschotte/tap/agentglass`, dev: `agentglass-dev`), script (`curl -fsSL https://raw.githubusercontent.com/BjoernSchotte/agentglass/main/install.sh | sh`, `-s -- --channel dev`), from source; "Releases & channels" (version scheme, stable vs dev, `agentglass update …`); the "Local only" bullet gains "Only `agentglass update` talks to GitHub, and only when you run it."; maintainer notes as listed above.
- [ ] **Step 4: Hand-off gate (STOP and ask the user)** — before any real publication: the user must (a) add `HOMEBREW_TAP_TOKEN`, (b) approve and merge the tap PR, (c) approve merging the feature branch to `main`, (d) approve the first dev release dispatch and later the first stable `scripts/release.sh`. List exactly these four in the report.
- [ ] **Step 5: After approval — real dev run** (controller-driven): dispatch `dev-release.yml` with `force=true` on `main`; verify: prerelease with 6 assets + attestation; tap PR-merged workflow run updates `agentglass-dev`; on this machine `curl -fsSL …/install.sh | sh -s -- --channel dev --prefix /tmp/agtest-install` → `--version --json` channel `dev`; `agentglass update --dry-run` from that binary; `brew install bjoernschotte/tap/agentglass-dev && brew test agentglass-dev` (then uninstall). Record results.
- [ ] **Step 6: Commit** (agentglass) `docs: install via Homebrew or install.sh; releases and channels`.
