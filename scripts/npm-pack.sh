#!/bin/sh
# the npm packages of agentglass-web from the release archives: the four platform packages (each holds its binary) and
# agentglass-web (the launcher, optional dependencies on them), all at <version>; no package has a scripts field.
#   sh scripts/npm-pack.sh <version> <dir with agentglass-web-<target>.tar.gz> <out dir> [target…]
set -e
version="$1"; dir="$2"; out="$3"; shift 3 || { echo "usage: sh scripts/npm-pack.sh <version> <archives dir> <out dir> [target…]" >&2; exit 2; }
here=$(cd "$(dirname "$0")/.." && pwd); dir=$(cd "$dir" && pwd); mkdir -p "$out"; out=$(cd "$out" && pwd)
targets="${*:-linux-x64 linux-arm64 darwin-arm64 darwin-x64}"
w=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$w"' EXIT
# set <file> <version>: the version, and the optional dependencies' versions
set_version() { node -e 'const f=process.argv[1],v=process.argv[2],fs=require("fs"),o=JSON.parse(fs.readFileSync(f,"utf8"));o.version=v;for(const k of Object.keys(o.optionalDependencies||{}))o.optionalDependencies[k]=v;if(o.scripts){console.error("npm-pack: "+f+" has a scripts field");process.exit(1)}fs.writeFileSync(f,JSON.stringify(o,null,2)+"\n")' "$1" "$2"; }
for t in $targets; do
  n="$t"; [ "$t" = darwin-x64 ] && n=darwin-x64-baseline
  p="$w/$n"; mkdir -p "$p/bin"; cp "$here/npm/platforms/$n/package.json" "$p/"
  tar -xzf "$dir/agentglass-web-$t.tar.gz" -C "$w" agentglass-web LICENSE-OFL.txt
  mv "$w/agentglass-web" "$p/bin/agentglass-web"; mv "$w/LICENSE-OFL.txt" "$p/"; chmod 755 "$p/bin/agentglass-web"
  set_version "$p/package.json" "$version"
  (cd "$p" && npm pack --silent --pack-destination "$out" > /dev/null)
done
m="$w/main"; mkdir -p "$m/bin"; cp "$here/npm/agentglass-web/package.json" "$here/npm/agentglass-web/README.md" "$m/"; cp "$here/npm/agentglass-web/bin/agentglass-web.js" "$m/bin/"
set_version "$m/package.json" "$version"
(cd "$m" && npm pack --silent --pack-destination "$out" > /dev/null)
ls "$out"
