#!/bin/sh
# build + run every self-check (src/**/*.check.ts) and shell test (scripts/*.test.sh); exit 1 if any fails
set -e
cd "$(dirname "$0")/.."
. ./scripts/toolchain.sh
sh scripts/build-info.sh
out=$(mktemp -d); fail=0
for f in $(find src -name '*.check.ts' | sort); do
  if ! scriptc build "$f" -o "$out/c" >"$out/log" 2>&1; then echo "BUILD FAIL $f"; cat "$out/log"; fail=1; continue; fi
  if AGENTGLASS_RULES=/nonexistent AGENTGLASS_NOTIFY=0 AGENTGLASS_REDACT=1 AGENTGLASS_REDACT_KEEP=keepme "$out/c" >"$out/run" 2>&1; then echo "ok   $f: $(tail -1 "$out/run")"; else echo "FAIL $f"; cat "$out/run"; fail=1; fi
done
for f in $(find scripts -name '*.test.sh' | sort); do
  if sh "$f" >"$out/run" 2>&1; then echo "ok   $f: $(tail -1 "$out/run")"; else echo "FAIL $f"; cat "$out/run"; fail=1; fi
done
rm -rf "$out"; exit $fail
