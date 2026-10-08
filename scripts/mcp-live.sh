#!/bin/sh
# agentglass-mcp against the real Gemini CLI and pi (manual, not in check.sh; no model call): each host gets the
# server in an isolated HOME and must report it connected with 11 tools. Never touches your own agent configs.
#   sh scripts/mcp-live.sh <bin-dir>      (<bin-dir> holds agentglass and agentglass-mcp)
set -e
dir=$(cd "${1:?usage: mcp-live.sh <bin-dir>}" && pwd); t=$(mktemp -d)
trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
h="$t/home"; p="$t/proj"; mkdir -p "$h/.gemini" "$h/.pi/agent" "$p"; fail=0
printf '{"mcpServers":{"agentglass":{"command":"%s"}}}\n' "$dir/agentglass-mcp" | tee "$h/.gemini/settings.json" > "$h/.pi/agent/mcp.json"
printf '{"%s":"TRUST_FOLDER"}\n' "$p" > "$h/.gemini/trustedFolders.json"
if command -v gemini > /dev/null 2>&1; then
  o=$(cd "$p" && HOME="$h" GEMINI_CLI_HOME="$h" timeout 60 gemini mcp list 2>&1 || true)
  case "$o" in *"agentglass"*Connected*) echo "gemini: connected";; *) echo "FAIL gemini: $o"; fail=1;; esac
else echo "gemini: not on PATH, skipped"; fi
if command -v pi > /dev/null 2>&1; then
  o=$(cd "$p" && HOME="$h" PI_CODING_AGENT_DIR="$h/.pi/agent" timeout 60 pi mcp list --json 2>&1 || true)
  r=$(printf '%s' "$o" | python3 -c 'import json,sys; s=json.load(sys.stdin)["servers"][0]; print(s["state"], len(s["tools"]))' 2>/dev/null || echo "unreadable: $o")
  [ "$r" = "connected 11" ] && echo "pi: connected, 11 tools" || { echo "FAIL pi: $r"; fail=1; }
else echo "pi: not on PATH, skipped"; fi
exit $fail
