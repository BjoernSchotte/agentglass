#!/bin/sh
# agentglass mcp install / doctor / bare mcp, with stub harness CLIs on PATH (never a real agent's config):
# printing runs nothing, --write needs --yes without a TTY and runs exactly the printed argv, OpenCode stays print-only,
# doctor speaks MCP to agentglass-mcp: sh scripts/mcp-install.test.sh
# check: builds 1
set -e
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
has() { case "$2" in *"$3"*) ;; *) echo "FAIL $1: '$3' not in: $2"; fail=1;; esac; }
command -v python3 > /dev/null 2>&1 || { echo "mcp-install: skipped (needs python3)"; exit 0; }
mkdir -p "$t/bin" "$t/stubs" "$t/h"
if [ -n "${AGENTGLASS_BIN:-}" ]; then
  cp "$AGENTGLASS_BIN" "$t/bin/agentglass"
  ( cd "$here" && . ./scripts/toolchain.sh && { [ -f src/build-info.ts ] || sh scripts/build-info.sh; } && scriptc build ${SCRIPTC_FLAGS:-} src/mcp/main.ts -o "$t/bin/agentglass-mcp" ) > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
else AGENTGLASS_OUT="$t/bin/agentglass" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
for s in claude codex gemini pi kiro-cli opencode; do printf '#!/bin/sh\necho "$(basename "$0") $*" >> "%s/calls.log"\n' "$t" > "$t/stubs/$s"; chmod +x "$t/stubs/$s"; done
: > "$t/calls.log"
run() { env -i HOME="$t/h" PATH="$t/bin:$t/stubs:/usr/bin:/bin" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES=/nonexistent \
  AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_HERDR=off AGENTGLASS_AGENT=0 "$@"; }

# print (the default): every harness found, its exact command; nothing runs
set +e; out=$(run agentglass mcp install < /dev/null); rc=$?; set -e
eq "install: exit" "$rc" 0
eq "install: 6 headings" "$(printf '%s\n' "$out" | grep -cE '^(Claude Code|Codex|Gemini CLI|pi|Kiro CLI|OpenCode)( |$)')" 6
has "install: claude" "$out" "claude mcp add --scope user agentglass -- agentglass-mcp"
has "install: codex toml" "$out" "[mcp_servers.agentglass]"
has "install: opencode snippet" "$out" '"mcp": {"agentglass": {"type": "local", "command": ["agentglass-mcp"], "enabled": true}}'
eq "install: ran nothing" "$(cat "$t/calls.log")" ""
# --write without a TTY and without --yes: refused, nothing runs
set +e; err=$(run agentglass mcp install --write < /dev/null 2>&1); rc=$?; set -e
eq "--write without --yes: exit 2" "$rc" 2
has "--write without --yes: hint" "$err" "--yes"
eq "--write without --yes: ran nothing" "$(cat "$t/calls.log")" ""
# --write --yes --harness claude: exactly the printed argv
run agentglass mcp install --write --yes --harness claude < /dev/null > "$t/w.out" 2>&1 || { echo "FAIL --write --yes: exit $?"; cat "$t/w.out"; fail=1; }
eq "--write --yes: the stub got the printed argv" "$(cat "$t/calls.log")" "claude mcp add --scope user agentglass -- agentglass-mcp"
has "--write --yes: reports the exit code" "$(cat "$t/w.out")" "exit 0"
: > "$t/calls.log"
run agentglass mcp install --write --yes --harness pi --scope project --redact < /dev/null > /dev/null 2>&1 || true
eq "--scope project --redact: pi" "$(cat "$t/calls.log")" "pi mcp add --local agentglass -- agentglass-mcp --redact"
: > "$t/calls.log"
set +e; o2=$(run agentglass mcp install --harness opencode --write --yes < /dev/null); rc=$?; set -e
eq "opencode --write: exit" "$rc" 0
has "opencode --write: print-only" "$o2" "print-only"
eq "opencode --write: ran nothing" "$(cat "$t/calls.log")" ""
set +e; run agentglass mcp install --harness cursor < /dev/null > /dev/null 2>&1; rc=$?; set -e
eq "unknown harness: exit 2" "$rc" 2
# inside an agent: JSON; --write still needs --yes
j=$(run CLAUDECODE=1 AGENTGLASS_AGENT= agentglass mcp install --harness claude,pi < /dev/null)
eq "agent: JSON" "$(printf '%s' "$j" | python3 -c 'import json,sys; d=json.load(sys.stdin); print([h["harness"] for h in d["harnesses"]], d["harnesses"][0]["argv"][:3])')" "['claude', 'pi'] ['claude', 'mcp', 'add']"
# no agentglass-mcp beside agentglass (a hand-copied binary): --write fails with the fix
mkdir "$t/lone"; cp "$t/bin/agentglass" "$t/lone/agentglass"
set +e; err=$(env -i HOME="$t/h" PATH="$t/stubs:/usr/bin:/bin" AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR="$t/cache" "$t/lone/agentglass" mcp install --write --yes --harness claude < /dev/null 2>&1); rc=$?; set -e
eq "no agentglass-mcp: exit 1" "$rc" 1
has "no agentglass-mcp: hint" "$err" "build.sh builds both"
eq "no agentglass-mcp: ran nothing" "$(cat "$t/calls.log")" ""

# bare `agentglass mcp`: a short text; misconfigured as the server (stdin not a TTY, no agent): exit 2 with the hint
set +e; err=$(run agentglass mcp < /dev/null 2>&1 > /dev/null); rc=$?; set -e
eq "bare mcp as a server: exit 2" "$rc" 2
eq "bare mcp as a server: hint" "$err" "the MCP server is agentglass-mcp: run agentglass mcp install"
has "bare mcp in an agent: JSON" "$(run CLAUDECODE=1 AGENTGLASS_AGENT= agentglass mcp < /dev/null)" '"server":"agentglass-mcp"'
has "mcp --help" "$(run agentglass mcp --help < /dev/null)" "agentglass mcp install"
has "help lists mcp" "$(run agentglass --help --format json < /dev/null | python3 -c 'import json,sys; print([c["cmd"] for c in json.load(sys.stdin)["commands"] if c["cmd"].startswith("mcp")])')" "'mcp install', 'mcp doctor'"
eq "compact agent help: no mcp" "$(run CLAUDECODE=1 AGENTGLASS_AGENT= agentglass < /dev/null | grep -c '"mcp' || true)" 0

# doctor: speaks MCP to agentglass-mcp from this shell (no agent around: no current session, said so)
set +e; d=$(run agentglass mcp doctor --json < /dev/null); rc=$?; set -e
eq "doctor: exit 0" "$rc" 0
eq "doctor --json" "$(printf '%s' "$d" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["ok"], d["tools"], d["protocol"], d["current"]["code"], d["toolsBytes"] > 4000, d["callMs"] >= 0)')" "True 11 2025-11-25 no_current_session True True"
dt=$(run agentglass mcp doctor < /dev/null); has "doctor text: no current session explained" "$dt" "expected outside an agent"
has "doctor text: tools" "$dt" "11 tools"
set +e; run AGENTGLASS_MCP_BIN=/nonexistent "$t/lone/agentglass" mcp doctor --json < /dev/null > "$t/d.json" 2>&1; rc=$?; set -e
eq "doctor without agentglass-mcp: exit 1" "$rc" 1

[ $fail = 0 ] && echo "mcp-install: all tests passed"
exit $fail
