#!/bin/sh
# agentglass prices: list with sources, set / alias / unset round trip, exit codes, agent-mode errors: sh scripts/prices.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_PRICES PI_CODING_AGENT_DIR PI_CODING_AGENT_SESSION_DIR CODEX_HOME XDG_CONFIG_HOME
export AGENTGLASS_AGENT=0 # human-mode behavior, also when the suite runs inside a coding agent
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/ag"; else AGENTGLASS_OUT="$t/ag" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
H="$t/home"; now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); day=$(date -u +%Y/%m/%d)
mkdir -p "$H/.claude/projects/-w-app" "$H/.codex/sessions/$day" "$H/.pi/agent/sessions/--w-app--" "$t/p"
# Claude: a priced model
C="$H/.claude/projects/-w-app/c1aude00-0000-4000-8000-000000000001.jsonl"
printf '{"type":"user","sessionId":"c1aude00-0000-4000-8000-000000000001","cwd":"/w/app","timestamp":"%s","message":{"role":"user","content":"hi"}}\n' "$now" > "$C"
printf '{"type":"assistant","sessionId":"c1aude00-0000-4000-8000-000000000001","cwd":"/w/app","timestamp":"%s","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1000,"output_tokens":100}}}\n' "$now" >> "$C"
# Codex: gpt-6.1-sol, unpriced by default
X="$H/.codex/sessions/$day/rollout-2026-10-05T10-00-00-c0dex000-0000-4000-8000-000000000002.jsonl"
printf '{"timestamp":"%s","type":"session_meta","payload":{"id":"c0dex000-0000-4000-8000-000000000002","timestamp":"%s","cwd":"/w/app"}}\n' "$now" "$now" > "$X"
printf '{"timestamp":"%s","type":"turn_context","payload":{"cwd":"/w/app","model":"gpt-6.1-sol"}}\n' "$now" >> "$X"
printf '{"timestamp":"%s","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":200000,"cached_input_tokens":0,"output_tokens":20000,"reasoning_output_tokens":0}}}}\n' "$now" >> "$X"
# pi: the harness reported the cost of claude-sonnet-5-5 itself (provider cliproxy)
P="$H/.pi/agent/sessions/--w-app--/2026-10-05T10-00-00-000Z_p1000000-0000-4000-8000-000000000003.jsonl"
printf '%s\n' "{\"type\":\"session\",\"version\":3,\"id\":\"p1000000-0000-4000-8000-000000000003\",\"timestamp\":\"$now\",\"cwd\":\"/w/app\"}" \
  "{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"$now\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"model\":\"claude-sonnet-5-5\",\"provider\":\"cliproxy\",\"usage\":{\"input\":100,\"output\":10,\"cacheRead\":0,\"cacheWrite\":0,\"cost\":{\"total\":0.5}},\"stopReason\":\"stop\"}}" > "$P"
