#!/bin/sh
# agentglass rules check|defaults against a fake HOME, and --json alerts of a cost rule: sh scripts/rules.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR # hermetic: the fake HOME decides, not the caller's overrides
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
sh "$here/scripts/build-info.sh"
mkdir -p "$t/home/.agentglass"
run() { HOME="$t/home" AGENTGLASS_AGENT=0 AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" "$@"; }
rf="$t/home/.agentglass/rules.json"
set +e
run rules check > "$t/out"; eq "no file: exit" $? 0
grep -q "missing: built-in rules" "$t/out" || { echo "FAIL no file: header"; cat "$t/out"; fail=1; }
printf '{"rules":[{"id":"x","metric":"nope"}]}\n' > "$rf"; chmod 600 "$rf"
run rules check > "$t/out"; eq "bad metric: exit" $? 2
grep -q '^rules.json:1:30: x: unknown metric' "$t/out" || { echo "FAIL bad metric line"; cat "$t/out"; fail=1; }
eq "check --json" "$(run rules check --json | jq -r '.diagnostics[0].severity + " " + (.diagnostics[0].line|tostring)')" "error 1"
printf '{"rules":[{"id":"x","metric":"session_cost","degraded":1,"colour":1}]}\n' > "$rf"
run rules check > /dev/null; eq "warning: exit" $? 1
run rules defaults > "$rf"; eq "defaults: exit" $? 0
run rules check > /dev/null; eq "defaults check: exit" $? 0
run rules defaults --examples > "$rf"
run rules check > /dev/null; eq "examples check: exit" $? 0
printf '{"notify":{"command":["/usr/bin/true"]}}\n' > "$rf"; chmod 664 "$rf"
run rules check > "$t/out"; eq "group-writable command: exit" $? 2
grep -q "notify.command ignored" "$t/out" || { echo "FAIL unsafe command not reported"; cat "$t/out"; fail=1; }
run rules nope > /dev/null 2>&1; eq "unknown subcommand: exit" $? 2
run rules 2> "$t/out"; eq "no subcommand: exit" $? 2
grep -q "which one? check or defaults" "$t/out" || { echo "FAIL no subcommand message"; cat "$t/out"; fail=1; }
run rules --help | grep -q "rules defaults" || { echo "FAIL rules --help"; fail=1; }
run --help | grep -q "agentglass rules check" || { echo "FAIL --help lists rules"; fail=1; }
run --help | grep -q -- "--no-alerts" || { echo "FAIL --help lists --no-alerts"; fail=1; }
set -e
# --json: alerts is an array on every session (empty without live agents)
p="$t/home/.claude/projects/-w-app"; mkdir -p "$p"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"user","sessionId":"s1","cwd":"/w/app","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$now" > "$p/s1.jsonl"
rm -f "$rf"
eq "json alerts" "$(run --json | jq -c '.[0].alerts')" "[]"
[ $fail = 0 ] && echo "rules cli: all checks passed"; exit $fail
