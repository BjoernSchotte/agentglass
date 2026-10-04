#!/bin/sh
# agentglass compare: sessions by id or prefix, expressions, --json shape, exit 2 on bad input, no ANSI without a TTY
set -e
cd "$(dirname "$0")/.."
. ./scripts/toolchain.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
BIN="$T/agentglass"; if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$BIN"; else scriptc build src/main.ts -o "$BIN" >/dev/null; fi
mkdir -p "$T/home/.claude/projects/-w-app" "$T/home/.codex/sessions/2026/10/01" "$T/home/.agentglass"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
claude() { # id nCalls
  F="$T/home/.claude/projects/-w-app/$1.jsonl"
  printf '%s\n' "{\"type\":\"user\",\"timestamp\":\"$NOW\",\"cwd\":\"/w/app\",\"sessionId\":\"$1\",\"message\":{\"role\":\"user\",\"content\":\"run the tests\"}}" > "$F"
  i=0; while [ $i -lt "$2" ]; do i=$((i + 1))
    printf '%s\n' "{\"type\":\"assistant\",\"timestamp\":\"$NOW\",\"message\":{\"id\":\"m$1$i\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t$1$i\",\"name\":\"Bash\",\"input\":{\"command\":\"npm test\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}" \
      "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t$1$i\",\"content\":\"x\"}]},\"uuid\":\"u$1$i\",\"timestamp\":\"$NOW\"}" >> "$F"
  done
}
claude aaaaaa11 2
claude aaaaaa22 3
printf '%s\n' "{\"timestamp\":\"$NOW\",\"type\":\"session_meta\",\"payload\":{\"id\":\"bbbbbb33\",\"cwd\":\"/w/other\",\"model\":\"gpt-5\"}}" \
  "{\"timestamp\":\"$NOW\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}}" \
  > "$T/home/.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-bbbbbb33-1111-2222-3333-444455556666.jsonl"
ag() { HOME="$T/home" AGENTGLASS_CACHE_DIR="$T/cache" AGENTGLASS_CONFIG= AGENTGLASS_AGENT=0 AGENTGLASS_NOTIFY=0 "$BIN" "$@"; } # human output: not the agent-mode JSON errors
ag compare aaaaaa11 aaaaaa22 --json > "$T/c.json"
grep -q '"tools":2' "$T/c.json" && grep -q '"tools":3' "$T/c.json" || { echo "FAIL counts"; cat "$T/c.json"; exit 1; }
grep -q '"expr":"session is claude:aaaaaa11","n":1' "$T/c.json" || { echo "FAIL expr"; cat "$T/c.json"; exit 1; }
grep -q '"turns":1' "$T/c.json" || { echo "FAIL turns"; cat "$T/c.json"; exit 1; }
grep -q '"wallMs":[0-9][0-9]*,' "$T/c.json" || { echo "FAIL wall"; cat "$T/c.json"; exit 1; }
grep -q '"activeMs":[0-9][0-9]*,' "$T/c.json" || { echo "FAIL active"; cat "$T/c.json"; exit 1; }
grep -q '"costByMode":{"api":[0-9.]*,"plan":[0-9.]*,"metered":[0-9.]*,"gateway":[0-9.]*,"unknown":[0-9.]*}' "$T/c.json" || { echo "FAIL costByMode"; cat "$T/c.json"; exit 1; }
grep -q '"tools":\[{"tool":"Bash","a":{"n":2,"err":0,' "$T/c.json" || { echo "FAIL tools"; cat "$T/c.json"; exit 1; }
grep -q '"programs":\[{"program":"npm","a":{"n":2,"err":0},"b":{"n":3,"err":0}}\]' "$T/c.json" || { echo "FAIL programs"; cat "$T/c.json"; exit 1; }
grep -q '"files":{"onlyA":\[\],"onlyB":\[\],"both":\[\]}' "$T/c.json" || { echo "FAIL files"; cat "$T/c.json"; exit 1; }
grep -q '"subagents":true' "$T/c.json" || { echo "FAIL subagents flag"; cat "$T/c.json"; exit 1; }
ag compare claude:aaaaaa11 aaaaaa22 --no-subagents --json | grep -q '"subagents":false' || { echo "FAIL --no-subagents"; exit 1; }
set +e; err=$(ag compare aaaaaa aaaaaa22 2>&1); rc=$?; set -e
[ $rc = 2 ] && echo "$err" | grep -q 'is ambiguous: claude:aaaaaa11, claude:aaaaaa22' || { echo "FAIL ambiguous rc=$rc $err"; exit 1; }
set +e; err=$(ag compare aaaaaa11 aaaaaa11 2>&1); rc=$?; set -e; [ $rc = 2 ] && echo "$err" | grep -q 'A and B are the same' || { echo "FAIL same rc=$rc $err"; exit 1; }
set +e; err=$(ag compare aaaaaa11 2>&1); rc=$?; set -e; [ $rc = 2 ] && echo "$err" | grep -q 'needs two sessions' || { echo "FAIL missing rc=$rc $err"; exit 1; }
set +e; err=$(ag compare --a 'harness is claude' 2>&1); rc=$?; set -e; [ $rc = 2 ] && echo "$err" | grep -q -- '--b is missing' || { echo "FAIL missing --b rc=$rc $err"; exit 1; }
set +e; err=$(ag compare --a 'tol is Bash' --b 'harness is codex' 2>&1); rc=$?; set -e
[ $rc = 2 ] && echo "$err" | grep -q 'did you mean tool' && echo "$err" | grep -q '^  \^' || { echo "FAIL bad expr rc=$rc $err"; exit 1; }
set +e; err=$(ag compare zzzzzz99 aaaaaa22 2>&1); rc=$?; set -e; [ $rc = 2 ] && echo "$err" | grep -q 'session "zzzzzz99": no such session' || { echo "FAIL unknown rc=$rc $err"; exit 1; }
ag compare --a 'harness is claude' --b 'harness is codex' --json | grep -q '"expr":"harness is codex"' || { echo "FAIL exprs"; exit 1; }
ag compare --a 'harness is claude' --b 'harness is codex' --json | grep -q '"b":{"expr":"harness is codex","n":1,"metrics":{"cost":0,' || { echo "FAIL codex side"; ag compare --a 'harness is claude' --b 'harness is codex' --json; exit 1; }
ag compare --a 'harness is claude' --b 'harness is codex' --filter 'repo is app' | grep -q 'group B matched nothing: harness is codex' || { echo "FAIL scope"; exit 1; }
ESC=$(printf '\033'); ag compare aaaaaa11 aaaaaa22 > "$T/c.txt"
grep -q "$ESC" "$T/c.txt" && { echo "FAIL ansi"; exit 1; }
grep -q '^tool calls  *2  *3  *+1  *×1.5$' "$T/c.txt" || { echo "FAIL text row"; cat "$T/c.txt"; exit 1; }
grep -q 'small samples, no significance' "$T/c.txt" || { echo "FAIL tools section"; cat "$T/c.txt"; exit 1; }
ag compare --help | grep -q -- "--a '<expr>' --b '<expr>'" || { echo "FAIL help"; exit 1; }
ag --help | grep -q 'agentglass compare' || { echo "FAIL main help"; exit 1; }
echo "compare cli: all checks passed"
