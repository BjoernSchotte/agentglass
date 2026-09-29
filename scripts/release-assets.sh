#!/bin/sh
# write SHA256SUMS + build-metadata.json next to the 4 archives: release-assets.sh <dir> <channel> <tag> <version> <source-sha>
set -e
dir="$1"; channel="$2"; tag="$3"; version="$4"; sha="$5"
if command -v sha256sum >/dev/null 2>&1; then H="sha256sum"; else H="shasum -a 256"; fi
cd "$dir"
$H agentglass-*.tar.gz | sort -k2 > SHA256SUMS
archives=$(awk '{printf "%s\"%s\":\"%s\"", (NR>1?",":""), $2, $1}' SHA256SUMS)
printf '{"schema":"agentglass.build-metadata/v1","version":"%s","channel":"%s","tag":"%s","sourceSha":"%s","builtAt":"%s","archives":{%s}}\n' \
  "$version" "$channel" "$tag" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$archives" > build-metadata.json
