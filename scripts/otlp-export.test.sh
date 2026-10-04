#!/bin/sh
# agentglass export against fixture homes: --dry-run output stable (golden), usage errors exit 2: sh scripts/otlp-export.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR # hermetic: the fake HOME decides, not the caller's overrides
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }
sh "$here/scripts/build-info.sh"
mkdir -p "$t/home"; cp -R "$here/testdata/otlp/fixtures/claude/." "$t/home/"
find "$t/home" -type f -exec touch -t 202609011100 {} +
run() { HOME="$t/home" TZ=UTC AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 AGENTGLASS_OTLP_DIR="$t/otlp" AGENTGLASS_CACHE_DIR="$t/cache" "$t/ag" "$@"; }
run export --dry-run --since all > "$t/a.jsonl"
run export --dry-run --since all > "$t/b.jsonl"
eq "dry run lines" "$(wc -l < "$t/a.jsonl" | tr -d ' ')" 1
cmp -s "$t/a.jsonl" "$t/b.jsonl" || { echo "FAIL dry run not stable"; fail=1; }
g="$here/testdata/otlp/golden-claude.json"
sed 's/"scope":{"name":"agentglass","version":"[^"]*"}/"scope":{"name":"agentglass","version":"(build)"}/g; s/"key":"os.type","value":{"stringValue":"darwin"}/"key":"os.type","value":{"stringValue":"linux"}/g' "$t/a.jsonl" > "$t/n.jsonl"
if [ -f "$g" ]; then cmp -s "$t/n.jsonl" "$g" || { echo "FAIL dry run differs from $g"; diff "$t/n.jsonl" "$g" | head -5; fail=1; }; fi
[ -z "$(ls -A "$t/otlp" 2>/dev/null)" ] || { echo "FAIL dry run wrote state: $(ls "$t/otlp")"; fail=1; }
set +e
run export > /dev/null 2> "$t/err"; rc=$?
eq "no endpoint exit" "$rc" 2
grep -q "no endpoint" "$t/err" || { echo "FAIL no endpoint message: $(cat "$t/err")"; fail=1; }
AGENTGLASS_CURL=/nonexistent run export --otlp http://localhost:1 --since all > /dev/null 2> "$t/err"; rc=$?
eq "no curl exit" "$rc" 2
grep -q "export needs curl (AGENTGLASS_CURL)" "$t/err" || { echo "FAIL no curl message: $(cat "$t/err")"; fail=1; }
run export --otlp http://localhost:4318 --filter 'tool is Bash' > /dev/null 2> "$t/err"; rc=$?
eq "call clause exit" "$rc" 2
run export --otlp 'http://localhost:4318/v1/traces
x' --dry-run > /dev/null 2> "$t/err"; rc=$?
eq "url with a line break exit" "$rc" 2
run --watch --otlp http://localhost:4318 --filter 'tool is Bash' > /dev/null 2> "$t/err"; rc=$?
eq "live call clause exit" "$rc" 2
run --watch --otlp http://localhost:4318 --filter 'nosuchkey is x' > /dev/null 2> "$t/err"; rc=$?
eq "live bad filter exit" "$rc" 2
run --watch --otlp http://localhost:4318 --harness nope > /dev/null 2> "$t/err"; rc=$?
eq "live bad harness exit" "$rc" 2
run --watch --otlp --content > /dev/null 2> "$t/err"; rc=$?
eq "live --otlp without url exit" "$rc" 2
run --help | grep -q "export --otlp <url>" || { echo "FAIL --help lacks export"; fail=1; }
run export --help | grep -q "^usage: agentglass export --otlp" || { echo "FAIL export --help"; fail=1; }
set -e
[ $fail = 0 ] && echo "otlp export cli: ok"
exit $fail
