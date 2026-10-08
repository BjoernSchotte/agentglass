#!/bin/sh
# smoke-test the freshly built ./agentglass (and ./agentglass-mcp) and pack them as dist/agentglass-<target>.tar.gz
set -e
target="$1"; want="$2"
got=$(./agentglass --version)
[ "$got" = "$want" ] || { echo "package.sh: built version '$got' != expected '$want'" >&2; exit 1; }
./agentglass --version --json | grep -q "\"platform\":\"$target\"" || { echo "package.sh: platform is not $target" >&2; exit 1; }
./agentglass --json --limit 1 >/dev/null
# macOS builds read processes through libproc (build.sh adds --ffi): one without it would silently spawn ps and lsof again
case "$target" in darwin-*) nm -u ./agentglass | grep -q '_proc_listallpids' || { echo "package.sh: $target binary has no libproc binding (build.sh --ffi)" >&2; exit 1; } ;; esac
# Linux builds promise glibc 2.36+ (Debian 12): refuse a binary that needs anything newer
case "$target" in linux-*) sh "$(dirname "$0")/glibc-floor.sh" ./agentglass 2.36 || { echo "package.sh: $target binary needs a newer glibc than 2.36" >&2; exit 1; } ;; esac
# the MCP server (spec mcp-server §11) ships in every archive: build.sh builds it beside agentglass, for every target
[ -x agentglass-mcp ] || { echo "package.sh: agentglass-mcp missing (build.sh builds it beside agentglass)" >&2; exit 1; }
mv=$(./agentglass-mcp --version) && [ "$mv" = "$want" ] || { echo "package.sh: agentglass-mcp version '$mv' != '$want'" >&2; exit 1; }
# the optional built-in HTTPS receiver (otlp-hub 11.4) ships in the same archive when its C-backend build passed
extra=""; if [ -x agentglass-receive-tls ]; then
  tv=$(./agentglass-receive-tls --version) && [ "$tv" = "$want" ] || { echo "package.sh: agentglass-receive-tls version '$tv' != '$want'" >&2; exit 1; }
  extra=agentglass-receive-tls
fi
mkdir -p dist && tar -czf "dist/agentglass-$target.tar.gz" agentglass agentglass-mcp $extra
