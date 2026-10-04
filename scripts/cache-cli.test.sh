#!/bin/sh
# one-shot CLI runs keep their indexing work (ledger cache + call rows), help/version never read it: sh scripts/cache-cli.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR # hermetic: the fake HOME decides, not the caller's overrides
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
# AGENTGLASS_BIN: a prebuilt binary (scripts/check.sh builds one for every test), else build one here
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
p="$t/home/.claude/projects/-w-app"; mkdir -p "$p" "$t/home/.agentglass"; f="$p/s1.jsonl"; c="$t/home/.agentglass/cache"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"user","sessionId":"s1","cwd":"/w/app","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$now" > "$f"
call() { # id command err
  printf '%s\n' "{\"type\":\"assistant\",\"sessionId\":\"s1\",\"timestamp\":\"$now\",\"message\":{\"id\":\"m$1\",\"model\":\"claude-sonnet-4-5\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t$1\",\"name\":\"Bash\",\"input\":{\"command\":\"$2\"}}],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}" \
    "{\"type\":\"user\",\"sessionId\":\"s1\",\"timestamp\":\"$now\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t$1\"$3,\"content\":\"x\"}]},\"uuid\":\"u$1\"}" >> "$f"
}
call 1 "npm test" ',"is_error":true'
call 2 "ls" ''
run() { HOME="$t/home" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" "$@"; }
bounded() { # run with a 20 s limit (no timeout(1) on macOS): 124 = killed
  HOME="$t/home" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" "$@" > /dev/null 2>&1 & pid=$!; n=0
  while kill -0 "$pid" 2>/dev/null; do n=$((n + 1)); [ $n -le 100 ] || { kill "$pid"; wait "$pid" 2>/dev/null; return 124; }; sleep 0.2; done
  wait "$pid"
}
off() { grep -o '"off":[0-9]*' "$1" | head -1 | cut -d: -f2; } # the one session's offset in a cache file

# help and version never read the ledger cache: a FIFO in its place would block the read until the timeout
mkdir -p "$c"; mkfifo "$c/ledger.json"
for a in --help --version "cost --help" "triage --help"; do
  set +e; bounded $a; rc=$?; set -e
  eq "$a without the ledger" "$rc" 0
done
set +e; (AGENTGLASS_AGENT=1 bounded); rc=$?; set -e # subshell: macOS sh (bash 3.2 --posix) keeps an assignment before a function call
eq "agent help without the ledger" "$rc" 0
rm -f "$c/ledger.json"

# a plain --json run saves what it indexed: ledger and call rows at the end of the log
run --json > /dev/null
size=$(wc -c < "$f" | tr -d ' ')
[ -s "$c/ledger.json" ] || { echo "FAIL --json saved no ledger.json"; fail=1; }
eq "--json ledger offset" "$(off "$c/ledger.json")" "$size"
eq "--json calls offset" "$(off "$c"/calls/*.json)" "$size"

# the log grows; cost (no call rows read) indexes the new lines and keeps the old rows: both files at the new end
call 3 "make" ',"is_error":true'
run cost --json > /dev/null
size=$(wc -c < "$f" | tr -d ' ')
eq "cost ledger offset" "$(off "$c/ledger.json")" "$size"
eq "cost calls offset" "$(off "$c"/calls/*.json)" "$size"
# errors reads the rows from the cache: the failed call from before and the one after the growth
e=$(run errors --format json --since 1d)
echo "$e" | grep -q 'npm test' || { echo "FAIL errors lost the cached row"; echo "$e"; fail=1; }
echo "$e" | grep -q 'make' || { echo "FAIL errors lacks the new row"; echo "$e"; fail=1; }
# triage too reads the cached rows of the sessions in its period
tr=$(run triage --preset errors --days 1 --json)
echo "$tr" | grep -q '"selection":{"expr":"status is error","n":2}' || { echo "FAIL triage over cached rows"; echo "$tr"; fail=1; }

# nothing new to index (and the head/tail memos of this log already kept): the cache is not rewritten
inode() { ls -i "$1" | awk '{print $1}'; } # a save renames a new file into place
run --json > /dev/null
before=$(inode "$c/ledger.json")
run --json > /dev/null
eq "unchanged cache kept" "$(inode "$c/ledger.json")" "$before"

# a warm run (heads and tails replayed from their memos) prints what a cold one does
rm -rf "$c"; cold=$(run --json); warm=$(run --json)
eq "warm --json = cold --json" "$warm" "$cold"
echo "$warm" | grep -q '"title":"hi"' || { echo "FAIL warm title: $warm"; fail=1; }

[ $fail = 0 ] && echo "cache cli: all checks passed"
exit $fail
