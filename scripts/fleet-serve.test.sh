#!/bin/sh
# agentglass fleet serve (forced command) and fleet authorize against a fake HOME: sh scripts/fleet-serve.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_REDACT SSH_ORIGINAL_COMMAND # hermetic: the fake HOME decides
export AGENTGLASS_AGENT=0
here=$(cd "$(dirname "$0")/.." && pwd); t=$(mktemp -d); trap 'rm -rf "$t"' EXIT
fail=0; eq() { [ "$2" = "$3" ] || { echo "FAIL $1: got '$2' want '$3'"; fail=1; }; }
if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$t/agentglass"; else AGENTGLASS_OUT="$t/agentglass" sh "$here/build.sh" > "$t/build.log" 2>&1 || { cat "$t/build.log"; exit 1; }; fi
p="$t/home/.claude/projects/-w-app"; mkdir -p "$p" "$t/home/.agentglass"
now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
printf '{"type":"user","sessionId":"s1","cwd":"/w/app","timestamp":"%s","message":{"role":"user","content":"secret title"}}\n' "$now" > "$p/s1.jsonl"
printf '{"type":"assistant","sessionId":"s1","timestamp":"%s","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1000,"output_tokens":0}}}\n' "$now" >> "$p/s1.jsonl"
run() { HOME="$t/home" AGENTGLASS_OFFLINE=1 AGENTGLASS_NOTIFY=0 "$t/agentglass" "$@"; }
code() { set +e; "$@" > "$t/out" 2> "$t/err"; c=$?; set -e; echo $c; }
eq "pull through serve" "$(SSH_ORIGINAL_COMMAND='agentglass fleet pull --days 7' run fleet serve | head -1 | jq -r .hello.format)" agentglass-fleet/v1
eq "viewer quoting" "$(SSH_ORIGINAL_COMMAND="~/'.local/bin/agentglass' 'fleet' 'pull' '--days' '7'" run fleet serve | tail -1 | jq -r .end.sessions)" 1
eq "real title without redact" "$(SSH_ORIGINAL_COMMAND='agentglass fleet pull' run fleet serve | grep -c 'secret title' || true)" 1
eq "version" "$(SSH_ORIGINAL_COMMAND='agentglass --version' run fleet serve)" "$(run --version)"
eq "refused --json" "$(SSH_ORIGINAL_COMMAND='agentglass --json' code run fleet serve)" 126
grep -q "only fleet pull/snapshot/watch and --version are allowed" "$t/err" || { echo "FAIL refusal message"; cat "$t/err"; fail=1; }
eq "refused ;" "$(SSH_ORIGINAL_COMMAND='agentglass fleet pull; id' code run fleet serve)" 126
eq "refused \$()" "$(SSH_ORIGINAL_COMMAND='agentglass fleet pull $(id)' code run fleet serve)" 126
eq "refused sh" "$(SSH_ORIGINAL_COMMAND='sh -c id' code run fleet serve)" 126
eq "refused: nothing printed" "$(wc -c < "$t/out" | tr -d ' ')" 0
eq "outside ssh" "$(code run fleet serve)" 2
eq "forced redact" "$(SSH_ORIGINAL_COMMAND='agentglass fleet pull' run fleet serve --redact | grep -c -e '/w/app' -e 'secret title' || true)" 0
eq "forced redact: hello" "$(SSH_ORIGINAL_COMMAND='agentglass fleet pull' run fleet serve --redact | head -1 | jq -r .hello.redact)" true
eq "asked redact" "$(SSH_ORIGINAL_COMMAND='agentglass fleet pull --redact' run fleet serve | grep -c 'secret title' || true)" 0
printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample viewer@laptop\n' > "$t/k.pub"
l=$(run fleet authorize "$t/k.pub" --from 10.0.0.0/8)
case "$l" in 'restrict,from="10.0.0.0/8",command="'*' fleet serve" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample viewer@laptop') ;; *) echo "FAIL authorize line: $l"; fail=1;; esac
case "$(run fleet authorize "$t/k.pub" --redact)" in *'fleet serve --redact" ssh-ed25519'*) ;; *) echo "FAIL authorize --redact"; fail=1;; esac
printf 'not a key\n' > "$t/bad.pub"
eq "bad key" "$(code run fleet authorize "$t/bad.pub")" 2
eq "missing key" "$(code run fleet authorize "$t/none.pub")" 2
[ $fail = 0 ] && echo "fleet serve: all checks passed"; exit $fail
