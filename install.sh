#!/bin/sh
# agentglass installer: curl -fsSL https://raw.githubusercontent.com/BjoernSchotte/agentglass/main/install.sh | sh
#   sh -s -- --channel dev          newest daily dev build instead of the newest stable release
#   sh -s -- --version 2026.9.1     a specific release (or a dev-… tag)
#   sh -s -- --prefix ~/bin         install directory (default ~/.local/bin)
# needs curl, tar and sha256sum (or shasum); verifies SHA256SUMS; replaces the binary atomically
set -eu

# everything runs from main(), called on the last line: a download cut off mid-way runs nothing
main() {
REPO="BjoernSchotte/agentglass"
API="${AGENTGLASS_RELEASES_API:-https://api.github.com/repos/$REPO/releases?per_page=100}"
BASE="${AGENTGLASS_DOWNLOAD_BASE:-https://github.com/$REPO/releases/download}"
channel=stable; want=""; prefix="$HOME/.local/bin"

die() { echo "install.sh: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) channel="${2:-}"; shift 2 ;;
    --version) want="${2:-}"; shift 2 ;;
    --prefix) prefix="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done
case "$channel" in stable|dev) ;; *) die "--channel must be stable or dev" ;; esac

case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) die "unsupported OS $(uname -s)" ;; esac
case "${AGENTGLASS_TEST_UNAME_M:-$(uname -m)}" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported architecture ${AGENTGLASS_TEST_UNAME_M:-$(uname -m)}" ;; esac
asset="agentglass-$os-$arch.tar.gz"
command -v curl >/dev/null 2>&1 || die "curl is required"
if command -v sha256sum >/dev/null 2>&1; then hash() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then hash() { shasum -a 256 "$1" | cut -d' ' -f1; }
else die "sha256sum or shasum is required"; fi

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT INT TERM

# release list → "tag draft prerelease" lines (tag_name precedes draft/prerelease in each GitHub release object)
releases() {
  curl -fsSL -H "User-Agent: agentglass-install" "$API" | tr ',{}' '\n\n\n' | awk '
    /"tag_name"/   { sub(/.*"tag_name"[ \t]*:[ \t]*"/, ""); sub(/".*/, ""); tag = $0; d = ""; p = "" }
    /"draft"/      { d = ($0 ~ /true/) ? "true" : "false" }
    /"prerelease"/ { p = ($0 ~ /true/) ? "true" : "false"; if (tag != "" && d != "") { print tag, d, p; tag = "" } }'
}
if [ -n "$want" ]; then
  case "$want" in dev-*) tag="$want" ;; v*) tag="$want" ;; *) tag="v$want" ;; esac
else
  list=$(releases) || die "cannot list releases from $API"
  if [ "$channel" = stable ]; then
    tag=$(echo "$list" | awk '$2 == "false" && $3 == "false" && $1 ~ /^v[0-9][0-9][0-9][0-9]\.[1-9][0-9]?\.[1-9][0-9]*$/ { v = substr($1, 2); split(v, a, "."); printf "%06d %04d %06d %s\n", a[1], a[2], a[3], $1 }' | sort | tail -1 | cut -d' ' -f4)
  else
    tag=$(echo "$list" | awk '$2 == "false" && $3 == "true" { print $1 }' |
      sed -n 's/^\(dev-\([0-9]\{8\}\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)-[0-9a-f]\{8\}\)$/\2 \3 \4 \1/p' | sort -k1,1n -k2,2n -k3,3n | tail -1 | cut -d' ' -f4)
  fi
  [ -n "$tag" ] || die "no $channel release found"
fi

echo "agentglass: downloading $tag ($os-$arch)"
curl -fsSL --retry 2 -o "$tmp/$asset" "$BASE/$tag/$asset" || die "cannot download $BASE/$tag/$asset"
curl -fsSL --retry 2 -o "$tmp/SHA256SUMS" "$BASE/$tag/SHA256SUMS" || die "cannot download SHA256SUMS for $tag"
expected=$(awk -v f="$asset" '{ n = $2; sub(/^\*/, "", n) } n == f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] && [ "$(hash "$tmp/$asset")" = "$expected" ] || die "checksum mismatch for $asset — not installed"
mkdir -p "$tmp/x" && tar -xzf "$tmp/$asset" -C "$tmp/x" agentglass || die "archive does not contain agentglass"
chmod 755 "$tmp/x/agentglass"
"$tmp/x/agentglass" --version >/dev/null 2>&1 || die "the downloaded agentglass does not run here$( [ "$os" = linux ] && echo " — Linux builds need glibc 2.36+ (found: $(ldd --version 2>&1 | head -1))" ); nothing changed — build from source instead"

mkdir -p "$prefix" 2>/dev/null || die "cannot write to $prefix — choose another --prefix"
prefix=$(cd "$prefix" && pwd -P)   # physical path: agentglass compares it with its resolved executable path
new="$prefix/.agentglass.new.$$"
cp "$tmp/x/agentglass" "$new" 2>/dev/null || die "cannot write to $prefix — choose another --prefix"
mv -f "$new" "$prefix/agentglass" || { rm -f "$new"; die "cannot write to $prefix — choose another --prefix"; }

version=$("$prefix/agentglass" --version 2>/dev/null || echo unknown)
mkdir -p "$HOME/.agentglass"
printf '{"method":"script","channel":"%s","path":"%s","version":"%s"}\n' "$channel" "$prefix/agentglass" "$version" > "$HOME/.agentglass/install.json"
echo "agentglass $version installed to $prefix/agentglass"
case ":$PATH:" in *":$prefix:"*) ;; *) echo "note: $prefix is not on your PATH — add it, e.g. export PATH=\"$prefix:\$PATH\"" ;; esac
}

main "$@"
