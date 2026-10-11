#!/bin/sh
# agentglass-web for the four release targets from one host (local-web-api §11): the UI built and embedded, Bun
# cross-compiles (x64 as baseline builds for older CPUs), the host's own target is smoke-run (--version), each packed as
# dist/agentglass-web-<target>.tar.gz.   sh scripts/build-web.sh <version> [target…]   (needs bun and pnpm)
set -e
version="$1"; shift; [ -n "$version" ] || { echo "usage: build-web.sh <version> [target…]" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd); cd "$here"
targets="${*:-linux-x64 linux-arm64 darwin-x64 darwin-arm64}"
pnpm --filter @agentglass/web build > /dev/null
(cd packages/bff && bun scripts/embed.ts > /dev/null)
case "$(uname -s)-$(uname -m)" in Linux-x86_64) host=linux-x64 ;; Linux-aarch64) host=linux-arm64 ;; Darwin-arm64) host=darwin-arm64 ;; Darwin-x86_64) host=darwin-x64 ;; *) host="" ;; esac
mkdir -p dist
for t in $targets; do
  case "$t" in linux-x64) b=bun-linux-x64-baseline ;; linux-arm64) b=bun-linux-arm64 ;; darwin-x64) b=bun-darwin-x64-baseline ;; darwin-arm64) b=bun-darwin-arm64 ;; *) echo "build-web: unknown target $t" >&2; exit 2 ;; esac
  o="dist/web-$t"; rm -rf "$o"; mkdir -p "$o"
  (cd packages/bff && bun build --compile --minify --target="$b" --define "process.env.AGENTGLASS_WEB_VERSION=\"$version\"" src/main.ts --outfile "$here/$o/agentglass-web" > /dev/null)
  if [ "$t" = "$host" ]; then
    got=$("$o/agentglass-web" --version); [ "$got" = "agentglass-web $version" ] || { echo "build-web: $t --version said '$got'" >&2; exit 1; }
  fi
  cp packages/ui/fonts/LICENSE-OFL.txt "$o/"
  tar -czf "dist/agentglass-web-$t.tar.gz" -C "$o" agentglass-web LICENSE-OFL.txt
  echo "dist/agentglass-web-$t.tar.gz $(wc -c < "dist/agentglass-web-$t.tar.gz" | tr -d ' ') bytes"
done
