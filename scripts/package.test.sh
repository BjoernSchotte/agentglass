#!/bin/sh
# scripts/package.sh with stub binaries: agentglass-mcp is required and must report the same version; the archive
# holds agentglass, agentglass-mcp and (when built) agentglass-receive-tls: sh scripts/package.test.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
# stub <file> <version>: answers --version, --version --json (linux-x64) and --json
stub() { printf '#!/bin/sh\ncase "$*" in "--version --json") echo '"'"'{"version":"%s","platform":"linux-x64"}'"'"';; --version) echo %s;; *) echo "[]";; esac\n' "$2" "$2" > "$1"; chmod 755 "$1"; }
pk() { (cd "$t/w" && OBJDUMP=true sh "$here/scripts/package.sh" linux-x64 2026.10.11 > "$t/out" 2>&1); }
mkdir -p "$t/w"; stub "$t/w/agentglass" 2026.10.11
if pk; then echo "FAIL packed without agentglass-mcp"; fail=1; fi
eq "missing agentglass-mcp named" "$(cat "$t/out")" "package.sh: agentglass-mcp missing (build.sh builds it beside agentglass)"
stub "$t/w/agentglass-mcp" 2026.10.10
if pk; then echo "FAIL packed an agentglass-mcp of another version"; fail=1; fi
eq "version mismatch named" "$(cat "$t/out")" "package.sh: agentglass-mcp version '2026.10.10' != '2026.10.11'"
stub "$t/w/agentglass-mcp" 2026.10.11
pk || { echo "FAIL package: $(cat "$t/out")"; fail=1; }
eq "archive" "$(tar -tzf "$t/w/dist/agentglass-linux-x64.tar.gz" | sort | tr '\n' ' ')" "agentglass agentglass-mcp "
stub "$t/w/agentglass-receive-tls" 2026.10.11
pk || { echo "FAIL package with tls: $(cat "$t/out")"; fail=1; }
eq "archive with tls" "$(tar -tzf "$t/w/dist/agentglass-linux-x64.tar.gz" | sort | tr '\n' ' ')" "agentglass agentglass-mcp agentglass-receive-tls "
[ $fail = 0 ] && echo "package: all tests passed"; exit $fail
