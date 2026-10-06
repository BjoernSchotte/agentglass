#!/bin/sh
# agentglass cost + --json billing fields against a fake HOME (one Claude API-key session, one unpriced model): sh scripts/cost.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR # hermetic: the fake HOME decides, not the caller's overrides
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
# AGENTGLASS_BIN: a prebuilt binary (scripts/check.sh builds one for every test), else build one here
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
p="$t/home/.claude/projects/-w-app"; mkdir -p "$p" "$t/home/.agentglass"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"user","sessionId":"s1","cwd":"/w/app","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$now" > "$p/s1.jsonl"
printf '{"type":"assistant","sessionId":"s1","timestamp":"%s","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1000000,"output_tokens":0}}}\n' "$now" >> "$p/s1.jsonl"
printf '{"type":"assistant","sessionId":"s1","timestamp":"%s","message":{"id":"m2","role":"assistant","model":"gpt-x-unknown","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":5000,"output_tokens":0}}}\n' "$now" >> "$p/s1.jsonl"
printf '{"apiKeyHelper":"/bin/true"}\n' > "$t/home/.claude/settings.json"
printf '{"budget":{"monthlyUsd":1}}\n' > "$t/home/.agentglass/config.json"
run() { HOME="$t/home" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" "$@"; }
j=$(run --json)
eq mode "$(echo "$j" | jq -r '.[0].billing.mode')" api
eq source "$(echo "$j" | jq -r '.[0].billing.source')" config
eq unpriced "$(echo "$j" | jq -r '.[0].unpricedTokens')" 5000
eq credits "$(echo "$j" | jq -r '.[0].unpricedCredits')" 0
eq cost "$(echo "$j" | jq -r '.[0].costUsd')" 3
c=$(run cost --json)
eq state "$(echo "$c" | jq -r '.budget.state')" over
eq approx "$(echo "$c" | jq -r '.budget.approx')" false
eq api "$(echo "$c" | jq -r '.today.byMode.api')" 3
eq bymodel "$(echo "$c" | jq -r '.today.unpriced.byModel["gpt-x-unknown"]')" 5000
eq tokens "$(echo "$c" | jq -r '.month.unpriced.tokens')" 5000
eq projected "$(echo "$c" | jq -r '.month.projected')" null
set +e; run cost --check > /dev/null; rc=$?; run cost --nope > /dev/null 2>&1; rc2=$?; set -e
eq exit "$rc" 3
eq "bad flag exit" "$rc2" 2
# a failed write (a full disk) keeps --check's over-budget exit
if [ -w /dev/full ]; then set +e; run cost --check > /dev/full 2>/dev/null; rc=$?; set -e; eq "write error: exit" "$rc" 3; fi
txt=$(run cost)
echo "$txt" | grep -q "spend" || { echo "FAIL text has no spend tag"; echo "$txt"; fail=1; }
echo "$txt" | grep -q "unpriced (month): gpt-x-unknown 5.0K" || { echo "FAIL text has no unpriced line"; echo "$txt"; fail=1; }
run cost --help | grep -q -- "--check" || { echo "FAIL cost --help"; fail=1; }
run --help | grep -q "agentglass cost" || { echo "FAIL --help lists cost"; fail=1; }
# rows (--by) through a failed write (a full disk): --check still exits 3 when over budget, in every format
if [ -w /dev/full ]; then for fm in json csv table; do
  set +e; run cost --check --by model --format $fm > /dev/full 2>/dev/null; rc=$?; set -e; eq "--by write error ($fm): exit" "$rc" 3
done; fi
# cli-agent-mode: inside an agent the summary is the same JSON; rows with --by/--since; csv needs rows; --check in both forms
eq "agent summary = --json" "$(AGENTGLASS_AGENT=1 run cost)" "$(run cost --json)"
set +e; run cost --format csv > /dev/null 2>&1; rc=$?; run cost --check --by day > "$t/rows" 2>/dev/null; rc2=$?; set -e
eq "csv without --by" "$rc" 2
eq "--check with rows" "$rc2" 3
eq "rows: day + total" "$(jq -r '.rows | map(.key) | length' < "$t/rows")" 2
eq "rows: total cost" "$(jq -r '.rows[-1].costUsd' < "$t/rows")" 3
eq "rows envelope source" "$(jq -r '.source' < "$t/rows")" ledger
eq "by model csv" "$(run cost --by model --format csv | head -1)" "key,in,out,cacheRead,cacheWrite,costUsd,unpricedTokens,sessions,priceSource,estimated"
eq "unpriced model row" "$(run cost --by model --format csv | grep "^gpt-x-unknown,")" "gpt-x-unknown,5000,0,0,0,,5000,1,unpriced,false"
# a bad budget value: ignored with one warning on stderr, the run still succeeds
printf '{"budget":{"monthlyUsd":"1"}}\n' > "$t/home/.agentglass/config.json"
eq "bad budget" "$(run cost --json 2>"$t/err" | jq -r '.budget')" null
grep -q "budget.monthlyUsd invalid" "$t/err" || { echo "FAIL no warning for an invalid budget"; fail=1; }
# a config.json that is not JSON: one warning naming the file, never silently "no budget"
printf '{"budget":{"monthlyUsd":1},}\n' > "$t/home/.agentglass/config.json"
eq "broken config" "$(run cost --json 2>"$t/err" | jq -r '.budget')" null
grep -q "config.json is not valid JSON" "$t/err" || { echo "FAIL no warning for a broken config.json"; cat "$t/err"; fail=1; }
eq "broken config: one warning" "$(grep -c 'not valid JSON' "$t/err")" 1
# model-prices: an alias prices the unknown model like claude-sonnet-4-5 — an estimate, ≈ even on an API key
rm -f "$t/home/.agentglass/config.json"
printf '{"gpt-x-unknown":{"alias":"claude-sonnet-4-5"}}\n' > "$t/home/.agentglass/prices.json"
j=$(run --json)
eq "alias: estimated share" "$(echo "$j" | jq -r '.[0].costEstimatedUsd')" 0.015
eq "alias: nothing unpriced" "$(echo "$j" | jq -r '.[0].unpricedTokens')" 0
eq "alias: cost" "$(echo "$j" | jq -r '.[0].costUsd')" 3.015
run cost | grep "^today" | grep -q "≈\$3.02" || { echo "FAIL alias: no ≈ on the api figure"; run cost; fail=1; }
eq "alias: by model" "$(run cost --by model --json | jq -r '.rows[] | select(.key=="gpt-x-unknown") | .priceSource + " " + (.estimated|tostring)')" "alias true"
rm -f "$t/home/.agentglass/prices.json"
eq "alias gone: unpriced again" "$(run --json | jq -r '.[0].unpricedTokens')" 5000
# fleet pull: the same objects as cost --json and --json, one JSON line each, in order
p=$(run fleet pull --days 7)
eq "pull: hello first" "$(echo "$p" | head -1 | jq -r '.hello.format')" agentglass-fleet/v1
eq "pull: cost = cost --json" "$(echo "$p" | jq -c 'select(.cost)|.cost')" "$(run cost --json | jq -c .)"
eq "pull: sessions = --json" "$(echo "$p" | jq -c 'select(.s)|.s|{id,costUsd,tokens,billing,title}')" "$(run --json | jq -c '.[]|{id,costUsd,tokens,billing,title}')"
eq "pull: end" "$(echo "$p" | tail -1 | jq -r '.end.sessions')" 1
eq "pull: redacted" "$(run fleet pull --redact | grep -c '/w/app' || true)" 0
eq "pull: redacted flag in hello" "$(run fleet pull --redact | head -1 | jq -r '.hello.redact')" true
set +e; run fleet pull --days 0 > /dev/null 2>&1; rc=$?; run fleet pull --nope > /dev/null 2>&1; rc2=$?; set -e
eq "pull: --days 0" "$rc" 2
eq "pull: bad flag" "$rc2" 2
[ $fail = 0 ] && echo "cost cli: all checks passed"; exit $fail
