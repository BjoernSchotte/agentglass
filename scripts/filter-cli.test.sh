#!/bin/sh
# --filter for --json/--watch, exit codes and caret, --harness/--live sugar, --pinned, filter keys in --help
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR # hermetic: the fake HOME decides, not the caller's overrides
cd "$(dirname "$0")/.."
. ./scripts/toolchain.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# AGENTGLASS_BIN: a prebuilt binary (scripts/check.sh builds one for every test), else build one here
BIN="$T/agentglass"; if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$BIN"; else scriptc build src/main.ts -o "$BIN" >/dev/null; fi
mkdir -p "$T/home/.claude/projects/-w-app" "$T/home/.codex/sessions/2026/10/01" "$T/home/.agentglass"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '%s\n' "{\"type\":\"user\",\"timestamp\":\"$NOW\",\"cwd\":\"/w/app\",\"sessionId\":\"c1\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}" \
  "{\"type\":\"assistant\",\"timestamp\":\"$NOW\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"Bash\",\"input\":{\"command\":\"npm test\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}" \
  "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t1\",\"is_error\":true,\"content\":\"x\"}]},\"uuid\":\"u2\",\"timestamp\":\"$NOW\"}" \
  > "$T/home/.claude/projects/-w-app/c1.jsonl"
printf '%s\n' "{\"timestamp\":\"$NOW\",\"type\":\"session_meta\",\"payload\":{\"id\":\"x1\",\"cwd\":\"/w/other\",\"model\":\"gpt-5\"}}" \
  "{\"timestamp\":\"$NOW\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}}" \
  > "$T/home/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-0000aaaa-1111-2222-3333-444455556666.jsonl"
ag() { HOME="$T/home" AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR="$T/cache" AGENTGLASS_NOTIFY=0 "$BIN" "$@"; }
ids() { grep -o '"id":"[^"]*"' | sort | tr '\n' ' '; }
[ "$(ag --json | grep -o '"id":"' | wc -l)" -eq 2 ] || { echo "FAIL two sessions: $(ag --json)"; exit 1; }
plain=$(ag --json | ids)
[ -s "$T/cache/ledger.jsonl" ] && [ "$(ls "$T/cache/calls" | grep -c '\.json$')" -eq 2 ] || { echo "FAIL plain --json keeps its index: $(ls -R "$T/cache")"; exit 1; }
[ "$(ag --json --filter 'tool is Bash and status is error' | ids)" = '"id":"c1" ' ] || { echo "FAIL same-call"; exit 1; }
[ -s "$T/cache/ledger.jsonl" ] && [ "$(ls "$T/cache/calls" | grep -c '\.json$')" -eq 2 ] || { echo "FAIL a ledger filter keeps its index: $(ls -R "$T/cache")"; exit 1; }
[ "$(ag --json | ids)" = "$plain" ] || { echo "FAIL plain --json over a saved ledger (rows not loaded)"; exit 1; }
[ "$(ag --json --filter 'tool is Bash' | ids)" = '"id":"c1" ' ] || { echo "FAIL rows from the saved calls files"; exit 1; }
[ "$(ag --json --filter 'tool is Bash and status is ok' | ids)" = '' ] || { echo "FAIL same-call negative"; exit 1; }
[ "$(ag --json --filter 'harness is codex' | grep -o '"id":"' | wc -l)" -eq 1 ] || { echo "FAIL harness"; exit 1; }
[ "$(ag --json --harness codex)" = "$(ag --json --filter 'harness is codex')" ] || { echo "FAIL --harness sugar"; exit 1; }
[ "$(ag --json --filter 'repo is app' --filter 'model ~ sonnet' | ids)" = '"id":"c1" ' ] || { echo "FAIL repeated --filter"; exit 1; }
[ "$(ag --json --filter 'hello' | ids)" = '"id":"c1" ' ] || { echo "FAIL bare word"; exit 1; }
set +e; err=$(ag --json --filter 'tol is Bash' 2>&1 >/dev/null); rc=$?; set -e
[ $rc = 2 ] || { echo "FAIL exit $rc"; exit 1; }
echo "$err" | grep -q 'unknown key "tol" — did you mean tool?' || { echo "FAIL msg: $err"; exit 1; }
echo "$err" | grep -q '^  \^' || { echo "FAIL caret: $err"; exit 1; }
set +e; err=$(ag --json --filter 'cost > abc' 2>&1 >/dev/null); rc=$?; set -e
[ $rc = 2 ] && echo "$err" | grep -q '^         \^' || { echo "FAIL caret column: $err"; exit 1; }
printf '{"filter":{"pinned":"harness is codex"}}\n' > "$T/home/.agentglass/config.json"
[ "$(ag --json | grep -o '"id":"' | wc -l)" -eq 2 ] || { echo "FAIL pins applied without --pinned"; exit 1; }
[ "$(ag --json --pinned | grep -o '"id":"' | wc -l)" -eq 1 ] || { echo "FAIL --pinned"; exit 1; }
printf '{"filter":{"pinned":"harness is codex","remember":false}}\n' > "$T/home/.agentglass/config.json"
[ "$(ag --json --pinned | grep -o '"id":"' | wc -l)" -eq 2 ] || { echo "FAIL remember false"; exit 1; }
set +e; err=$(ag --watch --filter 'duration > 1s' 2>&1 >/dev/null); rc=$?; set -e
[ $rc = 2 ] || { echo "FAIL watch duration rc=$rc"; exit 1; }
echo "$err" | grep -q 'known only after the call' || { echo "FAIL watch msg: $err"; exit 1; }
# not through ag(): $! of a backgrounded function is its subshell, and killing that leaves agentglass running
HOME="$T/home" AGENTGLASS_AGENT=0 AGENTGLASS_CACHE_DIR="$T/cache" AGENTGLASS_NOTIFY=0 "$BIN" --watch --from-start --filter 'tool is Bash' > "$T/watch.out" 2>/dev/null & p=$!
sleep 2; kill $p 2>/dev/null || true; wait $p 2>/dev/null || true
w=$(cat "$T/watch.out")
echo "$w" | grep -q '"kind":"tool","tool":"Bash"' || { echo "FAIL watch tool: $w"; exit 1; }
echo "$w" | grep -q '"kind":"result"' || { echo "FAIL watch result of the call: $w"; exit 1; }
! echo "$w" | grep -q '"kind":"user"' || { echo "FAIL watch user dropped: $w"; exit 1; }
echo "$w" | grep -q '"kind":"tool","tool":"Bash","id":"t1"' || { echo "FAIL watch tool line carries its call id: $w"; exit 1; }
echo "$w" | grep -q '"kind":"result","tool":null,"id":"t1"' || { echo "FAIL watch result line carries its call id: $w"; exit 1; }
ag --watch --for 1s --filter 'event is alert' > /dev/null || { echo "FAIL event is alert"; exit 1; }
ag --help | grep -q '^filter keys: harness repo' || { echo "FAIL help keys"; exit 1; }
ag --help | grep -q -- "--filter '<expr>'" || { echo "FAIL help option"; exit 1; }
echo "filter cli: all checks passed"
