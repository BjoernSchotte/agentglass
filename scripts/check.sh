#!/bin/sh
# build + run every self-check (src/**/*.check.ts) and shell test (scripts/*.test.sh); exit 1 if any fails
set -e
cd "$(dirname "$0")/.."
. ./scripts/toolchain.sh
sh scripts/build-info.sh
out=$(mktemp -d); fail=0
for f in $(find src -name '*.check.ts' | sort); do
  if ! scriptc build "$f" -o "$out/c" >"$out/log" 2>&1; then echo "BUILD FAIL $f"; cat "$out/log"; fail=1; continue; fi
  # hermetic: a fresh temp HOME/XDG per check and no agent-dir or agentglass path overrides from the caller, so no
  # check can read or write the user's real home (sessions, ~/.agentglass config, cache, run dir, palette, theme)
  rm -rf "$out/home"; mkdir -p "$out/home"
  if env -u GEMINI_CLI_HOME -u OPENCODE_DB -u PI_CODING_AGENT_DIR -u PI_CODING_AGENT_SESSION_DIR -u AGENTGLASS_CACHE_DIR \
    -u AGENTGLASS_CONFIG -u AGENTGLASS_RUN_DIR -u AGENTGLASS_PALETTE_FILE -u AGENTGLASS_THEME \
    HOME="$out/home" XDG_CONFIG_HOME="$out/home/.config" XDG_DATA_HOME="$out/home/.local/share" XDG_STATE_HOME="$out/home/.local/state" \
    XDG_CACHE_HOME="$out/home/.cache" AGENTGLASS_HERMETIC=1 \
    AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme "$out/c" >"$out/run" 2>&1; then echo "ok   $f: $(tail -1 "$out/run")"; else echo "FAIL $f"; cat "$out/run"; fail=1; fi
done
for f in $(find scripts -name '*.test.sh' | sort); do
  if sh "$f" >"$out/run" 2>&1; then echo "ok   $f: $(tail -1 "$out/run")"; else echo "FAIL $f"; cat "$out/run"; fail=1; fi
done
rm -rf "$out"; exit $fail
