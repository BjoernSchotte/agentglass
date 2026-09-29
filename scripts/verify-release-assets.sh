#!/bin/sh
# exit 0 iff <dir> holds exactly the 4 archives + SHA256SUMS + build-metadata.json and every archive matches SHA256SUMS
set -e
dir="$1"
want="SHA256SUMS agentglass-darwin-arm64.tar.gz agentglass-darwin-x64.tar.gz agentglass-linux-arm64.tar.gz agentglass-linux-x64.tar.gz build-metadata.json"
have=$(ls "$dir" | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//')
[ "$have" = "$want" ] || { echo "verify-release-assets: expected [$want], found [$have]" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then H="sha256sum"; else H="shasum -a 256"; fi
[ "$(wc -l < "$dir/SHA256SUMS" | tr -d ' ')" = 4 ] || { echo "verify-release-assets: SHA256SUMS must list 4 archives" >&2; exit 1; }
(cd "$dir" && $H -c SHA256SUMS >/dev/null) || { echo "verify-release-assets: checksum mismatch" >&2; exit 1; }
grep -q '"schema":"agentglass.build-metadata/v1"' "$dir/build-metadata.json" || { echo "verify-release-assets: bad build-metadata.json" >&2; exit 1; }
