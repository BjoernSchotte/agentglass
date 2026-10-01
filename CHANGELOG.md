# Changelog

All notable changes to agentglass. Versions are `YYYY.M.N` (N counts releases within the month).

## 2026.10.2

### Features

- **gemini:** tokens, cost and tool stats; built-in Gemini prices (56071ae, [#8](https://github.com/BjoernSchotte/agentglass/pull/8))
- **gemini:** sessions, subagents, transcript, busy and trash (b536bbc, [#8](https://github.com/BjoernSchotte/agentglass/pull/8))
- **gemini:** normalizing source — upserts, rewinds and checkpoints become an append-only stream (1ae13af, [#8](https://github.com/BjoernSchotte/agentglass/pull/8))
- **gemini:** register the Gemini CLI adapter and detect its processes (6d3d614, [#8](https://github.com/BjoernSchotte/agentglass/pull/8))
- **opencode:** read sessions over the service daemon's HTTP API when sqlite3 is unavailable (dfb3a51, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))
- **util:** JSON GET through the curl CLI, credentials via stdin (a96557c, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))
- **harness:** SessionSource cursor epoch — readers and ledger reset when it changes (5b7fa59, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))
- **pi:** link subagents to their spawning call, count --no-session subagent cost (045ad52, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))
- **pi:** find subagent sessions of the pi-subagents packages and nest them (e153dbe, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))
- **pi:** transcript shows codemode code, MCP proxy targets and nested calls (93ae4a4, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))
- **pi:** count tool calls nested in codemode and mcpScript (76ad511, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))
- **pi:** MCP calls under mcp__<server>__<tool>, adapter errors count (0d5c36f, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))

### Fixes

- **procs:** node flags with a separate value are not the script (426e94b, [#9](https://github.com/BjoernSchotte/agentglass/pull/9))
- **pricing:** a prices.json price replaces the built-in tiers it does not name (fd89fe4, [#9](https://github.com/BjoernSchotte/agentglass/pull/9))
- **gemini:** review — replaced files re-indexed, unpriced variants, drop counts, trash leftovers (5a5d42c, [#8](https://github.com/BjoernSchotte/agentglass/pull/8))
- **gemini:** finished subagents idle, drop counts of visible messages, tool subjects (4fcb32c, [#8](https://github.com/BjoernSchotte/agentglass/pull/8))
- **opencode,pi:** busy set read after the messages, revert-safe refetch, no made-up subagent ids (ae1fc08, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))
- **pi,opencode:** one row per MCP tool, curl ignores curlrc/proxy, sqlite3 hiccups keep SQLite (42cf41c, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))

### Refactoring & other

- **usage:** retool primitive; pi records calls through one helper (156a75b, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))

### Docs

- Gemini CLI in the README (aba9f42, [#8](https://github.com/BjoernSchotte/agentglass/pull/8))
- pi MCP and subagents, OpenCode without sqlite3 (5b7464a, [#7](https://github.com/BjoernSchotte/agentglass/pull/7))
- **specs:** gemini — observed initial $set.messages and headless trust check; decisions recorded (fcd07ec)
- **specs:** pi MCP + pi subagents + OpenCode HTTP reader; Gemini CLI harness — specs and implementation plans (a9d3109)

## 2026.10.1

### Features

- **release:** credit contributors and link PRs in release notes (283992e, [#6](https://github.com/BjoernSchotte/agentglass/pull/6))

### Fixes

- **usage:** bump ledger cache to v4 so kiro turns already booked are re-dated (59689e1, [#4](https://github.com/BjoernSchotte/agentglass/pull/4))
- **kiro:** parse end_timestamp as ISO string, not num() (dbe5f7e, [#4](https://github.com/BjoernSchotte/agentglass/pull/4))

### Build & CI

- drop the temporary build probe (debian:12 matrix verified 4/4) (763cf02, [#5](https://github.com/BjoernSchotte/agentglass/pull/5))
- **linux:** build in debian:12 so binaries need only glibc 2.36 (1b59c6d, [#5](https://github.com/BjoernSchotte/agentglass/pull/5))

### Refactoring & other

- **kiro:** cover ISO-string end_timestamp in day attribution (44ae6ff, [#4](https://github.com/BjoernSchotte/agentglass/pull/4))

### Docs

- **changelog:** credit @tgitchel-ae for the Kiro harness in 2026.9.2 (5c9dd8e, [#6](https://github.com/BjoernSchotte/agentglass/pull/6))
- brew trust the tap before installing agentglass-dev (224b30f)

### Contributors

- @tgitchel-ae ([#4](https://github.com/BjoernSchotte/agentglass/pull/4))

## 2026.9.2

### Features

- **kiro:** kiro-cli harness adapter on the HarnessAdapter port (939cd4d)

### Fixes

- **kiro:** date tool calls by turn, fall back to file mtime (0d88e46)

### Refactoring & other

- **kiro:** subagent and compaction-overflow calls keep their own day (327e581)

### Contributors

- @tgitchel-ae (Kiro harness, [#2](https://github.com/BjoernSchotte/agentglass/pull/2))

## 2026.9.1

### Features

- agentglass update — stable/dev channels, checksum + self-check, atomic swap, rollback (7184fc3)
- install.sh for stable and dev binaries (34ab58f)
- **opencode:** OpenCode 2.x/1.x harness adapter via sqlite3 (635b28c)
- **pi:** pi coding agent harness adapter (40f9489)
- **prices:** opt-in community price lists (LiteLLM / models.dev), cached locally (cbbe491)
- **platform:** port/adapter for OS specifics, Linux support (ebcd514)
- **redact:** privacy mode for screencasts (--redact / AGENTGLASS_REDACT=1) (a92492b)
- **stats:** per-tool errors, durations and drill-down (shell programs, changed files, slowest calls) (bbb3f8b)
- **callgraph:** DevTools-style flame chart + call tree per session (c) (477a885)
- **usage:** persist the ledger to ~/.agentglass/cache so restarts resume instead of re-indexing (bf426aa)
- **usage:** token/cost ledger, Stats tab, preview usage line, header cost widget (6395b72)
- **watchdog:** attention alarm and stuck detection (21d4bd6)
- **ui:** live agent ticker in the header + color themes (4ab140a)
- **cli:** --json snapshot, --watch JSONL event stream, --help, --version (7e73d82)
- **replay:** time-lapse playback of a transcript (P) (60b81f8)
- **hooks:** H.complete for blocking per-session computation used by exports (bad8176)
- **detail:** syntax highlighting, pretty JSON/YAML, foldable blocks (4620414)
- event drill-down and full mouse support (1c7fa4e)
- full keyboard-shortcut popup layer on ? (7533a02)
- first-class fx (vercel-labs) support (4004499)
- group subagents under their session with live status and drilldown (cef1ab2)
- agentglass TUI for browsing and steering coding-agent sessions (ac02f8b)

### Fixes

- **release:** never touch a published release; keep the pinned dev build when the pin can't be read; update/install hardening (c811540)
- **update:** recognise install.sh installs behind symlinked paths (macOS /var → /private/var) (3cb85c0)
- **opencode:** bound a read by the bytes of its rows (a920c87)
- **cli:** warnings to stderr in --json/--watch; sqlite3 note and aligned --help (4059688)
- **procs:** don't SIGTERM a shared OpenCode daemon (9bd64a4)
- **opencode:** hold streaming rows without the daemon too (258c32c)
- **opencode:** skip fork copies in usage (02a02d6)
- **pi:** busy from events only; !bash is not a turn (59fdcba)
- **opencode:** bound the read horizon to the current turn; busy only while the daemon lives (535a4c8)
- **harness:** align reads in 64 KB chunks and never starts mid-record (1fff248)
- **linux:** keep the last cpu sample when refreshes come < 500 ms apart (1a73648)
- **build:** find scriptc/Node 24 on PATH or any nvm install, check for clang (dd41b58)
- **stats:** replace ⟳/✎ with single-width arrows (fallback fonts drew them double-wide) (864eb6b)
- **ui:** fixed header widgets before the flexible ticker (H.headerFlex), compact stats; feature footer hints first (05acdf1)
- **detail:** no blank rows from padded output, aligned diff continuations, w toggles wrap/cut (cb41f56)
- truncate footer to terminal width and disable autowrap while running (b3515b1)

### Refactoring & other

- **install:** keep the riscv64 override out of later runs (bash --posix keeps prefix assignments on functions) (0fd98dd)
- **install:** report failing install runs instead of aborting silently (d9818d3)
- drop the temporary build probe (matrix verified: 4/4 green) (96c43d1)
- daily dev prerelease of green main, keep the newest 14 (9815f3a)
- stable release on tag push, drafts until every asset is there (d775776)
- build Linux on 24.04 (glibc >= 2.36), macOS x64 with scriptc's C backend (2d5748d)
- release-lib, release.sh and CHANGELOG.md (bf3739e)
- checks on every push; reusable 4-platform build (8aa2ec6)
- version and channel from the git tag, baked in at build time (c70eded)
- **harness:** steering gets the session; optional files/search; liveness by cwd; exact cost (41fee0e)
- **harness:** SessionSource port — readers go through the adapter's source (503300d)
- **specs:** real pi and OpenCode fixture sessions (26d1822)
- **harness:** HarnessAdapter port + registry, one file per agent (f8b6056)
- ignore specs/internals (ee7006d)
- **redact:** drop built-in project word; user words live in ~/.agentglass/redact.txt (1622b43)
- split into modules with extension hooks (e532194)
- ignore scriptc llvm artifacts (8570519)

### Docs

- install via Homebrew or install.sh; releases and channels (7884b5d)
- **specs:** release management — implementation plan (5625b83)
- **specs:** release management — CalVer stable + daily dev channel, brew tap, install.sh, agentglass update (e13aa23)
- pi and OpenCode in the README (019ddfe)
- **specs:** pi + OpenCode harness adapters — spec and implementation plan (05bf290)
- embed the launch video player in the README (8dcd74d)
- launch video (mp4 + webm), redacted screenshots and a README rework for the new features (78a5116)
- README covers replay, costs/stats, attention, stuck detection, ticker, themes, --json/--watch (b401724)
- launch-ready README with elevator pitch; license under Apache-2.0 (751f854)
