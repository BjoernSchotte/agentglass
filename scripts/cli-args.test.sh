#!/bin/sh
# one argument rule for every command: a value flag never swallows the flag after it (a bare `--watch --otlp --filter …`
# took --filter for its URL and exported every live session), --flag=value works everywhere, and an unknown flag or a
# stray word exits 2 instead of being ignored. Table-driven: sh scripts/cli-args.test.sh
set -e
unset AGENTGLASS_CONFIG AGENTGLASS_RULES AGENTGLASS_CACHE_DIR AGENTGLASS_OTLP_DIR AGENTGLASS_PRICES # hermetic: the fake HOME decides
export AGENTGLASS_AGENT=0 AGENTGLASS_FLEET=0 AGENTGLASS_NOTIFY=0 # human mode, also when the suite runs inside a coding agent
cd "$(dirname "$0")/.."
. ./scripts/toolchain.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
BIN="$T/agentglass"; if [ -n "${AGENTGLASS_BIN:-}" ]; then cp "$AGENTGLASS_BIN" "$BIN"; else scriptc build src/main.ts -o "$BIN" >/dev/null; fi
H="$T/home"; mkdir -p "$H/.claude/projects/-w-in-app" "$H/.claude/projects/-w-out-secret" "$H/.agentglass"
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
# claude <id> <cwd>: two turns, the first closed (an export sends it); inside the filter: cin in /w/in-app, outside: sout
# in /w/out-secret (its cwd must never show)
claude() {
  for k in 1 2; do
    printf '{"type":"user","timestamp":"%s","cwd":"%s","sessionId":"%s","uuid":"u%s","message":{"role":"user","content":"prompt %s"}}\n' "$NOW" "$2" "$1" "$k" "$k"
    printf '{"type":"assistant","timestamp":"%s","cwd":"%s","sessionId":"%s","message":{"id":"m%s","role":"assistant","model":"claude-sonnet-4-5","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":10,"output_tokens":5}}}\n' "$NOW" "$2" "$1" "$k"
  done
}
claude cin /w/in-app > "$H/.claude/projects/-w-in-app/cin.jsonl"
claude sout /w/out-secret > "$H/.claude/projects/-w-out-secret/sout.jsonl"
ag() { HOME="$H" AGENTGLASS_CACHE_DIR="$T/cache" AGENTGLASS_OTLP_DIR="$T/otlp" "$BIN" "$@"; }
fail=0; n=0
# run <args…>: rc, stdout in $T/o, stderr in $T/e (bounded: a --watch that runs on is a failure too)
run() { rc=0; ag "$@" > "$T/o" 2> "$T/e" < /dev/null & p=$!; ( sleep 20; kill $p 2>/dev/null ) & w=$!; wait $p || rc=$?; kill $w 2>/dev/null || true; wait $w 2>/dev/null || true; n=$((n+1)); }
F='cwd ~ /w/in-' # the filter every case keeps: out-secret must never show

# 1. usage errors: err <message part> <args…>
err() { msg=$1; shift; run "$@"; if [ $rc != 2 ] || ! grep -qF -- "$msg" "$T/e"; then echo "FAIL [$*]: exit $rc, want 2 with '$msg': $(head -c 300 "$T/e")"; fail=1; fi; }
err "unknown option --bogus" --json --bogus
err "unexpected argument extra" --json extra
err "unknown option --fitler" --json --fitler "$F"
err "unknown option --limit" --watch --for 1s --limit 3
err "unknown option --fitler" --watch --for 1s --fitler "$F"
err "unknown option --fitler" --watch --otlp http://127.0.0.1:9 --for 1s --fitler "$F"
err "unknown option --json" --watch --otlp http://127.0.0.1:9 --json
err "unexpected argument export" export --watch --otlp http://127.0.0.1:9
err "unknown option --theme" --json --theme nord
err "unexpected argument extra" --version extra
err "unknown command bogus" bogus
err "unknown option --bogus" --bogus
err "--theme needs a name" --theme
err "--filter needs" --json --filter
# --filter itself never takes a flag as its expression (it swallowed --live / --pinned / --harness, widening the output)
err "--filter needs" --json --filter --live
err "--filter needs" --watch --for 1s --filter --pinned
err "--filter needs" --watch --otlp http://127.0.0.1:9 --for 1s --filter --harness claude
err "--filter needs" sessions --filter --live
err "--filter needs" errors --filter --harness claude
err "--filter needs" cost --filter --harness claude
err "--filter needs" triage --filter --days 7
err "--filter needs" compare --filter --a x
err "--filter needs" export --dry-run --filter --harness claude
err "--filter needs" fleet --filter --json
err "unknown option --bogus" sessions --bogus
err "unexpected argument extra" session last extra
err "unknown option --bogus" cost --bogus
err "unknown option --bogus" triage --bogus
err "unknown option --bogus" compare --bogus
err "unknown option --bogus" prices --bogus
err "unknown option --bogus" export --dry-run --bogus
err "unknown option --bogus" update status --bogus
err "unknown option --bogus" open --bogus
err "unknown option --bogus" rules check --bogus

# 2. no value flag swallows --filter, before or after it: either a usage error naming that flag, or the filter applies
# "<command…>|<value flags>"
while IFS='|' read -r cmd vals; do
  [ -n "$cmd" ] || continue
  for v in $vals; do
    for order in before after; do
      # shellcheck disable=SC2086
      if [ $order = before ]; then run $cmd $v --filter "$F"; else run $cmd --filter "$F" $v; fi
      if [ $rc != 2 ] || ! grep -qF -- "$v" "$T/e"; then echo "FAIL [$cmd: $v without a value, $order --filter]: exit $rc: $(head -c 300 "$T/e")"; fail=1; fi
      if grep -q out-secret "$T/o"; then echo "FAIL [$cmd: $v $order --filter]: the filter was dropped"; fail=1; fi
    done
  done
done <<'EOF'
--json|--harness --limit --format --fields --days --related --event --at --minutes
--watch --from-start --for 2s|--harness --for
--watch --from-start --for 2s --otlp http://127.0.0.1:9|--since --detail --native --compression --batch --harness
sessions|--since --cwd --limit --harness --format --fields --by
errors|--since --limit --harness --format --fields
cost|--since --by --harness --format --fields
triage|--select --preset --baseline --entity --days --weight --limit
compare|--a --b
export --dry-run --since all|--until --harness --session --native --batch --compression --detail
EOF

# 3. the filter applies in every order and form; a bare --otlp (the endpoint from the config) takes no flag as its URL
printf '{"otlp":{"endpoint":"http://127.0.0.1:9"}}\n' > "$H/.agentglass/config.json"
# only <args…>: exit 0, the inside session in the output, the outside one not
only() { run "$@"; if [ $rc != 0 ] || ! grep -q in-app "$T/o" || grep -q out-secret "$T/o"; then echo "FAIL [$*]: exit $rc, want only in-app: $(head -c 300 "$T/o") $(head -c 300 "$T/e")"; fail=1; fi; }
only --json --filter "$F"
only --json --filter="$F"
only --json --format=json --filter "$F"
only --json --limit=5 --fields=id,cwd --filter="$F"
only sessions --filter="$F" --since=7d
only --watch --from-start --for 2s --filter="$F"
only export --dry-run --since all --otlp --filter "$F"
only export --dry-run --since all --filter "$F" --otlp
only export --dry-run --since=all --otlp=http://127.0.0.1:9 --filter="$F"
rm -f "$H/.agentglass/config.json"

[ $fail = 0 ] && echo "cli args: ok ($n runs)"
exit $fail
