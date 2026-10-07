#!/bin/sh
# agentglass wait (agent-wait §7) against a fake HOME: families, kinds, tools, overlap, filters, --now, --check, agent
# mode scoping, usage errors, 80-column text: sh scripts/wait.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR # hermetic: the fake HOME decides, not the caller's overrides
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
h="$t/h"; app="$h/w/app"; lib="$h/w/lib"; mkdir -p "$app/.git" "$lib/.git"
# portable (GNU + BSD): epoch seconds → ISO; the calls start two hours ago
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z; }
b=$(( $(date +%s) - 7200 ))
n=0
call() { # call <sid> <cwd> <start offset s> <tool> <input json> <duration s> <is_error>
  n=$((n + 1)); s0=$((b + $3)); s1=$((s0 + $6))
  printf '{"type":"assistant","sessionId":"%s","cwd":"%s","timestamp":"%s","message":{"id":"m%s","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"t%s","name":"%s","input":%s}],"usage":{"input_tokens":10,"output_tokens":1}}}\n' "$1" "$2" "$(iso $s0)" "$n" "$n" "$4" "$5"
  printf '{"type":"user","sessionId":"%s","cwd":"%s","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t%s","content":"x","is_error":%s}]},"uuid":"u%s","timestamp":"%s"}\n' "$1" "$2" "$n" "$7" "$n" "$(iso $s1)"
}
A=abcdef01-0000-4000-8000-00000000000a; L=abcdef02-0000-4000-8000-00000000000b
mkdir -p "$h/.claude/projects/-w-app" "$h/.claude/projects/-w-lib"
{ call $A "$app" 0 Bash '{"command":"pnpm test"}' 120 false
  call $A "$app" 200 Bash '{"command":"pnpm test"}' 100 true
  call $A "$app" 400 Bash '{"command":"npx tsc --noEmit"}' 30 false
  call $A "$app" 500 Bash '{"command":"git status"}' 1 false
  call $A "$app" 600 AskUserQuestion '{}' 60 false; } > "$h/.claude/projects/-w-app/$A.jsonl"
call $L "$lib" 30 Bash '{"command":"cd /w/lib && pnpm test"}' 90 false > "$h/.claude/projects/-w-lib/$L.jsonl"
run() { env -i HOME="$h" PATH="$PATH" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES=/nonexistent \
  AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_AGENT="${AG:-0}" AGENTGLASS_HERDR=off "$t/ag" "$@"; }