export AGENTGLASS_PRICES="$t/p/prices.json"
run() { HOME="$H" AGENTGLASS_CACHE_DIR="$t/cache" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES=/nonexistent AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" "$@"; }
code() { set +e; run "$@" > "$t/out" 2> "$t/err"; rc=$?; set -e; echo "$rc"; }

j=$(run prices --json)
eq "first row" "$(echo "$j" | jq -r '.models[0].model + " " + .models[0].source')" "gpt-6.1-sol unpriced"
eq "unpriced tokens" "$(echo "$j" | jq -r '.models[0].unpricedTokens')" 220000
eq "claude built-in" "$(echo "$j" | jq -r '.models[] | select(.model=="claude-sonnet-4-5") | .source + " " + (.price.in|tostring) + " " + (.price.cacheRead|tostring)')" "built-in 3 0.3"
eq "file" "$(echo "$j" | jq -r '.file')" "$t/p/prices.json"
eq "pi reported" "$(echo "$j" | jq -r '.models[] | select(.model=="claude-sonnet-5-5") | (.reportedCostUsd|tostring) + " " + .source')" "0.5 harness"
echo "$j" | jq -r '.models[] | select(.model=="claude-sonnet-5-5") | .note' | grep -q "^cost reported by pi" || { echo "FAIL pi note: $j"; fail=1; }
eq "--unpriced exit 4" "$(code prices --unpriced)" 4
grep -q "^gpt-6.1-sol " "$t/out" || { echo "FAIL --unpriced text"; cat "$t/out"; fail=1; }
run prices | grep -q "cost reported by pi" || { echo "FAIL text note"; fail=1; }
eq "set exit" "$(code prices set openai/GPT-6.1-sol --in 1.25 --out 10)" 0
grep -q "unpriced → user \$1.25 in / \$10 out (stored as gpt-6.1-sol in" "$t/out" || { echo "FAIL set line"; cat "$t/out"; fail=1; }
eq "file entry" "$(jq -c '."gpt-6.1-sol"' < "$t/p/prices.json")" '{"input":1.25,"output":10}'
j=$(run prices --json)
eq "now user" "$(echo "$j" | jq -r '.models[] | select(.model=="gpt-6.1-sol") | .source + " " + (.costUsd > 0 | tostring) + " " + (.unpricedTokens|tostring)')" "user true 0"
eq "--unpriced clean" "$(code prices --unpriced)" 0
eq "cost --by model source" "$(run cost --by model --json | jq -r '.rows[] | select(.key=="claude-sonnet-4-5") | .priceSource')" built-in
eq "cost --by model user" "$(run cost --by model --json | jq -r '.rows[] | select(.key=="gpt-6.1-sol") | .priceSource + " " + (.estimated|tostring)')" "user false"
eq "alias exit" "$(code prices alias gpt-6.1-sol-mini gpt-6.1-sol --json)" 0
eq "alias json" "$(jq -r '.after.source + " " + .after.via' < "$t/out")" "alias gpt-6.1-sol"
eq "alias chain exit" "$(code prices alias x gpt-6.1-sol-mini)" 2
grep -q "aliases do not chain" "$t/err" || { echo "FAIL chain message"; cat "$t/err"; fail=1; }
eq "alias to unpriced exit" "$(code prices alias y nope)" 2
grep -q "nope has no price" "$t/err" || { echo "FAIL unpriced target message"; cat "$t/err"; fail=1; }
eq "alias self exit" "$(code prices alias gpt-6.1-sol gpt-6.1-sol)" 2
eq "set --in only" "$(code prices set z --in 1)" 2
grep -q -- "--out is needed" "$t/err" || { echo "FAIL --out message"; cat "$t/err"; fail=1; }
eq "set bad number" "$(code prices set z --in x --out 1)" 2
grep -q '"x" is not a number' "$t/err" || { echo "FAIL number message"; cat "$t/err"; fail=1; }
eq "set on a harness-priced model" "$(code prices set claude-sonnet-5-5 --in 1 --out 1)" 0
grep -q "cost reported by pi" "$t/out" || { echo "FAIL set note"; cat "$t/out"; fail=1; }
eq "unset exit" "$(code prices unset gpt-6.1-sol)" 0
eq "unset again" "$(code prices unset gpt-6.1-sol)" 0
grep -q "nothing to remove (source: unpriced)" "$t/out" || { echo "FAIL nothing to remove"; cat "$t/out"; fail=1; }
eq "unpriced again" "$(code prices --unpriced)" 4
eq "--since" "$(run prices --since today --json | jq -r '.models | length')" 3
eq "bad --since" "$(code prices --since soon)" 2
# re-pricing in place = a cold index under the same prices, also for tokens the sessions book after the change
rm -f "$t/p/prices.json"; run cost --json > /dev/null # the cache, under no user prices
run prices set gpt-6.1-sol --in 2 --out 8 > /dev/null; run prices alias claude-sonnet-4-5 gpt-6.1-sol > /dev/null
run cost --json > /dev/null # loads the cache saved under the old prices: re-priced in place, saved again
later=$(date -u +%Y-%m-%dT%H:%M:%S.000Z) # live sessions book more under the new prices
printf '{"timestamp":"%s","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":260000,"cached_input_tokens":40000,"output_tokens":21000,"reasoning_output_tokens":0}}}}\n' "$later" >> "$X"
printf '{"type":"assistant","sessionId":"c1aude00-0000-4000-8000-000000000001","cwd":"/w/app","timestamp":"%s","message":{"id":"m2","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":500,"output_tokens":50,"cache_read_input_tokens":2000}}}\n' "$later" >> "$C"
cold() { HOME="$H" AGENTGLASS_CACHE_DIR="$t/cold" AGENTGLASS_CONFIG="$t/config.json" AGENTGLASS_RULES=/nonexistent AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/ag" "$@"; }
sj='[.[] | {id, costUsd, unpricedTokens, costEstimatedUsd}] | sort_by(.id)'
w=$(run --json --subagents | jq -c "$sj"); c=$(cold --json --subagents | jq -c "$sj")
eq "re-priced sessions = cold index" "$w" "$c"
echo "$w" | jq -e '[.[] | select(.costEstimatedUsd > 0)] | length == 1' > /dev/null || { echo "FAIL alias share: $w"; fail=1; }
cj='{t: .today, m: .month}'
eq "re-priced cost = cold index" "$(run cost --json | jq -c "$cj")" "$(cold cost --json | jq -c "$cj")"
# an invalid file is never overwritten
printf '{"a": 1,,}' > "$t/p/prices.json"; cp "$t/p/prices.json" "$t/p/before"
eq "invalid file exit" "$(code prices set q --in 1 --out 1)" 1
cmp -s "$t/p/prices.json" "$t/p/before" || { echo "FAIL invalid file changed"; fail=1; }
grep -q "not valid JSON" "$t/err" || { echo "FAIL invalid file message"; cat "$t/err"; fail=1; }
# an unreadable file (here a directory) is an error for every write, never "nothing to remove"
rm -f "$t/p/prices.json" "$t/p/before"; mkdir "$t/p/prices.json"
eq "unreadable file: unset exit" "$(code prices unset gpt-6.1-sol)" 1
grep -q "cannot be read" "$t/err" || { echo "FAIL unreadable message"; cat "$t/err"; fail=1; }
eq "unreadable file: set exit" "$(code prices set q --in 1 --out 1)" 1
rmdir "$t/p/prices.json"
# agent mode: one JSON error line on stderr, nothing on stdout
set +e; (AGENTGLASS_AGENT=1 run prices set z --in x --out 1) > "$t/out" 2> "$t/err"; rc=$?; set -e
eq "agent exit" "$rc" 2
eq "agent stdout empty" "$(wc -c < "$t/out" | tr -d ' ')" 0
eq "agent error code" "$(head -1 "$t/err" | jq -r '.error.code')" usage
eq "agent default json" "$(AGENTGLASS_AGENT=1 run prices --all-projects | jq -r '.models | length')" 3
# set / alias on a gateway-priced model: the before/after lines resolve with the provider the model is booked under
# (pi's models.json prices pi-gw-model for cliproxy only), not as "unpriced"
mkdir -p "$H/.pi/agent"; printf '{"providers":{"cliproxy":{"models":[{"id":"pi-gw-model","cost":{"input":3,"output":15}}]}}}\n' > "$H/.pi/agent/models.json"
printf '%s\n' "{\"type\":\"session\",\"version\":3,\"id\":\"p2000000-0000-4000-8000-000000000004\",\"timestamp\":\"$now\",\"cwd\":\"/w/app\"}" \
  "{\"type\":\"message\",\"id\":\"e1\",\"parentId\":null,\"timestamp\":\"$now\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"model\":\"pi-gw-model\",\"provider\":\"cliproxy\",\"usage\":{\"input\":100,\"output\":10,\"cacheRead\":0,\"cacheWrite\":0,\"cost\":{\"total\":0}},\"stopReason\":\"stop\"}}" > "$H/.pi/agent/sessions/--w-app--/2026-10-05T11-00-00-000Z_p2000000-0000-4000-8000-000000000004.jsonl"
eq "gateway model listed" "$(run prices --json | jq -r '.models[] | select(.model=="pi-gw-model") | .source + " " + .via')" "gateway cliproxy"
eq "set on a gateway model" "$(code prices set pi-gw-model --in 1 --out 2)" 0
grep -q "^pi-gw-model: gw cliproxy \$3 in / \$15 out → user \$1 in / \$2 out" "$t/out" || { echo "FAIL gateway before line"; cat "$t/out"; fail=1; }
eq "unset a gateway model --json" "$(run prices unset pi-gw-model --json | jq -r '[.before.source, .after.source, .after.via, .provider] | join(" ")')" "user gateway cliproxy cliproxy"
eq "alias a gateway model --json" "$(run prices alias pi-gw-model claude-sonnet-4-5 --json | jq -r '[.before.source, .before.via, .after.source] | join(" ")')" "gateway cliproxy alias"
run prices unset pi-gw-model > /dev/null
run prices --help | grep -q "prices alias <model> <target>" || { echo "FAIL prices --help"; fail=1; }
run --help | grep -q "agentglass prices" || { echo "FAIL --help lists prices"; fail=1; }
[ $fail = 0 ] && echo "prices: all tests passed"
exit $fail
