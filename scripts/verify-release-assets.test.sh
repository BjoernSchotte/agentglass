#!/bin/sh
# tests for release-assets.sh + verify-release-assets.sh: sh scripts/verify-release-assets.test.sh
set -e
here=$(cd "$(dirname "$0")" && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0
mkfix() { rm -rf "$t/r"; mkdir -p "$t/r"; for p in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do echo "bin $p" > "$t/r/agentglass-$p.tar.gz"; done
  sh "$here/release-assets.sh" "$t/r" stable v2026.9.1 2026.9.1 0123456789abcdef0123456789abcdef01234567 >/dev/null; }
expect() { if sh "$here/verify-release-assets.sh" "$t/r" >/dev/null 2>&1; then got=0; else got=1; fi; [ "$got" = "$2" ] || { echo "FAIL $1: exit $got, want $2"; fail=1; }; }
mkfix; expect "complete set" 0
grep -q '"schema":"agentglass.build-metadata/v1"' "$t/r/build-metadata.json" && grep -q '"version":"2026.9.1"' "$t/r/build-metadata.json" && grep -q '"agentglass-darwin-arm64.tar.gz":"' "$t/r/build-metadata.json" || { echo "FAIL metadata content"; fail=1; }
[ "$(wc -l < "$t/r/SHA256SUMS" | tr -d ' ')" = 4 ] || { echo "FAIL SHA256SUMS lines"; fail=1; }
mkfix; rm "$t/r/agentglass-linux-arm64.tar.gz"; expect "missing archive" 1
mkfix; echo x >> "$t/r/agentglass-darwin-x64.tar.gz"; expect "corrupted archive" 1
mkfix; echo x > "$t/r/extra.txt"; expect "unexpected file" 1
mkfix; rm "$t/r/build-metadata.json"; expect "missing metadata" 1
mkfix; rm "$t/r/SHA256SUMS"; expect "missing sums" 1
[ $fail = 0 ] && echo "release assets: all tests passed"; exit $fail
