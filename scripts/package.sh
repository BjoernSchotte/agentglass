#!/bin/sh
# smoke-test the freshly built ./agentglass and pack it as dist/agentglass-<target>.tar.gz
set -e
target="$1"; want="$2"
got=$(./agentglass --version)
[ "$got" = "$want" ] || { echo "package.sh: built version '$got' != expected '$want'" >&2; exit 1; }
./agentglass --version --json | grep -q "\"platform\":\"$target\"" || { echo "package.sh: platform is not $target" >&2; exit 1; }
./agentglass --json --limit 1 >/dev/null
mkdir -p dist && tar -czf "dist/agentglass-$target.tar.gz" agentglass
