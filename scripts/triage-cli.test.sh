#!/bin/sh
# agentglass triage: --json shape, guards as answers, no ANSI without a TTY, exit 2 on bad input
set -e
cd "$(dirname "$0")/.."
. ./scripts/toolchain.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
BIN="$T/agentglass"; scriptc build src/main.ts -o "$BIN" >/dev/null
mkdir -p "$T/home/.claude/projects/-w-app" "$T/home/.agentglass"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
F="$T/home/.claude/projects/-w-app/c1.jsonl"
printf '%s\n' "{\"type\":\"user\",\"timestamp\":\"$NOW\",\"cwd\":\"/w/app\",\"sessionId\":\"c1\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}" > "$F"
# 10 calls: 3 Bash npm test (error), 1 Bash ls (ok), 6 Read (ok)
call() { # id tool input err
  printf '%s\n' "{\"type\":\"assistant\",\"timestamp\":\"$NOW\",\"message\":{\"id\":\"m$1\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t$1\",\"name\":\"$2\",\"input\":$3}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}" \
    "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t$1\"$4,\"content\":\"x\"}]},\"uuid\":\"u$1\",\"timestamp\":\"$NOW\"}" >> "$F"
}
for i in 1 2 3; do call "$i" Bash '{"command":"npm test"}' ',"is_error":true'; done
call 4 Bash '{"command":"ls"}' ''
for i in 5 6 7 8 9 10; do call "$i" Read '{"file_path":"/w/app/README.md"}' ''; done
ag() { HOME="$T/home" AGENTGLASS_CACHE_DIR="$T/cache" AGENTGLASS_NOTIFY=0 "$BIN" "$@"; }
ag triage --preset errors --days 1 --json > "$T/out.json"
grep -q '"selection":{"expr":"status is error","n":3}' "$T/out.json" || { echo "FAIL selection"; cat "$T/out.json"; exit 1; }
grep -q '"baseline":{"mode":"rest","expr":"","n":7}' "$T/out.json" || { echo "FAIL baseline"; cat "$T/out.json"; exit 1; }
grep -q '"guard":"small-sample"' "$T/out.json" || { echo "FAIL guard"; cat "$T/out.json"; exit 1; }
grep -q '"attr":"program","value":"npm","sel":{"n":3,"share":1},"base":{"n":0,"share":0}' "$T/out.json" || { echo "FAIL npm row"; cat "$T/out.json"; exit 1; }
grep -q '"lift":null' "$T/out.json" || { echo "FAIL lift null for new"; cat "$T/out.json"; exit 1; }
ESC=$(printf '\033')
ag triage --preset errors --days 1 > "$T/out.txt"
grep -q "$ESC" "$T/out.txt" && { echo "FAIL ansi without tty"; exit 1; }
grep -q '^program  *npm  *100.0%  *0.0%  *new' "$T/out.txt" || { echo "FAIL text table"; cat "$T/out.txt"; exit 1; }
set +e; err=$(ag triage --select 'tol is x' 2>&1 >/dev/null); rc=$?; set -e
[ $rc = 2 ] || { echo "FAIL rc $rc"; exit 1; }
echo "$err" | grep -q 'did you mean tool' || { echo "FAIL msg: $err"; exit 1; }
set +e; ag triage --weight cost >/dev/null 2>&1; rc=$?; set -e
[ $rc = 2 ] || { echo "FAIL weight cost on calls rc $rc"; exit 1; }
set +e; ag triage --days 0 >/dev/null 2>&1; rc=$?; set -e
[ $rc = 2 ] || { echo "FAIL days 0 rc $rc"; exit 1; }
[ "$(ag triage --filter 'status is error' --preset errors --days 1 --json | grep -o '"guard":"[a-z-]*"')" = '"guard":"empty-baseline"' ] || { echo "FAIL empty-baseline"; exit 1; }
ag triage --filter 'status is error' --preset errors --days 1 | grep -q 'Baseline is empty: the filter `status is error` already selects only these' || { echo "FAIL guard text"; exit 1; }
[ "$(ag triage --select 'tool is Nope' --days 1 --json | grep -o '"guard":"[a-z-]*"')" = '"guard":"empty-selection"' ] || { echo "FAIL empty-selection"; exit 1; }
ag triage --preset expensive --json | grep -q '"entity":"session"' || { echo "FAIL preset entity"; exit 1; }
ag triage --help | grep -q -- '--preset errors|slow|long|expensive|failing|period' || { echo "FAIL help"; exit 1; }
ag --help | grep -q 'agentglass triage' || { echo "FAIL main help"; exit 1; }
echo "triage cli: all checks passed"