j=$(run wait --json)
eq "top family" "$(echo "$j" | jq -r '.rows[0].key')" "pnpm test"
eq "calls" "$(echo "$j" | jq -r '.rows[0].calls')" 3
eq "total" "$(echo "$j" | jq -r '.rows[0].totalMs')" 310000
eq "errors" "$(echo "$j" | jq -r '.rows[0].errors')" 1
eq "peak" "$(echo "$j" | jq -r '.rows[0].peak')" 2
eq "agents" "$(echo "$j" | jq -r '.rows[0].agents')" 2
eq "user time" "$(echo "$j" | jq -r '.agentTime.userMs')" 60000
eq "guard" "$(echo "$j" | jq -r '.guard')" null
eq "heavy peak" "$(echo "$j" | jq -r '.heavy.peak')" 2
eq "field order" "$(echo "$j" | jq -c '.rows[0] | keys_unsorted')" '["key","kind","heavy","calls","timedCalls","totalMs","share","p50Ms","p95Ms","maxMs","errors","errorRate","prevTotalMs","trend","agents","peak","peakAt","atLeast2Ms","atLeast3Ms","slowdown","hist"]'
eq "top-level order" "$(echo "$j" | jq -c 'keys_unsorted')" '["period","previous","scope","retention","agentTime","rows","heavy","now","guard","warnings"]'
eq "hist buckets" "$(echo "$j" | jq -r '.rows[0].hist | length')" 16
eq "by kind" "$(run wait --json --by kind | jq -c '[(.rows[] | select(.key == "test") | .totalMs), (.rows | map(.key) | index("typecheck") != null)]')" '[310000,true]'
eq "by tool" "$(run wait --json --by tool | jq -r '.rows[] | select(.key == "AskUserQuestion") | .kind')" user
eq "filter" "$(run wait --json --filter 'repo is lib' | jq -c '[.rows[0].key, .rows[0].calls, (.rows | length)]')" '["pnpm test",1,1]'
eq "filter kind" "$(run wait --json --filter 'kind is typecheck' | jq -c '[.rows[] | .key]')" '["tsc"]'
eq "limit" "$(run wait --json --limit 1 | jq -r '.rows | length')" 1
nw=$(run wait --now --json)
eq "now: running" "$(echo "$nw" | jq -c '.now.running')" '[]'
eq "now: no rows" "$(echo "$nw" | jq -c 'has("rows")')" false
eq "now: host scope" "$(echo "$nw" | jq -r '.now.heavyRunning')" 0
set +e; run wait --check > /dev/null 2>&1; rc=$?; run wait --check --max 0 > /dev/null 2>&1; rc2=$?
run wait --since nope > /dev/null 2> "$t/e1"; rc3=$?; run wait --by x > /dev/null 2>&1; rc4=$?; run wait stray > /dev/null 2>&1; rc5=$?
run wait --family x > /dev/null 2>&1; rc6=$?; run wait --limit 0 > /dev/null 2>&1; rc7=$?; set -e
eq "check: nothing running" "$rc" 0
eq "check --max 0" "$rc2" 2
eq "--since nope" "$rc3" 2
grep -q "since" "$t/e1" || { echo "FAIL --since error names the option"; fail=1; }
eq "--by x" "$rc4" 2
eq "stray argument" "$rc5" 2
eq "--family without --check" "$rc6" 2
eq "--limit 0" "$rc7" 2
# csv rows and --fields
eq "csv header" "$(run wait --format csv --fields key,calls,totalMs | head -1)" "key,calls,totalMs"
eq "csv row" "$(run wait --format csv --fields key,calls,totalMs | sed -n 2p)" "pnpm test,3,310000"
set +e; run wait --format csv --fields nope > /dev/null 2>&1; rc=$?; set -e
eq "unknown field" "$rc" 2
# text: fits 80 columns, names the split and the heavy line
txt=$(run wait | sed 's/\x1b\[[0-9;]*m//g')
eq "text width" "$(echo "$txt" | LC_ALL=C sed 's/·/./g; s/≥/>/g; s/×/x/g; s/…/./g' | awk 'length > 80' | wc -l | tr -d ' ')" 0
echo "$txt" | grep -q "pnpm test" || { echo "FAIL text lists pnpm test"; echo "$txt"; fail=1; }
echo "$txt" | grep -q "agent time" || { echo "FAIL text has the agent-time header"; echo "$txt"; fail=1; }
# agent mode: JSON by default, history of the current project only, now host-wide
cd "$app"
aj=$(AG=1 run wait)
eq "agent: json" "$(echo "$aj" | jq -r '.rows[0].key')" "pnpm test"
eq "agent: project rows" "$(echo "$aj" | jq -r '.rows[0].calls')" 2
eq "agent: scope project" "$(echo "$aj" | jq -r '.scope.project != null')" true
eq "agent: now host" "$(echo "$aj" | jq -r '.scope.now')" host
eq "agent: all projects" "$(AG=1 run wait --all-projects | jq -r '.rows[0].calls')" 3
cd "$t"
# help: text and JSON field list
run wait --help | grep -q -- "--check" || { echo "FAIL wait --help"; fail=1; }
run --help | grep -q "agentglass wait" || { echo "FAIL --help lists wait"; fail=1; }
eq "help fields" "$(run --help --format json | jq -c '.commands[] | select(.cmd == "wait") | .fields[0:3]')" '["key","kind","heavy"]'
# a bad wait config entry: one warning, the rest works
printf '{"wait":{"families":[{"match":""}],"minSec":5}}\n' > "$t/config.json"
eq "warnings" "$(run wait --json 2>/dev/null | jq -r '.warnings | length')" 1
# --watch evaluates the contention rule (heavy commands host-wide, as the TUI's tick): three fake agents each run
# `sh -c "sleep …"`, a user family rule makes sleep a heavy test run; the rule fires on the agents' sessions
fx="$t/fx"; sh "$here/scripts/fixture-agents.sh" start "$fx" --agents 3 --history 0 > /dev/null
trap '[ "$(exec sh -c "echo \$PPID")" = $$ ] || exit; sh "$here/scripts/fixture-agents.sh" stop "$fx" > /dev/null 2>&1 || true; rm -rf "$t"' EXIT
printf '{"wait":{"families":[{"match":"sleep ...","family":"slow suite","kind":"test"}]}}\n' > "$t/config.json"
printf '{"version":1,"builtins":false,"rules":[{"id":"contention","metric":"contention","op":">=","degraded":2,"for":"0s","ack":"none","message":"{value} heavy: {cmd}"}]}\n' > "$t/rules.json"
env -i HOME="$fx/home" PATH="$PATH" AGENTGLASS_CACHE_DIR="$t/cache2" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES="$t/rules.json" AGENTGLASS_RUN_DIR="$t/run" \
  AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_AGENT=0 AGENTGLASS_HERDR=off "$t/ag" --watch > "$t/watch.jsonl" 2> /dev/null & wp=$!
i=0; while [ $i -lt 40 ] && ! grep -q '"kind":"alert"' "$t/watch.jsonl" 2> /dev/null; do sleep 0.5; i=$((i + 1)); done
kill "$wp" 2> /dev/null || true; wait "$wp" 2> /dev/null || true
now=$(env -i HOME="$fx/home" PATH="$PATH" AGENTGLASS_CACHE_DIR="$t/cache2" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES="$t/rules.json" AGENTGLASS_RUN_DIR="$t/run" \
  AGENTGLASS_NOTIFY=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_AGENT=0 AGENTGLASS_HERDR=off "$t/ag" wait --now --json 2> /dev/null || true)
# (≥ 2 of the 3: on macOS CI one fixture agent's tree is not linked to its session)
eq "now: heavy" "$(printf '%s' "$now" | jq -r '.now.heavyRunning >= 2')" true
grep -q '"kind":"alert"' "$t/watch.jsonl" || { echo "watch saw: $(grep -c . "$t/watch.jsonl") lines, kinds $(jq -r .kind "$t/watch.jsonl" | sort | uniq -c | tr '\n' ' ')"; ps -axo pid=,ppid=,args= | grep -F "$fx" | grep -v grep | head -n 12; }
sh "$here/scripts/fixture-agents.sh" stop "$fx" > /dev/null
eq "watch: contention alert" "$(grep '"kind":"alert"' "$t/watch.jsonl" | head -n 1 | jq -r '.text | test("^[23] heavy: slow suite ×[23]$")')" true
[ $fail = 0 ] && echo "wait: all checks passed"
exit $fail
